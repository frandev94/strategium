import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { completeSimple as completeSimpleFn } from "@oh-my-pi/pi-ai";
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
	isVia,
	load,
	nowIso,
	openKeys,
	overlapMin,
	overlaps as overlapIntervals,
	poolOf,
	splitMin,
	release,
	safeName,
	VIA_REASONS,
	viaOf,
	writeAtomic,
	type Ev,
	type Via,
} from "./timer";
import { debrief, type AgentCost, type Reported } from "./debrief";
import { answer, missionFacts, servoSkullFacts, chars, due, parseAlias, parseEvery, stateHash, summarize, type Complete, type ServoSkullReply } from "./servo-skull";
import { volume } from "../../alarm/vox";
import { childEnv } from "./env";
import { activeStation, briefRow, CHRONICLE_CAP, clean, cockpitKey as keyAction, cockpitView, colorDepth, FINAL_STATUSES, grantedSeals, icons, isCost, jobEnds, navigate, oneLine, palette, pushEntry, RATINGS, renderCockpit, renderDebrief, transcriptLines, waitingSeal, type Deployed, type Entry, type Live, type Nav, type Note, type Rating, type View, type ViewInput } from "./cockpit";
import { allocateName, baseId, MAX_NAME, NAMED_AGENTS, type NameEntry } from "./names";
import { applyRun, corrupted, type Brothers, type Honour, honours, loadRoster, rankBrothers, runOutcomes, squadBrothers, STALE_MS, unfinished, updateRoster, withRosterLock } from "./roster";
import { loadContract, noteTarget, recordLine, recordNote, secretKind } from "./vault";
import { addResults, loadTally, proposals, squadKind, tallyLines, updateTally } from "./tally";
import { DEFAULT_THEME, isTheme, THEMES, type ThemeName } from "./themes";

// One run per omp session: each session owns one ticket, its edit guard and its alerts.
// Several sessions can run different tickets at the same time; the day file holds them all.
// Ownership of a ticket is an atomic claim file (see claim() in timer.ts), held while the session lives.
// `untimed`: the run has no booking until a `begin` or `start` with booked. Its time is counted, but there are no alerts, no stand down and no new shift.
// `where`: the station the run is at, read from the todo (see whereFrom), so the footer shows it after a restart too.
type Where = { station: string; back?: true; seal?: string; task?: string };
type Tier = "light" | "standard" | "heavy";
type Slice = { id: string; parallel: boolean; files: string[]; tier?: Tier };
// `hidden`: the tools hidden from the Captain for this run, put back when it ends. `slices`: the plan's squads as declared.
// `launched`: the parallel squads went out together in one task call.
// `agents`: the running battle-brothers and veterans, by the agent id the host allocated → the squad each builds.
// `stopped`: squads whose agents have all ended (finished, failed or cancelled) and that no agent builds again yet.
// `closedBy`: the session closed with the run going, so the next session resumes it.
// `idle`: the clock was stopped by the idle pause; the next turn of the session resumes it.
// `archmagos`: Muster marked the run for the Archmagos Dominus (begin archmagos: true). `librarians`: this run's librarians by
// agent id, running or done (finished completed; a failed or cancelled one never counts). `archmagosSpawned`: archmagos
// spawns let through. `redraft`: the run's one redraft (both plan paths): one more archmagos may spawn, and no librarian or
// archmagos spawns until a scout in `scouts` is done. `scouts`: the scouts spawned after the redraft, by agent id, running
// or done (finished completed). `builds`: the battle-brother spawns per squad id; the second runs one tier up (see tierFor).
// `phases`: the todo as last seen, so the cockpit boxes and seals come back after a restart.
// `since`: local ISO time of the run's first begin (kept by a same-key begin and a takeover); the debrief reads the key's day-file events from then on. Absent: the run began before it was stored.
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
	scouts?: Record<string, "running" | "done">;
	archmagosSpawned?: number;
	redraft?: true;
	builds?: Record<string, number>;
	names?: NameEntry[];
	// `ended`: how each squad's latest builder ended (a new builder of the squad clears it); `merged`: the Captain's own gh pr merge / glab mr merge came back clean. Both only with names on: they feed the roster at `end`.
	ended?: Record<string, "ok" | "failed">;
	merged?: true;
	phases?: Phase[];
	since?: string;
	ratings?: Record<string, Rating>; // agent id → the Captain's rating (the rate action); read through cleanRatings
	recorded?: string[]; // vault event ids already attempted (begin, seal:<id>, pr), so a replay or restart adds no second daily line; read through cleanRecorded
};
type Tui = { requestRender(): void; terminal: { rows: number } };
type Component = { render(width: number): string[]; handleInput?(data: string): void; invalidate?(): void; dispose?(): void };
// What the extension reads from the host's session context: the real one has more.
// `hasUI` and the optional ui calls are absent with --no-ui or in headless modes; RPC has them, but its custom() resolves at once without building the component.
type SessionCtx = {
	sessionManager: { getSessionId(): string; getSessionFile?(): string | undefined };
	hasUI?: boolean;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error"): void;
		setStatus(key: string, value: string | undefined): void;
		custom?(factory: (tui: Tui, theme: unknown, keybindings: unknown, done: (result?: unknown) => void) => Component, options?: { overlay?: boolean; overlayOptions?: object }): unknown;
	};
	setInterval(fn: () => void, ms: number): unknown;
	// The host's model APIs, used by the cockpit servo-skull; a host without them leaves the servo-skull with a reason row.
	models?: { resolve?(spec: string): HostModel | undefined };
	modelRegistry?: { hasConfiguredAuth?(model: HostModel): boolean; resolver?(model: HostModel, sessionId: string): NonNullable<Parameters<CompleteSimple>[2]>["apiKey"] };
	agent?: { kind?: string; id?: string };
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
	const sealId = waitingSeal(phases)?.id;
	const sealChars = [...clean(sealId ?? "")];
	const seal = sealId === undefined ? undefined : sealChars.length > 32 ? `${sealChars.slice(0, 31).join("")}…` : sealChars.join("");
	const back = phases.slice(i + 1).some(p => p.tasks.some(t => t.status === "completed"));
	// A seal keeps its own form. Other tasks show their text without the agent tag (`[agent] ` or `<glyph> agent · `), cut at 32.
	const text = seal ? "" : task.content.replace(/^\s*(?:\[[\w-]+\]|[^\w\s[]+\s*[\w-]+\s*·)\s*/u, "").trim();
	const chars = [...text];
	const short = chars.length > 32 ? `${chars.slice(0, 31).join("")}…` : text;
	return { station: phases[i].name, ...(back ? { back: true as const } : {}), ...(seal ? { seal } : {}), ...(short ? { task: short } : {}) };
}

const STATION_ORDER = ["Muster", "Auspex", "Scriptorium", "Deployment", "Skirmish", "Inquisition", "Extraction", "Debrief"];

/** The plan-mode hand-off: a non-empty init that shares no station with the phases it replaces and starts after their last one in the skeleton order. An unknown station is no hand-off. */
const isHandOff = (op: string | undefined, before: Phase[] | undefined, after: Phase[] | undefined): before is Phase[] => {
	if (op !== "init" || !before?.length || !after?.length || after.some(p => before.some(b => b.name === p.name))) return false;
	const at = (p: Phase) => STATION_ORDER.indexOf(p.name);
	const last = Math.max(...before.map(at));
	return before.every(p => at(p) >= 0) && at(after[0]) > last;
};

/** Any other non-empty init over existing phases (compaction, reverse init) re-creates the todo: omp's auto-start there is not progress, and it grants nothing. An empty init is ignored. */
const isRebuild = (op: string | undefined, before: Phase[] | undefined, after: Phase[] | undefined) =>
	op === "init" && !!before?.length && !isHandOff(op, before, after);

/**
 * The run's KEY from the objective as /strategium parsed it: a key as given, a `@file`'s base name, or the first words of "free text".
 * A key as given passes through verbatim (any text without spaces; timer.lockPath sanitises it for the lock file). A `@file` or "free text" gives
 * `[a-z0-9]+(-[a-z0-9]+)*`, at most 32 characters; `objective` when nothing usable is left.
 */
export function keyOf(objective: string): string {
	const file = objective.startsWith("@");
	if (!file && !objective.startsWith('"')) return objective;
	const text = file ? (objective.slice(1).split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "") : objective;
	const words = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	let slug = "";
	for (const w of words.slice(0, 4)) {
		const next = slug ? `${slug}-${w}` : w;
		if (next.length > 32) break;
		slug = next;
	}
	return slug || words[0]?.slice(0, 32) || "objective";
}

// Read on every use: the environment can change it, and a test points it somewhere of its own.
const stateDir = () => process.env.STRATEGIUM_STATE_DIR || path.join(homedir(), ".omp", "agent", "state", "strategium");
const runsDir = () => path.join(stateDir(), "runs");
const CAPTAIN_REASON =
	"Strategium: the Captain does not edit repository files. Delegate this change to a battle-brother agent.";

/** A run event in today's file. The debrief is secondary: a failed write must not break the hook that records it. */
const record = (ev: Omit<Ev, "ts">) => {
	try {
		append(today(), { ts: nowIso(), ...ev });
	} catch {
		// The debrief shows what was recorded.
	}
};
const today = () => dayFile(stateDir(), new Date());
const runFile = (sid: string) => path.join(runsDir(), `${sid}.json`);
// The session's heartbeat (local ISO time), rewritten every minute while it lives; see closeGap.
const beatFile = (sid: string) => path.join(runsDir(), `${sid}.beat`);
// The cockpit's chronicle, agent registry and squad marks, saved beside the run (not in it: see drawCockpit).
const cockpitFile = (sid: string) => path.join(runsDir(), `${sid}.cockpit`);
/** What the cockpit servo-skull spent in a run: omp's list price, the calls that came back with a reply (a failed or aborted one included, a throw is not), and tokens as an agent counts them (input only; cache reads and writes apart), and the model the alias last resolved to. */
type Spend = { cost: number; calls: number; tokens_in: number; tokens_out: number; cache_read: number; cache_write: number; model?: string };
/** The servo-skull's memory for the run key: the summary shown, when the last attempt started, and the call in flight. */
type ServoSkullState = { text?: string; dim?: boolean; station?: string; at?: number; lastAt?: number; lastHash?: string; ctrl?: AbortController; spend?: Spend; ask?: AbortController; answer?: { question: string; text: string; at: number } }; // ask: the user's question in flight; answer: the last one, shown in the box until a summary replaces it
/** completeSimple of @oh-my-pi/pi-ai: the test seam; the real one is imported on the first call. */
type CompleteSimple = typeof completeSimpleFn;
type HostModel = Parameters<CompleteSimple>[0];
/** A saved spend, or none for anything that is not one (the file may be hand-edited). */
const servoSkullSpend = (v: unknown): Spend | undefined => {
	const o = asObj(v);
	const n = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
	return isCost(o.cost) && n(o.calls) && o.calls > 0 && n(o.tokens_in) && n(o.tokens_out) && n(o.cache_read) && n(o.cache_write)
		? { cost: o.cost, calls: o.calls, tokens_in: o.tokens_in, tokens_out: o.tokens_out, cache_read: o.cache_read, cache_write: o.cache_write, ...(typeof o.model === "string" && o.model ? { model: chars(oneLine(o.model), 40) } : {}) }
		: undefined;
};
// A cockpit file saved before the rename holds the spend as `caster`.
const savedServoSkull = (o: Record<string, unknown>) => o["servo-skull"] ?? o.caster;
const savedSpend = (sid: string): Spend | undefined => {
	try {
		return servoSkullSpend(savedServoSkull(asObj(JSON.parse(readFileSync(cockpitFile(sid), "utf8")))));
	} catch {
		return undefined; // no saved cockpit
	}
};
// What each subagent writes about itself, one file per agent id, and the pointer that tells a child (same pid) which session to write for.
const liveDir = (sid: string) => path.join(runsDir(), `${sid}.live`);
const pidFile = () => path.join(runsDir(), `${process.pid}.pid`);
/** Remove everything a session left for its run. */
const dropFiles = (sid: string) => {
	// A file that cannot go (Windows holds one while a scanner reads it) must not keep the others, nor throw: leftovers without a run file are inert.
	const drop = (f: string, opts?: { recursive: true; maxRetries: number }) => {
		try {
			rmSync(f, { force: true, ...opts });
		} catch {
			// Left behind.
		}
	};
	for (const f of [runFile(sid), beatFile(sid), cockpitFile(sid)]) drop(f);
	drop(liveDir(sid), { recursive: true, maxRetries: 3 });
};
/** Remove this process's pointer: always, or only when it names `only`. */
const dropPointer = (only?: string) => {
	try {
		if (only === undefined || readFileSync(pidFile(), "utf8").trim() === only) rmSync(pidFile(), { force: true });
	} catch {
		// No pointer.
	}
};
/** Remove the pointers (of any process) that name a session with no run file: a crash left them. */
const sweepPointers = () => {
	try {
		for (const f of readdirSync(runsDir()).filter(f => f.endsWith(".pid"))) {
			const sid = readFileSync(path.join(runsDir(), f), "utf8").trim();
			if (!existsSync(runFile(sid))) rmSync(path.join(runsDir(), f), { force: true });
		}
	} catch {
		// Stale pointers are inert anyway.
	}
};
/** A live row's file in a session's `.live` dir; the agent id is encoded, it is not a path. */
const liveFile = (sid: string, id: string) => path.join(liveDir(sid), `${encodeURIComponent(id).replaceAll("*", "%2A")}.json`); // encodeURIComponent already encodes <>:"|? but leaves `*`, which Windows refuses in a file name
const LIVE_BYTES = 4096; // a live file is a few hundred bytes; a bigger one is not ours
const LIVE_TEXT = 200;
const STALL_MS = 5 * 60_000; // no tool call in flight and none ended for this long
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/** What an agent wrote about itself (contract v3: `since` and `at` in ms; `busy` the tool calls in flight; the rest as `Live`, which v1 and v2 files lack). The file is untrusted: anything of another shape is undefined. */
function readLive(sid: string, id: string): (Live & { busy?: number }) | undefined {
	try {
		const f = liveFile(sid, id);
		if (statSync(f).size > LIVE_BYTES) return undefined;
		const v = JSON.parse(readFileSync(f, "utf8"));
		if (!v || typeof v !== "object" || !isCount(v.since) || !isCount(v.at)) return undefined;
		if (["busy", "done", "total", "eta_min"].some(k => v[k] !== undefined && !isCount(v[k]))) return undefined;
		if (v.pct !== undefined && (!isCount(v.pct) || v.pct > 100)) return undefined;
		if (["tokens_in", "tokens_out", "cache_read", "cache_write"].some(k => v[k] !== undefined && !isCount(v[k]))) return undefined;
		if (v.cost !== undefined && !isCost(v.cost)) return undefined;
		if (["tool", "intent", "current", "line"].some(k => v[k] !== undefined && typeof v[k] !== "string")) return undefined;
		if (v.blocked !== undefined && typeof v.blocked !== "boolean") return undefined;
		return v;
	} catch {
		return undefined;
	}
}

/** Every readable live row of a run, by agent id; rows older than the run are an earlier key's in the same session. A damaged name or file is skipped. */
function liveRows(run: Run): Map<string, Live> {
	const rows = new Map<string, Live>();
	const since = Date.parse(run.since ?? "");
	try {
		for (const f of readdirSync(liveDir(run.sid))) {
			if (!f.endsWith(".json")) continue;
			try {
				const id = decodeURIComponent(f.slice(0, -5));
				const row = readLive(run.sid, id);
				if (row && !(row.since < since)) rows.set(id, row);
			} catch {
				// A name that does not decode is not an agent id.
			}
		}
	} catch {
		// No live dir: no agent wrote one.
	}
	return rows;
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

const TAIL_BYTES = 512 * 1024; // the newest part of a child's .jsonl the cockpit reads
const FINAL_BYTES = 64 * 1024; // the head of its final answer (.md)
const HEAD_CHUNK = 64 * 1024; // read size while looking for the agent's brief in the head of a cut log
const HEAD_BYTES = 512 * 1024; // how far into the log that look goes (session_init and skill prompts come first)
type TranscriptRead = { id: string; stamp: string; lines: string[] };
const NOT_FILE = Object.assign(new Error("not a regular file"), { code: "not a regular file" });
/** A regular file opened for reading, with the size and mtime of the open handle; undefined when absent. A link, directory or FIFO seen by lstat throws before any open. Not race-proof: a link swapped in between the lstat and the open is followed, and the fstat only confirms that what was opened is a regular file. */
function openRegular(file: string): { fd: number; size: number; mtimeMs: number } | undefined {
	const l = lstatSync(file, { throwIfNoEntry: false });
	if (!l) return undefined;
	if (!l.isFile()) throw NOT_FILE;
	const fd = openSync(file, "r");
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw NOT_FILE;
		return { fd, size: st.size, mtimeMs: st.mtimeMs };
	} catch (e) {
		closeSync(fd);
		throw e;
	}
}
/** Up to `len` bytes of the open file from `from`. */
function readSlice(fd: number, from: number, len: number): string {
	const buf = Buffer.allocUnsafe(len);
	return buf.toString("utf8", 0, readSync(fd, buf, 0, len, from));
}
/** The brief row of the log's first `limit` bytes, read in HEAD_CHUNK pieces up to the first complete `user` message (a line is parsed only once whole, and only once). */
function headBrief(fd: number, limit: number): string | undefined {
	let buf = Buffer.alloc(0);
	let from = 0;
	while (buf.length < limit) {
		const chunk = Buffer.allocUnsafe(Math.min(HEAD_CHUNK, limit - buf.length));
		const n = readSync(fd, chunk, 0, chunk.length, buf.length);
		if (n <= 0) break;
		buf = Buffer.concat([buf, chunk.subarray(0, n)]);
		const nl = buf.lastIndexOf(10);
		if (nl < from) continue;
		const row = briefRow(buf.toString("utf8", from, nl + 1));
		if (row !== undefined) return row;
		from = nl + 1;
	}
	return undefined;
}
/**
 * The rows of agent `id`'s transcript, from `<session file minus .jsonl>/<id>.jsonl` (omp writes a child's files beside its parent's) and, when `finished`, its `<id>.md`.
 * The id is checked before it becomes a path (a `.` is a nested agent, never read); only a regular file is opened, and its own handle is stat'ed. Bounded: the last TAIL_BYTES of the log, the first FINAL_BYTES of the answer.
 * `prev` is returned as is while both files keep their size and mtime. Never throws: a problem is one reason row.
 */
