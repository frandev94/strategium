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
	type Ev,
} from "./timer";
import { childEnv } from "./env";

// One run per omp session: each session owns one ticket, its edit guard and its alerts.
// Several sessions can run different tickets at the same time; the day file holds them all.
// Ownership of a ticket is an atomic claim file (see claim() in timer.ts), held while the session lives.
// `untimed`: the run has no booking. Its time is counted, but there are no alerts, no stand down and no new shift.
// `where`: the station the run is at, read from the todo (see whereFrom), so the footer shows it after a restart too.
type Where = { station: string; back?: true; seal?: string; task?: string };
type Slice = { id: string; parallel: boolean; files: string[] };
// `hidden`: the tools hidden from the Captain for this run, put back when it ends. `slices`: the plan's squads as declared.
// `launched`: the parallel squads went out together in one task call.
// `agents`: the running battle-brothers and veterans, by the agent id the host allocated → the squad each builds.
// `stopped`: squads whose agents have all ended (finished, failed or cancelled) and that no agent builds again yet.
// `closedBy`: the session closed with the run going, so the next session resumes it.
// `idle`: the clock was stopped by the idle pause; the next turn of the session resumes it.
// `archmagos`: Muster marked the run for the Archmagos Dominus (begin archmagos: true). `librarians`: this run's librarians by
// agent id, running or done (finished completed; a failed or cancelled one never counts). `archmagosSpawned`: archmagos
// spawns let through. `redraft`: the one redraft of the run was used, so one more archmagos may spawn.
type Run = {
	key: string;
	theatre: string;
	sid: string;
	repo?: string;
	untimed?: true;
	where?: Where;
	hidden?: string[];
	slices?: Slice[];
	launched?: true;
	agents?: Record<string, Slice>;
	stopped?: Slice[];
	closedBy?: "shutdown";
	idle?: true;
	archmagos?: true;
	librarians?: Record<string, "running" | "done">;
	archmagosSpawned?: number;
	redraft?: true;
};
// What the extension reads from the host's session context: the real one has more.
type SessionCtx = {
	sessionManager: { getSessionId(): string };
	ui: { notify(message: string, level?: "info" | "warning" | "error"): void; setStatus(key: string, value: string | undefined): void };
	setInterval(fn: () => void, ms: number): unknown;
	agent?: { kind?: string };
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	getAsyncJobSnapshot(): { running: unknown[] } | null | undefined;
	getPendingPlanReview(): unknown;
};
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
	// A seal keeps its own form. Other tasks show their text without the agent tag (`[agent] ` or `<glyph> agent · `), cut at 32.
	const text = seal ? "" : task.content.replace(/^\s*(?:\[[\w-]+\]|[^\w\s[]+\s*[\w-]+\s*·)\s*/u, "").trim();
	const chars = [...text];
	const short = chars.length > 32 ? `${chars.slice(0, 31).join("")}…` : text;
	return { station: phases[i].name, ...(back ? { back: true as const } : {}), ...(seal ? { seal } : {}), ...(short ? { task: short } : {}) };
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
	// Windows refuses the rename for a moment while a scanner or indexer holds the target or the temp file open.
	// ponytail: ~1 s of bounded retries, Windows only (blocking, like the sync write); a longer lock still throws.
	for (let tries = 0; ; tries++) {
		try {
			return renameSync(tmp, file);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (process.platform !== "win32" || tries >= 20 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw err;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
	}
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

// `reason`: "shutdown" marks the stop of a closing session, so the reopened session knows to resume; "idle" marks the idle pause;
// a stop the user asked for has none.
type StopEv = Ev & { reason?: "shutdown" | "idle" };

// `at`: the idle pause stamps the stop at the start of the idle minutes, not at the tick that noticed them.
function stopKey(key: string, reason?: "shutdown" | "idle", at = nowIso()): boolean {
	const file = openFile(key);
	if (!file) return false;
	const stop: StopEv = { ts: at, event: "stop", key, ...(reason ? { reason } : {}) };
	append(file, stop);
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
	// Begun again on the same key, every stored field stays except the booking mode.
	const { untimed: _u, ...kept } = keep ?? {};
	// A run begun under another key still hands its hidden tools on, or end could never restore them.
	writeRun({ ...kept, ...(mine?.hidden ? { hidden: mine.hidden } : {}), key, theatre, sid, repo: keep ? keep.repo : other?.repo, ...(untimed ? { untimed: true as const } : {}) });
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
 * Levels: 50 | 80 | 100 for the booking timer, "attention" when the user is needed, "theme" when the session's run ends,
 * "idle" when the clock pauses after idle minutes.
 * Unset → silent.
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

// The agents the Captain may spawn during a run.
const ROSTER = ["scout", "librarian", "archmagos", "battle-brother", "veteran", "apothecary", "inquisitor", "security-reviewer", "sonic", "task"];
const agentName = (a: string) => a.toLowerCase().split(/[:/]/).pop()!;
const SLICES_REASON = "Strategium: declare the plan's squads first: strategium action slices, with each squad's id, parallel flag and files.";
const ARCHMAGOS_OFF =
	"Strategium: the archmagos is off in this session. The user turns it on with /strategium-config archmagos on or STRATEGIUM_ARCHMAGOS=1; until then the lead librarian merges the plan.";
const ARCHMAGOS_UNMARKED =
	"Strategium: this run was not marked for the archmagos in Muster (strategium begin with archmagos: true); the lead librarian merges the plan.";
const archmagosWaits = (n: number) =>
	`Strategium: the archmagos integrates the librarians' parts: at least 2 librarians of this run must have finished first; ${n} have.`;
const ARCHMAGOS_AGAIN = "Strategium: this run already spawned its archmagos. Only a redraft allows one more: call strategium action redraft first.";
const ARCHMAGOS_SPENT = "Strategium: this run already spawned its archmagos and spent its one redraft.";
// Tool input arrives as unknown; anything that is not an object reads as empty.
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

// Windows and macOS filesystems ignore case; Linux does not.
const normFile = (f: string) => {
	const n = f.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	return process.platform === "linux" ? n : n.toLowerCase();
};
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** The files two squads share, each once; a file inside a listed folder names both. */
function sharedFiles(a: Slice, b: Slice): string[] {
	const out = new Set<string>();
	const bFiles = b.files.map(normFile);
	for (const f of a.files.map(normFile)) {
		for (const g of bFiles) {
			if (f === g) out.add(f);
			else if (overlaps(f, g)) out.add(f.length > g.length ? `${f} (inside ${g})` : `${g} (inside ${f})`);
		}
	}
	return [...out];
}

/** The squad list as the user writes it, for the corrected example in a message. */
const sliceJson = (slices: Slice[]) => JSON.stringify(slices.map(({ id, parallel, files }) => ({ id, parallel, files })));

/**
 * The reason the declared squads are unusable, if any: two parallel squads whose agents can run at the same time must
 * not share a file. A squad in `stopped` has no running agent, so it collides with nothing (see sliceWarnings).
 */
export function checkSlices(slices: Slice[], stopped: Slice[] = []): string | undefined {
	if (!slices.length) return "declare at least one squad";
	const ids = new Set<string>();
	for (const s of slices) {
		if (!s.id.trim()) return "every squad needs an id";
		if (ids.has(s.id)) return `duplicate squad id ${s.id}`;
		ids.add(s.id);
		if (!s.files.length) return `squad ${s.id} lists no files`;
	}
	const idle = new Set(stopped.map(s => s.id));
	const parallel = slices.filter(s => s.parallel && !idle.has(s.id));
	for (const [i, a] of parallel.entries()) {
		for (const b of parallel.slice(i + 1)) {
			const shared = sharedFiles(a, b);
			if (!shared.length) continue;
			const fixed = slices.map(s => (s.id === b.id ? { ...s, parallel: false } : s));
			return (
				`squads ${a.id} and ${b.id} are both parallel and both change ${shared.join(", ")}. ` +
				"Two agents working on the same file at the same time overwrite each other's changes. " +
				`Mark one parallel: false so it runs after the other, e.g. slices: ${sliceJson(fixed)}. ` +
				"If one of them has already finished, remove it from the list instead."
			);
		}
	}
	return undefined;
}

/**
 * Notes on squads whose agent has stopped, shown before the result of a declaration and never blocking it:
 * a stopped squad still in the list, and a new squad that changes files a stopped squad already changed.
 */
export function sliceWarnings(slices: Slice[], stopped: Slice[]): string[] {
	const idle = new Set(stopped.map(s => s.id));
	const live = slices.filter(s => !idle.has(s.id));
	const out: string[] = [];
	for (const s of slices.filter(s => idle.has(s.id))) {
		const clashes = live.flatMap(l => {
			const shared = sharedFiles(s, l);
			return shared.length ? [`${shared.join(", ")} with ${l.id}`] : [];
		});
		const note = clashes.length ? `; sharing ${clashes.join(" and ")} is not a conflict` : "";
		const rest = live.length ? `, e.g. slices: ${sliceJson(live)}` : "";
		out.push(`squad ${s.id} is no longer active (its agent has stopped)${note}. Remove it from the list${rest}.`);
	}
	for (const done of stopped.filter(d => !slices.some(s => s.id === d.id))) {
		for (const l of live) {
			const shared = sharedFiles(l, done);
			if (shared.length)
				out.push(
					`squad ${l.id} changes ${shared.join(", ")}, which squad ${done.id} already changed and its agent has stopped. ` +
						`Tell ${l.id}'s agent what ${done.id} changed there, so it builds on that work instead of undoing it.`,
				);
		}
	}
	return out;
}

/**
 * The agent ids of background task jobs that are no longer running, from what the host sends to the model: a job's
 * label is its agent id, in completion messages (jobId) and in wait results (id) alike. `only` keeps one end status.
 */
export function endedAgents(messages: unknown, only?: string): string[] {
	const out: string[] = [];
	for (const m of Array.isArray(messages) ? messages : []) {
		const jobs = asObj(asObj(m).details).jobs;
		if (!Array.isArray(jobs)) continue;
		for (const job of jobs.map(asObj))
			if (job.type === "task" && job.status !== "running" && (!only || job.status === only) && typeof job.label === "string") out.push(job.label);
	}
	return out;
}

/** The items of a task call: a `tasks` list, or the input itself as one item. */
const taskItems = (input: unknown) => {
	const o = asObj(input);
	return (Array.isArray(o.tasks) ? o.tasks : [o]).map(asObj);
};

/**
 * The squad a battle-brother or veteran item builds: the one its name spells (letters and digits, any case), else the
 * one its brief builds ("build squad <id>"). Undefined for any other agent.
 */
function builtSlice(item: Record<string, unknown>, run: Run): Slice | undefined {
	if (!["battle-brother", "veteran"].includes(agentName(String(item.agent ?? "task")))) return undefined;
	const known = [...(run.slices ?? []), ...(run.stopped ?? [])];
	const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
	const name = typeof item.name === "string" ? fold(item.name) : undefined;
	const built = [...String(item.task ?? "").matchAll(/\b(?:squad|slice)\s+([\w.-]*\w)/gi)].map(m => m[1]);
	return known.find(s => fold(s.id) === name) ?? known.find(s => built.includes(s.id));
}

/**
 * The run once its builders changed (`agents`: the running ones): each touched squad with a running agent is live
 * again, and one whose agents have all ended is stopped.
 */
function settle(run: Run, agents: Record<string, Slice>, touched: Slice[]): Run {
	const running = new Set(Object.values(agents).map(s => s.id));
	let slices = run.slices ?? [];
	let stopped = run.stopped ?? [];
	for (const slice of touched) {
		const id = slice.id;
		if (running.has(id)) {
			stopped = stopped.filter(s => s.id !== id);
			if (!slices.some(s => s.id === id)) slices = [...slices, slice];
		} else if (!stopped.some(s => s.id === id)) stopped = [...stopped, slice];
	}
	return { ...run, agents, slices, stopped };
}

// A runner is a command word, never an argument: it starts the command or follows ; & | ( ` or a newline, behind VAR=x
// assignments and wrappers (env, time, sudo, then...). It may be named by path (./node_modules/.bin/jest, /usr/bin/pytest,
// C:\tools\bun.exe) and carry .exe or .cmd on Windows.
const EXT = String.raw`(?:\.exe|\.cmd)?`;
const RUNNER = new RegExp(
	String.raw`(?:^|[;&|(\n\x60])\s*` +
		String.raw`(?:(?:\w+=\S*|(?:env|time|exec|nohup|sudo|xargs|nice|stdbuf|setsid|doas|watch)(?:\s+-\S+(?:\s+\d\S*)?)*|then|do|else|elif|if|while|until|!|\{|timeout(?:\s+-\S+(?:\s+\d\S*)?)*\s+\d\w*)\s+)*` +
		String.raw`(?:[^\s;&|()\x60"'<>=]*[\\/])?` +
		String.raw`(?:bun${EXT}\s+(?:test|run)\b|bunx${EXT}\s|npx${EXT}\s|(?:npm|pnpm|yarn)${EXT}\s+(?:test|t|run|run-script|exec|build)\b` +
		String.raw`|(?:tsc|jest|vitest|pytest|gradle|mvn|playwright)${EXT}\b|(?:cargo|go|dotnet)${EXT}\s+(?:test|build)\b)`,
);
const WRITE_WORD = /(^|[;&|(\n]|\$\(|`)\s*(rm|rmdir|mv|cp|touch|truncate|tee|ln)\b/;
// git's global options (-C dir, -c k=v, --git-dir=x) come before the subcommand and must not hide it.
const WRITE_GIT = /\bgit\s+(?:(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?|-\w)\s+)*(checkout\s+(\S+\s+)?--(?=\s|$)|checkout\s+\.(?=\s|$)|(restore|reset\s+--hard|clean|stash|apply|am|rm|mv)\b)/;
// A redirect, unless it goes to a file descriptor, /dev/null or a scratch place.
const WRITE_REDIRECT = /\d*>>?(?!>)(?!\s*(?:&[\d-]|\/dev\/null\b|["']?(?:\$\{?(?:TEMP|TMP|TMPDIR)\}?|\/tmp\/|%TEMP%|(?:out|local):\/\/)))/;

/**
 * Why a bash command is not allowed for the Captain during a run: test and build runners, and file writes.
 * Undefined when it may run.
 */
// ponytail: a pattern list, not a shell parser; it stops slips, not a determined workaround.
export function bashBlock(command: string): string | undefined {
	// Heredoc bodies are data; quoted strings are blanked, except a quoted redirect target.
	const cmd = command
		// The opener line stays (its redirect writes the file); only the body lines go.
		.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2(?=\n|$)/g, "<<HEREDOC$3")
		.replace(/(>>?\s*)?('[^']*'|"[^"]*")/g, (m, redir) => (redir ? m : '""'));
	if (RUNNER.test(cmd)) return "Strategium: the Captain runs no builds or test suites. Delegate the check to a sonic agent.";
	if (WRITE_WORD.test(cmd) || /\bsed\s+(-\w*i|--in-place)/.test(cmd) || /\bperl\s+-\w*i/.test(cmd) || WRITE_GIT.test(cmd) || WRITE_REDIRECT.test(cmd))
		return "Strategium: the Captain writes no files through bash during a run. Delegate the change to an agent; scratch output may only be redirected into $TEMP.";
	return undefined;
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

/** The footer line for a run: dot, planet, key, station, then its time or booking. */
function renderFooter(run: Run, evs: Ev[], running: boolean, el: number, bk: number): string {
	const key = run.key;
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
			? "new day: /strategium-resume"
			: `${stage} ${el}/${bk} min (${pct}%)${running ? "" : " paused"}`;
	// Where the run is: a seal waiting for the user (⏳, md-timer_sand F051F, in yellow), a return (↩, md-undo
	// F054C) or just the station. Codepoints checked in the Nerd Fonts glyphnames.json.
	const w = run.where;
	const where = !w
		? ""
		: w.seal
			? ` · \x1b[33m${nf ? "\u{f051f} " : "⏳"} seal ${w.seal}\x1b[39m`
			: ` · ${w.back ? (nf ? "\u{f054c}  " : "↩ ") : ""}${w.station}${w.task ? ` › ${w.task}` : ""}`;
	return `${dot}\x1b[39m ${planet} \x1b[38;5;248mstrategium: \x1b[39m${key}${where} · ${value}`;
}

export default function (pi: ExtensionAPI) {
	const z = pi.zod;
	// Set by the session handler; tool and command actions call it so the footer updates at once, not on the
	// next minute. It belongs to this instance: a module loaded twice would cross the sessions.
	let refreshFooter: (() => void) | undefined;
	// The latest session context and whether its timer runs: tick reads the session on every call, so a switch to a new session is followed.
	let live: SessionCtx | undefined;
	// omp switches sessions by mutating one SessionManager, so the previous id has to be kept as a string.
	let liveSid: string | undefined;
	// The session that asked for the open plan review, while it is open.
	let reviewSid: string | undefined;
	let timerSet = false;
	// /strategium-config notify on|off per session id; it wins over STRATEGIUM_NOTIFY (1, true, on, yes), which is off when unset.
	const notifyBySession = new Map<string, boolean>();
	const notifyOn = (sid: string) =>
		notifyBySession.get(sid) ?? /^(1|true|on|yes)$/i.test(process.env.STRATEGIUM_NOTIFY?.trim() ?? "");
	const notifyState = (sid: string) =>
		`${notifyOn(sid) ? "on" : "off"} (${notifyBySession.has(sid) ? "this session" : "STRATEGIUM_NOTIFY"})`;
	// /strategium-config archmagos on|off per session id; it wins over STRATEGIUM_ARCHMAGOS (1, true, on, yes), which is off when unset.
	const archmagosBySession = new Map<string, boolean>();
	const archmagosOn = (sid: string) =>
		archmagosBySession.get(sid) ?? /^(1|true|on|yes)$/i.test(process.env.STRATEGIUM_ARCHMAGOS?.trim() ?? "");
	const archmagosState = (sid: string) =>
		`${archmagosOn(sid) ? "on" : "off"} (${archmagosBySession.has(sid) ? "this session" : "STRATEGIUM_ARCHMAGOS"})`;
	// Minutes of idle before the clock pauses: /strategium-config idle <min> per session wins over STRATEGIUM_IDLE_MIN
	// (whole minutes; unset or invalid → 3; 0 = off).
	const idleBySession = new Map<string, number>();
	const idleMin = (sid: string) => {
		const env = process.env.STRATEGIUM_IDLE_MIN?.trim() ?? "";
		return idleBySession.get(sid) ?? (/^\d+$/.test(env) ? Number(env) : 3);
	};
	const idleState = (sid: string) => {
		const n = idleMin(sid);
		return `${n > 0 ? `${n} min` : "off"} (${idleBySession.has(sid) ? "this session" : "STRATEGIUM_IDLE_MIN"})`;
	};
	// When the main session last went idle (ms); tick counts from here. In memory only: a restart starts the count again.
	let idleSince: number | undefined;
	// A stop or start by hand spends the idle mark, so a later turn never resumes a run the user stopped. The idle count
	// restarts too: a stale agent_end time must not pause a run the user has just resumed.
	const spendIdle = (run: Run) => {
		idleSince = undefined;
		if (run.idle) writeRun({ ...run, idle: undefined });
	};
	/** Continue a paused run. The heartbeat is renewed so tick does not read the time since the last beat as a freeze. A timed run on a new day needs today's booking first and stays paused. */
	const resumeOrWarn = (run: Run, sid: string, ctx: SessionCtx): string | undefined => {
		try {
			const resumed = shift(run);
			beat(sid);
			return resumed;
		} catch (err) {
			ctx.ui.notify(
				err instanceof NewShift ? `Strategium: ${run.key} needs today's booking; /strategium-resume <min>` : `Strategium: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
	};
	/** The alarm, only when notifications are on for this session. */
	const alert = (sid: string, level: string, msg: string) => (notifyOn(sid) ? signal(level, msg) : undefined);

	const HIDDEN_TOOLS = ["edit", "ast_edit"];
	const bareName = (n: string) => n.replace(/^_+/, "");
	async function hideCaptainTools(): Promise<string[]> {
		const active = pi.getActiveTools();
		const hide = active.filter(n => HIDDEN_TOOLS.includes(bareName(n)));
		if (hide.length) await pi.setActiveTools(active.filter(n => !hide.includes(n)));
		return hide;
	}
	async function restoreTools(names?: string[]): Promise<void> {
		if (names?.length) await pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
	}

	/** End the session's run. When it was its own, the tools come back and the Strategium theme plays; a takeover end does neither. */
	async function finish(sid: string, ctx: SessionCtx, key?: string, takeover?: string): Promise<string> {
		const mine = ownRun(sid);
		const result = endRun(sid, key, takeover);
		if (mine && result === `ENDED ${mine.key}`) {
			await restoreTools(mine.hidden);
			const err = alert(sid, "theme", `${mine.key}: run ended`);
			if (err) ctx.ui.notify(`Strategium: ${err}`, "warning");
		}
		return result;
	}

	// Only the owning session alerts for its key, so each alert fires once.
	const maybeAlert = (ctx: SessionCtx, sid: string, file: string, evs: Ev[], key: string, now: Date, el: number, bk: number) => {
		const p = dueAlert(evs, key, now);
		if (p === undefined) return;
		append(file, { ts: nowIso(), event: "alert", key, p });
		ctx.ui.notify(`Strategium: ${p}% of the booking for ${key}`, p === 100 ? "warning" : "info");
		const alarmError = alert(sid, String(p), `${key}: ${p}% of the booking (${el}/${bk} min)`);
		if (alarmError) ctx.ui.notify(`Strategium: ${alarmError}`, "warning");
		pi.sendMessage(
			{ customType: "strategium-timer", content: `TIMER ${p}% ${key} ${el}/${bk} min`, display: true, attribution: "agent" },
			{ deliverAs: "aside", triggerTurn: true },
		);
	};
	const tick = () => {
		const ctx = live;
		if (!ctx) return;
		try {
			const sid = sidOf(ctx);
			const found = ownRun(sid);
			if (!found) return ctx.ui.setStatus("strategium", undefined);
			// A gap in our own heartbeats means the machine slept: close the block at the last beat and stay paused.
			// A session that was idle-counting is marked like the idle pause, so its next turn resumes the run.
			const counting = idleSince !== undefined;
			const gap = closeGap(found);
			if (gap) {
				if (counting) writeRun({ ...found, idle: true });
				const at = gap.slice(11, 16);
				ctx.ui.notify(
					`Strategium: ${found.key} paused at ${at}; this session was silent since then (sleep or freeze). ${counting ? "Your next prompt resumes it." : "/strategium-resume to continue."}`,
					"warning",
				);
				alert(sid, "attention", `${found.key}: paused at ${at} after a silent gap; resume when you are back`);
			}
			beat(sid);
			// Busy: the model is streaming (an `ask` waits for the user inside a stream), messages are queued, a background
			// job runs (agent_end can fire while one still does) or a plan review is open.
			// ponytail: an `ask` or review the user forgot keeps the clock counting; it sounds `attention` once, no timeout.
			// A background job that never ends (e.g. a bash watcher with timeout 0) keeps the session busy too, so the idle pause never fires.
			const busy = !ctx.isIdle() || ctx.hasPendingMessages() || (ctx.getAsyncJobSnapshot()?.running.length ?? 0) > 0 || !!ctx.getPendingPlanReview();
			let running = isOpen(found.key);
			const nowMs = Date.now();
			if (!running || busy) idleSince = undefined;
			else idleSince ??= nowMs;
			const limitMin = idleMin(sid);
			const limit = limitMin * 60_000;
			// ponytail: detection granularity is this tick (60 s); the stop is stamped at the exact idle threshold.
			if (running && limit > 0 && idleSince !== undefined && nowMs - idleSince >= limit) {
				stopKey(found.key, "idle", nowIso(new Date(idleSince + limit)));
				writeRun({ ...found, idle: true });
				idleSince = undefined;
				running = false;
				// No message into the session: a triggered turn would resume the clock at once.
				ctx.ui.notify(`Strategium: ${found.key} paused after ${limitMin} min idle; your next prompt resumes it`, "info");
				const err = alert(sid, "idle", `${found.key}: paused, idle ${limitMin} min`);
				if (err) ctx.ui.notify(`Strategium: ${err}`, "warning");
			}
			const file = today();
			const evs = load(file);
			const key = found.key;
			const now = new Date();
			const el = Math.floor(elapsedMin(evs, key, now));
			const bk = bookedMin(evs, key) ?? 0;
			ctx.ui.setStatus("strategium", renderFooter(found, evs, running, el, bk));
			// A paused run never alerts.
			if (running) maybeAlert(ctx, sid, file, evs, key, now, el, bk);
		} catch (err) {
			ctx.ui.notify(`Strategium timer: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	};
	pi.setLabel("Strategium");

	const schema = z.object({
		action: z.enum(["begin", "repo", "start", "stop", "add", "status", "report", "end", "attention", "notify", "slices", "redraft"]),
		key: z.string().optional(),
		booked: z.number().int().positive().optional(),
		spent: z.number().int().nonnegative().optional(),
		theatre: z.string().optional(),
		repo: z.string().optional(),
		date: z.string().optional(),
		takeover: z.string().optional(),
		message: z.string().optional(),
		minutes: z.number().int().optional(),
		on: z.boolean().optional(),
		archmagos: z.boolean().optional(),
		slices: z.array(z.object({ id: z.string(), parallel: z.boolean(), files: z.array(z.string()) })).optional(),
	});

	pi.registerTool({
		name: "strategium",
		label: "Strategium",
		description:
			"Strategium run state and booking timer, one run per omp session (other sessions may run other tickets in parallel). Actions: begin (key, booked?, spent?, theatre?, takeover?, archmagos?), repo (repo), start (booked?), stop, add (minutes), status, report (date?), end (key?, takeover?), attention (message), notify (on?), slices (slices), redraft. booked is optional: without it the run is untimed, its time is counted but there are no 50/80/100 % alerts and no new shifts. spent = minutes already worked on the key today that strategium has not tracked; they count toward the 50/80/100 % alerts. start resumes the run; on a new day it opens a new shift that counts from 0 (pass today's booked minutes; else the last booking is reused). add = a manual correction of today's time in whole minutes, negative to subtract. takeover = the id of a crashed session that holds the ticket, as given in the refusal; only the user decides that session is gone. attention plays the attention sound and shows a desktop notification with the message: use it whenever the user must act (a seal, a question, a blocker, a finished run). notify turns this session's sounds and desktop notifications on or off (on: true/false; without on it only reports the state); it wins over env STRATEGIUM_NOTIFY, which is off by default; set it only when the user asks. slices (slices: [{id, parallel, files}]: the plan's squads; parallel squads must not share a file; required before any battle-brother). A squad whose battle-brothers and veterans have all stopped (known when the task item's name is the squad id or its brief says build squad <id>) no longer counts: listing it again gives WARN lines before the result instead of an ERROR. No builder may start on files another running builder is changing. begin with archmagos: true marks the run for the Archmagos Dominus (false clears the mark; omitted keeps it); the plugin spawns one only when the setting is on, the run is marked and 2 librarians finished. status ends with the archmagos setting. redraft (no params) allows one more archmagos once per run, after an area's part was redrafted.",
		parameters: schema,
		async execute(_id, input, _signal, _onUpdate, ctx) {
			if (ctx?.agent?.kind === "sub") return text("ERROR strategium tool is for the main session only");
			const sid = sidOf(ctx);
			try {
				// The host validated input against `schema` before calling execute.
				const params = input as (typeof schema)["_output"];
				switch (params.action) {
					case "begin": {
						if (!params.key) throw new Error("begin needs key");
						begin(sid, params.key, params.theatre ?? "none", params.booked, params.spent, params.takeover);
						// A block start always restarts the idle count.
						idleSince = undefined;
						const run = ownRun(sid)!;
						const hid = await hideCaptainTools();
						writeRun({
							...run,
							hidden: [...new Set([...(run.hidden ?? []), ...hid])],
							// Omitted keeps what a same-key begin stored; false clears it.
							...(params.archmagos !== undefined ? { archmagos: params.archmagos || undefined } : {}),
						});
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
						spendIdle(run);
						return text(`${shift(run, params.booked)}\n${statusLines()}`);
					}
					case "stop": {
						const run = ownRun(sid);
						if (run) spendIdle(run);
						if (!run || !stopKey(run.key)) return text("IDLE");
						return text(`STOPPED ${run.key} ${Math.floor(elapsedMin(load(today()), run.key, new Date()))} min`);
					}
					case "add": {
						const run = ownRun(sid);
						if (!run) throw new Error("no active run in this session; use begin");
						return text(addMin(run, params.minutes ?? 0));
					}
					case "status":
						return text(`${fullStatus(sid)}\nARCHMAGOS ${archmagosState(sid)}`);
					case "report":
						return text(report(params.date));
					case "end":
						return text(await finish(sid, ctx, params.key, params.takeover));
					case "attention": {
						const key = ownRun(sid)?.key;
						const msg = params.message?.trim() || "Your attention is needed";
						const err = alert(sid, "attention", key ? `${key}: ${msg}` : msg);
						if (err) ctx.ui.notify(`Strategium: ${err}`, "warning");
						// A silent call makes no sound; say so, so the Captain does not count on it.
						const silent = !notifyOn(sid)
							? " (silent: notifications are off; /strategium-config notify on)"
							: process.env.STRATEGIUM_ALARM?.trim() ? "" : " (silent: STRATEGIUM_ALARM is not set; see /skill:strategium-setup)";
						return text(err ? `ERROR ${err}` : `ATTENTION ${msg}${silent}`);
					}
					case "notify": {
						if (params.on !== undefined) notifyBySession.set(sid, params.on);
						return text(`NOTIFY ${notifyState(sid)}`);
					}
					case "slices": {
						const run = ownRun(sid);
						if (!run) return text("ERROR no active run in this session");
						const slices: Slice[] = params.slices ?? [];
						const stopped = run.stopped ?? [];
						// Warnings come first, so the user reads them even when the list is refused.
						const lines = sliceWarnings(slices, stopped).map(w => `WARN ${w}`);
						const err = checkSlices(slices, stopped);
						if (err) return text([...lines, `ERROR ${err}`].join("\n"));
						const live = slices.filter(s => !stopped.some(d => d.id === s.id));
						writeRun({ ...run, slices: live, launched: undefined });
						lines.push(`SQUADS ${live.map(s => s.id + (s.parallel ? " (parallel)" : "")).join(", ") || "none"}`);
						return text(lines.join("\n"));
					}
					case "redraft": {
						const run = ownRun(sid);
						if (!run) return text("ERROR no active run in this session");
						if (run.redraft) return text(`ERROR the redraft of ${run.key} is spent (1 per run)`);
						writeRun({ ...run, redraft: true });
						return text(`REDRAFT ${run.key}: one more archmagos may be spawned`);
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
			// The objective: "free text" in quotes, @path to a spec or an approved plan, or a key (a ticket or a short name).
			// A theatre name may follow. Free text needs the quotes: unquoted words would read as a key and a theatre.
			const parsed = raw.match(/^"([^"]+)"(?:\s+(\S+))?$/) ?? raw.match(/^(\S+)(?:\s+(\S+))?$/);
			if (!parsed) {
				ctx.ui.notify(
					'Usage: /strategium <ticket | @file | "free text"> [theatre]; also /strategium-pause, -resume, -add, -status, -config, -end',
					"warning",
				);
				return;
			}
			const objective = raw.startsWith('"') ? `"${parsed[1]}"` : parsed[1];
			const theatre = (parsed[2] ?? process.env.STRATEGIUM_THEATRE ?? "none").replace(/^strategium-/, "");
			pi.sendUserMessage(
				theatre === "none"
					? `Read skill://strategium and run it for the objective ${objective} with no theatre.`
					: `Read skill://strategium and run it for the objective ${objective} with theatre skill://strategium-${theatre}.`,
			);
		},
	});

	/** One /strategium-<name> command: errors become a warning and the footer is redrawn after it. */
	const subcommand = (name: string, description: string, run: (arg: string | undefined, ctx: SessionCtx, sid: string) => unknown) =>
		pi.registerCommand(`strategium-${name}`, {
			description,
			handler: async (args, ctx) => {
				try {
					await run((args ?? "").trim() || undefined, ctx, sidOf(ctx));
				} catch (err) {
					ctx.ui.notify(`Strategium: ${err instanceof Error ? err.message : String(err)}`, "warning");
				} finally {
					refreshFooter?.();
				}
			},
		});

	subcommand("pause", "Stop this session's Strategium clock", (_arg, ctx, sid) => {
		const run = ownRun(sid);
		if (run) spendIdle(run);
		ctx.ui.notify(`Strategium: paused (${run && stopKey(run.key) ? run.key : "idle"})`, "info");
	});

	subcommand("resume", "Continue this session's Strategium run; on a new day pass today's booked minutes", (arg, ctx, sid) => {
		const run = ownRun(sid);
		if (!run) return ctx.ui.notify("Strategium: no active run in this session", "warning");
		spendIdle(run);
		const bk = arg === undefined ? undefined : Number(arg);
		if (bk !== undefined && !(Number.isInteger(bk) && bk > 0))
			throw new Error("resume takes the booked minutes as a whole number, e.g. /strategium-resume 240");
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
	});

	subcommand("add", "Correct today's time of this session's run in minutes (negative to subtract)", (arg, ctx, sid) => {
		const run = ownRun(sid);
		if (!run) return ctx.ui.notify("Strategium: no active run in this session", "warning");
		ctx.ui.notify(`Strategium: ${addMin(run, Number(arg))}`, "info");
	});

	subcommand("status", "Every Strategium run and its time", (_arg, ctx, sid) => ctx.ui.notify(fullStatus(sid), "info"));

	subcommand("config", "Show the Strategium settings; notify on|off sets this session's sounds and notifications; idle <min> sets the idle pause; archmagos on|off lets runs use the Archmagos Dominus", (arg, ctx, sid) => {
		if (arg !== undefined) {
			const m = arg.match(/^notify\s+(on|off)$/);
			const i = arg.match(/^idle\s+(\d+)$/);
			const a = arg.match(/^archmagos\s+(on|off)$/);
			if (!m && !i && !a) throw new Error("config takes notify on|off or idle <min>, or archmagos on|off; the other settings live in ~/.omp/agent/.env (/skill:strategium-setup)");
			if (m) notifyBySession.set(sid, m[1] === "on");
			else if (a) archmagosBySession.set(sid, a[1] === "on");
			else idleBySession.set(sid, Number(i![1]));
		}
		const env = (k: string) => process.env[k]?.trim() || "not set";
		ctx.ui.notify(
			[
				"Strategium config",
				`notify: ${notifyState(sid)}`,
				`idle: ${idleState(sid)}`,
				`archmagos: ${archmagosState(sid)}`,
				`theatre: ${env("STRATEGIUM_THEATRE")}`,
				`alarm: ${env("STRATEGIUM_ALARM")}`,
				`glyphs: ${process.env.STRATEGIUM_GLYPHS === "1" ? "on" : "off"}`,
				`state: ${stateDir()}`,
			].join("\n"),
			"info",
		);
	});

	subcommand("end", "Close this session's Strategium run", async (_arg, ctx, sid) => {
		ctx.ui.notify(await finish(sid, ctx), "info");
		// undefined removes the line; "" would leave an empty one under the other plugins' lines.
		ctx.ui.setStatus("strategium", undefined);
	});

	const onSession = async (e: { type: string; reason?: string }, ctx: SessionCtx) => {
		if (ctx.agent?.kind === "sub") return;
		// omp emits session_switch, not session_start, for a session opened in the same process: follow the latest one.
		const prevSid = liveSid;
		live = ctx;
		const sid = sidOf(ctx);
		liveSid = sid;
		// The mark is spent by the first switch after the review closed.
		const reviewed = reviewSid;
		reviewSid = undefined;
		// The fresh session of an approved plan takes over the run of the session that asked for the review.
		if (e.reason === "new" && prevSid && prevSid === reviewed && prevSid !== sid && !readRun(sid)) {
			const moved = ownRun(prevSid);
			if (moved) {
				try {
					claim(stateDir(), moved.key, sid, prevSid);
					// omp cancelled the old session's background agents: none runs any more.
					writeRun(settle({ ...moved, sid }, {}, Object.values(moved.agents ?? {})));
					rmSync(runFile(prevSid), { force: true });
					rmSync(beatFile(prevSid), { force: true });
					beat(sid);
					const n = notifyBySession.get(prevSid);
					if (n !== undefined) notifyBySession.set(sid, n);
					const idle = idleBySession.get(prevSid);
					if (idle !== undefined) idleBySession.set(sid, idle);
					const arch = archmagosBySession.get(prevSid);
					if (arch !== undefined) archmagosBySession.set(sid, arch);
				} catch {
					// Another session took the key meanwhile: the run stays where it is.
				}
			}
		}
		// A session without a run does not inherit the previous session's hidden tools.
		if (prevSid && prevSid !== sid && !readRun(sid)) await restoreTools(readRun(prevSid)?.hidden);
		// A resumed session takes its ticket back, unless another session claimed it meanwhile.
		const own = readRun(sid);
		let held = false;
		if (own) {
			// Reopened after a crash or kill: the time it was gone is not work.
			const died = closeGap(own) !== undefined;
			try {
				claim(stateDir(), own.key, sid);
				held = true;
			} catch {
				rmSync(runFile(sid), { force: true });
				rmSync(beatFile(sid), { force: true });
			}
			// A reload closes the session and opens it again; the run goes on by itself, across days too. A run the
			// user stopped carries no mark and stays paused. The heartbeat is renewed so tick does not read the gap
			// as a freeze. The mark is spent on every path.
			if (held) {
				const resume = died || own.closedBy === "shutdown";
				if (own.closedBy) writeRun({ ...own, closedBy: undefined });
				if (resume) resumeOrWarn(own, sid, ctx);
			}
		}
		refreshFooter = tick;
		if (!timerSet) {
			timerSet = true;
			ctx.setInterval(tick, 60_000);
		}
		idleSince = undefined;
		tick();
		// A run that is still ours keeps the editing tools hidden after a restart.
		// ponytail: a session whose run is taken over keeps the tools hidden until it restarts.
		if (held && own?.hidden?.length) await pi.setActiveTools(pi.getActiveTools().filter(n => !own.hidden!.includes(n)));
	};
	pi.on("session_start", onSession);
	pi.on("session_switch", onSession);

	// An approved plan opens a fresh session (reason "new", no shutdown of the old one); the run follows it only then.
	pi.on("plan_review_requested", (e, ctx) => {
		if (ctx?.agent?.kind === "sub") return;
		const run = ownRun(e.sessionId);
		reviewSid = run ? e.sessionId : undefined;
		// The user is called now: the review keeps the clock counting (it is busy), so the attention alarm replaces the idle one.
		if (!run) return;
		const err = alert(e.sessionId, "attention", `${run.key}: your plan review is waiting`);
		if (err) ctx.ui.notify(`Strategium: ${err}`, "warning");
	});
	// Every turn, whoever started it (before_agent_start fires only for typed prompts): the idle count restarts and an
	// idle-paused run continues. A run paused by hand carries no mark and stays paused.
	pi.on("agent_start", (_e, ctx) => {
		if (ctx?.agent?.kind === "sub") return;
		idleSince = undefined;
		const run = ownRun(sidOf(ctx));
		if (run?.idle) {
			writeRun({ ...run, idle: undefined });
			if (!isOpen(run.key)) {
				const resumed = resumeOrWarn(run, sidOf(ctx), ctx);
				if (resumed) ctx.ui.notify(`Strategium: ${resumed}`, "info");
			}
		}
		refreshFooter?.();
	});
	// The turn ended: the idle minutes count from here (tick restarts the count if something is still busy).
	pi.on("agent_end", (_e, ctx) => {
		if (ctx?.agent?.kind === "sub") return;
		idleSince = Date.now();
	});
	// "Approve and execute" closes the review before the new session exists, so its mark stays until the switch
	// (onSession spends it); omp restores the plan-mode tool set only after that, see before_agent_start. Any other
	// choice stays in this session: omp has restored the tools by now, hide the editing tools again.
	pi.on("plan_review_resolved", async (e, ctx) => {
		if (ctx?.agent?.kind === "sub") return;
		if (e.choice === "execute") return;
		reviewSid = undefined;
		const run = ownRun(sidOf(ctx));
		if (!run) return;
		const hid = await hideCaptainTools();
		writeRun({ ...run, hidden: [...new Set([...(run.hidden ?? []), ...hid])] });
	});
	// The first turn of an approved plan starts after omp's last tool restore: hide the editing tools once more.
	// A mark still open here means no new session came, so a later /new must not move the run.
	pi.on("before_agent_start", async (_e, ctx) => {
		if (ctx?.agent?.kind === "sub") return;
		reviewSid = undefined;
		if (ownRun(sidOf(ctx))?.hidden?.length) await hideCaptainTools();
	});
	// One line at startup, like other plugins print, so the user sees the plugin is on and how it is set.
	pi.on("session_start", (_e: unknown, ctx: SessionCtx) => {
		if (ctx.agent?.kind === "sub") return;
		const theatre = process.env.STRATEGIUM_THEATRE?.trim().replace(/^strategium-/, "") || "none";
		ctx.ui.notify(`Strategium loaded: theatre ${theatre}, notifications ${notifyOn(sidOf(ctx)) ? "on" : "off"}`, "info");
	});

	// Closing the session pauses its ticket and releases the claim; the run file stays so a resumed session
	// (or another session's `begin`, which adopts its repo) picks it up.
	pi.on("session_shutdown", (_e, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		refreshFooter = undefined;
		live = undefined;
		liveSid = undefined;
		timerSet = false;
		const sid = sidOf(ctx);
		const run = ownRun(sid);
		if (!run) return;
		// Marked on the run, not read from a day file: a reload after midnight resumes too. A run the user had stopped is not marked.
		const stopped = stopKey(run.key, "shutdown");
		release(stateDir(), run.key, sid);
		if (stopped) writeRun({ ...run, closedBy: "shutdown" });
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

	// The Captain's roster: during a run only these agents may be spawned, and no battle-brother before the squads.
	// The archmagos has four more guards, in order: setting, mark, 2 finished librarians, budget.
	pi.on("before_subagent_spawn", (e, ctx) => {
		if (ctx?.agent?.kind === "sub" || !ctx?.sessionManager) return;
		const sid = sidOf(ctx);
		const run = ownRun(sid);
		if (!run) return;
		const agent = agentName(String(asObj(e).agent ?? "task"));
		if (!ROSTER.includes(agent)) return { block: true, reason: `Strategium: during a run only these agents may be spawned: ${ROSTER.join(", ")}.` };
		if (agent === "archmagos") {
			if (!archmagosOn(sid)) return { block: true, reason: ARCHMAGOS_OFF };
			if (!run.archmagos) return { block: true, reason: ARCHMAGOS_UNMARKED };
			const done = Object.values(run.librarians ?? {}).filter(v => v === "done").length;
			if (done < 2) return { block: true, reason: archmagosWaits(done) };
			const spawned = run.archmagosSpawned ?? 0;
			if (spawned >= (run.redraft ? 2 : 1)) return { block: true, reason: run.redraft ? ARCHMAGOS_SPENT : ARCHMAGOS_AGAIN };
			// ponytail: counted here, once per real child (a write agent://<id> follow-up never fires this hook); a dispatch that
			// fails after it, or a later extension's block, still spends the budget: redraft or the user is the way out.
			writeRun({ ...run, archmagosSpawned: spawned + 1 });
			return;
		}
		if (agent === "battle-brother" && run.repo && !run.slices) return { block: true, reason: SLICES_REASON };
	});

	// The host gives no event when an agent ends; its result reaches the model as a message or a wait result that lists
	// the background jobs, labelled with the agent id. A builder that is no longer running leaves its squad; the squad
	// counts as stopped once none of its agents runs. An id ends once: an old message in the history matches nothing.
	// A running librarian whose job completed counts as done for the archmagos guard (failed or cancelled never do).
	pi.on("context", (e, ctx) => {
		if (ctx?.agent?.kind === "sub" || !ctx?.sessionManager) return;
		const run = ownRun(sidOf(ctx));
		if (!run) return;
		const messages = asObj(e).messages;
		let next: Run = run;
		const finished = endedAgents(messages, "completed").filter(id => run.librarians?.[id] === "running");
		if (finished.length) next = { ...next, librarians: { ...run.librarians, ...Object.fromEntries(finished.map(id => [id, "done" as const])) } };
		const ended = run.agents ? endedAgents(messages).filter(id => run.agents![id]) : [];
		if (ended.length) {
			const agents = { ...run.agents };
			for (const id of ended) delete agents[id];
			next = settle(next, agents, ended.map(id => run.agents![id]));
		}
		if (next !== run) writeRun(next);
	});

	// A task result gives the id the host allocated to each item, with its index in the call. A builder's id is bound to the
	// squad the item builds (ids are unique, so a reused name or two agents on one squad never share an entry); a
	// librarian's id is tracked for the archmagos guard, whether or not squads exist.
	pi.on("tool_result", (e, ctx) => {
		if (ctx?.agent?.kind === "sub" || !ctx?.sessionManager || e.toolName.replace(/^_+/, "") !== "task") return;
		const run = ownRun(sidOf(ctx));
		const progress = asObj(e.details).progress;
		if (!run || !Array.isArray(progress)) return;
		const items = taskItems(e.input);
		const agents = { ...run.agents };
		const librarians = { ...run.librarians };
		const launched: Slice[] = [];
		let tracked = false;
		for (const p of progress.map(asObj)) {
			const item = typeof p.index === "number" ? items[p.index] : undefined;
			if (!item || typeof p.id !== "string") continue;
			if (agentName(String(item.agent ?? "task")) === "librarian") {
				if (p.status === "completed") librarians[p.id] = "done";
				else if (p.status === "pending" || p.status === "running") librarians[p.id] ??= "running";
				else continue;
				tracked = true;
				continue;
			}
			const slice = builtSlice(item, run);
			if (!slice) continue;
			launched.push(slice);
			// A blocking call returns once its agents are done: those never count as running.
			if (p.status === "pending" || p.status === "running") agents[p.id] = slice;
		}
		let next: Run = run;
		if (launched.length) next = settle(next, agents, launched);
		if (tracked) next = { ...next, librarians };
		if (next !== run) writeRun(next);
	});

	// ponytail: bash is a pattern list (see bashBlock); the edit tools are hidden and write/edit targets are checked below.
	pi.on("tool_call", (e, ctx) => {
		if (ctx?.agent?.kind === "sub") return;
		const run = ownRun(sidOf(ctx));
		const name = e.toolName.replace(/^_+/, "");
		// A question to the user during a run needs them at the keyboard, wherever they are.
		if (name === "ask" && run) {
			const err = alert(sidOf(ctx), "attention", `${run.key}: your answer is needed`);
			if (err) ctx.ui.notify(`Strategium: ${err}`, "warning");
		}
		if (!run?.repo) return;
		const repo = run.repo;
		if (name === "ast_edit") return { block: true, reason: CAPTAIN_REASON };
		if (name === "bash") {
			const why = bashBlock(String(asObj(e.input).command ?? ""));
			if (why) return { block: true, reason: why };
		}
		if (name === "task") {
			const items = taskItems(e.input);
			const n = items.filter(item => agentName(String(item.agent ?? "task")) === "battle-brother").length;
			if (n > 0 && !run.slices) return { block: true, reason: SLICES_REASON };
			// No builder may start on files an agent is already changing: one still running, or another in this call.
			// A running squad is compared with its files as last declared.
			const busy = Object.values(run.agents ?? {}).map(s => run.slices?.find(l => l.id === s.id) ?? s);
			const starting: Slice[] = [];
			for (const item of items) {
				const slice = builtSlice(item, run);
				if (!slice) continue;
				const clash = [...busy, ...starting].find(other => sharedFiles(slice, other).length);
				if (clash)
					return {
						block: true,
						reason:
							`Strategium: squad ${slice.id} changes ${sharedFiles(slice, clash).join(", ")}, which ` +
							(clash.id === slice.id ? "another agent for the same squad" : `squad ${clash.id}`) +
							" is changing right now. Two agents working on the same file at the same time overwrite each other's changes. " +
							"Wait until that agent has finished, then launch this one.",
					};
				starting.push(slice);
			}
			if (n > 0 && !run.launched) {
				const par = run.slices!.filter(s => s.parallel).map(s => s.id);
				if (par.length >= 2 && n < par.length)
					return { block: true, reason: `Strategium: launch every parallel squad (${par.join(", ")}) in one task call; this call has ${n} battle-brother(s).` };
				writeRun({ ...run, launched: true });
			}
		}
		const targets = editTargets(name, asObj(e.input));
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
