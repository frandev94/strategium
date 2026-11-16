import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	append,
	blocks,
	bookedMin,
	claim,
	DAY_RE,
	holds,
	dayFile,
	dueAlert,
	elapsedMin,
	load,
	nowIso,
	openKeys,
	overlapMin,
	release,
} from "./timer";
import { childEnv } from "./env";

// One run per omp session: each session owns one ticket, its edit guard and its alerts.
// Several sessions can run different tickets at the same time; the day file holds them all.
// Ownership of a ticket is an atomic claim file (see claim() in timer.ts), held while the session lives.
// `untimed`: the run has no booking. Its time is counted, but there are no alerts, no stand down and no new shift.
// `where`: the station the run is at, read from the todo (see whereFrom), so the footer shows it after a restart too.
type Where = { station: string; back?: true; seal?: string };
type Run = { key: string; theatre: string; sid: string; repo?: string; untimed?: true; where?: Where };
type Phase = { name: string; tasks: { content: string; status: string }[] };

/**
 * Where the run is, read from the todo: its phases are the stations, in order. Undefined while no task is active.
 * `back`: a later station already has completed work, so the run returned here (recon, redraft, retrial).
 * `seal`: the active task waits for the user: `[seal] Plan`, or with glyph tags `<md-seal> seal · Plan`.
 */
export function whereFrom(phases: Phase[]): Where | undefined {
	const i = phases.findIndex(p => p.tasks.some(t => t.status === "in_progress"));
	if (i < 0) return undefined;
	const task = phases[i].tasks.find(t => t.status === "in_progress")!;
	const seal = task.content.match(/^\s*(?:\[seal\]|\u{f047a}\s*seal\s*·)\s*(\S+)/u)?.[1];
	const back = phases.slice(i + 1).some(p => p.tasks.some(t => t.status === "completed"));
	return { station: phases[i].name, ...(back ? { back: true as const } : {}), ...(seal ? { seal } : {}) };
}

// Read on every use: the environment can change it, and a test points it somewhere of its own.
const stateDir = () => process.env.STRATEGIUM_STATE_DIR || path.join(homedir(), ".omp", "agent", "state", "strategium");
const runsDir = () => path.join(stateDir(), "runs");
const CAPTAIN_REASON =
	"Strategium: the Captain does not edit repository files. Delegate this change to a battle-brother agent.";

const today = () => dayFile(stateDir(), new Date());
const runFile = (sid: string) => path.join(runsDir(), `${sid}.json`);
// The session's heartbeat (local ISO time), rewritten every minute while it lives; see closeGap.
const beatFile = (sid: string) => path.join(runsDir(), `${sid}.beat`);

/** Write through a temp file and rename, so a reader in another session never sees half a file. */
function writeAtomic(file: string, data: string): void {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, data, { mode: 0o600 });
	renameSync(tmp, file);
}