export function readTranscript(sessionFile: string | undefined, id: string, finished: boolean, prev?: TranscriptRead): TranscriptRead {
	const reason = (r: string): TranscriptRead => ({ id, stamp: r, lines: [r] });
	if (id.includes(".")) return reason(`${id}: a nested agent; its transcript is not read`);
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return reason(`${id}: not a transcript id`);
	if (!sessionFile?.endsWith(".jsonl")) return reason("no session file: this session is not saved, so its agents' transcripts are not either");
	const base = `${sessionFile.slice(0, -6)}/${id}`;
	const fds: number[] = [];
	try {
		const log = openRegular(`${base}.jsonl`);
		if (!log) return reason("no transcript yet: omp writes it after the agent's first reply");
		fds.push(log.fd);
		let ans: { fd: number; size: number; mtimeMs: number } | undefined;
		try {
			ans = finished ? openRegular(`${base}.md`) : undefined;
		} catch {
			ans = undefined; // a bad answer file (directory, link, unreadable) is no answer; the log's rows still show
		}
		if (ans) fds.push(ans.fd);
		const stamp = `${log.size}:${log.mtimeMs}:${finished ? (ans ? `${ans.size}:${ans.mtimeMs}` : "none") : "live"}`;
		if (prev?.id === id && prev.stamp === stamp) return prev;
		const tail = readSlice(log.fd, Math.max(0, log.size - TAIL_BYTES), Math.min(log.size, TAIL_BYTES));
		const final = finished ? (ans ? readSlice(ans.fd, 0, Math.min(ans.size, FINAL_BYTES)) : null) : undefined;
		const cut = log.size > TAIL_BYTES;
		return { id, stamp, lines: transcriptLines(tail, cut, final, cut ? headBrief(log.fd, Math.min(HEAD_BYTES, log.size - TAIL_BYTES)) : undefined) };
	} catch (e) {
		return reason(`transcript unreadable: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
	} finally {
		for (const fd of fds) closeSync(fd);
	}
}

function readRun(sid: string): Run | undefined {
	const f = runFile(sid);
	if (!existsSync(f)) return undefined;
	try {
		const run = JSON.parse(readFileSync(f, "utf8")) as Run;
		if (run && typeof run === "object") {
			if ("names" in run) run.names = cleanNames(run.names);
			run.ended = cleanEnded(run.ended);
			run.ratings = cleanRatings(run.ratings);
			if ("recorded" in run) run.recorded = cleanRecorded(run.recorded);
			if (run.merged !== true) delete run.merged;
		}
		return run;
	} catch {
		return undefined;
	}
}

/** This session's run, only while it still holds the ticket; a run taken over by another session is dropped. */
function ownRun(sid: string): Run | undefined {
	const run = readRun(sid);
	if (!run) return undefined;
	if (holds(stateDir(), run.key, sid)) return run;
	dropFiles(sid);
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
		.filter((r): r is Run => typeof r?.key === "string" && typeof r.sid === "string");
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

/** The ERROR line for a `via` that cannot be recorded, or undefined. Runs before any claim or file write. */
function viaError(via: unknown, booked?: number): string | undefined {
	if (via === undefined) return undefined;
	if (booked === undefined) return "ERROR via needs booked: the minutes of the booking or estimate it names";
	if (!isVia(via)) return 'ERROR bad via: key is 1-64 characters on one line, reason is "parent booking" or "estimate"';
	return undefined;
}

/** Only `key` and `reason` are ever written. */
const cleanVia = (via?: Via): Via | undefined => (via ? { key: via.key, reason: via.reason } : undefined);

function startKey(key: string, booked?: number, prior?: number, untimed = false, via?: Via): void {
	mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
	const file = today();
	const evs = load(file);
	// ponytail: booked fallback reads only today's file; a timed run that crosses midnight counts unbooked until `start` with booked.
	const bk = booked ?? bookedMin(evs, key);
	if (openKeys(evs).includes(key)) {
		// Already running: a new booking is a start event (every span reader ignores a start on an open key, so no time is lost);
		// without one, the minutes already worked are kept as an adjustment, not dropped.
		const stored = viaOf(evs, key);
		if (booked !== undefined && (booked !== bookedMin(evs, key) || via?.key !== stored?.key || via?.reason !== stored?.reason))
			append(file, { ts: nowIso(), event: "start", key, booked, ...(via ? { via } : {}), ...(prior ? { prior } : {}) });
		else if (prior) append(file, { ts: nowIso(), event: "adjust", key, prior });
		return;
	}
	if (bk === undefined && !untimed) throw new Error(`booked minutes unknown for ${key}; pass booked`);
	// via lives only next to booked: a given booking brings its own via (none = an own booking), a resume keeps the stored one.
	const v = booked === undefined ? viaOf(evs, key) : via;
	append(file, { ts: nowIso(), event: "start", key, ...(bk === undefined ? {} : { booked: bk }), ...(bk !== undefined && v ? { via: v } : {}), ...(prior ? { prior } : {}) });
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
	if (run.untimed && booked !== undefined) {
		// spendIdle may have rewritten the run file already, so clear `untimed` from its current content.
		const { untimed: _u, ...timed } = readRun(run.sid) ?? run;
		writeRun(timed);
		startKey(run.key, booked);
		return `timed ${run.key}: booked ${booked} min today`;
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
function begin(sid: string, key: string, theatre: string, booked?: number, spent?: number, takeover?: string, ownRepo?: { repo?: string }, via?: Via): void {
	claim(stateDir(), key, sid, takeover);
	const other = allRuns().find(r => r.key === key && r.sid !== sid);
	if (other) {
		// Force: the ticket changes hands, so its open block ends here whatever the heartbeat gap is.
		closeGap(other, true);
		// The run's cockpit and its agents' live rows move to the new session before the old files go.
		try {
			renameSync(cockpitFile(other.sid), cockpitFile(sid));
		} catch {
			// No saved cockpit.
		}
		try {
			const from = readdirSync(liveDir(other.sid));
			mkdirSync(liveDir(sid), { recursive: true, mode: 0o700 });
			for (const f of from) if (!existsSync(path.join(liveDir(sid), f))) renameSync(path.join(liveDir(other.sid), f), path.join(liveDir(sid), f));
		} catch {
			// No live rows, or one that would not move: dropFiles leaves the rest inert.
		}
		dropFiles(other.sid);
	}
	const mine = readRun(sid);
	if (mine && mine.key !== key) {
		stopKey(mine.key);
		release(stateDir(), mine.key, sid);
	}
	const untimed = booked === undefined;
	// Begun again on the same key, the run keeps the station it was at.
	const keep = mine?.key === key ? mine : undefined;
	// Begun again on the same key, every stored field stays except the booking mode. A takeover keeps the run's state too, but not the old session's hidden tools, shutdown mark or idle pause.
	const { untimed: _u, ...own }: Partial<Run> = keep ?? other ?? {};
	const { hidden: _h, closedBy: _c, idle: _i, ...taken } = own;
	// The taken run's builders ran in the other session: none runs here, so its squads are stopped, as in the plan-approve hand-off.
	const kept = keep ? own : other?.agents ? settle({ ...taken } as Run, {}, Object.values(other.agents)) : taken;
	// A run begun under another key still hands its hidden tools on, or end could never restore them.
	writeRun({ ...kept, ...(mine?.hidden ? { hidden: mine.hidden } : {}), key, theatre, sid, repo: ownRepo ? ownRepo.repo : keep ? keep.repo : other?.repo, since: keep?.since ?? other?.since ?? nowIso(), ...(untimed ? { untimed: true as const } : {}) });
	beat(sid);
	sweepPointers();
	startKey(key, booked, spent, untimed, via);
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
			const via = viaOf(evs, k);
			const pool = poolOf(evs, k, now);
			const shared = pool ? ` · shared ${pool.parent} ${Math.floor(pool.el)}/${pool.booked} min (${Math.floor((pool.el / pool.booked) * 100)}%)` : "";
			return `${k} ${el}/${bk} min (${Math.floor((el / bk) * 100)}%) ${state}${via ? ` via ${via.key} (${via.reason})` : ""}${shared}`;
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

/** The key's events from the day of `since` to today (at most 366 day files). An unparsable or missing `since` reads today only. */
function eventsSince(key: string, since?: string): Ev[] {
	const from = new Date(since ?? Number.NaN);
	const known = Number.isFinite(from.getTime());
	const first = known ? from : new Date();
	const evs: Ev[] = [];
	for (let i = 0; i < 366; i++) {
		const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
		if (day > new Date()) break;
		evs.push(...load(dayFile(stateDir(), day)));
	}
	return evs.filter(e => e.key === key && (!known || new Date(e.ts) >= from));
}

/** The squad marks the cockpit saved beside the run; a missing or malformed file reads as none. */
function savedNotes(sid: string): Record<string, { failed?: true; veteran?: true }> {
	try {
		const notes = asObj(JSON.parse(readFileSync(cockpitFile(sid), "utf8"))).notes;
		return Object.fromEntries(
			Object.entries(asObj(notes)).map(([id, n]) => [id, { ...(asObj(n).failed === true ? { failed: true as const } : {}), ...(asObj(n).veteran === true ? { veteran: true as const } : {}) }]),
		);
	} catch {
		return {};
	}
}

/** The role and squad of each agent the cockpit saved beside the run; a missing or malformed file reads as none. */
function savedRoles(sid: string): Map<string, { role: string; squad?: string }> {
	const roles = new Map<string, { role: string; squad?: string }>();
	try {
		const jobs = asObj(JSON.parse(readFileSync(cockpitFile(sid), "utf8"))).deployed;
		for (const d of Array.isArray(jobs) ? jobs : []) {
			const job = asObj(Array.isArray(d) ? d[1] : undefined);
			if (Array.isArray(d) && typeof d[0] === "string" && typeof job.role === "string") roles.set(d[0], { role: job.role, ...(typeof job.squad === "string" ? { squad: job.squad } : {}) });
		}
	} catch {
		// No saved cockpit: the agents are told apart by their live files only.
	}
	return roles;
}

/** The role and squad of each agent of the run: the live cockpit registry when it is this run's, else what the cockpit saved beside the run. */
function rolesFor(run: Run, live: { key?: string; deployed?: Map<string, Deployed> } | undefined): Map<string, { role: string; squad?: string }> {
	return live?.key === run.key && live.deployed ? new Map([...live.deployed].map(([id, d]) => [id, { role: d.role, squad: d.squad }])) : savedRoles(run.sid);
}

/** Build the run's debrief and save it under <state>/debriefs (kept after the run): the result lines for `end`. A failure never stops the end. */
function writeDebrief(run: Run, reported: Reported | undefined, live: { key?: string; notes: Record<string, Note>; deployed?: Map<string, Deployed>; servoSkull?: { spend?: Spend } } | undefined, clamp: boolean, honoursIn?: { rows: Honour[]; unsaved?: string }, out?: { summary?: string[] }): string[] {
	try {
		const evs = eventsSince(run.key, run.since);
		// A run stopped before `end` has no pause tail: its last interval closes at the stop (or at a later station entry). A takeover keeps it: the crash gap is real.
		const lastSpan = !clamp ? undefined : evs.filter(e => e.event === "start" || e.event === "stop").at(-1);
		const clampTo = lastSpan?.event === "stop" ? Math.max(...evs.filter(e => e === lastSpan || e.event === "station").map(e => new Date(e.ts).getTime())) : Number.NaN;
		const now = new Date();
		const end = Number.isFinite(clampTo) && clampTo < now.getTime() ? new Date(clampTo) : now;
		const agents = Object.values(run.agents ?? {});
		const stopped = new Set((run.stopped ?? []).map(s => s.id));
		const running = new Set(agents.map(s => s.id));
		const known = new Map<string, Slice>();
		for (const s of [...(run.slices ?? []), ...(run.stopped ?? []), ...agents]) if (!known.has(s.id)) known.set(s.id, s);
		const squads = [...known.values()].map(s => ({ id: s.id, ...(s.tier ? { tier: s.tier } : {}), state: running.has(s.id) ? ("running" as const) : stopped.has(s.id) ? ("stopped" as const) : ("not built" as const) }));
		const roles = rolesFor(run, live);
		const rows = liveRows(run);
		// A live file with no deployed entry (a nested child, an eval spawn without spawnKey) still counts, as role `other`.
		// shortcut: an eval spawn without spawnKey shows a `?` row and an `other` row for the same child, and a sync task spawn counts as `other`; upgrade if hosts omit spawnKey.
		const costs: AgentCost[] = [...roles, ...[...rows.keys()].filter(id => !roles.has(id)).map(id => [id, { role: "other", squad: undefined }] as const)].map(([id, r]) => {
			const { cost, tokens_in, tokens_out, cache_read, cache_write } = rows.get(id) ?? {};
			return { id, role: r.role, ...(r.squad ? { squad: r.squad } : {}), cost, tokens_in, tokens_out, cache_read, cache_write };
		});
		const spend = live?.key === run.key ? live.servoSkull?.spend : savedSpend(run.sid);
		if (spend?.calls) costs.push({ id: "servo-skull", role: "servo-skull", calls: spend.calls, model: spend.model, cost: spend.cost, tokens_in: spend.tokens_in, tokens_out: spend.tokens_out, cache_read: spend.cache_read, cache_write: spend.cache_write });
		const { markdown, summary } = debrief({ key: run.key, theatre: run.theatre, since: run.since, end, evs, squads, notes: live?.key === run.key ? live.notes : savedNotes(run.sid), reported, agents: costs, ratings: cleanRatings(run.ratings), ...(honoursIn ? { honours: honoursIn } : {}) });
		const file = path.join(stateDir(), "debriefs", `${safeName(run.key)}-${nowIso(now).slice(0, 19).replace(/:/g, "-")}.md`);
		try {
			writeAtomic(file, markdown);
		} catch (err) {
			const failed = `DEBRIEF not written: ${err instanceof Error ? err.message : String(err)}`;
			if (out) out.summary = [failed, ...summary]; // the open cockpit's final screen shows what the end reports, without the markdown
			return [failed, ...summary, markdown];
		}
		if (out) out.summary = [`DEBRIEF ${file}`, ...summary];
		return [`DEBRIEF ${file}`, ...summary];
	} catch (err) {
		const failed = `DEBRIEF not written: ${err instanceof Error ? err.message : String(err)}`;
		if (out) out.summary = [failed];
		return [failed];
	}
}

/** End this session's run, or another session's run of `key` by naming that crashed session's id in `takeover`. */
function endRun(sid: string, key?: string, takeover?: string, reported?: Reported, live?: { key?: string; notes: Record<string, Note>; deployed?: Map<string, Deployed>; servoSkull?: { spend?: Spend } }, names = false, out?: { summary?: string[] }): string {
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
	// The roster record goes in before the claim is released: until then the brothers still count as on campaign.
	const record = names ? recordRun(run) : undefined;
	// recordRun already waited out a busy lock: a second full wait would freeze the end again.
	const tally = recordTally(run, rolesFor(run, live), record?.error === "roster busy" ? 2000 : undefined);
	release(stateDir(), run.key, sid);
	// After the last span is closed and before the run's files go: the debrief reads them.
	const lines = writeDebrief(run, reported, live, run.sid === sid, names ? { rows: record?.honours ?? [], ...(record?.error ? { unsaved: record.error } : {}) } : undefined, out);
	dropFiles(run.sid);
	dropPointer(sid);
	return [`ENDED ${run.key}`, ...lines, ...(record ? [record.line] : []), ...(tally ? [tally] : [])].join("\n");
}

/** The TALLY and PROPOSE lines for `report`, or one WARN line when tally.json is unreadable; nothing for a missing or empty tally. */
function tallyReport(): string[] {
	const loaded = loadTally(stateDir());
	if ("error" in loaded) return [`WARN TALLY ${path.join(stateDir(), "tally.json")} unreadable (${loaded.error}): fix or delete it`];
	const { selectors } = parseTiers(process.env.STRATEGIUM_TIERS);
	return [...tallyLines(loaded.rows), ...proposals(loaded.rows, LADDER.map(tier => ({ tier, selector: selectors[tier] })))];
}

function report(date?: string): string {
	// The date comes from the model: only a plain day file, never a path.
	if (date !== undefined && !DAY_RE.test(date)) throw new Error(`bad date ${date}; expected YYYY-MM-DD`);
	const file = date ? path.join(stateDir(), `${date}.jsonl`) : today();
	const evs = load(file);
	// A past day ends at its midnight, so a block left open then does not grow until now.
	const past = date !== undefined && date !== path.basename(today(), ".jsonl");
	const now = past ? new Date(`${date}T23:59:59`) : new Date();
	const bl = blocks(evs, now, past);
	const keys = [...new Set(evs.filter(e => e.event === "start" || e.event === "stop" || e.event === "adjust").map(e => e.key))];
	const tally = date === undefined ? tallyReport() : [];
	if (!keys.length) return ["IDLE", ...tally].join("\n");
	const sum = (k: string, ev: string) =>
		evs.filter(e => e.key === k && e.event === ev).reduce((n, e) => n + (e.prior ?? 0), 0);
	const overlap = Math.floor(overlapMin(evs, now));
	// A block left open ends in "now" on today's report and at 23:59 on a past day, as in `blocks`.
	const hhmm = (d: Date) => (d.getTime() !== now.getTime() ? nowIso(d).slice(11, 16) : past ? "23:59" : "now");
	const split = [
		...overlapIntervals(evs, now).flatMap(o => {
			const m = Math.floor((o.end.getTime() - o.start.getTime()) / 60_000);
			return m ? [`OVERLAP ${o.keys.join("+")} ${hhmm(o.start)}-${hhmm(o.end)} (${m} min, ${Math.floor(m / o.keys.length)} each)`] : [];
		}),
		...[...splitMin(evs, now)].map(([k, m]) => `SPLIT ${k} ${Math.floor(m)} min (measured after an equal split of the overlaps)`),
	];
	return [
		...keys.flatMap(k => (sum(k, "start") ? [`PRIOR ${k} ${sum(k, "start")} min (estimate, before tracking)`] : [])),
		...keys.flatMap(k => (sum(k, "adjust") ? [`ADJUST ${k} ${sum(k, "adjust")} min (added by hand)`] : [])),
		...bl.map(b => `${b.key} ${b.start}-${b.end} (${b.min} min)`),
		...keys.flatMap(k => {
			const via = viaOf(evs, k);
			return via ? [`VIA ${k} ${via.key} (${via.reason})`] : [];
		}),
		...keys.map(k => {
			const measured = bl.filter(b => b.key === k).reduce((n, b) => n + b.min, 0);
			const worked = Math.floor(elapsedMin(evs, k, now));
			return `TOTAL ${k} measured ${measured} min, worked ${worked} min with prior and adjustments (~${Math.round(worked / 15) * 15} min)`;
		}),
		...(overlap ? [`OVERLAP ${overlap} min with two or more tickets running at once; split them before booking`, ...split] : []),
		...tally,
	].join("\n");
}

/** The slice of `Bun.spawn` the alarm uses; tests pass a spy as the factory's second argument. */
type Spawn = (o: { cmd: string[]; env: Record<string, string>; stdout: "ignore"; stderr: "ignore" }) => { exited: Promise<number>; unref(): void };

// The bundled vox, resolved from this file so a plugin upgrade moves the path with the code.
const VOX = path.join(import.meta.dir, "../../alarm/vox.ts");

/**
 * Run the bundled vox (`alarm/vox.ts`, with the current bun) with the level in STRATEGIUM_P, STRATEGIUM_SOUND=1|0,
 * STRATEGIUM_VOLUME when the user set one and, only when toasts are on, a desktop-notification text in STRATEGIUM_MSG.
 * Levels: 50 | 80 | 100 for the booking timer, "attention" when the user is needed, "theme" when the session's run ends,
 * "idle" when the clock pauses after idle minutes, "done" when a seal is granted.
 * Returns the reason when the alarm could not be started, so it is not a silent no-sound; `onFail` gets a non-zero exit code later.
 */
function signal(spawn: Spawn, level: string, msg: string | undefined, sound: boolean, volume?: number, onFail?: (code: number) => void): string | undefined {
	try {
		const child = spawn({
			cmd: [process.execPath, VOX],
			env: childEnv({
				// omp.exe is a compiled Bun binary: without this it runs the omp CLI with vox.ts as a message.
				BUN_BE_BUN: "1",
				STRATEGIUM_P: level,
				STRATEGIUM_SOUND: sound ? "1" : "0",
				...(volume !== undefined ? { STRATEGIUM_VOLUME: String(volume) } : {}),
				...(msg ? { STRATEGIUM_MSG: msg } : {}),
			}),
			stdout: "ignore",
			stderr: "ignore",
		});
		// The alarm must not keep the session alive.
		child.unref();
		void child.exited.then(code => code && onFail?.(code)).catch(() => {});
		return undefined;
	} catch (err) {
		return `alarm failed: ${err instanceof Error ? err.message : String(err)}`;
	}
}

// The agents the Captain may spawn during a run.
export const ROSTER = ["scout", "librarian", "archmagos", "battle-brother", "veteran", "apothecary", "inquisitor", "confessor", "security-reviewer", "sonic", "task"];
const agentName = (a: string) => a.toLowerCase().split(/[:/]/).pop()!;
const SLICES_REASON = "Strategium: declare the plan's squads first: strategium action slices, with each squad's id, parallel flag and files.";
const ARCHMAGOS_OFF =
	"Strategium: the archmagos is off in this session. The user turns it on with /strategium-config archmagos on or STRATEGIUM_ARCHMAGOS=1; until then the lead librarian merges the plan.";
const ARCHMAGOS_UNMARKED =
	"Strategium: this run was not marked for the archmagos in Muster (strategium begin with archmagos: true); the lead librarian merges the plan.";
const archmagosWaits = (n: number) =>
	`Strategium: the archmagos integrates the librarians' parts: at least 2 librarians of this run must have finished first; ${n} have.`;
const ARCHMAGOS_AGAIN = "Strategium: this run already spawned its archmagos. Only a redraft allows one more: call strategium action redraft first.";
const REDRAFT_REFRESH =
	"Strategium: this run was redrafted and Auspex has not refreshed the map yet: a scout spawned after the redraft must finish before any librarian or archmagos.";
const ARCHMAGOS_SPENT = "Strategium: this run already spawned its archmagos and spent its one redraft.";
// Tool input arrives as unknown; anything that is not an object reads as empty.
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

// The cost tiers: each one is an omp model selector, and its `:level` suffix sets the effort. STRATEGIUM_TIERS overrides them.
const TIERS: Record<Tier, string> = { light: "@smol:medium", standard: "@task:medium", heavy: "@slow:high" };
const LADDER: Tier[] = ["light", "standard", "heavy"];

/**
 * `tier=selector` entries separated by `;` over the defaults. An entry with an unknown tier or an empty selector is
 * dropped and listed in `ignored`. Always returns a selector for each tier.
 */
export function parseTiers(env: string | undefined): { selectors: Record<Tier, string>; ignored: string[] } {
	const selectors = { ...TIERS };
	const ignored: string[] = [];
	for (const raw of (env ?? "").split(";")) {
		const entry = raw.trim();
		if (!entry) continue;
		const at = entry.indexOf("=");
		const name = entry.slice(0, Math.max(at, 0)).trim();
		const selector = entry.slice(at + 1).trim();
		if (!selector || !LADDER.includes(name as Tier)) ignored.push(entry);
		else selectors[name as Tier] = selector;
	}
	return { selectors, ignored };
}

const tiersState = () => {
	const env = process.env.STRATEGIUM_TIERS?.trim() ?? "";
	const { selectors, ignored } = parseTiers(env);
	const list = LADDER.map(t => `${t}=${selectors[t]}`).join(" ");
	return `${list} (${env ? "STRATEGIUM_TIERS" : "default"})${ignored.length ? `; ignored: ${ignored.join(", ")}` : ""}`;
};

const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The squad a recorded name was handed out for, if that squad is known. */
function recordedSquad(run: Run, name: string): Slice | undefined {
	const squad = run.names?.find(n => n.name === name)?.squad;
	return [...(run.slices ?? []), ...(run.stopped ?? [])].find(s => s.id === squad);
}

/**
 * The squad a spawn builds, undefined when the spawnKey matches none.
 * `named`: item names that took their squad from the brief ("build squad <id>").
 * Exact ids and brief names win over the folded match, which tries the key without its -<digits> suffix first, then the whole key.
 * shortcut: a name ending in -<digits> reads as a reused name of the squad before it unless a squad has that exact id; upgrade if ids like that appear.
 */
function squadOf(run: Run, spawnKey: string, named: Map<string, string>): Slice | undefined {
	const known = [...(run.slices ?? []), ...(run.stopped ?? [])];
	// The recorded name first (omp's -N suffix dropped), then today's rules.
	const byName = recordedSquad(run, baseId(spawnKey));
	if (byName) return byName;
	const stripped = spawnKey.replace(/-\d+$/, "");
	let slice: Slice | undefined;
	for (const key of [spawnKey, stripped]) {
		const id = named.get(key);
		slice = known.find(s => s.id === id || s.id === key);
		if (slice) break;
	}
	return slice ?? known.find(s => fold(s.id) === fold(stripped)) ?? known.find(s => fold(s.id) === fold(spawnKey));
}

/**
 * The tier a battle-brother of a squad runs on: the squad's planned tier on its first spawn, one up on each later one,
 * never above heavy. Counts the spawn in the run (`builds`). Undefined when the spawnKey matches no squad.
 */
function tierFor(run: Run, spawnKey: string, named: Map<string, string>): Tier | undefined {
	const slice = squadOf(run, spawnKey, named);
	if (!slice) return undefined;
	// `builds` counts at the hook, before the dispatch is known to succeed, like archmagosSpawned.
	const n = run.builds && Object.hasOwn(run.builds, slice.id) ? run.builds[slice.id] : 0;
	writeRun({ ...run, builds: { ...run.builds, [slice.id]: n + 1 } });
	return LADDER[Math.min(LADDER.indexOf(slice.tier ?? "standard") + (n ? 1 : 0), LADDER.length - 1)];
}

/** Run.names as read from disk: well-formed entries only, in order, each name once. */
function cleanNames(v: unknown): NameEntry[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const seen = new Set<string>();
	const out: NameEntry[] = [];
	for (const raw of v) {
		const { name, agent, surname, squad, spawned, old } = asObj(raw);
		if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(name) || name.length > MAX_NAME || seen.has(name)) continue;
		if (typeof agent !== "string" || !NAMED_AGENTS.includes(agent) || typeof surname !== "string" || (squad !== undefined && typeof squad !== "string")) continue;
		seen.add(name);
		out.push({ name, agent, surname, ...(squad !== undefined ? { squad } : {}), ...(spawned === true ? { spawned: true as const } : {}), ...(old === true ? { old: true as const } : {}) });
	}
	return out.length ? out : undefined;
}

/** Run.ended as read from disk: only "ok" and "failed" outcomes. */
function cleanEnded(v: unknown): Record<string, "ok" | "failed"> | undefined {
	const kept = Object.entries(asObj(v)).filter(([, e]) => e === "ok" || e === "failed");
	return kept.length ? (Object.fromEntries(kept) as Record<string, "ok" | "failed">) : undefined;
}

/** Run.recorded as read from disk: unique ids of at most 220 characters, the first 200; undefined when none is left. */
function cleanRecorded(v: unknown): string[] | undefined {
	const kept = [...new Set(Array.isArray(v) ? v.filter((id): id is string => typeof id === "string" && id.length <= 220) : [])].slice(0, 200);
	return kept.length ? kept : undefined;
}

/** One rating as the rate action takes it and as the run file holds it: the checked Rating, or the reason it is refused. Cuts nothing. */
function parseRating(v: unknown): Rating | string {
	const o = asObj(v);
	const rating = RATINGS.find(r => r === o.rating);
	if (!rating) return "rating must be proven, proven-regression or corrupted";
	const evidence = Array.isArray(o.evidence) ? o.evidence.map(oneLine) : [];
	if (!evidence.length || evidence.includes("")) return "rate needs evidence: finding IDs, the failing check or the breached rule";
	if (evidence.length > 8) return "at most 8 evidence items";
	if (evidence.some(e => e.length > 200)) return "evidence item too long (max 200 characters)";
	const model = oneLine(o.model);
	if (!model) return "rate needs model: the model the agent ran on, e.g. @task";
	if (model.length > 60) return "model too long (max 60 characters)";
	const effort = typeof o.effort === "string" ? o.effort.trim().toLowerCase() : "";
	if (!/^[a-z][a-z0-9-]{0,15}$/.test(effort)) return "effort must be one word such as low, medium, high or default";
	return { rating, evidence, model, effort };
}

const ratingKey = (id: string) => id !== "" && id === oneLine(id) && id.length <= 128;

/** Run.ratings as read from disk or handed to a consumer: only the entries parseRating accepts, under a sane key; undefined when none is left. */
function cleanRatings(v: unknown): Record<string, Rating> | undefined {
	const kept = Object.entries(Array.isArray(v) ? {} : asObj(v)).flatMap(([id, r]) => {
		const p = parseRating(r);
		return ratingKey(id) && typeof p !== "string" ? [[id, p] as const] : [];
	});
	return kept.length ? Object.fromEntries(kept) : undefined;
}

/** The run with `squad`'s outcome set, or cleared when `end` is undefined. */
function setEnded(run: Run, squad: string, end?: "ok" | "failed"): Run {
	const kept = Object.entries(run.ended ?? {}).filter(([k]) => k !== squad);
	if (end) kept.push([squad, end]);
	return { ...run, ended: kept.length ? Object.fromEntries(kept) : undefined };
}

/** Outcome of an agent's final status: only a real failure is a fall; aborted and cancelled leave the squad without one. */
const outcomeOf = (status: unknown): "ok" | "failed" | undefined => (status === "completed" ? "ok" : status === "failed" ? "failed" : undefined);

/**
 * The Captain's own gh pr <verb> / glab mr <verb>: after any `cd …` steps joined by `&&`, the command starts with it,
 * is not --help/-h, and has no pipe, `;` or newline whose exit code could stand for its own.
 */
function ownCommand(command: string, verb: string): boolean {
	const segs = command.split("&&").map(s => s.trim());
	const seg = segs.find(s => !/^cd(\s|$)/.test(s)) ?? "";
	return new RegExp(`^(?:gh\\s+pr|glab\\s+mr)\\s+${verb}(?:\\s|$)`).test(seg) && !/\s(?:--help|-h)(?:\s|$)|[|;\n]|(?<![&>])&(?![&>])/.test(command);
}

const isMerge = (command: string): boolean => ownCommand(command, "merge") && !/\s--auto\b/.test(command);

const HEREDOC = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/;

/**
 * The words of one shell line, quotes removed and backslashes resolved; undefined when a quote is left open or an unquoted `|`, `;` or lone `&` appears
 * (they hide the exit code). One linear pass.
 */
function shellWords(line: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let live = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "'" || c === '"') {
			let close = -1;
			for (let j = i + 1; j < line.length && close < 0; j++) {
				if (c === '"' && line[j] === "\\") j++;
				else if (line[j] === c) close = j;
			}
			if (close < 0) return undefined;
			word += line.slice(i + 1, close);
			live = true;
			i = close;
		} else if (c === "\\") {
			if (i + 1 < line.length) word += line[++i];
			live = true;
		} else if (/\s/.test(c)) {
			if (live) words.push(word);
			word = "";
			live = false;
		} else if (c === "|" || c === ";") return undefined;
		else if (c === "&" && line[i + 1] !== "&" && line[i + 1] !== ">" && line[i - 1] !== ">" && line[i - 1] !== "&") return undefined;
		else {
			word += c;
			live = true;
		}
	}
	if (live) words.push(word);
	return words;
}