const beat = (sid: string) => writeAtomic(beatFile(sid), nowIso());
function lastBeat(sid: string): string | undefined {
	try {
		return readFileSync(beatFile(sid), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}
const sidOf = (ctx: { sessionManager: { getSessionId(): string } }) => ctx.sessionManager.getSessionId();

function readRun(sid: string): Run | undefined {
	const f = runFile(sid);
	if (!existsSync(f)) return undefined;
	try {
		return JSON.parse(readFileSync(f, "utf8")) as Run;
	} catch {
		return undefined;
	}
}

/** This session's run, only while it still holds the ticket; a run taken over by another session is dropped. */
function ownRun(sid: string): Run | undefined {
	const run = readRun(sid);
	if (!run) return undefined;
	if (holds(stateDir(), run.key, sid)) return run;
	rmSync(runFile(sid), { force: true });
	rmSync(beatFile(sid), { force: true });
	return undefined;
}

function writeRun(run: Run): void {
	writeAtomic(runFile(run.sid), JSON.stringify(run));
}

function allRuns(): Run[] {
	if (!existsSync(runsDir())) return [];
	return readdirSync(runsDir())
		.filter(f => f.endsWith(".json"))
		// A truncated run file must not break `status` for every other session.
		.map(f => {
			try {
				return JSON.parse(readFileSync(path.join(runsDir(), f), "utf8")) as Run;
			} catch {
				return undefined;
			}
		})
		.filter((r): r is Run => r !== undefined);
}

// Session ids share a time prefix, so the tail tells sessions apart.
const shortSid = (sid: string) => sid.slice(-8);

/**
 * The day file holding the open start of `key`: today, or yesterday when the block crossed midnight.
 * A stop has to land in the file that holds the start, or that day keeps a block that never ends
 * and its report books minutes that were never worked.
 */
function openFile(key: string): string | undefined {
	for (const file of [today(), dayFile(stateDir(), new Date(Date.now() - 86_400_000))])
		if (openKeys(load(file)).includes(key)) return file;
	return undefined;
}

const isOpen = (key: string) => openFile(key) !== undefined;

function startKey(key: string, booked?: number, prior?: number, untimed = false): void {
	mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
	const file = today();
	const evs = load(file);
	// ponytail: booked fallback reads only today's file; a run spanning midnight needs `start` with booked.
	const bk = booked ?? bookedMin(evs, key);
	if (openKeys(evs).includes(key)) {
		// Already running: the minutes already worked are kept as an adjustment, not dropped.
		if (prior) append(file, { ts: nowIso(), event: "adjust", key, prior });
		return;
	}
	if (bk === undefined && !untimed) throw new Error(`booked minutes unknown for ${key}; pass booked`);
	append(file, { ts: nowIso(), event: "start", key, ...(bk === undefined ? {} : { booked: bk }), ...(prior ? { prior } : {}) });
}

function stopKey(key: string): boolean {
	const file = openFile(key);
	if (!file) return false;
	append(file, { ts: nowIso(), event: "stop", key });
	return true;
}

/** Raised when a new day starts without its booking; the command hands it to the Captain to fetch. */
class NewShift extends Error {}

/**
 * Start (or restart) counting `run`'s ticket. Each day is its own file and its own booking: the first start of a
 * day is a new shift that counts from 0 (plus any `add`) against that day's booking, never yesterday's. Without
 * today's booked minutes it throws NewShift, so they are looked up (theatre) or asked, not guessed.
 */
function shift(run: Run, booked?: number): string {
	const today_ = bookedMin(load(today()), run.key);
	// A run without a booking has no shifts to ask for: it just counts again.
	if (run.untimed && booked === undefined) {
		startKey(run.key, undefined, undefined, true);
		return `resumed ${run.key}`;
	}
	if (booked === undefined && today_ === undefined)
		throw new NewShift(`new day for ${run.key}: today's booked minutes are needed for the new shift`);
	startKey(run.key, booked);
	return today_ === undefined ? `new shift for ${run.key} today, booked ${booked} min` : `resumed ${run.key}`;
}

/** Manual correction: `min` minutes added to (or, negative, taken from) today's time for the run's ticket. */
function addMin(run: Run, min: number): string {
	if (!Number.isInteger(min) || min === 0) throw new Error("add needs a whole number of minutes, e.g. 30 or -15");
	mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
	append(today(), { ts: nowIso(), event: "adjust", key: run.key, prior: min });
	return `ADDED ${min > 0 ? "+" : ""}${min} min to ${run.key} (now ${Math.floor(elapsedMin(load(today()), run.key, new Date()))} min today)`;
}

// A session that misses heartbeats for this long was closed hard (crash, killed) or the machine slept.
const GAP_MS = 3 * 60_000;

/**
 * If `run`'s ticket is still open but its session went silent (crash, killed process, sleep), close the open block
 * at the last heartbeat, in that heartbeat's day file, so the silent time is not counted. Returns the beat it closed
 * at, or undefined when there was no gap. With `force` the block is closed even without a gap: a session that takes a
 * ticket over has to close the previous turn, or the new booking would never start.
 */
function closeGap(run: Run, force = false): string | undefined {
	const beat = lastBeat(run.sid);
	if (!force && (!beat || Date.now() - new Date(beat).getTime() < GAP_MS)) return undefined;
	const at = beat ?? nowIso();
	// The stop goes in the file that holds the start: a start left open in another day would grow
	// its elapsed for ever and book minutes that were never worked.
	const file = openFile(run.key);
	if (!file) return undefined;
	append(file, { ts: at, event: "stop", key: run.key });
	return at;
}

/** Claim `key` for session `sid`. A ticket held by a crashed session is taken over by naming its id in `takeover`. */
function begin(sid: string, key: string, theatre: string, booked?: number, spent?: number, takeover?: string): void {
	claim(stateDir(), key, sid, takeover);
	const other = allRuns().find(r => r.key === key && r.sid !== sid);
	if (other) {
		// Force: the ticket changes hands, so its open block ends here whatever the heartbeat gap is.
		closeGap(other, true);
		rmSync(runFile(other.sid), { force: true });
		rmSync(beatFile(other.sid), { force: true });
	}
	const mine = readRun(sid);
	if (mine && mine.key !== key) {
		stopKey(mine.key);
		release(stateDir(), mine.key, sid);
	}
	const untimed = booked === undefined;
	// Begun again on the same key, the run keeps the station it was at.
	const keep = mine?.key === key ? mine : undefined;
	writeRun({ key, theatre, sid, repo: keep ? keep.repo : other?.repo, ...(untimed ? { untimed: true as const } : {}), ...(keep?.where ? { where: keep.where } : {}) });
	beat(sid);
	startKey(key, booked, spent, untimed);
}

function statusLines(): string {
	const evs = load(today());
	const now = new Date();
	const open = openKeys(evs);
	const keys = [...new Set(evs.filter(e => e.event === "start").map(e => e.key))];
	if (!keys.length) return "IDLE";
	return keys
		.map(k => {
			const el = Math.floor(elapsedMin(evs, k, now));
			const bk = bookedMin(evs, k);
			const state = open.includes(k) ? "running" : "stopped";
			if (bk === undefined) return `${k} ${el} min (no booking) ${state}`;
			return `${k} ${el}/${bk} min (${Math.floor((el / bk) * 100)}%) ${state}`;
		})
		.join("\n");
}

function fullStatus(sid: string): string {
	const runs = allRuns().map(r => {
		// A run whose session is gone (crash) still has its file: say so, or the user counts it twice.
		const stale = holds(stateDir(), r.key, r.sid) ? "" : " (stale: its session is gone)";
		return `RUN ${r.key} theatre=${r.theatre} repo=${r.repo ?? "none"} session=${shortSid(r.sid)}${r.sid === sid ? " (this session)" : ""}${stale}`;
	});
	return [statusLines(), ...runs].join("\n");
}

/** End this session's run, or another session's run of `key` by naming that crashed session's id in `takeover`. */
function endRun(sid: string, key?: string, takeover?: string): string {
	// ownRun() may drop the run file, so ask for it once.
	const mine = ownRun(sid);
	const run = key && key !== mine?.key ? allRuns().find(r => r.key === key) : mine;
	if (!run) return "ERROR no run to end in this session";
	if (run.sid !== sid) {
		if (!takeover) return `ERROR ${run.key} belongs to session ${shortSid(run.sid)}; end it there, or take it over with that id`;
		claim(stateDir(), run.key, sid, takeover);
		closeGap(run);
	}
	stopKey(run.key);
	release(stateDir(), run.key, sid);
	rmSync(runFile(run.sid), { force: true });
	rmSync(beatFile(run.sid), { force: true });
	return `ENDED ${run.key}`;
}

function report(date?: string): string {
	// The date comes from the model: only a plain day file, never a path.
	if (date !== undefined && !DAY_RE.test(date)) throw new Error(`bad date ${date}; expected YYYY-MM-DD`);
	const file = date ? path.join(stateDir(), `${date}.jsonl`) : today();
	const evs = load(file);
	// A past day ends at its midnight, so a block left open then does not grow until now.
	const now = date && date !== path.basename(today(), ".jsonl") ? new Date(`${date}T23:59:59`) : new Date();
	const bl = blocks(evs, now);
	const keys = [...new Set(evs.filter(e => e.event !== "alert").map(e => e.key))];
	if (!keys.length) return "IDLE";
	const sum = (k: string, ev: string) =>
		evs.filter(e => e.key === k && e.event === ev).reduce((n, e) => n + (e.prior ?? 0), 0);
	const overlap = Math.floor(overlapMin(evs, now));
	return [
		...keys.flatMap(k => (sum(k, "start") ? [`PRIOR ${k} ${sum(k, "start")} min (estimate, before tracking)`] : [])),
		...keys.flatMap(k => (sum(k, "adjust") ? [`ADJUST ${k} ${sum(k, "adjust")} min (added by hand)`] : [])),
		...bl.map(b => `${b.key} ${b.start}-${b.end} (${b.min} min)`),
		...keys.map(k => {
			const measured = bl.filter(b => b.key === k).reduce((n, b) => n + b.min, 0);
			const worked = Math.floor(elapsedMin(evs, k, now));
			return `TOTAL ${k} measured ${measured} min, worked ${worked} min with prior and adjustments (~${Math.round(worked / 15) * 15} min)`;
		}),
		...(overlap ? [`OVERLAP ${overlap} min with two or more tickets running at once; split them before booking`] : []),
	].join("\n");
}

/** The alarm command split into arguments: quotes keep a path with spaces in one piece. */
function alarmCmd(cmd: string): string[] {
	return (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(t => t.replace(/^["']|["']$/g, ""));
}

/**
 * Run STRATEGIUM_ALARM with the level in STRATEGIUM_P and a desktop-notification text in STRATEGIUM_MSG.
 * Levels: 50 | 80 | 100 for the booking timer, "attention" when the user is needed. Unset → silent.
 * Returns the reason when the alarm could not be started, so it is not a silent no-sound.
 */
function signal(level: string, msg: string): string | undefined {
	const alarm = process.env.STRATEGIUM_ALARM?.trim();
	if (!alarm) return undefined;
	try {
		const child = Bun.spawn({
			cmd: alarmCmd(alarm),
			env: childEnv({ STRATEGIUM_P: level, STRATEGIUM_MSG: msg }),
			stdout: "ignore",
			stderr: "ignore",
		});
		// The alarm must not keep the session alive.
		child.unref();
		return undefined;
	} catch (err) {
		return `the alarm failed: ${err instanceof Error ? err.message : String(err)}`;
	}
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

/**
 * Every file a tool call would write, whatever wire contract it uses:
 * hashline `[path#TAG]`, replace and patch `path`, apply_patch `*** Add/Update/Delete File:`
 * and `*** Move to:`, sloppy `*** Edit File:`. The edit tool can also arrive as `apply_patch`.
 */
export function editTargets(name: string, input: Record<string, unknown>): string[] {
	if (name === "write") return typeof input.path === "string" ? [input.path] : [];
	if (name !== "edit" && name !== "apply_patch") return [];
	const out: string[] = [];
	const raw = String(input.input ?? "");
	for (const m of raw.matchAll(/^\[([^\]#\r\n]+)#[0-9A-Fa-f]{4}\]/gm)) out.push(m[1]);
	for (const m of raw.matchAll(/^\*\*\*\s+(?:Add|Update|Delete|Edit)\s+File:\s*(.+)$/gm)) out.push(m[1].trim());
	for (const m of raw.matchAll(/^\*\*\*\s+Move\s+to:\s*(.+)$/gm)) out.push(m[1].trim());
	if (typeof input.path === "string") out.push(input.path);
	return out;
}

export default function (pi: ExtensionAPI) {
	const z = pi.zod;
	// Set by session_start; tool and command actions call it so the footer updates at once, not on the
	// next minute. It belongs to this instance: a module loaded twice would cross the sessions.
	let refreshFooter: (() => void) | undefined;
	pi.setLabel("Strategium");

	pi.registerTool({
		name: "strategium",
		label: "Strategium",
		description:
			"Strategium run state and booking timer, one run per omp session (other sessions may run other tickets in parallel). Actions: begin (key, booked?, spent?, theatre?, takeover?), repo (repo), start (booked?), stop, add (minutes), status, report (date?), end (key?, takeover?), attention (message). booked is optional: without it the run is untimed, its time is counted but there are no 50/80/100 % alerts and no new shifts. spent = minutes already worked on the key today that strategium has not tracked; they count toward the 50/80/100 % alerts. start resumes the run; on a new day it opens a new shift that counts from 0 (pass today's booked minutes; else the last booking is reused). add = a manual correction of today's time in whole minutes, negative to subtract. takeover = the id of a crashed session that holds the ticket, as given in the refusal; only the user decides that session is gone. attention plays the attention sound and shows a desktop notification with the message: use it whenever the user must act (a seal, a question, a blocker, a finished run).",
		parameters: z.object({
			action: z.enum(["begin", "repo", "start", "stop", "add", "status", "report", "end", "attention"]),
			key: z.string().optional(),
			booked: z.number().int().positive().optional(),
			spent: z.number().int().nonnegative().optional(),
			theatre: z.string().optional(),
			repo: z.string().optional(),
			date: z.string().optional(),
			takeover: z.string().optional(),
			message: z.string().optional(),
			minutes: z.number().int().optional(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (ctx?.agent?.kind === "sub") return text("ERROR strategium tool is for the main session only");
			const sid = sidOf(ctx);
			try {
				switch (params.action) {
					case "begin": {
						if (!params.key) throw new Error("begin needs key");
						begin(sid, params.key, params.theatre ?? "none", params.booked, params.spent, params.takeover);
						return text(statusLines());
					}
					case "repo": {
						const run = ownRun(sid);
						if (!run) return text("ERROR no active run in this session");
						if (!params.repo) throw new Error("repo needs repo");
						// Resolved against the session cwd, the same base the edit guard uses.
						const repo = path.resolve(ctx.cwd, params.repo);
						writeRun({ ...run, repo });
						return text(`RUN ${run.key} repo=${repo}`);
					}
					case "start": {
						const run = ownRun(sid);
						if (!run) throw new Error("no active run in this session; use begin");
						return text(`${shift(run, params.booked)}\n${statusLines()}`);
					}
					case "stop": {
						const run = ownRun(sid);
						if (!run || !stopKey(run.key)) return text("IDLE");
						return text(`STOPPED ${run.key} ${Math.floor(elapsedMin(load(today()), run.key, new Date()))} min`);
					}
					case "add": {
						const run = ownRun(sid);
						if (!run) throw new Error("no active run in this session; use begin");
						return text(addMin(run, params.minutes ?? 0));
					}
					case "status":
						return text(fullStatus(sid));
					case "report":
						return text(report(params.date));
					case "end":
						return text(endRun(sid, params.key, params.takeover));
					case "attention": {
						const key = ownRun(sid)?.key;
						const msg = params.message?.trim() || "Your attention is needed";
						const err = signal("attention", key ? `${key}: ${msg}` : msg);
						if (err) ctx.ui.notify(`Strategium: ${err}`, "warning");
						return text(err ? `ERROR ${err}` : `ATTENTION ${msg}`);
					}
				}
			} catch (err) {
				return text(`ERROR ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				refreshFooter?.();
			}
		},
	});

	pi.registerCommand("strategium", {
		description: "Run one objective through the Strategium workflow: a ticket, a @file or \"free text\"",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const [first, second] = raw.split(/\s+/).filter(Boolean);
			const sid = sidOf(ctx);
			try {
				switch (first) {
					case undefined:
						ctx.ui.notify(
							'Usage: /strategium <ticket | @file | "free text"> [theatre] | pause | resume [booked] | add <min> | status | end',
							"warning",
						);
						return;
					case "pause": {
						const run = ownRun(sid);
						ctx.ui.notify(`Strategium: paused (${run && stopKey(run.key) ? run.key : "idle"})`, "info");
						return;
					}
					case "resume": {
						const run = ownRun(sid);
						if (!run) return ctx.ui.notify("Strategium: no active run in this session", "warning");
						const bk = second === undefined ? undefined : Number(second);
						if (bk !== undefined && !(Number.isInteger(bk) && bk > 0))
							throw new Error("resume takes the booked minutes as a whole number, e.g. /strategium resume 240");
						try {
							ctx.ui.notify(`Strategium: ${shift(run, bk)}`, "info");
						} catch (err) {
							if (!(err instanceof NewShift)) throw err;
							const skill = run.theatre.startsWith("strategium-") ? run.theatre : `strategium-${run.theatre}`;
							pi.sendUserMessage(
								run.theatre === "none"
									? `New Strategium shift for ${run.key}: ask me today's booked minutes, then call strategium start with booked.`
									: `New Strategium shift for ${run.key}: read today's booked minutes for it as skill://${skill} Muster says (not booked today: tell me and stop), then call strategium start with booked. If I already worked on it today before this, propose those minutes as Muster does and record them with strategium add after my OK.`,
							);
						}
						return;
					}
					case "add": {
						const run = ownRun(sid);
						if (!run) return ctx.ui.notify("Strategium: no active run in this session", "warning");
						ctx.ui.notify(`Strategium: ${addMin(run, Number(second))}`, "info");
						return;
					}
					case "status":
						ctx.ui.notify(fullStatus(sid), "info");
						return;
					case "end":
						ctx.ui.notify(endRun(sid), "info");
						// undefined removes the line; "" would leave an empty one under the other plugins' lines.
						ctx.ui.setStatus("strategium", undefined);
						return;
				}
			} catch (err) {
				ctx.ui.notify(`Strategium: ${err instanceof Error ? err.message : String(err)}`, "warning");
				return;
			} finally {
				refreshFooter?.();
			}
			// The objective: "free text" in quotes, @path to a spec or an approved plan, or a key (a ticket or a short name).
			// A theatre name may follow. Free text needs the quotes: unquoted words would clash with the subcommands.
			const parsed = raw.match(/^"([^"]+)"(?:\s+(\S+))?$/) ?? raw.match(/^(\S+)(?:\s+(\S+))?$/);
			if (!parsed) {
				ctx.ui.notify('Strategium: put a free objective in quotes, e.g. /strategium "add a dark mode"', "warning");
				return;
			}
			const objective = raw.startsWith('"') ? `"${parsed[1]}"` : parsed[1];
			const theatre = (parsed[2] ?? process.env.STRATEGIUM_THEATRE ?? "none").replace(/^strategium-/, "");
			const glyphs = process.env.STRATEGIUM_GLYPHS === "1" ? " Use glyph todo tags." : "";
			pi.sendUserMessage(
				(theatre === "none"
					? `Read skill://strategium and run it for the objective ${objective} with no theatre.`
					: `Read skill://strategium and run it for the objective ${objective} with theatre skill://strategium-${theatre}.`) + glyphs,
			);
		},
	});

	pi.on("session_start", (_e, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		const sid = sidOf(ctx);
		// A resumed session takes its ticket back, unless another session claimed it meanwhile.
		const own = readRun(sid);
		if (own) {
			// Reopened after a crash or kill: the time it was gone is not work.
			closeGap(own);
			try {
				claim(stateDir(), own.key, sid);
			} catch {
				rmSync(runFile(sid), { force: true });
				rmSync(beatFile(sid), { force: true });
			}
		}
		const tick = () => {
			try {
				const found = ownRun(sid);
				if (!found) return ctx.ui.setStatus("strategium", undefined);
				// A gap in our own heartbeats means the machine slept: close the block at the last beat and stay paused.
				const gap = closeGap(found);
				if (gap) {
					const at = gap.slice(11, 16);
					ctx.ui.notify(
						`Strategium: ${found.key} paused at ${at}; this session was silent since then (sleep or freeze). /strategium resume to continue.`,
						"warning",
					);
					signal("attention", `${found.key}: paused at ${at} after a silent gap; resume when you are back`);
				}
				beat(sid);
				const run = found;
				const file = today();
				const evs = load(file);
				const key = run.key;
				const running = isOpen(key);
				const now = new Date();
				const el = Math.floor(elapsedMin(evs, key, now));
				const bk = bookedMin(evs, key) ?? 0;
				const pct = bk ? Math.floor((el / bk) * 100) : 0;
				// Same shape as other plugins' footer lines: dot, icon, grey "name:", value. Dot: grey paused, green/yellow/red by booking use.
				const dot = !running ? "\x1b[38;5;243m○" : pct >= 100 ? "\x1b[31m●" : pct >= 80 ? "\x1b[33m●" : "\x1b[32m●";
				// Nerd Font glyphs only with STRATEGIUM_GLYPHS=1; emoji otherwise.
				const nf = process.env.STRATEGIUM_GLYPHS === "1";
				const phase = pct >= 100 ? 4 : pct >= 80 ? 3 : pct >= 50 ? 2 : pct >= 25 ? 1 : 0;
				// The world is calm, a meteor falls, it burns, and past the booking it is purged.
				// Glyphs drawn and checked in Cascadia Code NF: md-earth F01E7, md-meteor F0629, md-fire F0238, md-nuke F06A4.
				const stageColor = ["39", "39", "214", "202", "160"][phase];
				const stageGlyph = (nf
					? ["\u{f01e7}", "\u{f01e7}", "\u{f0629}", "\u{f0238}", "\u{f06a4}"]
					: ["🌍", "🌍", "🌠", "🔥", "💥"])[phase];
				const stage = `\x1b[38;5;${stageColor}m${stageGlyph}${nf ? " " : ""}\x1b[39m`;
				// Gold planet (256-colour 214), reset right after so the rest of the line keeps its colours.
				// Nerd Font md-* glyphs draw two cells wide but count as one, so they get an extra space (seen in the terminal).
				const planet = `\x1b[38;5;214m${nf ? "\u{f0018} " : "🪐"}\x1b[39m`;
				// A run without a booking only counts time. A timed run with no booking today waits for its new shift.
				const value = run.untimed && bookedMin(evs, key) === undefined
					? running ? `${el} min` : "paused"
					: bookedMin(evs, key) === undefined
						? "new day: /strategium resume"
						: `${stage} ${el}/${bk} min (${pct}%)${running ? "" : " paused"}`;
				// Where the run is: a seal waiting for the user (⏳, md-timer_sand F051F, in yellow), a return (↩, md-undo
				// F054C) or just the station. Codepoints checked in the Nerd Fonts glyphnames.json.
				const w = run.where;
				const where = !w
					? ""
					: w.seal
						? ` · \x1b[33m${nf ? "\u{f051f} " : "⏳"} seal ${w.seal}\x1b[39m`
						: ` · ${w.back ? (nf ? "\u{f054c}  " : "↩ ") : ""}${w.station}`;
				ctx.ui.setStatus("strategium", `${dot}\x1b[39m ${planet} \x1b[38;5;248mstrategium: \x1b[39m${key}${where} · ${value}`);
				if (!running) return;
				// Only the owning session alerts for its key, so each alert fires once.
				const p = dueAlert(evs, key, now);
				if (p === undefined) return;
				append(file, { ts: nowIso(), event: "alert", key, p });
				ctx.ui.notify(`Strategium: ${p}% of the booking for ${key}`, p === 100 ? "warning" : "info");
				const alarmError = signal(String(p), `${key}: ${p}% of the booking (${el}/${bk} min)`);
				if (alarmError) ctx.ui.notify(`Strategium: ${alarmError}`, "warning");
				pi.sendMessage(
					{ customType: "strategium-timer", content: `TIMER ${p}% ${key} ${el}/${bk} min`, display: true, attribution: "agent" },
					{ deliverAs: "aside", triggerTurn: true },
				);
			} catch (err) {
				ctx.ui.notify(`Strategium timer: ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
		};
		refreshFooter = tick;
		ctx.setInterval(tick, 60_000);
		tick();
	});

	// Closing the session pauses its ticket and releases the claim; the run file stays so a resumed session
	// (or another session's `begin`, which adopts its repo) picks it up.
	pi.on("session_shutdown", (_e, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		refreshFooter = undefined;
		const sid = sidOf(ctx);
		const run = ownRun(sid);
		if (!run) return;
		stopKey(run.key);
		release(stateDir(), run.key, sid);
	});

	// The todo phases are the stations: keep where the run is, so the footer shows it at once and after a restart.
	pi.on("tool_result", (e, ctx) => {
		if (ctx?.agent?.kind === "sub" || e.toolName.replace(/^_+/, "") !== "todo" || e.isError) return;
		const phases = (e.details as { phases?: Phase[] } | undefined)?.phases;
		const run = ownRun(sidOf(ctx));
		const where = phases && whereFrom(phases);
		if (!run || !where) return;
		writeRun({ ...run, where });
		refreshFooter?.();
	});

	// ponytail: bash writes are not guarded; parse bash commands if the Captain ever edits through bash
	pi.on("tool_call", (e, ctx) => {
		if (ctx?.agent?.kind === "sub") return;
		const run = ownRun(sidOf(ctx));
		const name = e.toolName.replace(/^_+/, "");
		// A question to the user during a run needs them at the keyboard, wherever they are.
		if (name === "ask" && run) {
			const err = signal("attention", `${run.key}: your answer is needed`);
			if (err) ctx.ui.notify(`Strategium: ${err}`, "warning");
		}
		const repo = run?.repo;
		if (!repo) return;
		if (name === "ast_edit") return { block: true, reason: CAPTAIN_REASON };
		const targets = editTargets(name, e.input as Record<string, unknown>);
		if (!targets.length) return;
		// Windows and macOS filesystems ignore case; Linux does not.
		const norm = (p: string) => (process.platform === "linux" ? p : p.toLowerCase());
		// A scheme of two or more letters is a URI; a single letter is a Windows drive (C://...).
		const isUri = (t: string) => /^[a-z][a-z0-9+.-]+:\/\//i.test(t);
		// Compare real paths, so an alias of the repo through a symlink matches the root too.
		const real = (p: string) => {
			try {
				return realpathSync(p);
			} catch {
				// The file may not exist yet: canonicalise its directory instead.
				try {
					return path.join(realpathSync(path.dirname(p)), path.basename(p));
				} catch {
					return p;
				}
			}
		};
		const roots = [repo, `${repo}-worktrees`].map(r => norm(real(path.resolve(r))));
		for (const t of targets) {
			if (isUri(t)) {
				// A device that writes files is not exempt: `xd://ast_edit` dispatches the AST editor.
				if (/^xd:\/\/(ast_edit|eval|lsp|debug)\b/i.test(t)) return { block: true, reason: CAPTAIN_REASON };
				continue;
			}
			const abs = norm(real(path.resolve(ctx.cwd, t)));
			if (roots.some(r => abs === r || abs.startsWith(r + path.sep))) return { block: true, reason: CAPTAIN_REASON };
		}
	});
}