/** Index just past the heredoc body a line opens (its terminator included), or `from` when the line opens none. */
function afterHeredoc(lines: string[], from: number, line: string): { next: number; opened: boolean } {
	const m = HEREDOC.exec(line);
	if (!m) return { next: from, opened: false };
	let i = from;
	while (i < lines.length && lines[i].trim() !== m[2]) i++;
	return { next: Math.min(i + 1, lines.length), opened: true };
}

/**
 * A PR create is the command whose first real line, after optional `cd … &&` steps, starts `gh pr create` / `glab mr create`.
 * Lines before it may only be shell assignments (`title=$(cat <<'X'` with its body, terminator and `)`); after it only its own heredoc body.
 * The create line is refused with an unquoted `|`, `;` or lone `&`, an open quote, or --web/--dry-run/--help (also `=value`) or a short cluster with w or h.
 */
function isPrCreate(command: string): boolean {
	const lines = command.split("\n").map(l => l.replace(/\r$/, ""));
	let afterAssign = false;
	for (let i = 0; i < lines.length; ) {
		const raw = lines[i].trim();
		if (raw === "" || (raw === ")" && afterAssign)) {
			afterAssign = false;
			i++;
			continue;
		}
		afterAssign = false;
		let rest = raw;
		for (let m = /^cd(?:\s[^&;|]*)?&&\s*/.exec(rest); m; m = /^cd(?:\s[^&;|]*)?&&\s*/.exec(rest)) rest = rest.slice(m[0].length);
		const create = /^(?:gh\s+pr|glab\s+mr)\s+create(?:\s|$)/.test(rest);
		if (!create && !/^[A-Za-z_]\w*=/.test(raw)) return false;
		const words = shellWords(create ? rest : raw);
		if (!words) return false;
		const { next, opened } = afterHeredoc(lines, i + 1, create ? rest : raw);
		if (!create) {
			afterAssign = opened;
			i = next;
			continue;
		}
		if (words.some(w => /^--(?:web|dry-run|help)(?:=|$)/.test(w) || /^-[A-Za-z]*[wh][A-Za-z]*$/.test(w))) return false;
		return lines.slice(next).every(l => l.trim() === "");
	}
	return false;
}

/** Fold the run's outcomes into the shared roster at `end`: the line to print, undefined with nothing to record. A roster failure never stops the end. */
function recordRun(run: Run): { line: string; honours: Honour[]; error?: string } | undefined {
	const names = cleanNames(run.names);
	const outcomes = runOutcomes({ ...run, names, ratings: cleanRatings(run.ratings) });
	if (!outcomes.length) return undefined;
	const merged = run.merged === true && !unfinished({ names, ended: run.ended });
	// The end has no second chance: wait past STALE_MS so a lock left by a crash is taken instead of losing the record.
	const seen: { before?: Brothers } = {};
	const err = updateRoster(
		stateDir(),
		b => {
			seen.before = b;
			return applyRun(b, outcomes, merged);
		},
		STALE_MS + 2000,
	);
	// An unsaved record has no known "before": no joins, Crux or corruption.
	const rows = honours(outcomes, merged, err ? undefined : seen.before);
	return err ? { line: `WARN ROSTER not written: ${err}`, honours: rows, error: err } : { line: `ROSTER ${outcomes.length} squad(s) recorded`, honours: rows };
}

/** Fold the run's rated builders into the tally at `end`: the line to print, undefined when no builder was rated. Never throws. */
function recordTally(run: Run, roles: Map<string, { role: string; squad?: string }>, waitMs = STALE_MS + 2000): string | undefined {
	try {
		const names = cleanNames(run.names);
		const known = [...Object.values(run.agents ?? {}), ...(run.stopped ?? []), ...(run.slices ?? [])];
		let skipped = 0;
		const results = Object.entries(cleanRatings(run.ratings) ?? {}).flatMap(([id, r]) => {
			const hit = names?.find(n => n.name === baseId(id));
			const who = hit ? { role: hit.agent, squad: hit.squad } : roles.get(id);
			if (!who || !isBuilderRole(who.role)) return [];
			// The agent's own copy under its id first (a redraft may reuse a squad id for other files), then any slice of that squad.
			const own = run.agents?.[id];
			const slice = own?.id === who.squad ? own : who.squad ? known.find(s => s.id === who.squad) : undefined;
			if (!slice) skipped++;
			return slice ? [{ model: r.model, effort: r.effort, kind: squadKind(slice.files), rating: r.rating }] : [];
		});
		if (!results.length && !skipped) return undefined;
		const note = skipped ? ` (${skipped} skipped)` : "";
		if (!results.length) return `TALLY recorded 0 rating(s)${note}`;
		const err = updateTally(stateDir(), rows => addResults(rows, results), waitMs);
		return err ? `WARN TALLY not written: ${err}` : `TALLY recorded ${results.length} rating(s)${note}`;
	} catch (err) {
		return `WARN TALLY not written: ${err instanceof Error ? err.message : String(err)}`;
	}
}

/** The name behind a spawn id (omp's -N suffix dropped) in the run's names, if any. */
const nameBehind = (run: Run, id: string): string | undefined => run.names?.find(n => n.name === baseId(id))?.name;

type Pick = { prefer: string[]; skip: Set<string> };

// A paused run may not beat, so a quiet run is judged by the newest of its heartbeat and run file; a day without either is a run nobody finishes.
const CAMPAIGN_MS = 24 * 3_600_000;
const touchedAt = (sid: string) => Math.max(0, ...[runFile(sid), beatFile(sid)].map(f => statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0));

/** Surnames in use by the not-retired builders of other sessions' open runs: those brothers are on campaign, until the claim is gone or the run has been silent for 24 h. */
function onCampaign(sid: string): Set<string> {
	const away = new Set<string>();
	for (const r of allRuns())
		if (r.sid !== sid && holds(stateDir(), r.key, r.sid) && Date.now() - touchedAt(r.sid) < CAMPAIGN_MS)
			for (const n of cleanNames(r.names) ?? []) if (n.squad !== undefined && !n.old) away.add(n.surname);
	return away;
}

/**
 * Run `fn` (it ends with writeRun) under the roster lock, with the picks for a new builder squad: the best brothers first,
 * corrupted ones and those on campaign skipped. A busy lock or an unreadable roster allocates without records and returns a WARN line.
 */
function withPicks<T>(sid: string, fn: (pick: Pick) => T): { value: T; warn?: string } {
	let warn: string | undefined;
	const locked = withRosterLock(stateDir(), () => {
		const away = onCampaign(sid);
		const loaded = loadRoster(stateDir());
		if ("error" in loaded) {
			warn = `WARN roster ${path.join(stateDir(), "roster.json")} unreadable (${loaded.error}): names come from the pool; fix or delete it`;
			return fn({ prefer: [], skip: away });
		}
		const skip = new Set([...away, ...Object.keys(loaded.brothers).filter(b => corrupted(loaded.brothers[b]))]);
		return fn({ prefer: rankBrothers(loaded.brothers, away), skip });
	});
	if ("busy" in locked) return { value: fn({ prefer: [], skip: onCampaign(sid) }), warn: "WARN roster busy: names come from the pool" };
	return { value: locked.value, warn };
}

/** The run once the name behind a spawn key (omp's -N suffix dropped) is marked spawned; the same run when no name of that agent matches or it is marked already. */
function markSpawned(run: Run, key: string, agent: string): Run {
	const hit = run.names?.find(n => n.name === baseId(key));
	if (!hit || hit.agent !== agent || hit.spawned) return run;
	return { ...run, names: run.names!.map(n => (n === hit ? { ...n, spawned: true as const } : n)) };
}

/** Why a name is refused with names on: undefined when the plugin handed it out for this agent and it has not spawned yet. */
function nameProblem(run: Run, agent: string, name: string): string | undefined {
	if (!name) return "has no name";
	const hit = run.names?.find(n => n.name === name);
	if (!hit) return `has the name ${name}, which the plugin did not hand out`;
	if (hit.agent !== agent) return `has the name ${name}, which was handed out for ${hit.agent}`;
	if (hit.spawned) return `has the name ${name}, which has already spawned`;
	if (hit.old) return `has the name ${name}, which a redraft retired`;
	return undefined;
}

const nameReason = (agent: string, what: string, problem: string) =>
	`Strategium: names are on and ${what} ${problem}. To get a name for ${agent}${agent === "battle-brother" || agent === "veteran" ? " (with its squad)" : ""}, call strategium action name`;

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
export const endedAgents = (messages: unknown, only?: string): string[] =>
	jobEnds(messages).filter(j => !only || j.status === only).map(j => j.id);

/** The items of a task call: a `tasks` list, or the input itself as one item. */
const taskItems = (input: unknown) => {
	const o = asObj(input);
	return (Array.isArray(o.tasks) ? o.tasks : [o]).map(asObj);
};

/** True when `id` is rated corrupted; with names on the same name with or without omp's -N suffix counts too, whichever form holds the rating (names are unique in a run). */
function corruptedSource(run: Run, id: string, named: boolean): boolean {
	return Object.entries(run.ratings ?? {}).some(([k, r]) => r.rating === "corrupted" && (named ? baseId(k) === baseId(id) : k === id));
}

/**
 * The ids a brief names on a `Reuse: <id>` line, one line at a time (no \s across lines, so the scan is linear), with an optional
 * markdown prefix (- * > ** __) and `code`, <angle> or agent:// around the id.
 * shortcut: eval `agent()` briefs are never scanned (only the `task` tool call is); spawn builders with `task` for the veto to hold, upgrade if the extension sees eval spawns.
 */
function reuseSources(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const m = /^[-*>_`#"'(\t ]*(?:\d{1,9}[.)][-*>_`#"'(\t ]*)?reuse[ \t]*:[ \t*_`<>"'[]*(?:agent:\/\/)?(\w[\w.-]*)(\/?)/i.exec(line);
		if (!m || m[2]) continue; // an id followed by / is a path, not an agent
		let id = m[1];
		while (/[.-]$/.test(id)) id = id.slice(0, -1);
		out.push(id);
	}
	return out;
}

const isBuilderRole = (agent: string) => agent === "battle-brother" || agent === "veteran";
// A file's folder; a top-level file has none, so it never makes two squads neighbours.
const areaOf = (f: string) => {
	const d = path.posix.dirname(normFile(f));
	return d === "." ? undefined : d;
};

/**
 * D2/D3 (#143): proven builders of this run that have ended and whose squad shares files, else a folder, with `target`;
 * shared files first, then the fewest session tokens, then id; the best three.
 * shortcut: cumulative session tokens stand in for context headroom, since omp exposes no context fill to extensions; upgrade if getUsageStatistics or the live row gains the current context size.
 */
function reuseCandidates(run: Run, target: Slice, roles: Map<string, { role: string; squad?: string }>, named: boolean) {
	const squadOfId = new Map<string, string>();
	for (const [id, r] of roles) if (isBuilderRole(r.role) && r.squad) squadOfId.set(id, r.squad);
	for (const n of run.names ?? []) if (n.spawned && !n.old && isBuilderRole(n.agent) && n.squad) squadOfId.set(n.name, n.squad);
	const known = [...(run.slices ?? []), ...(run.stopped ?? [])];
	const rows = liveRows(run);
	const targetAreas = new Set(target.files.map(areaOf));
	const out: { id: string; squad: string; shared: boolean; tokens: number }[] = [];
	for (const [id, squad] of squadOfId) {
		const src = known.find(s => s.id === squad);
		const running = named ? Object.keys(run.agents ?? {}).some(k => baseId(k) === baseId(id)) : Boolean(run.agents?.[id]);
		const retired = named && (run.names ?? []).some(n => n.old && n.name === baseId(id));
		if (!src || running || retired || corruptedSource(run, id, named) || !run.ratings || !Object.hasOwn(run.ratings, id) || run.ratings[id].rating !== "proven") continue;
		const shared = sharedFiles(src, target).length > 0;
		if (!shared && !src.files.some(f => areaOf(f) && targetAreas.has(areaOf(f)))) continue;
		const row = rows.get(id);
		const used = [row?.tokens_in, row?.tokens_out, row?.cache_read, row?.cache_write];
		// Unknown usage sorts last.
		out.push({ id, squad, shared, tokens: used.some(v => v !== undefined) ? used.reduce<number>((a, v) => a + (v ?? 0), 0) : Number.POSITIVE_INFINITY });
	}
	return out.sort((a, b) => Number(b.shared) - Number(a.shared) || (a.tokens < b.tokens ? -1 : a.tokens > b.tokens ? 1 : 0) || (a.id < b.id ? -1 : 1)).slice(0, 3);
}

/**
 * The squad a battle-brother or veteran item builds: the one its name spells (letters and digits, any case), else the
 * one its brief builds ("build squad <id>"). Undefined for any other agent.
 */
function builtSlice(item: Record<string, unknown>, run: Run): Slice | undefined {
	if (!isBuilderRole(agentName(String(item.agent ?? "task")))) return undefined;
	const known = [...(run.slices ?? []), ...(run.stopped ?? [])];
	// The recorded name first; names off (or a name the plugin did not hand out) falls back to the rules below.
	const given = typeof item.name === "string" ? item.name.trim() : undefined;
	const byName = given ? recordedSquad(run, given) : undefined;
	if (byName) return byName;
	const name = typeof item.name === "string" ? fold(item.name) : undefined;
	const task = String(item.task ?? "");
	const built = [...task.matchAll(/\b(?:squad|slice)\s+([\w.-]*\w)/gi)].map(m => m[1]);
	// A reuse brief also names the source's squad: the one right after `build` is the squad being built.
	const after = /\bbuild\s+(?:squad|slice)\s+([\w.-]*\w)/i.exec(task)?.[1];
	return known.find(s => fold(s.id) === name) ?? (after ? known.find(s => s.id === after) : undefined) ?? known.find(s => built.includes(s.id));
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

// A runner is a command word, never an argument: it starts the command or follows ; & | ( ` { or a newline, behind VAR=x
// assignments and wrappers (env, time, sudo, then...). It may be named by path (./node_modules/.bin/jest, /usr/bin/pytest,
// C:\tools\bun.exe) and carry .exe or .cmd on Windows.
const EXT = String.raw`(?:\.exe|\.cmd)?`;
// NAME=v, NAME+=v, NAME[i]=v. Every part stops at a separator (WORD), so a scan from each command start cannot run to the
// end of the line again and again; the nested forms $(..) and $((..)) cannot contain a bracket or a quote.
// SP is a blank that is not a newline: a newline already starts a command, so crossing it would rescan the rest again.
const SP = String.raw`[^\S\n]`;
const WORD = String.raw`[^\s;&|()\x60]`;
const ASSIGN = String.raw`\w+(?:\[[^\]\s;&|()\x60]*\])?\+?=${WORD}*(?:\$\(\(?${WORD}*\)\)?${WORD}*)*`;
const COMMAND_START = String.raw`(?:^|[;&|(\n\x60])`;
const RUNNER = new RegExp(
	String.raw`${COMMAND_START}${SP}*` +
		String.raw`(?:(?:${ASSIGN}|(?:env|time|exec|nohup|sudo|xargs|nice|stdbuf|setsid|doas|watch|coproc)(?:${SP}+-${WORD}+(?:${SP}+\d${WORD}*)?)*|then|do|else|elif|if|while|until|!|\{|timeout(?:${SP}+-${WORD}+(?:${SP}+[\w.]${WORD}*)?)*${SP}+[\d.][\w.]*)${SP}+)*` +
		String.raw`(?:[^\s;&|()\x60"'<>=]*[\\/])?` +
		String.raw`(?:bun${EXT}\s+(?:test|run)\b|bunx${EXT}\s|npx${EXT}\s|(?:npm|pnpm|yarn)${EXT}\s+(?:test|t|run|run-script|exec|build)\b` +
		String.raw`|(?:tsc|jest|vitest|pytest|gradle|mvn|playwright)${EXT}\b|(?:cargo|go|dotnet)${EXT}\s+(?:test|build)\b)`,
);
const WRITE_WORD = new RegExp(String.raw`${COMMAND_START}${SP}*(?:${ASSIGN}${SP}+)*(?:rm|rmdir|mv|cp|touch|truncate|tee|ln)\b`);
// git's global options (-C dir, -c k=v, --git-dir=x) come before the subcommand and must not hide it; at most eight, so
// each `git` start reads a bounded stretch.
// shortcut: nine or more global options before anything are refused whatever follows (git + 9 options + a read-only
// subcommand is a false positive), because the bounded form above stops reading at eight and must stay linear.
const WRITE_GIT_MANY = /\bgit\s+(?:(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?|-\w)\s+){9}/;
const WRITE_GIT = /\bgit\s+(?:(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?|-\w)\s+){0,8}(checkout\s+(\S+\s+)?--(?=\s|$)|checkout\s+\.(?=\s|$)|(restore|reset\s+--hard|clean|stash|apply|am|rm|mv)\b)/;
// A redirect, unless it goes to a file descriptor, /dev/null or a scratch place.
const WRITE_REDIRECT = />>?(?!>)(?!\s*(?:&[\d-]|\/dev\/null\b|["']?(?:\$\{?(?:TEMP|TMP|TMPDIR)\}?|\/tmp\/|%TEMP%|(?:out|local):\/\/)))/;

// Linear rewrites (one flat regex pass each) that put a command back where the two patterns above look for it:
// ${IFS} is a space; a redirection (with its {fd} or digit and its word) is no command word; the `)` that ends a case
// pattern (the word stays: it may be a command in a subshell) and the `{` that opens a function body or group are
// separators. \d{0,2} and the separator-free words keep each start from rescanning the line.
const REDIRECTION = /(?:\{\w+\}|\d{0,2})(?:<<<|<<-?|<>|[<>]&|&>>?|>>?|<)[ \t]*[^\s;&|()\x60]+/g;
const CASE_ARM = /(?:^|[;\n]|\bin\b)[ \t]*\(?[^\s;&()\x60]+[ \t]*\)/g;
const asCommands = (s: string) =>
	s.replace(/\$\{IFS\}|\$IFS\b/g, " ").replace(CASE_ARM, m => `${m.slice(0, -1)};`).replace(/\{(?=\s)/g, ";").replace(REDIRECTION, "");

/**
 * Linear heredoc stripper: the opener line stays (its redirect writes the file), the body goes, the terminator is the first
 * line after the opener that equals the word after optional leading blanks (as bash: an empty body is fine). An opener inside
 * quotes on its own line (`echo "<<Z"`) is no opener (unless `quoted` is false: main's quote-blind reading, terminator from
 * two lines below). Like the regex it replaced, an unquoted word shrinks to a shorter
 * prefix when only that prefix ends a line (`<<EOFX` closes at `EO`, the rest `FX` stays on the opener line). Terminator
 * lookups use a word -> line numbers map and try only prefix lengths that some line has, so no opener rescans the text.
 */
function stripHeredocs(s: string, quoted = true): string {
	let starts: number[] | undefined;
	let byWord: Map<string, number[]> | undefined;
	let lens: number[] = [];
	const index = () => {
		starts = [0];
		byWord = new Map();
		const seen = new Set<number>();
		for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) starts.push(i + 1);
		starts.forEach((st, n) => {
			let a = st;
			while (s[a] === " " || s[a] === "\t") a++;
			const e = n + 1 < starts!.length ? starts![n + 1] - 1 : s.length;
			if (a >= e) return;
			const k = s.slice(a, e);
			(byWord!.get(k) ?? byWord!.set(k, []).get(k)!).push(n);
			seen.add(e - a);
		});
		lens = [...seen].sort((x, y) => y - x);
	};
	const lineOf = (pos: number) => {
		let lo = 0, hi = starts!.length - 1;
		while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts![m] <= pos) lo = m; else hi = m - 1; }
		return lo;
	};
	let out = "", copied = 0, nl = -2;
	// quote state of the current line, advanced once over the text up to each opener (never rescanned)
	let quote = "", qpos = 0;
	for (let i = s.indexOf("<<"); i >= 0; i = s.indexOf("<<", i + 1)) {
		for (; qpos < i; qpos++) {
			const c = s[qpos];
			if (c === "\n") quote = "";
			else if (c === "\\" && quote !== "'") qpos++;
			else if (quote) { if (c === quote) quote = ""; }
			else if (c === "'" || c === '"') quote = c;
		}
		if ((quoted && quote) || s[i - 1] === "<") continue;
		let p = i + 2;
		if (s[p] === "-") p++;
		while (/\s/.test(s[p] ?? "x")) p++;
		const q = s[p] === "'" || s[p] === '"' ? s[p] : "";
		const w0 = p + q.length;
		let w1 = w0;
		while (/\w/.test(s[w1] ?? " ")) w1++;
		if (w1 === w0 || (q && s[w1] !== q)) continue;
		const rest = w1 + q.length;
		if (nl !== -1 && nl < rest) nl = s.indexOf("\n", rest);
		if (nl < 0) continue;
		if (!starts) index();
		const from = lineOf(rest) + (quoted ? 1 : 2);
		let t = -1, k = w1 - w0;
		for (const len of q ? [k] : lens) {
			if (len > k) continue;
			const lines = byWord!.get(s.slice(w0, w0 + len));
			if (!lines) continue;
			let lo = 0, hi = lines.length;
			while (lo < hi) { const m = (lo + hi) >> 1; if (lines[m] < from) lo = m + 1; else hi = m; }
			if (lo < lines.length) { t = lines[lo]; k = len; break; }
		}
		if (t < 0) continue;
		const end = t + 1 < starts!.length ? starts![t + 1] - 1 : s.length;
		out += s.slice(copied, i) + "<<HEREDOC" + s.slice(q ? rest : w0 + k, nl);
		copied = end;
		i = end - 1;
		qpos = end;
		quote = "";
	}
	return out + s.slice(copied);
}

/**
 * Why a bash command is not allowed for the Captain during a run: test and build runners, and file writes.
 * Undefined when it may run.
 */
// ponytail: a pattern list, not a shell parser; it stops slips, not a determined workaround.
export function bashBlock(command: string): string | undefined {
	// The quote-blind reading main used is checked too: the quote blanking misreads $'\'', \" and "$(…"…")", so a body only
	// that reading drops can pair a quote over a real command.
	return blockStripped(stripHeredocs(command)) ?? blockStripped(stripHeredocs(command, false));
}

function blockStripped(stripped: string): string | undefined {
	// Heredoc bodies are data; quoted strings are blanked, except a quoted redirect target.
	const cmd = stripped
		.replace(/(>>?\s*)?('[^']*'|"[^"]*")/g, (m, redir) => (redir ? m : '""'));
	// A backslash before a word character is an escape (r\m); a Windows path keeps its own, so both readings are checked.
	// A runner is also looked for in the command as written: `$IFS` inside an assignment value is no space there.
	const readings = [asCommands(cmd), asCommands(cmd.replace(/\\(?=\w)/g, ""))];
	if (RUNNER.test(cmd) || readings.some(r => RUNNER.test(r))) return "Strategium: the Captain runs no builds or test suites. Delegate the check to a sonic agent.";
	if (readings.some(r => WRITE_WORD.test(r)) || /\bsed\s+(-\w*i|--in-place)/.test(cmd) || /\bperl\s+-\w*i/.test(cmd) || WRITE_GIT.test(cmd) || WRITE_GIT_MANY.test(cmd) || WRITE_REDIRECT.test(cmd))
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

// The cockpit key comes from env, a file or a command, so it is checked against omp's KeyId grammar before it is bound.
const KEY_RE = /^((ctrl|shift|alt|super)\+){0,4}([a-z0-9`\-=[\]\\;',./!@#$%^&*()_+|~{}:<>?]|escape|esc|enter|return|tab|space|backspace|delete|insert|clear|home|end|pageup|pagedown|up|down|left|right|f[1-9]|f1[0-2])$/;
// Usable: no repeated modifier, and a ctrl, alt or super modifier or an F key, because omp runs extension shortcuts before the editor, so a bare "e" would make e untypable.
const usableKey = (k: string): boolean => {
	if (!KEY_RE.test(k)) return false;
	const parts = k.split(/\+(?=.)/);
	const mods = parts.slice(0, -1);
	return new Set(mods).size === mods.length && (mods.some(m => m !== "shift") || /^f\d/.test(parts.at(-1)!));
};
type KeyId = Parameters<ExtensionAPI["registerShortcut"]>[0];
const cockpitHint = (key: string) => `${key.split(/\+(?=.)/).map(p => p.toUpperCase()).join(" + ")} to enter cockpit`;

/** The footer line for a run: dot, planet, key, station, then its time or booking. */
function renderFooter(run: Run, evs: Ev[], running: boolean, el: number, bk: number, hint: string): string {
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
	// A run without a booking only counts time. A timed run with no booking today counts from midnight unbooked, or waits paused, for its new shift.
	const value = run.untimed && bookedMin(evs, key) === undefined
		? running ? `${el} min` : "paused"
		: bookedMin(evs, key) === undefined
			? running ? `${el} min · new day: /strategium-resume <min>` : "new day: /strategium-resume"
			: `${stage} ${el}/${bk} min (${pct}%)${running ? "" : " paused"}`;
	// Where the run is: a seal waiting for the user (⏳, md-timer_sand F051F, in yellow), a return (↩, md-undo
	// F054C) or just the station. Codepoints checked in the Nerd Fonts glyphnames.json.
	const w = run.where;
	const where = !w
		? ""
		: w.seal
			? ` · \x1b[33m${nf ? "\u{f051f} " : "⏳"} seal ${w.seal}\x1b[39m`
			: ` · ${w.back ? (nf ? "\u{f054c}  " : "↩ ") : ""}${w.station}${w.task ? ` › ${w.task}` : ""}`;
	const line = `${dot}\x1b[39m ${planet} \x1b[38;5;248mstrategium: \x1b[39m${key}${where} · ${value}`;
	// The cockpit hint goes flush right when the terminal is wide enough. omp collapses runs of plain spaces in a
	// status line, so the padding is no-break spaces. shortcut: width read once per draw (no resize hook in omp), so a resize shows on the next tick or status refresh.
	// Measured as omp draws it: sanitizeHookStatusText collapses runs of spaces, even across colour codes.
	const pad = (process.stdout.columns ?? 0) - Bun.stringWidth(Bun.stripANSI(line).replace(/ +/g, " ")) - hint.length;
	return pad >= 2 ? `${line}${"\u00a0".repeat(pad)}\x1b[2m${hint}\x1b[22m` : line;
}

export default function (pi: ExtensionAPI, deps: { spawn?: Spawn; completeSimple?: CompleteSimple } = {}) {
	const spawn: Spawn = deps.spawn ?? Bun.spawn;
	// Imported on the first real call, not at load: the extension and its tests never pull pi-ai in otherwise (omp resolves the bare name to its bundled copy).
	const completeSimple: CompleteSimple = deps.completeSimple ?? (async (model, context, options) => (await import("@oh-my-pi/pi-ai")).completeSimple(model, context, options));
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
	// Every message to the user goes through here: plain sentences (omp adds its own Warning:/Error: prefix), and the same warning or error again within 2 s in one session is dropped (a command's own answer always shows).
	const NO_RUN = "No Strategium run in this session. Start one with /strategium <ticket>.";
	const up = (t: string) => t[0].toUpperCase() + t.slice(1);
	/** `t` as one sentence: a final period is added only when it has no terminal punctuation. */
	const end = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
	const lastNote = new Map<string, { text: string; at: number }>();
	const notify = (ctx: SessionCtx, text: string, level: "info" | "warning" | "error" = "info") => {
		const sid = sidOf(ctx);
		const now = Date.now();
		const last = lastNote.get(sid);
		if (level !== "info" && last?.text === text && now - last.at < 2000) return;
		lastNote.set(sid, { text, at: now });
		ctx.ui.notify(text, level);
	};
	/** The alarm could not start: `err` is signal()'s reason ("alarm failed: …"). */
	const alarmWarn = (ctx: SessionCtx, err: string) => notify(ctx, `The Strategium ${end(err)} Silence it with /strategium-config notify off.`, "warning");
	// /strategium-config notify on|off per session id; it wins over STRATEGIUM_NOTIFY (1, true, on, yes), which is off when unset.
	const notifyBySession = new Map<string, boolean>();
	const notifyOn = (sid: string) =>
		notifyBySession.get(sid) ?? /^(1|true|on|yes)$/i.test(process.env.STRATEGIUM_NOTIFY?.trim() ?? "");
	const notifyState = (sid: string) =>
		`${notifyOn(sid) ? "on" : "off"} (${notifyBySession.has(sid) ? "this session" : "STRATEGIUM_NOTIFY"})`;
	// /strategium-config sound|toast on|off per session id; they win over STRATEGIUM_SOUND / STRATEGIUM_TOAST, which are on unless 0, false, off or no.
	const soundBySession = new Map<string, boolean>();
	const toastBySession = new Map<string, boolean>();
	const switchOn = (m: Map<string, boolean>, env: string, sid: string) => m.get(sid) ?? !/^(0|false|off|no)$/i.test(process.env[env]?.trim() ?? "");
	const soundOn = (sid: string) => switchOn(soundBySession, "STRATEGIUM_SOUND", sid);
	const toastOn = (sid: string) => switchOn(toastBySession, "STRATEGIUM_TOAST", sid);
	const soundState = (sid: string) => `${soundOn(sid) ? "on" : "off"} (${soundBySession.has(sid) ? "this session" : "STRATEGIUM_SOUND"})`;
	const toastState = (sid: string) => `${toastOn(sid) ? "on" : "off"} (${toastBySession.has(sid) ? "this session" : "STRATEGIUM_TOAST"})`;
	/** The channels an alarm uses in this session: none when notify is off. */
	const channels = (sid: string) => (notifyOn(sid) ? [soundOn(sid) && "sound", toastOn(sid) && "toast"].filter(Boolean) as string[] : []);
	// /strategium-config archmagos on|off per session id; it wins over STRATEGIUM_ARCHMAGOS (1, true, on, yes), which is off when unset.
	const archmagosBySession = new Map<string, boolean>();
	// Task item name → the squad its brief builds, for the tier of a builder whose name is not its squad id. Not persisted: it only lives from the call to the spawn.
	const briefNames = new Map<string, string>();
	const archmagosOn = (sid: string) =>
		archmagosBySession.get(sid) ?? /^(1|true|on|yes)$/i.test(process.env.STRATEGIUM_ARCHMAGOS?.trim() ?? "");
	const archmagosState = (sid: string) =>
		`${archmagosOn(sid) ? "on" : "off"} (${archmagosBySession.has(sid) ? "this session" : "STRATEGIUM_ARCHMAGOS"})`;
	// /strategium-config commit on|off per session id; it wins over STRATEGIUM_COMMIT (1, true, on, yes), which is off when unset.
	const commitBySession = new Map<string, boolean>();
	const commitOn = (sid: string) => commitBySession.get(sid) ?? /^(1|true|on|yes)$/i.test(process.env.STRATEGIUM_COMMIT?.trim() ?? "");
	const commitState = (sid: string) => `${commitOn(sid) ? "on" : "off"} (${commitBySession.has(sid) ? "this session" : "STRATEGIUM_COMMIT"})`;
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
	// The alarm's volume (0-100): /strategium-config volume <n> per session wins over STRATEGIUM_VOLUME (parsed by vox, as the alarm would); neither → vox's default.
	const volumeBySession = new Map<string, number>();
	const volumeOf = (sid: string): number | undefined =>
		volumeBySession.get(sid) ?? (process.env.STRATEGIUM_VOLUME?.trim() ? volume(process.env) : undefined);
	const volumeState = (sid: string) =>
		`${volumeOf(sid) ?? volume({})} (${volumeBySession.has(sid) ? "this session" : volumeOf(sid) !== undefined ? "STRATEGIUM_VOLUME" : "default"})`;
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
			notify(
				ctx,
				err instanceof NewShift ? `Strategium run ${run.key} needs today's booking. Book it with /strategium-resume <min>.` : `Strategium could not resume the run: ${end(err instanceof Error ? err.message : String(err))} Try /strategium-resume again.`,
				"warning",
			);
		}
	};
	// The sessions already told that vox exited non-zero: one note each, not one per alarm.
	const alarmWarned = new Set<string>();
	const alarmExit = (sid: string, ctx: SessionCtx) => (code: number) => {
		if (alarmWarned.has(sid)) return;
		alarmWarned.add(sid);
		notify(ctx, `The Strategium alarm exited with code ${code}, so vox could not play. Check the audio player or silence it with /strategium-config notify off.`, "warning");
	};
	/** The alarm, only when notifications are on and sound or toast is: the message goes only with toasts, the sound flag always. */
	const alert = (sid: string, level: string, msg: string, ctx: SessionCtx) => {
		const ch = channels(sid);
		return ch.length ? signal(spawn, level, ch.includes("toast") ? msg : undefined, ch.includes("sound"), volumeOf(sid), alarmExit(sid, ctx)) : undefined;
	};

	// The cockpit theme: /strategium-config cockpit-theme saves one in the state dir, which wins over STRATEGIUM_COCKPIT_THEME;
	// unknown names fall through to the default. Unlike the key it applies at once: the palette is only read when drawing.
	const themeFile = () => path.join(stateDir(), "cockpit-theme");
	const themeSetting = (): { name: ThemeName; from: string } => {
		let saved = "";
		try {
			saved = readFileSync(themeFile(), "utf8").trim().toLowerCase();
		} catch {
			// no saved theme: fall through to the env and the default
		}
		const fromEnv = process.env.STRATEGIUM_COCKPIT_THEME?.trim().toLowerCase() ?? "";
		if (isTheme(saved)) return { name: saved, from: "/strategium-config" };
		if (isTheme(fromEnv)) return { name: fromEnv, from: "STRATEGIUM_COCKPIT_THEME" };
		return { name: DEFAULT_THEME, from: "default" };
	};
	let theme = themeSetting();
	let pal = palette(colorDepth(), THEMES[theme.name]);

	// The relic look: /strategium-config relic saves "on" or "off" in the state dir, which wins over STRATEGIUM_RELIC (1/0, anything else ignored); off by default.
	const relicFile = () => path.join(stateDir(), "relic");
	const relicSetting = (): { on: boolean; from: string } => {
		let saved = "";
		try {
			saved = readFileSync(relicFile(), "utf8").trim().toLowerCase();
		} catch {
			// no saved choice: fall through to the env and the default
		}
		const fromEnv = process.env.STRATEGIUM_RELIC?.trim() ?? "";
		if (saved === "on" || saved === "off") return { on: saved === "on", from: "/strategium-config" };
		if (fromEnv === "1" || fromEnv === "0") return { on: fromEnv === "1", from: "STRATEGIUM_RELIC" };
		return { on: false, from: "default" };
	};
	let relic = relicSetting();

	// The servo-skull: /strategium-config servo-skull saves "on" or "off" in the state dir, which wins over STRATEGIUM_SERVO_SKULL (1/0, anything else ignored); off by default.
	const servoSkullFile = () => path.join(stateDir(), "servo-skull");
	const servoSkullSetting = (): { on: boolean; from: string } => {
		let saved = "";
		try {
			saved = readFileSync(servoSkullFile(), "utf8").trim().toLowerCase();
		} catch {
			// no saved choice: fall through to the env and the default
		}
		const fromEnv = process.env.STRATEGIUM_SERVO_SKULL?.trim() ?? "";
		if (saved === "on" || saved === "off") return { on: saved === "on", from: "/strategium-config" };
		if (fromEnv === "1" || fromEnv === "0") return { on: fromEnv === "1", from: "STRATEGIUM_SERVO_SKULL" };
		return { on: false, from: "default" };
	};
	let servoSkull = servoSkullSetting();

	// Agent names (#133): /strategium-config names saves "on" or "off" in the state dir, which wins over STRATEGIUM_NAMES (1/0, anything else ignored); off by default.
	const namesFile = () => path.join(stateDir(), "names");
	const namesSetting = (): { on: boolean; from: string } => {
		let saved = "";
		try {
			saved = readFileSync(namesFile(), "utf8").trim().toLowerCase();
		} catch {
			// no saved choice: fall through to the env and the default
		}
		const fromEnv = process.env.STRATEGIUM_NAMES?.trim() ?? "";
		if (saved === "on" || saved === "off") return { on: saved === "on", from: "/strategium-config" };
		if (fromEnv === "1" || fromEnv === "0") return { on: fromEnv === "1", from: "STRATEGIUM_NAMES" };
		return { on: false, from: "default" };
	};
	let naming = namesSetting();
	const namesState = () => `${naming.on ? "on" : "off"} (${naming.from})`;

	// Vault records (#151): /strategium-config vault saves an absolute folder or "off" in the state dir, which wins over STRATEGIUM_VAULT (an absolute folder, anything else ignored); off by default.
	const vaultFile = () => path.join(stateDir(), "vault");
	const vaultSetting = (): { dir?: string; from: string } => {
		let saved = "";
		try {
			saved = readFileSync(vaultFile(), "utf8").trim();
		} catch {
			// no saved choice: fall through to the env and the default
		}
		const fromEnv = process.env.STRATEGIUM_VAULT?.trim() ?? "";
		if (saved.toLowerCase() === "off") return { from: "/strategium-config" };
		if (path.isAbsolute(saved)) return { dir: saved, from: "/strategium-config" };
		if (path.isAbsolute(fromEnv)) return { dir: fromEnv, from: "STRATEGIUM_VAULT" };
		return { from: "default" };
	};
	let vault = vaultSetting();
	const vaultLine = () => {
		if (!vault.dir) return `vault: off (${vault.from})`;
		const c = loadContract(vault.dir);
		return `vault: ${vault.dir} (${vault.from}) · ${"error" in c ? c.error : "contract ok"}`;
	};
	const vaultNoticed = new Set<string>();
	/** Append one line to the vault's daily. A failure is one notice per run and the run goes on; nothing here throws. */
	function vaultWrite(ctx: SessionCtx, run: Run, text: string): void {
		if (!vault.dir) return;
		let why: string | undefined;
		try {
			const c = loadContract(vault.dir);
			why = "error" in c ? c.error : recordLine(vault.dir, c.contract, stateDir(), new Date(), run.key, text);
		} catch (err) {
			why = err instanceof Error ? err.message : String(err);
		}
		const id = `${run.key} ${run.since}`;
		if (!why || vaultNoticed.has(id)) return;
		vaultNoticed.add(id);
		notify(ctx, `Strategium cannot write to the vault ${vault.dir}: ${why}. The run goes on, but this event is not in the vault; fix the folder or run /strategium-config vault off.`, "warning");
	}
	/** Record event `id` once per run: the id goes into the run file first, so a crash loses the line and never doubles it. Returns the run to carry on with. */
	function vaultEvent(ctx: SessionCtx, run: Run, id: string, text: string): Run {
		if (!vault.dir || run.recorded?.includes(id)) return run;
		const next = { ...run, recorded: [...(run.recorded ?? []), id] };
		try {
			writeRun(next);
		} catch {
			return run;
		}
		vaultWrite(ctx, next, text);
		return next;
	}
	// The names issued in this omp process, per session, across its runs: omp suffixes an id it has already seen, so a campaign's next run avoids them. Lost on restart.
	const issuedBySession = new Map<string, Set<string>>();
	const issuedFor = (sid: string) => {
		const set = issuedBySession.get(sid) ?? new Set<string>();
		issuedBySession.set(sid, set);
		return set;
	};
	const servoSkullConfigLine = () => {
		const every = parseEvery(process.env.STRATEGIUM_SERVO_SKULL_EVERY_MIN);
		const alias = parseAlias(process.env.STRATEGIUM_SERVO_SKULL_MODEL);
		const raw = process.env.STRATEGIUM_SERVO_SKULL?.trim() ?? "";
		const ignored = [raw && raw !== "1" && raw !== "0" ? `STRATEGIUM_SERVO_SKULL "${chars(oneLine(raw), 40)}"` : "", every.ignored === undefined ? "" : `STRATEGIUM_SERVO_SKULL_EVERY_MIN "${every.ignored}"`].filter(Boolean);
		// The old names are not read: they are listed with the new ones.
		ignored.push(...Object.keys(process.env).filter(k => k.startsWith("STRATEGIUM_CASTER")).map(k => `${k} (now ${k.replace("CASTER", "SERVO_SKULL")})`));
		if (existsSync(path.join(stateDir(), "caster"))) ignored.push("saved file caster (now servo-skull; can be deleted)");
		const resolved = "alias" in alias && cockpit.servoSkull.spend?.model ? ` → ${cockpit.servoSkull.spend.model}` : "";
		return `servo-skull: ${servoSkull.on ? "on" : "off"} (${servoSkull.from}) · model ${"alias" in alias ? alias.alias : alias.error}${resolved} · every ${every.min} min${ignored.length ? ` · ignored: ${ignored.join(", ")}` : ""}${servoSkull.on ? " · ask: /strategium-skull <question>" : ""}`;
	};

	// The cockpit: an overlay on demand while this session has a run. Everything it shows beyond the run file
	// (chronicle, squad notes, agent ids) lives in memory, keyed by run key, and drawCockpit saves it beside the run in
	// runs/<sid>.cockpit when it changed (dirty), so the plan-approval move and an omp restart both keep it.
	const cockpit = {
		key: undefined as string | undefined,
		chronicle: [] as Entry[],
		station: undefined as string | undefined, // the station the chronicle last saw, kept across a rebuild init so the next done does not log it again
		asked: undefined as string | null | undefined, // the seal the chronicle last saw waiting (null: none); undefined: not known yet
		notes: {} as Record<string, Note>,
		dirty: false,
		seal: undefined as { id: string; lines: string[] } | undefined, // what the Captain prepared for the seal that waits (the `seal` action)
		deployed: new Map<string, Deployed>(),
		roster: undefined as { n: number; brothers: Brothers } | undefined, // roster.json as read for a run with `n` names, names on only: a brother's record cannot change while his run holds him, a new name may be one the file now knows. Never an unreadable read
		final: new Map<string, Live | undefined>(), // a finished agent's live row: read once, a miss re-read while its agent's or squad's detail is open (undefined: none found); memory only
		clock: undefined as ViewInput["clock"],
		view: undefined as View | undefined,
		input: undefined as ViewInput | undefined, // the last view input, so a cursor key recomputes the view without reading files
		transcript: undefined as TranscriptRead | undefined, // the rows of the open transcript, with the stamp of the files they came from; read by Enter and by the redraw while it is open
		nav: {} as Nav, // the cursor and browsed station: in memory only, never saved
		overlay: undefined as Tui | undefined,
		status: undefined as "working" | "awaiting" | undefined,
		close: undefined as (() => void) | undefined,
		debrief: undefined as { key: string; lines: string[] } | undefined, // the final screen: set at `end` while the overlay is open, so the overlay outlives the run
		servoSkull: {} as ServoSkullState,
	};
	/** At most n characters, a cut one ending in `…`. */
	const brief = (s: string, n: number) => ([...s].length > n ? `${chars(s, n - 1)}…` : s);
	let cockpitWidth = 0; // the width the open cockpit was last drawn at; 0 before its first render
	const SEAL_LINES = 200;
	const SEAL_LINE_CHARS = 500;
	/** Abort the servo-skull's call in flight, if any: it no longer counts as in flight, its reply is not shown, and its attempt is forgotten so a reopened cockpit calls again. */
	const abortServoSkull = () => {
		const c = cockpit.servoSkull;
		if (!c.ctrl) return;
		c.ctrl.abort();
		c.ctrl = undefined;
		c.lastAt = undefined;
		c.lastHash = undefined;
	};
	const resetCockpit = (key?: string) => {
		abortServoSkull();
		cockpit.servoSkull.ask?.abort();
		cockpit.servoSkull = {};
		cockpit.key = key;
		cockpit.chronicle = [];
		cockpit.station = undefined;
		cockpit.asked = undefined;
		cockpit.notes = {};
		cockpit.deployed.clear();
		cockpit.roster = undefined;
		cockpit.final.clear();
		cockpit.clock = undefined;
		cockpit.seal = undefined;
		cockpit.nav = {};
		cockpit.transcript = undefined;
		cockpit.debrief = undefined;
		cockpit.dirty = key !== undefined;
	};
	/** The open transcript's rows (the one nav names; undefined with none open): the files are stat'ed and read again only when their size or mtime changed. */
	let readAt = 0;
	const readOpen = (ctx: SessionCtx) => {
		const id = cockpit.nav.detail?.transcript;
		if (id === undefined) return undefined;
		const now = Date.now();
		if (cockpit.transcript?.id === id && now - readAt < 1000 && now >= readAt) return cockpit.transcript; // at most one stat per second
		readAt = now;
		return readTranscript(ctx.sessionManager.getSessionFile?.(), id, cockpit.deployed.get(id)?.state !== "active", cockpit.transcript);
	};
	/** Take the saved state of this session's run, replacing memory; a missing, corrupt or other-key file is a clean start. */
	const loadCockpit = (sid: string, key: string) => {
		try {
			const saved = JSON.parse(readFileSync(cockpitFile(sid), "utf8"));
			const jobs: unknown = saved.deployed;
			const shaped =
				saved.key === key &&
				Array.isArray(saved.chronicle) && saved.chronicle.every((e: unknown) => e && typeof e === "object" && typeof (e as Entry).text === "string") &&
				saved.notes && typeof saved.notes === "object" && !Array.isArray(saved.notes) &&
				Array.isArray(jobs) && jobs.every(d => Array.isArray(d) && typeof d[0] === "string" && d[1] && typeof d[1] === "object") &&
				(saved.seal === undefined || (!!saved.seal && typeof saved.seal.id === "string" && Array.isArray(saved.seal.lines) && saved.seal.lines.every((l: unknown) => typeof l === "string")));
			if (!shaped) throw new Error("another run's or a malformed state");
			resetCockpit(key);
			cockpit.chronicle = (saved.chronicle as Entry[]).slice(-CHRONICLE_CAP).map(({ agent, ...e }) => (typeof agent === "string" ? { ...e, agent } : e)); // an agent id that is not a string is dropped; the view checks it against the registry
			cockpit.notes = saved.notes;
			for (const [id, job] of saved.deployed as [string, Deployed][]) {
				// Hand-edited or damaged numbers are read as absent.
				for (const k of ["at", "ended", "stalled"] as const) if (typeof job[k] !== "number") delete job[k];
				if (job.blocked !== true) delete job.blocked;
				if (typeof job.name !== "string") delete job.name;
				cockpit.deployed.set(id, job);
			}
			cockpit.seal = saved.seal && { id: saved.seal.id, lines: saved.seal.lines.slice(0, SEAL_LINES).map((l: string) => l.slice(0, SEAL_LINE_CHARS)) };
			cockpit.servoSkull.spend = servoSkullSpend(savedServoSkull(saved)); // a malformed field is none; it never voids the rest
			cockpit.dirty = false;
		} catch {
			resetCockpit(key);
		}
	};
	const log = (key: string, who: string, text: string, tone?: Entry["tone"], agent?: string) => {
		if (cockpit.key !== key) resetCockpit(key);
		cockpit.chronicle = pushEntry(cockpit.chronicle, { at: new Date().toTimeString().slice(0, 5), who, text, ...(tone ? { tone } : {}), ...(agent ? { agent } : {}) });
		cockpit.dirty = true;
	};
	/** The live row of an agent, unless the file is older than this deploy (a previous agent's with the same id). */
	const ownRow = (sid: string, id: string, job: Deployed) => {
		const row = readLive(sid, id);
		return row && row.since >= (job.at ?? 0) ? row : undefined;
	};
	/** A deployed agent ended: log it once, keep it in the registry as done or failed, and note its squad as failed or not. */
	const endJob = (key: string, id: string, ok: boolean) => {
		const job = cockpit.deployed.get(id);
		if (job?.state !== "active") return;
		job.state = ok ? "done" : "failed";
		job.ended = Date.now();
		if (job.squad) cockpit.notes[job.squad] = { ...(cockpit.notes[job.squad]?.veteran ? { veteran: true as const } : {}), ...(ok ? {} : { failed: true as const }) };
		log(key, job.who, `${ok ? "✓" : "✗"} ${naming.on && job.name ? `${job.name} ` : ""}${ok ? "returned" : "failed"}`, ok ? "ok" : "fail", id);
	};
	/** Idle for the host with nothing queued and no background job running: the prompt is free for the user's orders. */
	const agentStatus = (ctx: SessionCtx) =>
		ctx.isIdle() && !ctx.hasPendingMessages() && !ctx.getAsyncJobSnapshot()?.running.length ? "awaiting" : "working";
	/** An open cockpit shows the agent's state at once, without rebuilding the run. The host's state decides (it already streams before agent_start). */
	const setAgentStatus = (ctx: SessionCtx) => {
		cockpit.status = agentStatus(ctx);
		if (cockpit.view?.status === cockpit.status || !cockpit.overlay) return;
		cockpit.view = { ...cockpit.view!, status: cockpit.status };
		cockpit.overlay.requestRender();
	};

	/** Rebuild the view from the run and the in-memory state, then repaint an open overlay. Never ticks the timer. */
	const drawCockpit = (run: Run, ctx: SessionCtx) => {
		if (cockpit.key !== run.key) resetCockpit(run.key);
		// What each active agent wrote about itself. A stalled one (no tool call in flight, none ended for 5 min) is logged once per `at`.
		const now = Date.now();
		const rows = new Map<string, Live>();
		for (const [id, job] of cockpit.deployed) {
			if (job.state !== "active") {
				// shortcut: a valid row is read once, so what the agent wrote after it is lost; a miss (no file yet, a rename in flight, half a file) is read again only while its detail is open; upgrade if the detail of a returned agent must keep following its file.
				if (!cockpit.final.get(id) && (!cockpit.final.has(id) || cockpit.nav.detail?.id === `agent:${id}` || (!!job.squad && cockpit.nav.detail?.id === `squad:${job.squad}`))) cockpit.final.set(id, ownRow(run.sid, id, job));
				const r = cockpit.final.get(id);
				if (r) rows.set(id, r);
				continue;
			}
			cockpit.final.delete(id); // an id spawned again drops the row of the agent that ended under it
			// A file older than this deploy is a previous agent's with the same id.
			const row = ownRow(run.sid, id, job);
			if (row) rows.set(id, row);
			// A row that stopped saying it is blocked re-arms the alarm for the next block.
			if (row && !row.blocked && job.blocked) {
				delete job.blocked;
				cockpit.dirty = true;
			}
			// shortcut: a block undone before the parent's next read (≤1 s with the cockpit open, ≤60 s closed) is never seen; upgrade if agents unblock themselves that fast.
			if (row?.blocked === true) {
				// Once per transition. A blocked row still falls through to the stall rule below.
				if (!job.blocked) {
					job.blocked = true;
					const line = cap(oneLine(row.line));
					log(run.key, job.who, line ? `blocked: ${line}` : "blocked", "warn", id);
					const err = alert(run.sid, "attention", `${run.key}: ${job.who} is blocked${line ? `: ${line}` : ""}`, ctx);
					if (err) alarmWarn(ctx, err);
				}
			}
			// The idle period starts at the last tool call; an agent with no live row has nothing to count from (it may be an eval spawn or another process), so it is never stalled.
			const start = row?.at ?? 0;
			if (!start || row?.busy || now - start < STALL_MS || job.stalled === start) continue;
			job.stalled = start;
			log(run.key, job.who, `stalled ${Math.floor((now - start) / 60_000)}m`, "warn", id);
		}
		cockpit.transcript = readOpen(ctx);
		const n = run.names?.length ?? 0;
		const roster = naming.on ? (cockpit.roster?.n === n ? cockpit.roster : loadRoster(stateDir())) : { brothers: {} };
		if (naming.on) cockpit.roster = "error" in roster ? undefined : { n, brothers: roster.brothers };
		cockpit.input = {
			live: rows,
			now,
			key: run.key,
			untimed: cockpit.clock?.bk ? undefined : run.untimed,
			glyphs: process.env.STRATEGIUM_GLYPHS === "1",
			deployed: cockpit.deployed,
			phases: run.phases,
			ratings: run.ratings,
			slices: run.slices,
			stopped: run.stopped,
			agents: run.agents,
			notes: cockpit.notes,
			status: cockpit.status,
			clock: cockpit.clock,
			chronicle: cockpit.chronicle,
			seal: cockpit.seal,
			servoSkull: servoSkull.on ? (cockpit.servoSkull.answer ? { station: `answer to "${brief(cockpit.servoSkull.answer.question, 40)}"`, text: cockpit.servoSkull.answer.text, dim: false, at: cockpit.servoSkull.answer.at } : { station: cockpit.servoSkull.station ?? activeStation(run.phases ?? []) ?? "no station yet", text: cockpit.servoSkull.text ?? "listening…", dim: cockpit.servoSkull.text === undefined || cockpit.servoSkull.dim === true, at: cockpit.servoSkull.at }) : undefined,
			transcript: cockpit.transcript,
			names: naming.on ? { squads: squadBrothers(cleanNames(run.names), "brothers" in roster ? roster.brothers : undefined), ...("error" in roster ? { unreadable: true as const } : {}) } : undefined,
		};
		cockpit.view = cockpitView({ ...cockpit.input, nav: cockpit.nav });
		cockpit.nav = cockpit.view.nav; // normalized: a browsed station is dropped when the active one moved
		if (cockpit.dirty) {
			try {
				writeAtomic(cockpitFile(run.sid), JSON.stringify({ key: cockpit.key, chronicle: cockpit.chronicle, notes: cockpit.notes, deployed: [...cockpit.deployed], ...(cockpit.seal ? { seal: cockpit.seal } : {}), ...(cockpit.servoSkull.spend?.calls ? { "servo-skull": cockpit.servoSkull.spend } : {}) }));
				cockpit.dirty = false;
			} catch {
				// Kept dirty: the next draw tries again.
			}
		}
		cockpit.overlay?.requestRender();
	};
	/** The call itself: STRATEGIUM_SERVO_SKULL_FAKE answers with that text (replays); otherwise the role alias is resolved through the host and completeSimple is asked. A reason string means no call is made. */
	const servoSkullPrepare = (ctx: SessionCtx): { complete: Complete } | { reason: string } => {
		const fake = process.env.STRATEGIUM_SERVO_SKULL_FAKE;
		if (fake) return { complete: async () => ({ text: fake, cost: 0, tokens_in: 0, tokens_out: 0 }) };
		const a = parseAlias(process.env.STRATEGIUM_SERVO_SKULL_MODEL);
		if ("error" in a) return { reason: a.error };
		// The host's model API is guarded: a missing or throwing one is a reason row, never an error in the timer.
		let model: HostModel | undefined;
		let authed = false;
		try {
			model = ctx.models?.resolve?.(a.alias);
			authed = !!model && ctx.modelRegistry?.hasConfiguredAuth?.(model) === true;
		} catch {
			// treated as unresolved
		}
		if (!model) return { reason: `no model for ${chars(a.alias, 40)}` };
		if (!authed) return { reason: "no auth" };
		const sid = sidOf(ctx);
		return {
			complete: async (system, user, signal) => {
				const m = await completeSimple(model, { systemPrompt: [system], messages: [{ role: "user", content: user, timestamp: Date.now() }] }, { apiKey: ctx.modelRegistry!.resolver!(model, sid), disableReasoning: true, maxTokens: 200, signal });
				const u = m.usage;
				return {
					text: (m.content ?? []).filter(p => p.type === "text").map(p => p.text ?? "").join(" "),
					cost: u?.cost?.total,
					tokens_in: u?.input,
					tokens_out: u?.output,
					cache_read: u?.cacheRead,
					cache_write: u?.cacheWrite,
					model: typeof model.id === "string" ? chars(oneLine(model.id), 40) : undefined,
					...(m.stopReason === "error" || m.stopReason === "aborted" ? { failed: true as const, error: m.stopReason === "error" ? m.errorMessage : undefined } : {}),
				};
			},
		};
	};
	/** A reply that came back was paid, shown or not: count it in the servo-skull's spend (the debrief row). */
	const countSpend = (c: ServoSkullState, reply: ServoSkullReply | undefined) => {
		if (!reply) return;
		const n = (x: number | undefined) => (typeof x === "number" && Number.isSafeInteger(x) && x > 0 ? x : 0);
		const spend = (c.spend ??= { cost: 0, calls: 0, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0 });
		if (reply.model) spend.model = reply.model;
		spend.cost += isCost(reply.cost) ? reply.cost : 0;
		spend.calls++;
		spend.tokens_in += n(reply.tokens_in);
		spend.tokens_out += n(reply.tokens_out);
		spend.cache_read += n(reply.cache_read);
		spend.cache_write += n(reply.cache_write);
		cockpit.dirty = true;
	};
	/** On a servo-skull tick of the open cockpit: start one summary when it is due (see `due`). The attempt is stamped when it starts, so a failure waits for a new state and a new interval and never loops. */
	const servoSkullTick = (ctx: SessionCtx) => {
		const c = cockpit.servoSkull;
		if (!servoSkull.on || !cockpit.input) return;
		const view = cockpitView({ ...cockpit.input });
		const hash = stateHash(view, cockpit.input.live, cockpit.chronicle);
		const now = Date.now();
		if (!due({ on: true, now, everyMs: parseEvery(process.env.STRATEGIUM_SERVO_SKULL_EVERY_MIN).min * 60_000, lastAt: c.lastAt, inFlight: !!c.ctrl, hash, lastHash: c.lastHash })) return;
		c.lastAt = now;
		c.lastHash = hash;
		const station = view.station.name;
		// The run may have ended while a call was in flight: then nothing is drawn and no file is written.
		const redraw = () => {
			const r = readRun(sidOf(ctx));
			if (r) drawCockpit(r, ctx);
		};
		const prep = servoSkullPrepare(ctx);
		if ("reason" in prep) {
			Object.assign(c, { text: prep.reason, dim: true, station, at: undefined });
			return redraw();
		}
		const startedAt = Date.now();
		const ctrl = new AbortController();
		const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(30_000)]);
		const facts = servoSkullFacts(view, cockpit.input.live, cockpit.chronicle);
		c.ctrl = ctrl; // set last: a throw above leaves no call in flight
		summarize(prep.complete, station, facts, signal)
			.then(r => {
				if (c.ctrl === ctrl) c.ctrl = undefined;
				if (cockpit.servoSkull !== c || !readRun(sidOf(ctx))) return; // the run was reset or has ended meanwhile: the reply is not counted or drawn
				// A reply that arrives after an abort is not shown, but it was paid.
				countSpend(c, r.reply);
				if (!ctrl.signal.aborted) {
					Object.assign(c, { text: r.text, dim: r.dim, station, at: r.dim ? undefined : Date.now() });
					if (!r.dim && c.answer && c.answer.at < startedAt) delete c.answer; // a summary that started after the answer arrived replaces it
				}
				redraw();
			})
			.catch(() => {
				// A summary never throws into the host; the next attempt waits for a new state.
			});
	};
	const openCockpit = (ctx: SessionCtx) => {
		if (ctx.agent?.kind === "sub") return;
		const run = ownRun(sidOf(ctx));
		if (!run) return notify(ctx, NO_RUN, "warning");
		if (!ctx.hasUI || typeof ctx.ui.custom !== "function") return notify(ctx, "The Strategium cockpit needs the interactive UI. Open it from the omp terminal with /strategium-cockpit.", "warning");
		if (cockpit.close) return;
		cockpit.status = agentStatus(ctx);
		cockpit.nav = {}; // a reopened cockpit starts clean
		cockpit.transcript = undefined;
		drawCockpit(run, ctx);
		const closed = () => {
			abortServoSkull();
			cockpit.close = undefined;
			cockpit.overlay = undefined;
			cockpit.nav = {}; // a closed cockpit reads no transcript on a later redraw
			cockpit.transcript = undefined;
			cockpit.debrief = undefined;
		};
		// Not awaited: the command returns at once and the overlay lives until Esc or q.
		Promise.resolve(
			ctx.ui.custom(
				(tui, _theme, _keys, done) => {
					let frame = 0;
					let open = true; // a timer callback the host still holds after close does nothing
					const timer = setInterval(() => {
						try {
							if (!open || cockpit.debrief) return; // the final screen is static: nothing to redraw until esc/q or a new run
							frame++;
							if (live) setAgentStatus(live); // the host's idle flag lags agent_end, and the last job ending sends no event
							// Every second frame the children's files are read again: at most once a second.
							// readRun, not ownRun: a transient lock read failure must not drop the run.
							const own = frame % 2 === 0 ? readRun(sidOf(ctx)) : undefined;
							if (own) {
								drawCockpit(own, ctx);
								servoSkullTick(ctx);
							}
							tui.requestRender();
						} catch {
							// A timer never throws; the next frame tries again.
						}
					}, 500);
					const close = () => {
						open = false;
						clearInterval(timer);
						closed();
						done();
					};
					cockpit.overlay = tui;
					cockpit.close = close;
					return {
						render: width => ((cockpitWidth = width), cockpit.debrief ? renderDebrief(cockpit.debrief.key, cockpit.debrief.lines, width, pal, tui.terminal.rows) : renderCockpit(cockpit.view!, width, frame, pal, tui.terminal.rows, relic.on)),
						handleInput: data => {
							const act = keyAction(data, !!cockpit.nav.detail);
							if (act === "close") return close();
							if (cockpit.debrief) return; // the final screen takes no other key
							if (!act || !cockpit.view || !cockpit.input) return;
							const open = cockpit.nav.detail?.transcript;
							cockpit.nav = navigate(cockpit.view, act);
							if (cockpit.nav.detail?.transcript !== open) {
								// Enter opening a transcript is the one key that reads a file; closing it drops the rows.
								cockpit.transcript = readOpen(ctx);
								cockpit.input = { ...cockpit.input, transcript: cockpit.transcript };
							}
							cockpit.view = cockpitView({ ...cockpit.input, status: cockpit.status, nav: cockpit.nav });
							cockpit.nav = cockpit.view.nav;
							tui.requestRender();
						},
						dispose: () => {
							open = false;
							clearInterval(timer);
							if (cockpit.close === close) closed(); // the host tore it down: free the cockpit so it opens again; an old overlay disposed late must not touch the current one
						},
					};
				},
				{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true, mouseTracking: false } },
			),
		).catch(() => (cockpit.close ?? closed)());
	};

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

	/** Begin `key` for the session: the tool's `begin` and the /strategium command both come here, so the edit guard is armed the same way. */
	async function beginRun(sid: string, key: string, theatre: string, booked: number | undefined, spent: number | undefined, takeover: string | undefined, archmagos: boolean | undefined, ctx: SessionCtx, ownRepo?: { repo?: string }, via?: Via): Promise<string> {
		// A session that lost its ticket drops its files here; its in-memory cockpit goes too, or a begin of the same key would bring it back.
		if (!ownRun(sid)) resetCockpit();
		begin(sid, key, theatre, booked, spent, takeover, ownRepo, via);
		// A takeover moved the saved cockpit to this session: load it, or the first draw saves an empty one over it.
		if (cockpit.key !== key) loadCockpit(sid, key);
		// A block start always restarts the idle count.
		idleSince = undefined;
		const run = ownRun(sid)!;
		const hid = await hideCaptainTools();
		const begun = {
			...run,
			hidden: [...new Set([...(run.hidden ?? []), ...hid])],
			// Omitted keeps what a same-key begin stored; false clears it.
			...(archmagos !== undefined ? { archmagos: archmagos || undefined } : {}),
		};
		writeRun(begun);
		vaultEvent(ctx, begun, "begin", "run begun");
		return statusLines();
	}

	/** End the session's run. When it was its own, the tools come back and the Strategium theme plays; a takeover end does neither. */
	async function finish(sid: string, ctx: SessionCtx, key?: string, takeover?: string, reported?: Reported): Promise<string> {
		const mine = ownRun(sid);
		// endRun picks the same run and deletes its file: the end line is built from this copy.
		const target = vault.dir ? (key && key !== mine?.key ? allRuns().find(r => r.key === key) : mine) : undefined;
		const out: { summary?: string[] } = {};
		const result = endRun(sid, key, takeover, reported, cockpit, naming.on, out);
		if (target && result.split("\n", 1)[0] === `ENDED ${target.key}`) {
			const time = result.split("\n").find(l => l.startsWith("TIME "))?.slice(5).split(":")[0];
			vaultWrite(ctx, target, `run ended${target.merged ? ", PR merged" : ""}${time ? ` (${time})` : ""}`);
		}
		if (mine && result.split("\n", 1)[0] === `ENDED ${mine.key}`) {
			// An open cockpit stays up as the final screen; a closed one is not opened.
			if (cockpit.close && out.summary) {
				abortServoSkull(); // no run left to cast about
				cockpit.nav = {}; // an open detail must not make esc a "back" on the final screen
				cockpit.transcript = undefined;
				cockpit.debrief = { key: mine.key, lines: [...out.summary, ...(mine.merged ? ["PR merged"] : [])] };
				cockpit.overlay?.requestRender();
			}
			await restoreTools(mine.hidden);
			const err = alert(sid, "theme", `${mine.key}: run ended`, ctx);
			if (err) alarmWarn(ctx, err);
		}
		return result;
	}

	// Only the owning session alerts for its key, so each alert fires once.
	const maybeAlert = (ctx: SessionCtx, sid: string, file: string, evs: Ev[], key: string, now: Date, el: number, bk: number) => {
		const p = dueAlert(evs, key, now);
		if (p === undefined) return;
		const pool = poolOf(evs, key, now);
		const shared = pool ? `shared via ${pool.parent}: ${pool.keys.join("+")}` : "";
		// shortcut: two sessions ticking within the same milliseconds can both read "not alerted yet" and both alert; upgrade to an exclusive marker file if doubles are ever seen.
		append(file, { ts: nowIso(), event: "alert", key, p, ...(pool ? { pool: pool.parent } : {}) });
		notify(ctx, `${p}% of the Strategium booking for ${key} is used${pool ? ` (${shared})` : ""}.${p === 100 ? " Add time with /strategium-add <min> or wrap up the run." : ""}`, p === 100 ? "warning" : "info");
		const alarmError = alert(sid, String(p), `${key}: ${p}% of the booking (${el}/${bk} min${pool ? `, ${shared}` : ""})`, ctx);
		if (alarmError) alarmWarn(ctx, alarmError);
		log(key, "TIMER", `⧗ ${p}% of the booking`);
		pi.sendMessage(
			{ customType: "strategium-timer", content: `TIMER ${p}% ${key} ${el}/${bk} min${pool ? ` via ${pool.parent} (shared ${pool.keys.join("+")})` : ""}`, display: true, attribution: "agent" },
			{ deliverAs: "aside", triggerTurn: true },
		);
	};
	const tick = () => {
		const ctx = live;
		if (!ctx) return;
		try {
			const sid = sidOf(ctx);
			const found = ownRun(sid);
			if (!found) {
				if (!cockpit.debrief) cockpit.close?.(); // the final screen waits for esc/q
				return ctx.ui.setStatus("strategium", undefined);
			}
			// A gap in our own heartbeats means the machine slept: close the block at the last beat and stay paused.
			// A session that was idle-counting is marked like the idle pause, so its next turn resumes the run.
			const counting = idleSince !== undefined;
			const gap = closeGap(found);
			if (gap) {
				if (counting) writeRun({ ...found, idle: true });
				const at = gap.slice(11, 16);
				notify(
					ctx,
					`Strategium run ${found.key} paused at ${at} because this session was silent since then (sleep or freeze). ${counting ? "Your next prompt resumes it." : "Continue with /strategium-resume."}`,
					"warning",
				);
				const alarmErr = alert(sid, "attention", `${found.key}: paused at ${at} after a silent gap; resume when you are back`, ctx);
				if (alarmErr) alarmWarn(ctx, alarmErr);
			}
			beat(sid);
			// Busy: the model is streaming (an `ask` waits for the user inside a stream), messages are queued, a background
			// job runs (agent_end can fire while one still does) or a plan review is open.
			// ponytail: an `ask` or review the user forgot keeps the clock counting; it sounds `attention` once, no timeout.
			// A background job that never ends (e.g. a bash watcher with timeout 0) keeps the session busy too, so the idle pause never fires.
			const busy = !ctx.isIdle() || ctx.hasPendingMessages() || (ctx.getAsyncJobSnapshot()?.running.length ?? 0) > 0 || !!ctx.getPendingPlanReview();
			const openIn = openFile(found.key);
			let running = openIn !== undefined;
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
				notify(ctx, `Strategium run ${found.key} paused after ${limitMin} min idle. Your next prompt resumes it.`, "info");
				const err = alert(sid, "idle", `${found.key}: paused, idle ${limitMin} min`, ctx);
				if (err) alarmWarn(ctx, err);
			}
			// A block still open at midnight goes on in the new day: yesterday's ends at 00:00 and today's starts there. Without a
			// booking, so a timed run counts with no alerts until /strategium-resume <min> gives today's. After the idle check: an idle stop
			// stamped before midnight must land in yesterday's file, not after today's 00:00 start.
			if (running && openIn !== today()) {
				const midnight = nowIso(new Date(new Date().setHours(0, 0, 0, 0)));
				append(openIn!, { ts: midnight, event: "stop", key: found.key });
				append(today(), { ts: midnight, event: "start", key: found.key });
			}
			const file = today();
			const evs = load(file);
			const key = found.key;
			const now = new Date();
			const pool = poolOf(evs, key, now);
			const el = Math.floor(pool ? pool.el : elapsedMin(evs, key, now));
			const bk = (pool ? pool.booked : bookedMin(evs, key)) ?? 0;
			ctx.ui.setStatus("strategium", renderFooter(found, evs, running, el, bk, cockpitHint(cockpitKey.key)));
			// A paused run never alerts. Reset first, so the clock stored below is not wiped by the first draw of a new key.
			if (cockpit.key !== key) resetCockpit(key);
			if (running) maybeAlert(ctx, sid, file, evs, key, now, el, bk);
			cockpit.clock = { running, el, ...(bk ? { bk } : {}) };
			drawCockpit(found, ctx);
		} catch (err) {
			notify(ctx, `The Strategium timer failed: ${err instanceof Error ? err.message : String(err)}. Check the state folder, or end the run with /strategium-end.`, "warning");
		}
	};
	pi.setLabel("Strategium");

	const count = z.number().int().nonnegative().optional();
	const schema = z.object({
		action: z.enum(["begin", "repo", "start", "stop", "add", "status", "report", "end", "switch", "attention", "notify", "slices", "redraft", "name", "reuse", "rate", "seal", "signal", "record"]),
		key: z.string().optional(),
		booked: z.number().int().positive().optional(),
		via: z.object({ key: z.string(), reason: z.enum(VIA_REASONS) }).optional(),
		spent: z.number().int().nonnegative().optional(),
		theatre: z.string().optional(),
		repo: z.string().optional(),
		date: z.string().optional(),
		takeover: z.string().optional(),
		message: z.string().optional(),
		minutes: z.number().int().optional(),
		on: z.boolean().optional(),
		archmagos: z.boolean().optional(),
		reported: z
			.object({
				apothecary: z.object({ killed: count, survived: count, crashes: count }).optional(),
				review: z.object({ pass: count, fail: count, opened: count, fixed: count, not_reproduced: count }).optional(),
			})
			.optional(),
		slices: z.array(z.object({ id: z.string(), parallel: z.boolean(), files: z.array(z.string()), tier: z.enum(["light", "standard", "heavy"]).optional() })).optional(),
		lines: z.array(z.string()).optional(),
		pct: z.number().int().min(0).max(100).optional(),
		eta_min: z.number().int().min(0).max(10080).optional(),
		line: z.string().optional(),
		blocked: z.boolean().optional(),
		agent: z.string().optional(),
		rating: z.enum(["proven", "proven-regression", "corrupted"]).optional(),
		evidence: z.array(z.string()).optional(),
		model: z.string().optional(),
		effort: z.string().optional(),
		squad: z.string().optional(),
		again: z.boolean().optional(),
		source: z.string().optional(),
		text: z.string().optional(),
		note: z.string().optional(),
	});

	pi.registerTool({
		name: "strategium",
		label: "Strategium",
		description:
			"Strategium run state and booking timer, one run per omp session (other sessions may run other tickets in parallel). Actions: begin (key, booked?, via?, spent?, theatre?, takeover?, archmagos?), repo (repo), start (booked?), stop, add (minutes), status, report (date?), end (key?, takeover?, reported?), switch (key, booked?, via?, takeover?), attention (message), notify (on?), slices (slices), redraft, name (agent, squad?, again?, source?), reuse (squad), rate (agent, rating, evidence, model, effort), seal (lines), signal (pct?, eta_min?, line?, blocked?; subagents only, your own cockpit row), record (text, note?; Captain only). booked is optional: without it the run is untimed, its time is counted but there are no 50/80/100 % alerts and no new shifts. via = {key, reason: parent booking|estimate}, only with booked, when the booking is not the key's own (the theatre's lookup); keys booked through the same parent share that booking's alerts; a booked without via drops it; a new day drops it. spent = minutes already worked on the key today that strategium has not tracked; they count toward the 50/80/100 % alerts. start resumes the run; start (or begin again) with booked makes an untimed run timed, and its minutes so far count toward the booking; on a new day it opens a new shift that counts from 0 (pass today's booked minutes; else the last booking is reused). add = a manual correction of today's time in whole minutes, negative to subtract. switch ends this session's run (a normal end) and begins key in one call, keeping theatre and repo; booked is the new key's own (none = untimed), never the old one's; takeover names the holder of key. takeover = the id of a crashed session that holds the ticket, as given in the refusal; only the user decides that session is gone. attention plays the attention sound and shows a desktop notification with the message: use it whenever the user must act (a seal, a question, a blocker, a finished run). notify turns this session's sounds and desktop notifications on or off (on: true/false; without on it only reports the state); it wins over env STRATEGIUM_NOTIFY, which is off by default; set it only when the user asks. The user picks the alarm's channels with /strategium-config sound|toast on|off; attention reports the channels that fired. slices (slices: [{id, parallel, files, tier?}]: the plan's squads; tier is light, standard (default) or heavy, and the plugin runs that squad's battle-brothers on that tier's model, so name each task item after its squad id (with names on, after the name from the name action); parallel squads must not share a file; required before any battle-brother). A squad whose battle-brothers and veterans have all stopped (known when the task item's name is the squad id or its brief says build squad <id>, or when its name came from the name action) no longer counts: listing it again gives WARN lines before the result instead of an ERROR. No builder may start on files another running builder is changing. begin with archmagos: true marks the run for the Archmagos Dominus (false clears the mark; omitted keeps it); the plugin spawns one only when the setting is on, the run is marked and 2 librarians finished. status ends with the archmagos, tiers, notify, sound, toast and names settings. redraft (no params) records the run's one redraft (in both plan paths; a second is refused) and sends the run back to Auspex; it makes the run's builder names obsolete. name (agent, squad?, again?) hands out the agent's lore name and answers NAME <name> or ERROR <reason>. It works only with names on (status shows NAMES on|off (<source>); /strategium-config names on|off|default or env STRATEGIUM_NAMES=1; off by default, and then it answers ERROR). agent is a roster agent; squad, a declared squad id, is required for battle-brother and veteran and refused for the other agents; again: true keeps a non-builder agent's persona; source (battle-brother and veteran only) is the name of a spawned builder of this run that is not corrupted: the new builder takes its surname. With names on, the name of every task item (and the label of an eval agent) must come from this action: a refusal says so, and slices adds a NAMES <squad>=<name>, ... line for the parallel squads. reuse (squad) lists up to 3 proven builders of this run that have ended and whose squad shares files, or a folder, with the squad (REUSE line, then a SEED line for the brief); it writes nothing. A task item or the call's context with a line Reuse: <agent id> that names a corrupted agent is blocked. rate (Captain only) stores your verdict on one agent of this run, by the agent id the task result shows: rating is proven, proven-regression (proven, but it added a new BLOCKING finding on the lines a penance touched) or corrupted (a reproduced BLOCKING finding, an apothecary survivor or fuzz crash, a red acceptance check, or a rule breach: a commit, git push, a gh write, or a write outside its worktree); evidence = 1-8 short items (finding IDs, the failing check, the breached rule); model and effort = what the agent ran on (the tier selector @task:medium is model @task, effort medium; effort default when none). Corrupted is final for that agent; with names on it also marks the squad's brother as fallen, provisionally: the squad falls at end unless a later builder replaces it. seal (lines: string[]) fills the cockpit's seal panel with the lines you are about to show for the seal that waits (its [seal] task in progress); the panel clears when that seal is granted. The plugin refuses librarian and archmagos spawns until a scout spawned after it has finished. On a run that spawned its archmagos, one more archmagos may be spawned. end writes the run's debrief (time per station, seals, squads, spawns) to <state dir>/debriefs and answers ENDED <key>, DEBRIEF <path> and summary lines; reported = {apothecary: {killed, survived, crashes}, review: {pass, fail, opened, fixed, not_reproduced}}: whole numbers from the agents' reports, shown only in the (reported) sections. report (date?) also ends with the TALLY and PROPOSE lines of <state dir>/tally.json (per model, effort and squad kind: proven, proven-regression, corrupted; PROPOSE names a heavier default tier for a kind whose tier keeps failing), or a WARN line when that file is unreadable; a report with a date shows none. end also adds the run's rated builders to <state dir>/tally.json and answers TALLY recorded <n> rating(s), or WARN TALLY not written: <reason>; nothing when no builder of a declared squad was rated.",
		parameters: schema,
		async execute(_id, input, _signal, _onUpdate, ctx) {
			if (ctx?.agent?.kind === "sub" && input.action !== "signal") return text("ERROR strategium tool is for the main session only");
			const sid = sidOf(ctx);
			try {
				// The host validated input against `schema` before calling execute.
				const params = input as (typeof schema)["_output"];
				switch (params.action) {
					case "begin": {
						if (!params.key) throw new Error("begin needs key");
						const bad = viaError(params.via, params.booked);
						if (bad) return text(bad);
						return text(await beginRun(sid, params.key, params.theatre ?? "none", params.booked, params.spent, params.takeover, params.archmagos, ctx, undefined, cleanVia(params.via)));
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
					case "name": {
						if (!naming.on) return text("ERROR names are off: /strategium-config names on or STRATEGIUM_NAMES=1");
						const run = ownRun(sid);
						if (!run) return text("ERROR no active run in this session");
						if (!params.agent) throw new Error("name needs agent");
						const { squad, source } = params;
						const agent = agentName(params.agent);
						if (squad !== undefined && isBuilderRole(agent) && ![...(run.slices ?? []), ...(run.stopped ?? [])].some(s => s.id === squad))
							return text(`ERROR squad ${squad} is not declared: call strategium action slices first`);
						// D5: the reused brother's surname comes from a builder of this run that has spawned and is not corrupted.
						let surname: string | undefined;
						if (source !== undefined) {
							if (!isBuilderRole(agent)) return text("ERROR source is only for battle-brother and veteran");
							const src = run.names?.find(n => n.name === baseId(source));
							if (!src || !src.spawned || src.old || !isBuilderRole(src.agent)) return text(`ERROR ${source} is not a builder of this run that has spawned`);
							if (corruptedSource(run, source, true)) return text(`ERROR ${source} is corrupted: a corrupted agent is never reused`);
							surname = src.surname;
						}
						// No await from here to writeRun: parallel calls in one process cannot hand out one name twice.
						const issued = issuedFor(sid);
						const place = (pick?: Pick): string => {
							const got = allocateName(run.names ?? [], { agent, squad, again: params.again, surname }, issued, undefined, pick);
							if ("error" in got) return `ERROR ${got.error}`;
							if (got.fresh) {
								writeRun({ ...run, names: [...(run.names ?? []), got.entry] });
								issued.add(got.entry.name);
							}
							return `NAME ${got.entry.name}`;
						};
						// A new builder surname comes from the roster, under its lock with the run write inside; every other name needs no roster.
						if (!isBuilderRole(agent) || run.names?.some(n => n.squad === squad && !n.old)) return text(place());
						const placed = withPicks(sid, place);
						return text(placed.warn ? `${placed.warn}\n${placed.value}` : placed.value);
					}
					case "reuse": {
						const run = ownRun(sid);
						if (!run) return text("ERROR no active run in this session");
						if (!params.squad) throw new Error("reuse needs squad");
						const target = [...(run.slices ?? []), ...(run.stopped ?? [])].find(s => s.id === params.squad);
						if (!target) return text(`ERROR squad ${params.squad} is not declared: call strategium action slices first`);
						// The same registry the debrief reads: the live cockpit, else the one saved beside the run.
						const roles = cockpit.key === run.key ? new Map([...cockpit.deployed].map(([id, d]) => [id, { role: d.role, squad: d.squad }])) : savedRoles(run.sid);
						const found = reuseCandidates(run, target, roles, naming.on);
						if (!found.length) return text(`REUSE squad ${target.id}: none (no proven builder of this run that has ended shares its files or area); spawn a fresh builder`);
						const list = found.map(c => `${c.id} (squad ${c.squad}, ${c.shared ? "shared files" : "same area"}, ${Number.isFinite(c.tokens) ? `${c.tokens} tokens` : "usage unknown"})`).join("; ");
						const best = found[0].id;
						return text(
							`REUSE squad ${target.id}: ${list}\n` +
								`SEED brief line "Reuse: ${best}", the line "build squad ${target.id}", the squad's lessons and open finding IDs, its commit(s) to git show, agent://${best} (final report) and history://${best}:-60; spawn the agent the ladder calls for (battle-brother for a penance, veteran for the escalation)` +
								(naming.on ? `; with names on, strategium action name with source: ${best}` : ""),
						);
					}
					case "rate": {
						if (!params.agent) throw new Error("rate needs agent");
						const run = ownRun(sid);
						if (!run) return text("ERROR no active run in this session");
						const id = params.agent;
						// A synchronous task never reaches the cockpit registry: its spawned name in the run's names is enough.
						const named = run.names?.find(n => n.name === id && n.spawned);
						if (!(named || (cockpit.key === run.key && cockpit.deployed.has(id))) || !ratingKey(id)) return text(`ERROR ${id} is not an agent of this run: pass the agent id the task result shows`);
						const rating = parseRating(params);
						if (typeof rating === "string") return text(`ERROR ${rating}`);
						const was = run.ratings && Object.hasOwn(run.ratings, id) ? run.ratings[id] : undefined;
						if (was?.rating === "corrupted" && rating.rating !== "corrupted") return text(`ERROR ${id} is corrupted for the rest of the run`);
						const next = { ...run, ratings: { ...run.ratings, [id]: rating } };
						writeRun(next);
						// D6: with names on, a corrupted latest builder makes its squad a fall at end.
						const squad = named?.squad ?? cockpit.deployed.get(id)?.squad;
						const brother = naming.on && rating.rating === "corrupted" && squad ? squadBrothers(cleanNames(run.names), undefined)[squad] : undefined;
						// The roster credits a squad's outcome to its first builder, so the line names that brother, not a reused one.
						const first = brother && cleanNames(run.names)?.find(e => isBuilderRole(e.agent) && e.squad === squad && !e.old);
						return text(
							[
								`RATED ${id} ${rating.rating}${was ? ` (was ${was.rating})` : ""} model=${rating.model} effort=${rating.effort} evidence=${rating.evidence.length}`,
								...(brother?.name === baseId(id) ? [`FALL ${(first ?? brother).surname} squad ${squad} falls at end unless a later builder replaces it`] : []),
								...(rating.rating === "corrupted" ? [`LESSON write local://${run.key}-lessons.md for ${id}${squad ? ` before the next round of squad ${squad}` : ""}${rating.evidence[0]?.startsWith("cause:") ? "" : "; start evidence with cause: <why>"}`] : []),
							].join("\n"),
						);
					}
					case "status":
						return text(`${fullStatus(sid)}\nARCHMAGOS ${archmagosState(sid)}\nCOMMIT ${commitState(sid)}\nTIERS ${tiersState()}\nNOTIFY ${notifyState(sid)}\nSOUND ${soundState(sid)}\nTOAST ${toastState(sid)}\nNAMES ${namesState()}`);
					case "report":
						return text(report(params.date));
					case "end":
						return text(await finish(sid, ctx, params.key, params.takeover, params.reported));
					case "switch": {
						if (!params.key) throw new Error("switch needs key");
						const key = params.key;
						const bad = viaError(params.via, params.booked);
						if (bad) return text(bad);
						const via = cleanVia(params.via);
						const old = ownRun(sid);
						if (!old) return text("ERROR no run to switch from in this session");
						if (key === old.key) return text(`ERROR ${key} is already this session's run`);
						if (Object.keys(old.agents ?? {}).length) return text(`ERROR ${old.key} still has builders (battle-brothers, veterans) running: wait for them or end the run first`);
						// Claim first: a refused key leaves the old run running, and no session can take it between the two halves.
						claim(stateDir(), key, sid, params.takeover);
						const retry = `call strategium begin key ${key} theatre ${old.theatre}${params.booked !== undefined ? ` booked ${params.booked}` : ""}${via ? ` via key ${via.key} reason ${via.reason}` : ""}${old.repo ? `, then repo ${old.repo}` : ""}`;
						let ended: string;
						try {
							ended = await finish(sid, ctx);
						} catch (err) {
							release(stateDir(), key, sid);
							// The end ran and a later step threw: the run is gone and the claim on key is released, so say what to call.
							if (!ownRun(sid)) return text(`ERROR ${old.key} ended but ${key} did not begin: ${err instanceof Error ? err.message : String(err)}; ${retry}`);
							throw err;
						}
						try {
							// ownRepo is passed even when undefined: that means "this session has no repo", unlike not passing it (keep or take the holder's).
							const begun = await beginRun(sid, key, old.theatre, params.booked, undefined, undefined, undefined, ctx, { repo: old.repo }, via);
							return text(`${ended}\n${begun}`);
						} catch (err) {
							// The end cannot be undone and the claim on key stays ours, so the retry begin succeeds.
							return text(`${ended}\nERROR begin ${key} failed after ${old.key} ended: ${err instanceof Error ? err.message : String(err)}; ${retry}`);
						}
					}
					case "attention": {
						const key = ownRun(sid)?.key;
						const msg = params.message?.trim() || "Your attention is needed";
						const err = alert(sid, "attention", key ? `${key}: ${msg}` : msg, ctx);
						if (err) alarmWarn(ctx, err);
						// A silent call makes no sound; say so, so the Captain does not count on it.
						const ch = channels(sid);
						const silent = !notifyOn(sid)
							? " (silent: notifications are off; /strategium-config notify on)"
							: !ch.length
								? " (silent: sound and toast are off; /strategium-config sound on or toast on)"
								: ` (${ch.join(", ")})`;
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
						const at = lines.length;
						lines.push(`SQUADS ${live.map(s => s.id + (s.parallel || s.tier ? ` (${[s.parallel && "parallel", s.tier].filter(Boolean).join(", ")})` : "")).join(", ") || "none"}`);
						let next: Run = { ...run, slices: live, launched: undefined };
						// Each live parallel squad's first Brother, reused until it has spawned; a squad whose Brother has spawned is skipped.
						// Synchronous from ownRun to writeRun, like `name`, so parallel calls cannot hand out one name twice.
						const place = (pick?: Pick) => {
							const entries = [...(run.names ?? [])];
							const issued = issuedFor(sid);
							const pairs: string[] = [];
							for (const s of live.filter(s => s.parallel)) {
								if (entries.some(n => n.squad === s.id && !n.old && n.agent === "battle-brother" && n.spawned)) continue;
								const got = allocateName(entries, { agent: "battle-brother", squad: s.id }, issued, undefined, pick);
								if ("error" in got) {
									lines.push(`WARN ${got.error}`);
									continue;
								}
								if (got.fresh) {
									entries.push(got.entry);
									issued.add(got.entry.name);
								}
								pairs.push(`${s.id}=${got.entry.name}`);
							}
							if (pairs.length) lines.push(`NAMES ${pairs.join(", ")}`);
							if (entries.length) next = { ...next, names: entries };
							writeRun(next);
						};
						if (!naming.on) writeRun(next);
						else if (!live.some(s => s.parallel)) place();
						else {
							const placed = withPicks(sid, place);
							if (placed.warn) lines.splice(at, 0, placed.warn);
						}
						return text(lines.join("\n"));
					}
					case "seal": {
						const run = ownRun(sid);
						if (!run) return text("ERROR no active run in this session");
						const waiting = waitingSeal(run.phases ?? []);
						if (!waiting) return text("ERROR no seal waits; start its [seal] task first");
						// Lines come from the model: capped so one call cannot bloat the state file, cleaned like at render.
						const lines = (params.lines ?? []).slice(0, SEAL_LINES).map(l => clean(l.slice(0, SEAL_LINE_CHARS)).trimEnd());
						while (lines.length && !lines.at(-1)) lines.pop();
						if (cockpit.key !== run.key) resetCockpit(run.key);
						cockpit.seal = { id: waiting.id, lines };
						cockpit.dirty = true;
						drawCockpit(run, ctx);
						return text(`SEAL ${waiting.id} panel ${lines.length} lines`);
					}
					case "redraft": {
						const run = ownRun(sid);
						if (!run) return text("ERROR no active run in this session");
						if (run.redraft) return text(`ERROR the redraft of ${run.key} is spent (1 per run)`);
						writeRun({ ...run, redraft: true, builds: undefined, ended: undefined, ...(run.names ? { names: run.names.map(n => (n.squad ? { ...n, old: true as const } : n)) } : {}) });
						record({ event: "redraft", key: run.key });
						return text(
							`REDRAFT ${run.key}: back to Auspex; no librarian or archmagos until a scout spawned now has finished${run.archmagosSpawned ? "; then one more archmagos may be spawned" : ""}`,
						);
					}
					case "record": {
						// The Captain's own entry: checks first, so a refusal writes nothing; no dedupe and no run.recorded (that list is for the plugin's events).
						const run = ownRun(sid);
						if (!run) return text("ERROR no active run in this session");
						const entry = params.text?.trim();
						if (!entry) return text("ERROR record needs text");
						if (entry.length > 200) return text("ERROR record needs text of at most 200 characters");
						const kind = secretKind(params.text as string);
						if (kind) return text(`ERROR the text looks like a secret (${kind}); nothing was written; rephrase without the value`);
						if (!vault.dir) return text("ERROR no vault set (/strategium-config vault <absolute folder>)");
						const c = loadContract(vault.dir);
						if ("error" in c) return text(`ERROR vault ${vault.dir}: ${c.error}`);
						const now = new Date();
						const note = params.note;
						if (note !== undefined) {
							const t = noteTarget(vault.dir, c.contract, now, note);
							if ("error" in t) return text(`ERROR record refused: note ${note}: ${t.error}; nothing was written`);
						}
						const why = recordLine(vault.dir, c.contract, stateDir(), now, run.key, entry);
						if (why) return text(`ERROR vault ${vault.dir}: ${why}`);
						if (note === undefined) return text("RECORDED daily");
						const noteWhy = recordNote(vault.dir, c.contract, stateDir(), now, run.key, entry, note);
						return text(noteWhy ? `RECORDED daily\nERROR note ${note}: ${noteWhy}; the daily line stays` : `RECORDED daily\nRECORDED note ${note}`);
					}
					case "signal": {
						// Subagents only, and only their own row: the id comes from the host's ctx, never from a parameter.
						if (ctx?.agent?.kind !== "sub") return text("ERROR signal is for subagents: it writes the caller's own cockpit row");
						if (!ctx.agent.id) return text("ERROR signal needs the caller's agent id");
						const own = ["action", "pct", "eta_min", "line", "blocked"];
						const extra = Object.keys(params).filter(k => !own.includes(k) && (params as Record<string, unknown>)[k] !== undefined);
						if (extra.length) return text(`ERROR signal writes only your own row; it takes pct, eta_min, line, blocked (got: ${extra.join(", ")})`);
						const { pct, eta_min, line, blocked } = params;
						if (pct === undefined && eta_min === undefined && line === undefined && blocked === undefined) return text("ERROR signal needs pct, eta_min, line or blocked");
						if ((pct !== undefined && (!isCount(pct) || pct > 100)) || (eta_min !== undefined && (!isCount(eta_min) || eta_min > 10080)) || (line !== undefined && typeof line !== "string") || (blocked !== undefined && typeof blocked !== "boolean"))
							return text("ERROR signal takes pct 0-100, eta_min 0-10080, line text, blocked true or false");
						if (blocked && !cap(oneLine(line))) return text("ERROR signal blocked: true needs a non-empty line saying what you wait for: the Captain reads it in the alarm");
						// A change of blocked is written at once: the Captain must not wait for the 1 s throttle to hear it.
						const ok = recordLive(ctx, 0, { pct, eta_min, line: cap(oneLine(line)) || undefined, blocked: blocked || undefined }, !!blocked !== mine.wroteBlocked);
						return text(ok ? "SIGNAL ok" : "SIGNAL ignored (no Strategium run)");
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
			// The command begins the run itself (the clock counts from here) and hands the Captain the objective.
			const parsed = raw.match(/^"([^"]+)"(?:\s+(\S+))?$/) ?? raw.match(/^(\S+)(?:\s+(\S+))?$/);
			if (!parsed) {
				notify(
					ctx,
					'Usage: /strategium <ticket | @file | "free text"> [theatre]; also /strategium-pause, -resume, -add, -status, -config, -cockpit, -end',
					"warning",
				);
				return;
			}
			const objective = raw.startsWith('"') ? `"${parsed[1]}"` : parsed[1];
			const named = parsed[2] ?? (process.env.STRATEGIUM_THEATRE?.trim() || undefined);
			const theatre = (named ?? "none").replace(/^strategium-/, "");
			const key = keyOf(objective);
			const sid = sidOf(ctx);
			// Begin the run now, untimed, so the clock counts from the command; a key this session already holds is left as it is.
			let note = `Strategium run ${key} has begun, untimed: first todo init the skeleton todo from the skill (in omp plan mode only the plan stations, --to Scriptorium). Read rule://strategium-captain and the other strategium rules listed in the skill's Rules section.`;
			if (ownRun(sid)?.key === key) note = `Strategium run ${key} is already this session's run.`;
			else {
				try {
					await beginRun(sid, key, theatre, undefined, undefined, undefined, undefined, ctx);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					notify(ctx, `Strategium could not begin run ${key}: ${end(message)} Fix that, then run /strategium <ticket> again.`, "warning");
					note = `Strategium could not begin run ${key}: ${message}`;
				}
			}
			refreshFooter?.();
			pi.sendUserMessage(
				`${named === undefined
					? `Read skill://strategium and run it for the objective ${objective}; no theatre was named: take the default theatre from the skill's Theatre section.`
					: theatre === "none"
						? `Read skill://strategium and run it for the objective ${objective} with no theatre.`
						: `Read skill://strategium and run it for the objective ${objective} with theatre skill://strategium-${theatre}.`} ${note}`,
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
					notify(ctx, `Strategium could not run /strategium-${name}: ${end(err instanceof Error ? err.message : String(err))}`, "warning");
				} finally {
					refreshFooter?.();
				}
			},
		});

	subcommand("pause", "Stop this session's Strategium clock", (_arg, ctx, sid) => {
		const run = ownRun(sid);
		if (run) spendIdle(run);
		notify(ctx, `Strategium paused (${run && stopKey(run.key) ? run.key : "idle"}).`, "info");
	});

	subcommand("resume", "Continue this session's Strategium run; on a new day pass today's booked minutes", (arg, ctx, sid) => {
		const run = ownRun(sid);
		if (!run) return notify(ctx, NO_RUN, "warning");
		spendIdle(run);
		const bk = arg === undefined ? undefined : Number(arg);
		if (bk !== undefined && !(Number.isInteger(bk) && bk > 0))
			throw new Error("resume takes the booked minutes as a whole number, e.g. /strategium-resume 240");
		try {
			notify(ctx, end(up(shift(run, bk))));
		} catch (err) {
			if (!(err instanceof NewShift)) throw err;
			const skill = run.theatre.startsWith("strategium-") ? run.theatre : `strategium-${run.theatre}`;
			pi.sendUserMessage(
				run.theatre === "none"
					? `New Strategium shift for ${run.key}: ask me today's booked minutes, then call strategium start with booked.`
					: `New Strategium shift for ${run.key}: read today's booked minutes for it as skill://${skill} Muster says (including what to do when it is not booked today), then call strategium start with booked. If I already worked on it today before this, propose those minutes as Muster does and record them with strategium add after my OK.`,
			);
		}
	});

	subcommand("add", "Correct today's time of this session's run in minutes (negative to subtract)", (arg, ctx, sid) => {
		const run = ownRun(sid);
		if (!run) return notify(ctx, NO_RUN, "warning");
		notify(ctx, addMin(run, Number(arg)));
	});

	subcommand("skull", "Ask the servo-skull a question about the whole run (one paid model call per question); it answers in the cockpit's servo-skull box when the cockpit shows it, here otherwise", async (arg, ctx, sid) => {
		if (ctx.agent?.kind === "sub") return;
		const run = ownRun(sid);
		if (!run) return notify(ctx, NO_RUN, "warning");
		if (!servoSkull.on) return notify(ctx, "The servo-skull is off. Turn it on with /strategium-config servo-skull on, then ask again.", "warning");
		if (!arg) return notify(ctx, "Usage: /strategium-skull <question>", "warning");
		if (cockpit.key !== run.key) loadCockpit(sid, run.key);
		const c = cockpit.servoSkull;
		if (c.ask) return notify(ctx, "The servo-skull is still answering the last question.", "warning");
		const prep = servoSkullPrepare(ctx);
		if ("reason" in prep) return notify(ctx, `The servo-skull cannot answer: ${prep.reason}.`, "warning");
		const ctrl = new AbortController();
		c.ask = ctrl;
		notify(ctx, "The Servo-skull is answering…");
		try {
			const facts = missionFacts({ key: run.key, phases: run.phases, deployed: cockpit.deployed, live: liveRows(run), chronicle: cockpit.chronicle, seal: cockpit.seal, returns: { redraft: run.redraft === true, builds: run.builds }, clock: cockpit.clock, slices: run.slices });
			const r = await answer(prep.complete, arg, facts, AbortSignal.any([ctrl.signal, AbortSignal.timeout(30_000)]));
			const fresh = readRun(sid);
			if (cockpit.servoSkull !== c || fresh?.key !== run.key) return; // the run was reset, has ended or is another one meanwhile: the reply is not counted or shown
			countSpend(c, r.reply); // paid, shown or not
			if (r.dim) return notify(ctx, `The servo-skull could not answer: ${r.text}.`, "warning");
			const question = chars(oneLine(arg), 300);
			c.answer = { question, text: r.text, at: Date.now() }; // a cockpit opened later still shows it, until a summary replaces it
			// The box shows it only in the main view of a cockpit at least 72 columns wide (the width is 0 until the first render).
			const boxShows = !!cockpit.close && !cockpit.nav.detail && !cockpit.debrief && (cockpitWidth === 0 || cockpitWidth >= 72);
			if (cockpit.close) drawCockpit(fresh, ctx);
			if (!boxShows) notify(ctx, `Servo-skull on "${brief(question, 60)}": ${r.text}`);
		} finally {
			if (c.ask === ctrl) c.ask = undefined;
		}
	});

	subcommand("status", "Every Strategium run and its time", (_arg, ctx, sid) => notify(ctx, fullStatus(sid)));

	subcommand("config", "Show the Strategium settings; notify on|off sets this session's sounds and notifications; sound on|off and toast on|off pick the alarm's channels; volume <0-100> [preview] sets the alarm's volume (preview plays it); idle <min> sets the idle pause; archmagos on|off lets runs use the Archmagos Dominus; commit on|off asks before each commit in this session's runs; cockpit-key <key> sets the cockpit key from the next omp start; cockpit-theme <name> sets the cockpit's colours; relic on|off|default sets the worn relic look; servo-skull on|off|default sets the cockpit's model commentator; names on|off|default sets whether the plugin hands out and checks agent names; vault <absolute folder>|off|default sets the vault whose daily note records run events", (arg, ctx, sid) => {
		let conflict: { key: string; c: NonNullable<ReturnType<ExtensionAPI["getShortcutConflict"]>> } | undefined;
		let preview = false;
		if (arg !== undefined) {
			const m = arg.match(/^notify\s+(on|off)$/);
			const so = arg.match(/^sound\s+(on|off)$/);
			const to = arg.match(/^toast\s+(on|off)$/);
			const i = arg.match(/^idle\s+(\d+)$/);
			const vo = arg.match(/^volume(?:\s+(\d+))?(\s+preview)?$/);
			const a = arg.match(/^archmagos\s+(on|off)$/);
			const c = arg.match(/^commit\s+(on|off)$/);
			const k = arg.match(/^cockpit-key\s+(\S+)$/);
			const th = arg.match(/^cockpit-theme\s+(\S+)$/);
			const re = arg.match(/^relic\s+(on|off|default)$/);
			const ca = arg.match(/^servo-skull\s+(on|off|default)$/);
			const na = arg.match(/^names\s+(on|off|default)$/);
			const va = arg.match(/^vault\s+(.+)$/);
			if (!m && !so && !to && !i && !(vo && (vo[1] || vo[2])) && !a && !c && !k && !th && !re && !ca && !na && !va) throw new Error("config takes notify on|off or idle <min>, or archmagos on|off, or commit on|off, or sound on|off, or toast on|off, or volume <0-100> [preview], or cockpit-key <key>, or cockpit-theme <name>, or relic on|off|default, or servo-skull on|off|default, or names on|off|default, or vault <absolute folder>|off|default; the other settings live in ~/.omp/agent/.env (/skill:strategium-setup)");
			if (m) notifyBySession.set(sid, m[1] === "on");
			else if (so) soundBySession.set(sid, so[1] === "on");
			else if (to) toastBySession.set(sid, to[1] === "on");
			else if (vo) {
				if (vo[1] !== undefined) {
					const n = Number(vo[1]);
					if (n > 100) throw new Error("volume takes 0 to 100");
					volumeBySession.set(sid, n);
				}
				preview = !!vo[2];
			} else if (a) archmagosBySession.set(sid, a[1] === "on");
			else if (c) commitBySession.set(sid, c[1] === "on");
			else if (th) {
				const v = th[1].toLowerCase();
				if (v === "default") rmSync(themeFile(), { force: true });
				else {
					if (!isTheme(v)) throw new Error(`cockpit-theme takes ${Object.keys(THEMES).join(", ")} or default`);
					mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
					writeFileSync(themeFile(), v);
				}
				theme = themeSetting();
				pal = palette(colorDepth(), THEMES[theme.name]);
			} else if (re) {
				const v = re[1];
				if (v === "default") rmSync(relicFile(), { force: true });
				else {
					mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
					writeFileSync(relicFile(), v);
				}
				relic = relicSetting();
			} else if (ca) {
				const v = ca[1];
				if (v === "default") rmSync(servoSkullFile(), { force: true });
				else {
					mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
					writeFileSync(servoSkullFile(), v);
				}
				servoSkull = servoSkullSetting();
			} else if (na) {
				const v = na[1];
				if (v === "default") rmSync(namesFile(), { force: true });
				else {
					mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
					writeFileSync(namesFile(), v);
				}
				naming = namesSetting();
			} else if (va) {
				const v = va[1].trim().replace(/^"(.*)"$/, "$1");
				if (v.toLowerCase() === "default") rmSync(vaultFile(), { force: true });
				else {
					const off = v.toLowerCase() === "off";
					if (!off && !path.isAbsolute(v)) throw new Error("vault takes an absolute folder path, off or default");
					mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
					writeFileSync(vaultFile(), off ? "off" : v);
				}
				vault = vaultSetting();
			} else if (k) {
				const v = k[1].toLowerCase();
				if (v === "default") rmSync(keyFile(), { force: true });
				else {
					if (!usableKey(v)) throw new Error("cockpit-key takes a key such as alt+c, ctrl+shift+k or f8, or default");
					const c = pi.getShortcutConflict(v as KeyId);
					if (c?.kind === "reserved") throw new Error(`${v} is reserved by omp and never opens the cockpit; pick another key`);
					mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
					writeFileSync(keyFile(), v);
					if (c) conflict = { key: v, c };
				}
			} else idleBySession.set(sid, Number(i![1]));
		}
		const env = (k: string) => process.env[k]?.trim() || "not set";
		const next = keySetting();
		notify(
			ctx,
			[
				"Strategium config",
				`notify: ${notifyState(sid)}`,
				`sound: ${soundState(sid)}`,
				`volume: ${volumeState(sid)}`,
				`toast: ${toastState(sid)}`,
				`idle: ${idleState(sid)}`,
				`archmagos: ${archmagosState(sid)}`,
				`commit: ${commitState(sid)}`,
				`cockpit-key: ${cockpitKey.key} (${cockpitKey.from})${next.key !== cockpitKey.key || next.from !== cockpitKey.from ? `; next omp start: ${next.key} (${next.from})` : ""}`,
				`cockpit-theme: ${theme.name} (${theme.from})`,
				`relic: ${relic.on ? "on" : "off"} (${relic.from})`,
				`names: ${namesState()}`,
				vaultLine(),
				servoSkullConfigLine(),
				`theatre: ${env("STRATEGIUM_THEATRE")}`,
				`glyphs: ${process.env.STRATEGIUM_GLYPHS === "1" ? "on" : "off"}`,
				`state: ${stateDir()}`,
			].join("\n"),
			"info",
		);
		if (conflict) notify(ctx, keyConflict(conflict.key, conflict.c), "warning");
		// The preview plays the alarm at this volume even with notify or sound off: the user asked to hear it.
		if (preview) {
			const err = signal(spawn, "done", undefined, true, volumeOf(sid), alarmExit(sid, ctx));
			if (err) notify(ctx, `Strategium could not play the alarm preview: ${end(err)} Check the audio player.`, "warning");
		}
	});

	subcommand("end", "Close this session's Strategium run", async (_arg, ctx, sid) => {
		notify(ctx, await finish(sid, ctx));
		// undefined removes the line; "" would leave an empty one under the other plugins' lines.
		ctx.ui.setStatus("strategium", undefined);
	});

	subcommand("cockpit", "Open the Strategium cockpit", (_arg, ctx) => openCockpit(ctx));
	const keyFile = () => path.join(stateDir(), "cockpit-key");
	const keySetting = (): { key: string; from: string } => {
		let saved = "";
		try {
			saved = readFileSync(keyFile(), "utf8").trim().toLowerCase();
		} catch {
			// no saved key: fall through to the env and the default
		}
		const fromEnv = process.env.STRATEGIUM_COCKPIT_KEY?.trim().toLowerCase() ?? "";
		if (usableKey(saved)) return { key: saved, from: "/strategium-config" };
		if (usableKey(fromEnv)) return { key: fromEnv, from: "STRATEGIUM_COCKPIT_KEY" };
		return { key: "alt+c", from: "default" };
	};
	// Read once: omp binds shortcuts before session_start, so a new key applies on the next omp start.
	const cockpitKey = keySetting();
	const keyConflict = (key: string, c: NonNullable<ReturnType<ExtensionAPI["getShortcutConflict"]>>) => {
		const fix = "Set another key with /strategium-config cockpit-key <key> or use /strategium-cockpit";
		if (c.kind === "reserved") return `${key} is reserved by omp and never opens the Strategium cockpit. ${fix}.`;
		if (c.kind === "keybinding") return `${key} is also omp's ${c.keybindings.join(", ")}, which may take it first. ${fix}.`;
		return `${key} is also a shortcut of ${c.extensionPath}, and only one of them runs. ${fix}.`;
	};
	pi.registerShortcut(cockpitKey.key as KeyId, { description: "Open the Strategium cockpit", handler: ctx => openCockpit(ctx) });

	const onSession = async (e: { type: string; reason?: string }, ctx: SessionCtx) => {
		if (ctx.agent?.kind === "sub") return;
		if (cockpit.debrief) cockpit.close?.(); // another session: the old run's final screen goes
		// omp emits session_switch, not session_start, for a session opened in the same process: follow the latest one.
		const prevSid = liveSid;
		live = ctx;
		const sid = sidOf(ctx);
		liveSid = sid;
		// The mark is spent by the first switch after the review closed.
		const reviewed = reviewSid;
		reviewSid = undefined;
		let carried = false;
		// The fresh session of an approved plan takes over the run of the session that asked for the review.
		if (e.reason === "new" && prevSid && prevSid === reviewed && prevSid !== sid && !readRun(sid)) {
			const moved = ownRun(prevSid);
			if (moved) {
				try {
					claim(stateDir(), moved.key, sid, prevSid);
					// omp cancelled the old session's background agents: none runs any more.
					// The old session's station is not where the fresh one starts.
					writeRun(settle({ ...moved, sid, where: undefined }, {}, Object.values(moved.agents ?? {})));
					// The cockpit in memory is the moved run's: the next draw saves it under the new sid.
					if (cockpit.key === moved.key) {
						cockpit.dirty = true;
						carried = true;
					}
					// The plan-mode agents' live rows (their costs) go with the run; a name the new dir already holds is the newer one.
					try {
						const from = readdirSync(liveDir(prevSid));
						mkdirSync(liveDir(sid), { recursive: true, mode: 0o700 });
						for (const f of from) if (!existsSync(path.join(liveDir(sid), f))) renameSync(path.join(liveDir(prevSid), f), path.join(liveDir(sid), f));
					} catch {
						// No live rows, or one that would not move: dropFiles leaves the rest inert.
					}
					dropFiles(prevSid);
					beat(sid);
					// The old id must not keep a setting its run took away.
					for (const m of [
						notifyBySession,
						soundBySession,
						toastBySession,
						volumeBySession,
						idleBySession,
						archmagosBySession,
						commitBySession,
					] as Map<string, unknown>[]) {
						const v = m.get(prevSid);
						if (v !== undefined) m.set(sid, v);
						m.delete(prevSid);
					}
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
				dropFiles(sid);
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
		// Before the first tick, so its draw never overwrites the saved state with an empty one.
		if (held && !carried) loadCockpit(sid, own!.key);
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
		cockpit.close?.();
		const run = ownRun(e.sessionId);
		reviewSid = run ? e.sessionId : undefined;
		// The user is called now: the review keeps the clock counting (it is busy), so the attention alarm replaces the idle one.
		if (!run) return;
		const err = alert(e.sessionId, "attention", `${run.key}: your plan review is waiting`, ctx);
		if (err) alarmWarn(ctx, err);
	});
	pi.on("tool_approval_requested", (_e, ctx) => {
		if (ctx?.agent?.kind === "sub") return;
		cockpit.close?.();
	});
	// Every turn, whoever started it (before_agent_start fires only for typed prompts): the idle count restarts and an
	// idle-paused run continues. A run paused by hand carries no mark and stays paused.
	// The open cockpit says at once what the agent does; the host is idle only after agent_end returns, so the 500 ms redraw checks again.
	pi.on("agent_start", (_e, ctx) => {
		if (ctx?.agent?.kind === "sub") return;
		setAgentStatus(ctx);
		idleSince = undefined;
		const run = ownRun(sidOf(ctx));
		if (run?.idle) {
			writeRun({ ...run, idle: undefined });
			if (!isOpen(run.key)) {
				const resumed = resumeOrWarn(run, sidOf(ctx), ctx);
				if (resumed) notify(ctx, end(up(resumed)));
			}
		}
		refreshFooter?.();
	});
	// The turn ended: the idle minutes count from here (tick restarts the count if something is still busy).
	pi.on("agent_end", (_e, ctx) => {
		if (ctx?.agent?.kind === "sub") return;
		idleSince = Date.now();
		setAgentStatus(ctx);
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
		notify(ctx, `Strategium loaded with theatre ${theatre}, notifications ${notifyOn(sidOf(ctx)) ? "on" : "off"}.`);
		const c = pi.getShortcutConflict(cockpitKey.key as KeyId);
		if (c) notify(ctx, keyConflict(cockpitKey.key, c), "warning");
		const rawKey = process.env.STRATEGIUM_COCKPIT_KEY?.trim();
		if (rawKey && !usableKey(rawKey.toLowerCase())) notify(ctx, `STRATEGIUM_COCKPIT_KEY "${rawKey}" is not a key such as alt+c, ctrl+shift+k or f8, so Strategium ignores it. Set a valid key or unset it.`, "warning");
		const rawTheme = process.env.STRATEGIUM_COCKPIT_THEME?.trim();
		if (rawTheme && !isTheme(rawTheme.toLowerCase())) notify(ctx, `STRATEGIUM_COCKPIT_THEME "${rawTheme}" is not a theme (${Object.keys(THEMES).join(", ")}), so Strategium ignores it. Set a valid theme or unset it.`, "warning");
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
		const details = e.details as { op?: string; phases?: Phase[] } | undefined;
		const phases = details?.phases;
		const run = ownRun(sidOf(ctx));
		// A rebuild's init (it shares a station with the run's phases) is auto-started by omp at its first task, which is not where the run is.
		if (isRebuild(details?.op, run?.phases, phases)) return;
		const where = phases && whereFrom(phases);
		if (!run || !where) return;
		writeRun({ ...run, where });
		refreshFooter?.();
	});

	// The Captain's roster: during a run only these agents may be spawned, and no battle-brother before the squads.
	// The archmagos has four more guards, in order: setting, mark, 2 finished librarians, budget. After a redraft, a librarian
	// or archmagos also waits for a scout spawned after it to finish.
	pi.on("before_subagent_spawn", (e, ctx) => {
		if (ctx?.agent?.kind === "sub" || !ctx?.sessionManager) return;
		const sid = sidOf(ctx);
		const run = ownRun(sid);
		if (!run) return;
		const agent = agentName(String(asObj(e).agent ?? "task"));
		// The model the child runs on, for the debrief: the host's own choice when no tier sets one.
		const hostModel = () => {
			const { patterns, modelRole } = asObj(e);
			const first = Array.isArray(patterns) ? patterns[0] : undefined;
			return oneLine(typeof first === "string" && first ? first : typeof modelRole === "string" && modelRole ? `@${modelRole}` : "default").slice(0, 60) || "default";
		};
		if (!ROSTER.includes(agent)) return { block: true, reason: `Strategium: during a run only these agents may be spawned: ${ROSTER.join(", ")}.` };
		// An eval spawn takes its id from its label: with names on, that label (without omp's -N suffix) must be a name handed out for this agent.
		const key = typeof asObj(e).spawnKey === "string" ? (asObj(e).spawnKey as string) : "";
		if (naming.on && asObj(e).invocationKind === "eval") {
			const problem = nameProblem(run, agent, baseId(key));
			if (problem) return { block: true, reason: `${nameReason(agent, "this eval spawn", problem)} (pass label=<name> from strategium action name)` };
		}
		// Two separate task calls in one turn pass the tool_call guard together: the spawn hook refuses the second spawn of a name.
		if (naming.on && asObj(e).invocationKind !== "eval") {
			const hit = run.names?.find(n => n.name === baseId(key));
			if (hit?.spawned && hit.agent === agent) return { block: true, reason: nameReason(agent, "this spawn", `has the name ${hit.name}, which has already spawned`) };
		}
		if ((agent === "librarian" || agent === "archmagos") && run.redraft && !Object.values(run.scouts ?? {}).includes("done"))
			return { block: true, reason: REDRAFT_REFRESH };
		if (agent === "archmagos") {
			if (!archmagosOn(sid)) return { block: true, reason: ARCHMAGOS_OFF };
			if (!run.archmagos) return { block: true, reason: ARCHMAGOS_UNMARKED };
			const done = Object.values(run.librarians ?? {}).filter(v => v === "done").length;
			if (done < 2) return { block: true, reason: archmagosWaits(done) };
			const spawned = run.archmagosSpawned ?? 0;
			if (spawned >= (run.redraft ? 2 : 1)) return { block: true, reason: run.redraft ? ARCHMAGOS_SPENT : ARCHMAGOS_AGAIN };
			// ponytail: counted here, once per real child (a write agent://<id> follow-up never fires this hook); a dispatch that
			// fails after it, or a later extension's block, still spends the budget: redraft or the user is the way out.
			writeRun({ ...markSpawned(run, key, agent), archmagosSpawned: spawned + 1 });
			record({ event: "spawn", key: run.key, role: agent, model: hostModel() });
			return;
		}
		if (agent === "battle-brother" && run.repo && !run.slices) return { block: true, reason: SLICES_REASON };
		// The tier sets the child's model and its effort (the selector's :level). Reviewers and the rest keep their own.
		const spawned = markSpawned(run, key, agent);
		let tier: Tier | undefined;
		const squad = agent === "veteran" || agent === "battle-brother" ? squadOf(spawned, key, briefNames)?.id : undefined;
		// A new builder reopens its squad: the outcome of the one before no longer stands.
		const marked = squad && naming.on && run.ended && Object.hasOwn(run.ended, squad) ? setEnded(spawned, squad) : spawned;
		if (agent === "veteran") tier = "heavy";
		else if (agent === "battle-brother") tier = tierFor(marked, key, briefNames) ?? "standard";
		// tierFor already wrote the marked run with its `builds`; any other spawn writes the mark alone.
		if (marked !== run && !(agent === "battle-brother" && squad)) writeRun(marked);
		const model = tier ? parseTiers(process.env.STRATEGIUM_TIERS).selectors[tier] : undefined;
		record({ event: "spawn", key: run.key, role: agent, model: model ?? hostModel(), ...(tier ? { tier } : {}), ...(squad ? { squad } : {}) });
		if (tier) return { model, note: `Strategium tier ${tier}` };
	});

	// The host gives no event when an agent ends; its result reaches the model as a message or a wait result that lists
	// the background jobs, labelled with the agent id. A builder that is no longer running leaves its squad; the squad
	// counts as stopped once none of its agents runs. An id ends once: an old message in the history matches nothing.
	// A running librarian or post-redraft scout whose job completed counts as done for the guards (failed or cancelled never do).
	pi.on("context", (e, ctx) => {
		if (ctx?.agent?.kind === "sub" || !ctx?.sessionManager) return;
		const run = ownRun(sidOf(ctx));
		if (!run) return;
		const messages = asObj(e).messages;
		let next: Run = run;
		const completed = endedAgents(messages, "completed");
		const finished = completed.filter(id => run.librarians?.[id] === "running");
		if (finished.length) next = { ...next, librarians: { ...run.librarians, ...Object.fromEntries(finished.map(id => [id, "done" as const])) } };
		const scouted = completed.filter(id => run.scouts?.[id] === "running");
		if (scouted.length) next = { ...next, scouts: { ...run.scouts, ...Object.fromEntries(scouted.map(id => [id, "done" as const])) } };
		const ends = run.agents ? jobEnds(messages).filter(j => run.agents![j.id]) : [];
		const ended = ends.map(j => j.id);
		if (ended.length) {
			const agents = { ...run.agents };
			for (const id of ended) delete agents[id];
			next = settle(next, agents, ended.map(id => run.agents![id]));
			if (naming.on) for (const j of ends) next = setEnded(next, run.agents![j.id].id, outcomeOf(j.status));
		}
		if (next !== run) writeRun(next);
	});

	// A task result gives the id the host allocated to each item, with its index in the call. A builder's id is bound to the
	// squad the item builds (ids are unique, so a reused name or two agents on one squad never share an entry); a
	// librarian's id is tracked for the archmagos guard, whether or not squads exist, and after a redraft so is a scout's.
	pi.on("tool_result", (e, ctx) => {
		if (ctx?.agent?.kind === "sub" || !ctx?.sessionManager || e.toolName.replace(/^_+/, "") !== "task") return;
		const run = ownRun(sidOf(ctx));
		const progress = asObj(e.details).progress;
		if (!run || !Array.isArray(progress)) return;
		const items = taskItems(e.input);
		const agents = { ...run.agents };
		const librarians = { ...run.librarians };
		const scouts = { ...run.scouts };
		let scouted = false;
		const launched: Slice[] = [];
		let tracked = false;
		const done: [string, "ok" | "failed" | undefined][] = [];
		for (const p of progress.map(asObj)) {
			const item = typeof p.index === "number" ? items[p.index] : undefined;
			if (!item || typeof p.id !== "string") continue;
			const name = agentName(String(item.agent ?? "task"));
			// Librarians always; scouts only after a redraft (their end is the refresh).
			const map = name === "librarian" ? librarians : name === "scout" && run.redraft ? scouts : undefined;
			if (map) {
				const before = map[p.id];
				if (p.status === "completed") map[p.id] = "done";
				else if (p.status === "pending" || p.status === "running") map[p.id] ??= "running";
				else continue;
				if (map[p.id] !== before) {
					if (map === scouts) scouted = true;
					else tracked = true;
				}
				continue;
			}
			const slice = builtSlice(item, run);
			if (!slice) continue;
			launched.push(slice);
			// A blocking call returns once its agents are done: those never count as running.
			if (p.status === "pending" || p.status === "running") agents[p.id] = slice;
			else if (FINAL_STATUSES.includes(String(p.status))) done.push([slice.id, outcomeOf(p.status)]);
		}
		let next: Run = run;
		if (launched.length) next = settle(next, agents, launched);
		if (naming.on) for (const [squad, end] of done) next = setEnded(next, squad, end);
		if (tracked) next = { ...next, librarians };
		if (scouted) next = { ...next, scouts };
		if (next !== run) writeRun(next);
	});

	// The Captain's own gh pr merge / glab mr merge that came back clean: the run was merged (the Laurel needs it).
	pi.on("tool_result", (e, ctx) => {
		if (!(naming.on || vault.dir) || ctx?.agent?.kind === "sub" || !ctx?.sessionManager || e.toolName.replace(/^_+/, "") !== "bash" || e.isError) return;
		const input = asObj(e.input);
		if (input.async === true || asObj(e.details).async !== undefined || asObj(e.details).exitCode !== undefined || !isMerge(String(input.command ?? ""))) return;
		const run = ownRun(sidOf(ctx));
		if (run && !run.merged) writeRun({ ...run, merged: true });
	});

	// The Captain's own gh pr create / glab mr create that came back clean: the run's first PR goes into the vault's daily.
	pi.on("tool_result", (e, ctx) => {
		if (!vault.dir || ctx?.agent?.kind === "sub" || !ctx?.sessionManager || e.toolName.replace(/^_+/, "") !== "bash" || e.isError) return;
		const input = asObj(e.input);
		if (input.async === true || asObj(e.details).async !== undefined || asObj(e.details).exitCode !== undefined || !isPrCreate(String(input.command ?? ""))) return;
		const run = ownRun(sidOf(ctx));
		if (!run) return;
		const out = (Array.isArray(e.content) ? e.content : []).map(c => (c?.type === "text" ? c.text : "")).join("\n");
		const url = out.match(/https?:\/\/\S+?\/(?:pull|merge_requests)\/\d+/)?.[0];
		vaultEvent(ctx, run, "pr", url ? `PR opened ${url}` : "PR opened");
	});

	// ponytail: bash is a pattern list (see bashBlock); the edit tools are hidden and write/edit targets are checked below.
	pi.on("tool_call", (e, ctx) => {
		if (ctx?.agent?.kind === "sub") return;
		const run = ownRun(sidOf(ctx));
		const name = e.toolName.replace(/^_+/, "");
		// omp hands the keys of a dialog opened while the cockpit is up to the cockpit, then focus to the editor: close it before the dialog mounts.
		if (name === "ask") cockpit.close?.();
		// A question to the user during a run needs them at the keyboard, wherever they are.
		if (name === "ask" && run) {
			const err = alert(sidOf(ctx), "attention", `${run.key}: your answer is needed`, ctx);
			if (err) alarmWarn(ctx, err);
		}
		// With names on, every roster item of a task call must carry a name the plugin handed out. Before the repo check: it holds with or without a repo.
		if (naming.on && run && name === "task") {
			const seen = new Set<string>();
			for (const item of taskItems(e.input)) {
				const agent = agentName(String(item.agent ?? "task"));
				if (!ROSTER.includes(agent)) continue;
				const given = typeof item.name === "string" ? item.name.trim() : "";
				const problem = seen.has(given) ? `has the name ${given}, which another item of this call already uses` : nameProblem(run, agent, given);
				if (problem) return { block: true, reason: nameReason(agent, "a task item", problem) };
				seen.add(given);
			}
		}
		// A corrupted agent is never a reuse source; like the names check it holds with or without a repo.
		if (run && name === "task") {
			const input = asObj(e.input);
			const briefs = [...taskItems(e.input).map(i => String(i.task ?? "")), String(input.context ?? "")];
			const bad = briefs.flatMap(reuseSources).find(id => corruptedSource(run, id, naming.on));
			if (bad)
				return {
					block: true,
					reason: `Strategium: a task item names ${bad} as its reuse source (Reuse: ${bad}), and ${bad} is rated corrupted: a corrupted agent is never reused. Pick another source with strategium action reuse, or brief a fresh builder without the Reuse line.`,
				};
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
				if (typeof item.name === "string") {
					if (slice) briefNames.set(item.name.trim(), slice.id);
					else briefNames.delete(item.name.trim());
				}
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

	// The cockpit's own hooks come last, so the handlers above have already written the run. They record and redraw
	// (drawCockpit); none of them ticks the timer, so the idle count is untouched.
	// A seal granted: it was in the todo before, not completed, and is completed now.
	pi.on("tool_result", (e, ctx) => {
		if (ctx?.agent?.kind === "sub" || e.toolName.replace(/^_+/, "") !== "todo" || e.isError) return;
		const details = e.details as { op?: string; phases?: Phase[] } | undefined;
		const phases = details?.phases;
		const run = ownRun(sidOf(ctx));
		if (!run || !Array.isArray(phases)) return;
		const before = run.phases;
		writeRun({ ...run, phases });
		const was = before && whereFrom(before);
		// A rebuild's init is auto-started by omp at its first task, which is not where the run is: no station or seal-waiting entry.
		const rebuild = isRebuild(details?.op, before, phases);
		const now = rebuild ? undefined : whereFrom(phases);
		// Seeded from the persisted phases, so a restart or a new run starts from what the run already showed.
		cockpit.station ??= was?.station;
		if (cockpit.asked === undefined && was) cockpit.asked = was.seal ?? null;
		if (now && now.station !== cockpit.station) {
			log(run.key, "STRATEGOS", `station ${now.station}`);
			record({ event: "station", key: run.key, station: now.station.slice(0, 200) });
		}
		if (now) cockpit.station = now.station;
		if (now?.seal && now.seal !== cockpit.asked) {
			log(run.key, "STRATEGOS", `${icons(process.env.STRATEGIUM_GLYPHS === "1").seal} seal ${now.seal} awaits the Chapter Master`, "seal");
			record({ event: "seal", key: run.key, seal: (waitingSeal(phases)?.id ?? now.seal).slice(0, 200), state: "asked" });
		}
		if (now) cockpit.asked = now.seal ?? null;
		// A hand-off (plan stations replaced by the remaining ones) is the approval: the seal that waited is granted.
		const handedOff = isHandOff(details?.op, before, phases) ? waitingSeal(before) : undefined;
		let sealed: Run = { ...run, phases };
		for (const seal of handedOff ? [handedOff] : grantedSeals(before, phases)) {
			log(run.key, "✠ SEAL", `${seal.id} granted`, "seal");
			record({ event: "seal", key: run.key, seal: seal.id.slice(0, 200), state: "granted" });
			sealed = vaultEvent(ctx, sealed, `seal:${seal.id.slice(0, 200)}`, `seal ${seal.id} granted`);
			const err = alert(sidOf(ctx), "done", `${run.key}: seal ${seal.id} granted`, ctx);
			if (err) alarmWarn(ctx, err);
		}
		// Prepared lines live only while their seal waits: any other state of the todo drops them.
		if (cockpit.seal && cockpit.seal.id !== waitingSeal(phases)?.id) {
			cockpit.seal = undefined;
			cockpit.dirty = true;
		}
		drawCockpit(sealed, ctx);
	});

	// An agent deployed: the host allocates its id in the task result. An agent spawned by eval agent() is registered by its spawn hook (below).
	pi.on("tool_result", (e, ctx) => {
		if (ctx?.agent?.kind === "sub" || !ctx?.sessionManager || e.toolName.replace(/^_+/, "") !== "task") return;
		const run = ownRun(sidOf(ctx));
		const progress = asObj(e.details).progress;
		if (!run || !Array.isArray(progress)) return;
		const items = taskItems(e.input);
		for (const p of progress.map(asObj)) {
			if (typeof p.id !== "string") continue;
			if (p.status === "pending" || p.status === "running") {
				if (cockpit.deployed.has(p.id)) continue;
				const item = typeof p.index === "number" ? items[p.index] : undefined;
				const agent = agentName(String(item?.agent ?? "task"));
				const squad = item && builtSlice(item, run)?.id;
				const station = activeStation(run.phases ?? []);
				// log first: it resets the cockpit when the run key changed, which would wipe a registry entry set before it.
				if (!squad) {
					const name = naming.on ? nameBehind(run, p.id) : undefined;
					log(run.key, agent.toUpperCase(), name ? `${name} deployed` : "deployed", undefined, p.id);
					cockpit.deployed.set(p.id, { who: agent.toUpperCase(), role: agent, station, state: "active", at: Date.now(), ...(name ? { name } : {}) });
					continue;
				}
				const veteran = agent === "veteran";
				const ic = icons(process.env.STRATEGIUM_GLYPHS === "1");
				const name = naming.on ? nameBehind(run, p.id) : undefined;
				log(run.key, `SQUAD ${squad}`, veteran ? `${ic.veteran} ${name ? `${name} ` : ""}escalated to VETERAN` : `${ic.brother} ${name ?? "battle-brother"} deployed`, veteran ? "fail" : undefined, p.id);
				if (veteran) cockpit.notes[squad] = { ...cockpit.notes[squad], veteran: true };
				cockpit.deployed.set(p.id, { who: `SQUAD ${squad}`, role: agent, squad, station, state: "active", at: Date.now(), ...(name ? { name } : {}) });
			} else if (FINAL_STATUSES.includes(String(p.status))) endJob(run.key, p.id, p.status === "completed");
		}
		drawCockpit(run, ctx);
	});

	// An agent returned or failed: its job ends, or its eval cell reports its end, in a message to the model. An id ends once.
	pi.on("context", (e, ctx) => {
		if (ctx?.agent?.kind === "sub" || !ctx?.sessionManager) return;
		const ends = jobEnds(asObj(e).messages).filter(j => cockpit.deployed.get(j.id)?.state === "active");
		const run = ends.length ? ownRun(sidOf(ctx)) : undefined;
		if (!run) return;
		for (const j of ends) endJob(run.key, j.id, j.status === "completed");
		drawCockpit(run, ctx);
	});

	pi.on("before_subagent_spawn", (e, ctx) => {
		if (ctx?.agent?.kind === "sub" || !ctx?.sessionManager || asObj(e).invocationKind !== "eval") return;
		const run = ownRun(sidOf(ctx));
		const agent = agentName(String(asObj(e).agent ?? "task"));
		if (!run || !ROSTER.includes(agent)) return;
		const spawnKey = asObj(e).spawnKey;
		const id = typeof spawnKey === "string" && spawnKey ? spawnKey : `eval-${agent}-${cockpit.deployed.size + 1}`;
		const name = naming.on ? nameBehind(run, id) : undefined;
		log(run.key, agent.toUpperCase(), name ? `${name} deployed` : "deployed", undefined, id);
		// The spawnKey is the agent's id: its job label and its eval status events, so the context hook above ends it.
		// shortcut: an eval spawn without spawnKey has nothing to match its end, so it stays ▶ until the run key changes; upgrade if a host omits spawnKey.
		cockpit.deployed.set(id, { who: agent.toUpperCase(), role: agent, station: activeStation(run.phases ?? []), state: "active", at: Date.now(), ...(name ? { name } : {}) });
		drawCockpit(run, ctx);
	});

	// The session that spawns children leaves a pointer for them (they share its pid); it goes with the session.
	pi.on("before_subagent_spawn", (_e, ctx) => {
		if (ctx?.agent?.kind === "sub" || !ctx?.sessionManager) return;
		const sid = sidOf(ctx);
		if (!ownRun(sid)) return dropPointer(); // a pointer left for another session must not send our agents' rows there
		try {
			writeAtomic(pidFile(), sid);
		} catch {
			// No pointer: the rows of its agents show elapsed time only.
		}
	});

	// The subagent side of the live rows: this instance, in a child session, records what its agent does in runs/<sid>.live/<id>.json for the
	// parent's cockpit to read. It never throws into the agent loop and writes at most once a second (one trailing write carries the latest state).
	// shortcut: a child in another OS process reads no pointer (its pid differs) and writes nothing; upgrade if omp moves subagents out of process.
	// shortcut: a lost tool_execution_end leaves `busy` up, so that agent never counts as stalled; upgrade if the host drops those events.
	const LIVE_MS = 1000;
	const mine = { since: 0, at: 0, busy: 0, wrote: 0, wroteBlocked: false, row: {} as Partial<Live>, timer: undefined as ReturnType<typeof setTimeout> | undefined };
	const cap = (s: string) => s.slice(0, LIVE_TEXT);
	/** The session's own usage as omp counts it, read when the file is written. Unknown stays absent: no tokens, no price (cost 0 with tokens) or a failing read give no field. */
	// shortcut: tokens include nested sync spawns' tokens (omp has no per-nested token split; cost excludes them); upgrade if omp adds one.
	const usageRow = (ctx: { sessionManager?: { getUsageStatistics?: () => unknown } } | undefined): Partial<Live> => {
		try {
			const u = asObj(ctx?.sessionManager?.getUsageStatistics?.());
			if (!((u.totalTokens as number) > 0)) return {};
			const cost = (u.cost as number) - (u.subagentCost as number);
			return {
				...(isCount(u.input) ? { tokens_in: u.input } : {}),
				...(isCount(u.output) ? { tokens_out: u.output } : {}),
				...(isCount(u.cacheRead) ? { cache_read: u.cacheRead } : {}),
				...(isCount(u.cacheWrite) ? { cache_write: u.cacheWrite } : {}),
				...(Number.isFinite(cost) && cost > 0 ? { cost } : {}),
			};
		} catch {
			return {};
		}
	};
	/** Records the row; true when a run pointer is valid (written or scheduled). `force` writes at once, past the 1 s throttle. */
	const recordLive = (ctx: { agent?: { kind?: string; id?: string }; sessionManager?: { getUsageStatistics?: () => unknown } } | undefined, busy: number, row: Partial<Live>, force = false) => {
		const id = ctx?.agent?.id;
		if (ctx?.agent?.kind !== "sub" || !id) return false;
		try {
			const now = Date.now();
			mine.since ||= now;
			mine.at = now;
			mine.busy = Math.max(0, mine.busy + busy);
			Object.assign(mine.row, row);
			// A write is pending and carries the latest state: no pointer read, no stat.
			if (mine.timer && !force) return true;
			const sid = readFileSync(pidFile(), "utf8").trim();
			// A pointer to a run that is gone is inert.
			if (!/^[\w.-]+$/.test(sid) || !existsSync(runFile(sid))) return false;
			const write = () => {
				Object.assign(mine.row, usageRow(ctx));
				clearTimeout(mine.timer);
				mine.timer = undefined;
				mine.wrote = Date.now();
				mine.wroteBlocked = !!mine.row.blocked;
				try {
					if (existsSync(runFile(sid))) writeAtomic(liveFile(sid, id), JSON.stringify({ since: mine.since, at: mine.at, busy: mine.busy, ...mine.row }));
				} catch {
					// The next update writes again.
				}
			};
			if (force || now - mine.wrote >= LIVE_MS) write();
			else {
				mine.timer = setTimeout(write, LIVE_MS - (now - mine.wrote));
				mine.timer.unref();
			}
			return true;
		} catch {
			// No pointer or no file: nothing to show.
			return false;
		}
	};
	// A block clears only with a later signal without blocked (or when the agent is no longer active): an agent waiting on the Captain does so inside a tool call, so a tool start must not undo it.
	pi.on("tool_execution_start", (e, ctx) => void recordLive(ctx, 1, { tool: cap(bareName(e.toolName)), intent: typeof e.intent === "string" ? cap(e.intent) : undefined }));
	pi.on("tool_execution_end", (_e, ctx) => void recordLive(ctx, -1, {}));
	pi.on("tool_result", (e, ctx) => {
		const phases = (e.details as { phases?: unknown } | undefined)?.phases;
		if (ctx?.agent?.kind !== "sub" || e.toolName.replace(/^_+/, "") !== "todo" || e.isError || !Array.isArray(phases)) return;
		const tasks = phases.flatMap(p => (Array.isArray(p?.tasks) ? p.tasks : []) as { content?: unknown; status?: unknown }[]).filter(t => t?.status !== "abandoned");
		const current = tasks.find(t => t?.status === "in_progress")?.content;
		recordLive(ctx, 0, { done: tasks.filter(t => t?.status === "completed").length, total: tasks.length, current: typeof current === "string" ? cap(current) : undefined });
	});
	// An assistant message ended: the throttled write carries the usage and moves `at`. The turn's end writes at once so the final figure lands.
	pi.on("message_end", (e, ctx) => void (asObj(asObj(e).message).role === "assistant" && recordLive(ctx, 0, {})));
	pi.on("agent_end", (_e, ctx) => void recordLive(ctx, 0, {}, true));
	// A parked child writes its last figure now (this clears the pending timer), whether or not one was pending.
	pi.on("session_shutdown", (_e, ctx) => {
		recordLive(ctx, 0, {}, true);
		if (ctx?.agent?.kind === "sub") clearTimeout(mine.timer);
	});

	pi.on("session_shutdown", (_e, ctx) => {
		if (ctx?.agent?.kind === "sub") return;
		cockpit.close?.();
		resetCockpit();
		if (ctx?.sessionManager) dropPointer(sidOf(ctx));
	});
}
