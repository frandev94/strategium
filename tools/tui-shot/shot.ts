const USAGE = `Run the real omp + this plugin in a Windows ConPTY, seed a run, and screenshot what the user sees, or replay past regressions. Windows only.

  bun tools/tui-shot/shot.ts [--seed=scriptorium|skirmish|timed|restart] [--ponytail[=DIR]] [--suffix=-x] [--plugin=DIR]
                             [--out=DIR] [--omp=EXE] [--edge=EXE] [--no-png]
  bun tools/tui-shot/shot.ts --replay=NAME | --all  [--plugin=DIR] [--suffix=-x] [--out=DIR] [--omp=EXE] [--edge=EXE] [--no-png] [--all-png] [--keep-work]

Default mode writes screen<sfx>.* (the footer the seeded run draws, before Alt+C) and overlay<sfx>.* (after Alt+C).
--ponytail[=DIR]: also load the ponytail omp plugin (second -e), default dir found under ~/.omp/plugins; suffix defaults to -ponytail.
--replay=NAME runs one regression scenario (REPLAYS below): keys, resizes and waits in the real omp, text checks on the screen xterm.js holds at each
checkpoint; prints PASS/FAIL and exits 0/1 (unknown name: 2). --all runs every scenario and prints a table. --keep-work keeps the work dir (replay.log). --all-png (replays) shoots every snapshot, not only the png=True ones.
Outputs (default %TEMP%\\strategium-tui-shot): <name>.raw (VT bytes), <name>.html (xterm.js 5.5 vendored in tools/tui-shot/vendor, no network), <name>.png (headless Edge).
The run is seeded on disk and omp resumes a hand-written session with the same id, so no model call is spent (the replays that need a model use the fake provider in replay-ext.ts).
`;
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { killTree, Pty } from "./pty.ts";

const COLS = 140, ROWS = 45;
const ROOT = resolve(import.meta.dir, "..", "..");
const SID = "01a1eb00-0000-7000-8000-00000000d3a0", KEY = "demo-shot"; // the session id + run key tie claim, run file and session file together

// --- seeds: data only. Task text is "[role] Title"; status completed|in_progress|pending. To add one, add an entry here. ---
type Task = { content: string; status: string };
type Phase = { name: string; tasks: Task[] };
type Seed = { where: Record<string, string>; extra: Record<string, unknown>; phases: Phase[]; timed?: number; cockpit?: Record<string, unknown> };
const t = (content: string, status: string): Task => ({ content, status });
const sl = (id: string) => ({ id, parallel: true, files: [] });
const MUSTER = { name: "Muster", tasks: [t("[captain] Begin run", "completed"), t("[captain] Orders", "completed")] };
const AUSPEX = { name: "Auspex", tasks: [t("[scout] Map the cockpit code", "completed")] };
const INQ = { name: "Inquisition", tasks: [t("[inquisitor] Review the branch", "pending"), t("[seal] Demo", "pending")] };
const SCRIPTORIUM = {
	name: "Scriptorium",
	tasks: [t("[librarian] Plan area cockpit", "completed"), t("[librarian] Plan area docs", "completed"), t("[archmagos] Merge the plan", "completed"), t("[seal] Plan", "in_progress")],
};
export const SEEDS: Record<string, Seed> = {
	scriptorium: { // planning station, a seal waiting for the Chapter Master
		where: { station: "Scriptorium", seal: "Plan" }, extra: {},
		phases: [MUSTER, AUSPEX, SCRIPTORIUM,
			{ name: "Deployment", tasks: [t("[captain] Declare the squads", "pending")] },
			{ name: "Skirmish", tasks: [t("[battle-brother] Build the squads", "pending")] }, INQ],
	},
	skirmish: { // building station: two live agents, one stopped slice
		where: { station: "Skirmish", task: "Build squad alpha" },
		extra: { agents: { AlphaBrother: sl("alpha"), GammaVeteran: sl("gamma") }, stopped: [sl("beta")] },
		phases: [MUSTER, AUSPEX,
			{ name: "Scriptorium", tasks: [t("[librarian] Plan area cockpit", "completed"), t("[archmagos] Merge the plan", "completed"), t("[seal] Plan", "completed")] },
			{ name: "Deployment", tasks: [t("[captain] Declare the squads", "completed")] },
			{ name: "Skirmish", tasks: [t("[battle-brother] Build squad alpha", "in_progress"), t("[battle-brother] Build squad beta", "completed"),
				t("[veteran] Rebuild squad gamma", "in_progress"), t("[apothecary] Test squad beta", "in_progress"), t("[seal] Commit", "pending")] }, INQ],
	},
	timed: { // scriptorium, but a booked run (not untimed): today's day file has the start event with booked=240, as startKey writes it
		where: { station: "Scriptorium", seal: "Plan" }, extra: {}, timed: 240,
		phases: [MUSTER, AUSPEX, SCRIPTORIUM],
	},
};
SEEDS.restart = { ...SEEDS.skirmish, cockpit: { // skirmish plus a saved cockpit (runs/<sid>.cockpit): what an omp restart must bring back
	chronicle: [
		{ at: "10:01", who: "STRATEGOS", text: "station Skirmish" },
		{ at: "10:02", who: "✠ SEAL", text: "Plan granted", tone: "seal" },
		{ at: "10:03", who: "SQUAD alpha", text: "battle-brother deployed" },
		{ at: "10:04", who: "SQUAD beta", text: "✓ returned", tone: "ok" },
		{ at: "10:05", who: "SQUAD gamma", text: "escalated to VETERAN", tone: "fail" },
		{ at: "10:06", who: "SQUAD delta", text: "✗ failed", tone: "fail" }],
	notes: { gamma: { veteran: true }, delta: { failed: true } },
	deployed: [
		["AlphaBrother", { who: "AlphaBrother", role: "battle-brother", squad: "alpha", station: "Skirmish", state: "active" }],
		["GammaVeteran", { who: "GammaVeteran", role: "veteran", squad: "gamma", station: "Skirmish", state: "active" }],
		["BetaBrother", { who: "BetaBrother", role: "battle-brother", squad: "beta", station: "Skirmish", state: "done" }],
		["DeltaBrother", { who: "DeltaBrother", role: "battle-brother", squad: "delta", station: "Skirmish", state: "failed" }]],
} };
SEEDS["seal-panel"] = { ...SEEDS.scriptorium, cockpit: { chronicle: [], notes: {}, deployed: [], seal: { id: "Plan", lines: [ // prepared panel lines: 14, so the cap shows 11 + "+3 more"
	"Squads: cockpit (standard), shots (light), docs (light)", "Merge bar: AC1 no SEAL box at 140 columns", "Merge bar: AC2 SEALS chain",
	"Merge bar: AC3 seal panel", "Merge bar: AC4 tests follow the contract", "Merge bar: bun run check clean", "Merge bar: bun test 0 fail",
	"Merge bar: regression replays PASS", "Merge bar: docs in step", "LONG-" + "x".repeat(195), "Merge bar: apothecary fuzz pass",
	"Merge bar: PR closes #82", "line 13", "line 14"] } } };

// --- args: argparse semantics (--x=v and --x v; --ponytail with an optional value), no prefix abbreviations ---
export interface Args {
	seed: string; ponytail: string | true | null; suffix: string | null; plugin: string; out: string; omp: string | null; edge: string | null;
	noPng: boolean; allPng: boolean; replay: string | null; all: boolean; keepWork: boolean; help: boolean;
}
const VALUE: Record<string, keyof Args> = { "--seed": "seed", "--suffix": "suffix", "--plugin": "plugin", "--out": "out", "--omp": "omp", "--edge": "edge", "--replay": "replay" };
const FLAG: Record<string, keyof Args> = { "--no-png": "noPng", "--all-png": "allPng", "--all": "all", "--keep-work": "keepWork", "-h": "help", "--help": "help" };
export function parseArgs(argv: string[]): Args | { error: string } {
	const a: Args = { seed: "scriptorium", ponytail: null, suffix: null, plugin: ROOT, out: join(tmpdir(), "strategium-tui-shot"), omp: null, edge: null,
		noPng: false, allPng: false, replay: null, all: false, keepWork: false, help: false };
	const set = a as unknown as Record<string, unknown>;
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i], eq = tok.startsWith("--") ? tok.indexOf("=") : -1;
		const name = eq < 0 ? tok : tok.slice(0, eq), val = eq < 0 ? undefined : tok.slice(eq + 1), next = argv[i + 1];
		if (Object.hasOwn(VALUE, name)) {
			if (val !== undefined) set[VALUE[name]] = val;
			else if (next === undefined || next.startsWith("-")) return { error: `argument ${name}: expected one argument` };
			else set[VALUE[name]] = argv[++i];
		} else if (Object.hasOwn(FLAG, name)) {
			if (val !== undefined) return { error: `argument ${name}: ignored explicit argument '${val}'` };
			set[FLAG[name]] = true;
			if (a.help) return a; // argparse prints the help as soon as it meets -h
		} else if (name === "--ponytail") {
			if (val !== undefined) a.ponytail = val;
			else if (next !== undefined && !next.startsWith("-")) a.ponytail = argv[++i];
			else a.ponytail = true;
		} else return { error: `unrecognized arguments: ${tok}` };
	}
	if (!Object.hasOwn(SEEDS, a.seed)) return { error: `argument --seed: invalid choice: '${a.seed}' (choose from ${Object.keys(SEEDS).map(s => `'${s}'`).join(", ")})` };
	return a;
}

/** sys.exit(msg): main prints the message on stderr and exits 1. */
class Fatal extends Error {}
function die(msg: string): never {
	throw new Fatal(msg);
}

// Set by main() (shot.py's module globals): the parsed args and what they resolve to.
let A: Args;
let SFX = "", OUT = "", PLUGIN = "", omp = "", edge: string | null = null, PAGE = "";
const EXT = join(ROOT, "tools", "tui-shot", "replay-ext.ts"); // dev-only fake provider, always the harness's own copy

function find(opt: string | null, name: string, cands: string[]): string {
	return opt || cands.find(c => existsSync(c)) || Bun.which(name) || die(`${name} not found: pass --${name}=PATH`);
}
function findPony(): string | null {
	const dir = join(homedir(), ".omp", "plugins", "cache", "plugins");
	const hits = existsSync(dir) ? readdirSync(dir).filter(n => n.startsWith("ponytail___")).sort().reverse() : [];
	return hits.length ? join(dir, hits[0]) : null;
}

// Keys as Windows Terminal sends them in win32-input-mode: CSI Vk;Sc;Uc;Kd;Cs;Rc _ (Cs: 2 left Alt, 128 Caps Lock, 256 enhanced key).
export function rec(vk: number, sc: number, uc: number, kd: number, cs: number) {
	return `\x1b[${vk};${sc};${uc};${kd};${cs};1_`;
}
export const KEYS: Record<string, string[]> = {
	altc: [rec(18, 56, 0, 1, 2), rec(67, 46, 99, 1, 2), rec(67, 46, 99, 0, 2), rec(18, 56, 0, 0, 0)],
	"caps-altc": [rec(18, 56, 0, 1, 130), rec(67, 46, 67, 1, 130), rec(67, 46, 67, 0, 130), rec(18, 56, 0, 0, 128)],
	esc: [rec(27, 1, 27, 1, 0), rec(27, 1, 27, 0, 0)],
	q: [rec(81, 16, 113, 1, 0), rec(81, 16, 113, 0, 0)],
	"plain-q": ["q"],
	down: [rec(40, 80, 0, 1, 256), rec(40, 80, 0, 0, 256)],
	right: [rec(39, 77, 0, 1, 256), rec(39, 77, 0, 0, 256)],
	enter: ["\r"],
};

/** Local time with its offset, as Python's datetime.astimezone().isoformat() writes it. */
function isoLocal(d: Date) {
	const p = (n: number) => String(n).padStart(2, "0"), o = -d.getTimezoneOffset();
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
		+ `${o < 0 ? "-" : "+"}${p(Math.floor(Math.abs(o) / 60))}:${p(Math.abs(o) % 60)}`;
}

type Ev = ["s", string, number, boolean] | ["r", number, number, number]; // snapshot (name, byte offset, png) / resize (byte offset, cols, rows)
const now = () => Date.now() / 1000;

/** One omp in its own ConPTY, with its own throwaway work dir (state, session, cwd, edge profile) under OUT. */
export class Run {
	cols = COLS;
	rows = ROWS;
	work: string;
	state: string;
	sess: string;
	cwd: string;
	sfile: string;
	runfile: string;
	beat: string;
	log: string;
	cmd: string;
	env: Record<string, string>;
	events: Ev[] = []; // in call order: snapshots and resizes, replayed by the page
	notes: Record<string, any> = {}; // scenario scratch (esc-close, cockpit-restart)
	private chunks: Buffer[] = []; // the stream: byte offsets, never decoded before slicing
	private size = 0;
	private pty!: Pty;

	constructor(seed: string, readonly sfx: string, readonly ext = false, ponytail: string | null = null) {
		// Fixed name (it shows in omp's footer, so shots stay comparable) and per suffix (parallel runs need different --suffix).
		this.work = join(OUT, "work" + sfx);
		try { rmSync(this.work, { recursive: true, force: true }); } catch {}
		[this.state, this.sess, this.cwd] = ["state", "sessions", "cwd"].map(d => join(this.work, d));
		for (const d of [join(this.state, "runs"), join(this.state, "claims"), this.sess, this.cwd]) mkdirSync(d, { recursive: true });
		// Seed before omp starts: a session file with a fixed id, plus the run file and claim the extension reads.
		this.sfile = join(this.sess, `2026-11-17T00-00-00-000Z_${SID}.jsonl`);
		writeFileSync(this.sfile, JSON.stringify({ type: "session", version: 3, id: SID, timestamp: "2026-11-17T00:00:00.000Z", cwd: this.cwd }) + "\n");
		const S = SEEDS[seed];
		this.runfile = join(this.state, "runs", SID + ".json");
		writeFileSync(this.runfile, JSON.stringify({ key: KEY, theatre: "none", sid: SID, ...(S.timed ? {} : { untimed: true }), where: S.where, phases: S.phases,
			slices: ["alpha", "beta", "gamma", "delta"].map(sl), ...S.extra }));
		if (S.cockpit) // the file index.ts writes (cockpit file contract: key, chronicle oldest first, notes, deployed [id, Deployed][])
			writeFileSync(join(this.state, "runs", SID + ".cockpit"), JSON.stringify({ key: KEY, ...S.cockpit }));
		if (S.timed) { // the day file startKey would have written: local date, local time with offset
			const n = new Date(); n.setMilliseconds(0);
			const midnight = new Date(n); midnight.setHours(0, 0, 0, 0);
			const ts = new Date(Math.max(n.getTime() - 10 * 60_000, midnight.getTime()));
			writeFileSync(join(this.state, isoLocal(n).slice(0, 10) + ".jsonl"), JSON.stringify({ ts: isoLocal(ts), event: "start", key: KEY, booked: S.timed }) + "\n");
		}
		// Same lock name as timer.ts lockPath().
		writeFileSync(join(this.state, "claims", `${KEY}-${createHash("sha1").update(KEY).digest("hex").slice(0, 8)}.lock`), SID);
		this.beat = join(this.state, "runs", SID + ".beat"); // the extension writes it on its first tick
		this.log = join(this.work, "replay.log");
		this.cmd = `"${omp}" --no-extensions --session-dir "${this.sess}" --resume "${this.sfile}" -e "${PLUGIN}"` + (ponytail ? ` -e "${ponytail}"` : "");
		this.env = {};
		for (const [a, b] of Object.entries(process.env)) if (b !== undefined) this.env[a] = b;
		Object.assign(this.env, { STRATEGIUM_STATE_DIR: this.state, STRATEGIUM_GLYPHS: "1", TERM_PROGRAM: "Windows_Terminal", WT_SESSION: "00000000-0000-0000-0000-000000000001" });
		if (ext) { // every model role pinned to the fake provider: side turns (title...) never reach a real model either
			writeFileSync(join(this.work, "replay.yml"),
				"modelRoles:\n" + ["default", "slow", "plan", "advisor", "task", "vision", "commit", "smol"].map(r => `  ${r}: replay/ask\n`).join(""));
			this.cmd += ` -e "${EXT}" --model replay/ask --config "${this.work}\\replay.yml"`;
			this.env.STRATEGIUM_REPLAY_DIR = this.work;
		}
		this.launch();
	}

	/** The whole stream so far (bytes). */
	get out(): Buffer {
		if (this.chunks.length !== 1) this.chunks = [Buffer.concat(this.chunks, this.size)];
		return this.chunks[0];
	}

	private append(b: Buffer) {
		this.chunks.push(b);
		this.size += b.length;
	}

	/** Start omp (cmd, env, cwd) in a new ConPTY at the current size; its output is appended to the stream. */
	private launch() {
		this.pty = new Pty(this.cols, this.rows, b => this.append(b));
		this.pty.start(this.cmd, this.cwd, this.env);
	}

	stop() {
		this.pty.stop();
	}

	/** Kill omp (a crash: no shutdown hook) and start it again on the same work dir, seed untouched. One stream: the old process's bytes stay,
	 * then a reset (leave the alternate buffer, RIS) so the page replays the new process on a clean screen. Waits for the new process's first heartbeat. */
	async restart() {
		this.stop(); // drains the old pipe before the reset marker
		await Bun.sleep(500);
		this.append(Buffer.from("\x1b[?1049l\x1bc"));
		if (existsSync(this.beat)) unlinkSync(this.beat);
		this.launch();
		await this.settle();
	}

	cleanup() {
		if (!A.keepWork) try { rmSync(this.work, { recursive: true, force: true }); } catch {}
	}

	// --- steps: every one that waits is async; scenarios await each call ---
	send(s: string) {
		this.pty.send(s);
	}
	async key(name: string) {
		for (const s of KEYS[name]) { this.send(s); await Bun.sleep(30); }
	}
	async typeText(s: string) {
		this.send(s);
		await Bun.sleep(500);
	}
	sleep(s: number) {
		return Bun.sleep(s * 1000);
	}
	async resize(cols: number, rows: number) {
		this.pty.drain(); // the offset is the exact byte where the new size starts
		this.pty.resize(cols, rows);
		this.cols = cols;
		this.rows = rows;
		this.events.push(["r", this.size, cols, rows]);
		await Bun.sleep(500);
	}
	async waitQuiet(quiet = 1.0, timeout = 3.0) {
		const end = now() + timeout;
		let last = this.size, since = now();
		while (now() - since < quiet && now() < end) {
			await Bun.sleep(100);
			if (this.size !== last) { last = this.size; since = now(); }
		}
	}
	/** Wait until `text` (bytes, no spaces: ConPTY may paint a gap as a cursor move) is in the stream; false on timeout. */
	async waitFor(text: Buffer, timeout: number) {
		const end = now() + timeout;
		while (!this.out.includes(text) && now() < end) await Bun.sleep(100);
		return this.out.includes(text);
	}
	async waitBeat() {
		const end = now() + 60;
		while (!existsSync(this.beat) && now() < end) await Bun.sleep(100);
		if (!existsSync(this.beat))
			throw new Error(`extension never ticked: no run heartbeat in ${this.state}; omp said: ${JSON.stringify(this.out.subarray(-400).toString("utf8"))}`);
	}
	/** Ready = the extension ticked (heartbeat file exists) and the screen has been quiet for 2 s. */
	async settle() {
		await this.waitBeat();
		await this.waitQuiet(2, 60);
	}
	async open() {
		await this.key("altc");
		await this.waitQuiet(1.0, 3.0);
	}
	altOpen() {
		return this.out.lastIndexOf("\x1b[?1049h") > this.out.lastIndexOf("\x1b[?1049l");
	}
	async snap(name: string, png = false) {
		await Bun.sleep(300);
		this.pty.drain();
		this.events.push(["s", name, this.size, png]);
	}
	logEvents(): Record<string, any>[] {
		if (!existsSync(this.log)) return [];
		return readFileSync(this.log, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
	}
}

// --- rendering: xterm.js 5.5 (vendored, checked against vendor/SHA256SUMS) in headless Edge. One page replays the stream with the logged resizes; it dumps every snapshot or is photographed. ---
const VENDOR = join(ROOT, "tools", "tui-shot", "vendor"); // the harness's own copy, like EXT
const XTERM = ["xterm-5.5.0/xterm.css", "xterm-5.5.0/xterm.js", "addon-unicode11-0.8.0/addon-unicode11.js"];
/** file:// URLs of XTERM, each checked against its SHA256SUMS line first; exits on a missing or changed file. */
function vendored() {
	const sums = new Map<string, string>();
	for (const l of readFileSync(join(VENDOR, "SHA256SUMS"), "utf8").split("\n")) {
		const m = /^\s*(\S+)\s+(.*)$/.exec(l);
		if (m) sums.set(m[2].trim().replace(/^\*+/, ""), m[1].toLowerCase()); // "*": sha256sum's binary-mode marker
	}
	for (const rel of XTERM) {
		const p = join(VENDOR, rel);
		const got = existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "missing";
		if (got !== sums.get(rel))
			die(`vendored file tools/tui-shot/vendor/${rel} does not match vendor/SHA256SUMS (sha256 ${got}, expected ${sums.get(rel) ?? "no entry"}); restore it with: git checkout -- tools/tui-shot/vendor`);
	}
	return XTERM.map(rel => pathToFileURL(join(VENDOR, rel)).href);
}
const PAGE_TEMPLATE = `<!doctype html><meta charset=utf8>
<link rel=stylesheet href="@CSS@">
<style>body{margin:0;background:#000;overflow:hidden}.xterm-viewport{overflow:hidden!important}#term{display:inline-block;padding:8px;background:#000}</style>
<div id=term></div><pre id=dump></pre>
<script src="@XTERM@"></script>
<script src="@U11@"></script>
<script>
const t=new Terminal({cols:@COLS@,rows:@ROWS@,fontFamily:'CaskaydiaCove Nerd Font Mono',fontSize:14,allowProposedApi:true,scrollback:0});
t.loadAddon(new Unicode11Addon.Unicode11Addon());t.unicode.activeVersion='11';  // emoji are 2 cells wide, as in Windows Terminal
t.open(document.getElementById('term'));
const bytes=Uint8Array.from(atob("@B64@"),c=>c.charCodeAt(0)),EV=@EV@,snaps=[];
function dump(name){const b=t.buffer.active,cells=[],wide=[];
  for(let y=0;y<t.rows;y++){const L=b.getLine(y),row=[];
    for(let x=0;x<t.cols;x++){const c=L.getCell(x),wd=c.getWidth();if(wd==0)row.push('');else{row.push(c.getChars()||' ');if(wd==2)wide.push([y,x]);}}
    cells.push(row);}
  return {name,type:b.type,cols:t.cols,rows:t.rows,cells,wide};}
let pos=0,i=0;
function next(){
  if(i>=EV.length){const rest=bytes.subarray(pos);pos=bytes.length;return t.write(rest,()=>setTimeout(()=>{document.getElementById('dump').textContent=JSON.stringify(snaps);document.body.dataset.done=1;},300));}
  const e=EV[i++];t.write(bytes.subarray(pos,e[1]),()=>{pos=e[1];if(e[0]=='r')t.resize(e[2],e[3]);else snaps.push(dump(e[2]));next();});}
document.fonts.load('14px "CaskaydiaCove Nerd Font Mono"').finally(next);
</script>`;
// split/join, not replace: a "$" in the replacement must stay literal
const fill = (s: string, key: string, v: string) => s.split(key).join(v);

type PageEv = ["s", number, string] | ["r", number, number, number];
/** Write <name>.raw and <name>.html for the stream `data` (events: resizes and snapshots, by byte offset). */
function page(name: string, data: Buffer, events: PageEv[], cols = COLS, rows = ROWS) {
	writeFileSync(join(OUT, name + ".raw"), data);
	writeFileSync(join(OUT, name + ".html"),
		fill(fill(fill(fill(PAGE, "@COLS@", String(cols)), "@ROWS@", String(rows)), "@B64@", data.toString("base64")), "@EV@", JSON.stringify(events)));
}

async function edgeRun(prof: string, args: string[], capture = false): Promise<Buffer> {
	const p = Bun.spawn([edge!, "--headless=new", "--disable-gpu", "--user-data-dir=" + prof, "--hide-scrollbars", "--window-size=1200,780", "--virtual-time-budget=20000", ...args],
		{ stdout: capture ? "pipe" : "ignore", stderr: "ignore" });
	const late = Promise.withResolvers<Buffer>();
	const timer = setTimeout(() => late.resolve(Buffer.alloc(0)), 90_000);
	try {
		const done = (async () => {
			const b = p.stdout instanceof ReadableStream ? Buffer.from(await new Response(p.stdout).arrayBuffer()) : Buffer.alloc(0);
			await p.exited;
			return b;
		})();
		return await Promise.race([done, late.promise]);
	} finally {
		clearTimeout(timer);
		killTree(p.pid);
	}
}

async function shoot(prof: string, name: string) {
	const png = join(OUT, name + ".png");
	if (existsSync(png)) unlinkSync(png);
	await edgeRun(prof, ["--screenshot=" + png, pathToFileURL(join(OUT, name + ".html")).href]);
	if (!existsSync(png)) die(`edge produced no ${png}`);
}

// --- default mode: the two shots ---
async function capture(pony: string | null) {
	const R = new Run(A.seed, SFX, false, pony);
	let names: string[] = [];
	try {
		await R.settle();
		page("screen" + SFX, R.out, []); // the footer the seeded run draws on its first tick
		await R.key("altc"); // Alt+C as Windows Terminal sends it in win32-input-mode: Alt down, C down/up, Alt up
		await Bun.sleep(1500);
		page("overlay" + SFX, R.out, []); // the screen + the Alt+C delta, replayed in one stream
		names = ["screen" + SFX, "overlay" + SFX];
	} finally {
		R.stop();
	}
	try {
		if (edge && !A.noPng) for (const n of names) await shoot(join(R.work, "edge-profile"), n); // headless Edge with a throwaway profile, never the user's
	} finally {
		R.cleanup();
	}
	console.log("done", PLUGIN, "raw bytes", R.out.length, "->", names.map(n => join(OUT, n + (A.noPng ? ".html" : ".png"))).join(", "));
}

// --- replays: snapshot reading and check helpers ---
type Dump = { name: string; type: string; cols: number; rows: number; cells: string[][]; wide: [number, number][] };
/** Python's s[a:b]: slices count code points (Nerd Font glyphs are astral). */
const cut = (s: string, a: number, b?: number) => [...s].slice(a, b).join("");

/** The screen xterm.js held at a checkpoint: one string per cell (a wide cell's continuation cell is ""), the active buffer, the size. */
export class Snap {
	name: string;
	type: string;
	cols: number;
	rows: number;
	cells: string[][];
	wide: Set<string>; // "y,x"
	rowsText: string[];
	constructor(d: Dump) {
		({ name: this.name, type: this.type, cols: this.cols, rows: this.rows, cells: this.cells } = d);
		this.wide = new Set(d.wide.map(([y, x]) => `${y},${x}`));
		this.rowsText = this.cells.map(r => r.join("").trimEnd());
	}
	row(y: number) {
		return 0 <= y && y < this.rows ? this.rowsText[y] : "";
	}
	at(y: number, x: number) {
		return 0 <= y && y < this.rows && 0 <= x && x < this.cells[y].length ? this.cells[y][x] : "";
	}
	has(text: string) {
		return this.rowsText.some(r => r.includes(text));
	}
	/** First row index holding `text`, or -1. */
	where(text: string) {
		return this.rowsText.findIndex(r => r.includes(text));
	}
	/** Cell index of the first cell of `text` in row y, or -1 (string offsets and cell lengths both in UTF-16 units). */
	colOf(y: number, text: string) {
		const row = this.cells.at(y) ?? [], i = row.join("").indexOf(text);
		if (i < 0) return -1;
		let n = 0;
		for (let x = 0; x < row.length; x++) {
			if (n >= i && row[x] !== "") return x; // text never starts on a wide cell's continuation (shot.py returned it)
			n += row[x].length;
		}
		return -1;
	}
	/** Cell index of the last non-blank cell of row y (-1: blank row). */
	lastCol(y: number) {
		const row = this.cells.at(y) ?? [];
		for (let x = row.length - 1; x >= 0; x--) if (row[x].trim()) return x;
		return -1;
	}
	wideCells(y0 = 0, y1?: number): [number, number][] {
		return [...this.wide].map(k => k.split(",").map(Number) as [number, number])
			.filter(([y]) => y >= y0 && (y1 === undefined || y < y1))
			.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	}
	framed() {
		return this.rowsText.some(r => r.startsWith("╔═"));
	}
	dump() {
		return this.rowsText.flatMap((r, y) => (r ? [`${String(y).padStart(2)} |${r}`] : []));
	}
}

export function oneOf(c: string, chars: string) {
	return c !== "" && chars.includes(c);
}

type Result = [name: string, ok: boolean, got: unknown, want: unknown, snap: Snap | null];
/** What a scenario's checks see: its snapshots, its run, and ck() to record a check. */
export class Ctx {
	results: Result[] = [];
	notes: string[] = [];
	constructor(readonly R: Run, readonly s: Map<string, Snap>) {}
	ck(name: string, ok: unknown, got: unknown = null, want: unknown = null, snap: Snap | null = null) {
		this.results.push([name, !!ok, got, want, snap]);
	}
	say(line: string) {
		this.notes.push(line);
	}
	logHas(ev: string, kw: Record<string, unknown> = {}) {
		return this.R.logEvents().some(e => e.ev === ev && Object.entries(kw).every(([a, b]) => e[a] === b));
	}
}

// --- scenarios. Steps drive the run (R); checks read snapshots (C). To add one: a steps function, a checks function, an entry in REPLAYS. ---
async function openSnap(R: Run, png = true) {
	await R.open();
	await R.snap("open", png);
}
const snapOf = (C: Ctx, name: string) => C.s.get(name)!;
const repr = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : Bun.inspect(v));
const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

async function stepsFullscreenHeight(R: Run) {
	await R.snap("before");
	await openSnap(R);
}
function checksFullscreenHeight(C: Ctx) {
	const b = snapOf(C, "before"), o = snapOf(C, "open");
	C.ck("before: no cockpit frame", !b.framed(), null, null, b);
	C.ck("open: alternate buffer", o.type === "alternate", o.type, "alternate");
	C.ck("open: row 0 is the top frame", o.row(0).startsWith("╔═") && o.row(0).includes("STRATEGIUM"), cut(o.row(0), 0, 50), "╔═ … STRATEGIUM", o);
	C.ck(`open: row ${o.rows - 1} is the bottom frame`, o.row(o.rows - 1).startsWith("╚═ esc/q close"), cut(o.row(o.rows - 1), 0, 50), "╚═ esc/q close", o);
	const bad = range(1, o.rows - 1).filter(y => !(oneOf(o.at(y, 0), "║╟") && oneOf(o.at(y, o.cols - 1), "║╢")));
	C.ck(`open: rows 1-${o.rows - 2} framed at col 0 and col ${o.cols - 1}`, bad.length === 0, `rows ${repr(bad)}`, null, o);
	const leak = range(0, o.rows).filter(y => o.row(y).includes("strategium: demo-shot") || o.row(y).includes("ALT + C"));
	C.ck("open: no footer or editor under the cockpit", leak.length === 0, `rows ${repr(leak)}`, null, o);
}

async function stepsFullscreenResize(R: Run) {
	await R.open(); await R.resize(140, 30); await R.waitQuiet(1.0, 3.0); await R.snap("h30");
	await R.resize(100, 45); await R.waitQuiet(1.0, 3.0); await R.snap("w100"); await R.resize(60, 45); await R.waitQuiet(1.0, 3.0); await R.snap("w60", true);
}
function checksFullscreenResize(C: Ctx) {
	const a = snapOf(C, "h30"), b = snapOf(C, "w100"), c = snapOf(C, "w60");
	C.ck("h30: 30 rows", a.rows === 30, a.rows, 30);
	C.ck("h30: row 0 top frame, row 29 bottom frame", a.row(0).startsWith("╔═") && a.row(29).startsWith("╚═ esc/q close"), [cut(a.row(0), 0, 20), cut(a.row(29), 0, 20)], null, a);
	const bad = range(1, 44).filter(y => !oneOf(b.at(y, 99), "║╢"));
	C.ck("w100: col 99 framed on rows 1-43", b.cols === 100 && bad.length === 0, `cols ${b.cols} rows ${repr(bad)}`, null, b);
	C.ck("w60: stacked, no top frame", !c.framed() && !c.rowsText.join("").includes("╔"), null, null, c);
	C.ck("w60: last row is esc/q close", c.row(c.rows - 1).includes("esc/q close"), c.row(c.rows - 1), "esc/q close", c);
	C.ck("w60: nothing past col 59", c.cols === 60 && range(0, c.rows).every(y => c.lastCol(y) < 60), c.cols, 60, c);
}

async function stepsFrameEdges(R: Run) {
	await R.open();
	for (const [n, cw] of [["w140", 140], ["w100", 100], ["w72", 72]] as const) {
		if (cw !== 140) { await R.resize(cw, 45); await R.waitQuiet(1.0, 3.0); }
		await R.snap(n);
	}
}
function checksFrameEdges(C: Ctx) {
	for (const [n, s] of C.s) {
		const W = s.cols;
		const bad = range(0, s.rows).filter(y => oneOf(s.at(y, 0), "╔║╟╚") && !oneOf(s.at(y, W - 1), "╗║╢╝"));
		C.ck(`${n}: every framed row ends at col ${W - 1}`, bad.length === 0, `rows ${repr(bad)}`, null, s);
		const y = s.where("CHRONICLE");
		C.ck(`${n}: CHRONICLE rule ends ═…║ at col ${W - 1}, no notch`, y >= 0 && s.lastCol(y) === W - 1 && oneOf(s.at(y, W - 1), "║╢") && "─═".includes(s.at(y, W - 2)),
			cut(s.row(y), -12), "…─╢", s);
		// A grid row of boxes runs from the row with ┌ to the row with └; all its rows end at one edge, and so do the grid rows with the same number of boxes.
		const edge = (y: number) => Math.max(-1, ...range(0, W - 1).filter(x => oneOf(s.at(y, x), "┐│┤┘")));
		const blocks = new Map<number, Set<number>>();
		let top: number | null = null;
		for (let y = 0; y < s.rows; y++) {
			if (s.row(y).includes("┌")) top = y;
			if (top !== null && edge(y) >= 0) { if (!blocks.has(top)) blocks.set(top, new Set()); blocks.get(top)!.add(edge(y)); }
			if (s.row(y).includes("└")) top = null;
		}
		const perCount = new Map<number, Set<number>>();
		for (const [y, e] of blocks) {
			const c = s.row(y).split("┐").length - 1;
			if (!perCount.has(c)) perCount.set(c, new Set());
			for (const x of e) perCount.get(c)!.add(x);
		}
		C.ck(`${n}: box grid has one right edge per box count (no staircase)`, blocks.size > 0 && [...perCount.values()].every(e => e.size === 1), perCount, null, s);
	}
}

async function stepsGlyphWidth(R: Run) {
	await R.snap("screen");
	await openSnap(R, false);
}
function checksGlyphWidth(C: Ctx) {
	for (const n of ["screen", "open"]) {
		const s = snapOf(C, n);
		C.ck(`${n}: no ⚔ ☠ ⏳`, !s.rowsText.some(r => [..."⚔☠⏳"].some(g => r.includes(g))), null, null, s);
	}
	const sc = snapOf(C, "screen"), y = sc.where("strategium: demo-shot");
	C.ck("screen: no wide cell in the footer run line", y >= 0 && sc.wideCells(y, y + 1).length === 0, sc.wideCells(y, y + 1), [], sc);
	const o = snapOf(C, "open");
	C.ck("open: no wide cell in the cockpit", o.wideCells().length === 0, o.wideCells(), [], o);
}

async function stepsSealRow(R: Run) {
	await R.snap("screen");
	await openSnap(R);
}
function checksSealRow(C: Ctx) {
	const sc = snapOf(C, "screen"), o = snapOf(C, "open"), y = o.where("SEALS");
	C.ck("footer has seal Plan", sc.has("seal Plan"), null, "seal Plan", sc);
	// chain: waiting glyph (1 cell, then padding spaces) Plan, then ' → ', then '○ Demo'
	const m = y >= 0 ? /\u{F051F}( +)Plan → ○ Demo/u.exec(o.row(y)) : null;
	const start = m ? [...o.row(y).slice(0, m.index)].length : -1; // a code-point index, compared with a cell x like Python's m.start()
	C.ck("SEALS row is '<U+F051F> Plan → ○ Demo', glyph 1 cell", m !== null && !o.wide.has(`${y},${start}`), o.row(y), null, o);
	C.ck("no SEAL ─ box title", !o.rowsText.some(r => r.includes("SEAL ─")), null, null, o);
	C.ck("panel title SEAL PLAN · awaits you", o.has("SEAL PLAN · awaits you"), null, null, o);
	C.ck("panel default line", o.has("the details are in the Captain's message"), null, null, o);
	C.ck("station title has seal Plan awaits you", o.rowsText.some(r => r.includes("▶") && r.includes("seal Plan awaits you")), null, null, o);
}

async function stepsSealPanel(R: Run) {
	await openSnap(R);
}
function checksSealPanel(C: Ctx) {
	const o = snapOf(C, "open"), W = o.cols, y = o.where("SEAL PLAN · awaits you"), st = o.where("seal Plan awaits you");
	C.ck(`panel ┌ at col 2 and ┐ at col ${W - 3}`, y >= 0 && o.at(y, 2) === "┌" && o.at(y, W - 3) === "┐", o.row(y), null, o);
	C.ck("first seeded line shown", o.has("Squads: cockpit (standard)"), null, null, o);
	const long = o.rowsText.find(r => r.includes("LONG-")) ?? "";
	C.ck("200-char line ends in … before its │", /…\s*│/u.test(long), long, null, o);
	C.ck("+3 more row", o.has("+3 more"), null, null, o);
	const first = y >= 0 ? (range(y + 1, o.rows).find(i => o.row(i).includes("┌") && i !== y) ?? -1) : -1;
	C.ck("panel between station title and first agent box", (0 <= st && st < y && y < first) || (first === -1 && 0 <= st && st < y), [st, y, first], null, o);
	const bad = range(0, o.rows).filter(i => oneOf(o.at(i, 0), "╔║╟╚") && !oneOf(o.at(i, W - 1), "╗║╢╝"));
	C.ck(`every framed row ends at col ${W - 1}`, bad.length === 0, `rows ${repr(bad)}`, null, o);
}

async function stepsArchmagos(R: Run) {
	await openSnap(R, false);
}
function checksArchmagos(C: Ctx) {
	C.ck("Merge the plan ([archmagos]) is in the cockpit", snapOf(C, "open").has("Merge the plan"), null, null, snapOf(C, "open"));
}

async function stepsAgentStatus(R: Run) {
	await openSnap(R);
}
function checksAgentStatus(C: Ctx) {
	const o = snapOf(C, "open"), end = range(1, o.rows).find(y => o.row(y).startsWith("╟─")) ?? o.rows;
	const head = range(1, end).map(y => o.row(y)).join("\n"), y = o.where("VOX OPEN");
	C.ck("header has VOX OPEN · esc to give orders", head.includes("○ VOX OPEN · esc to give orders"), head, null, o);
	C.ck("header has no AGENT AT WORK / PLAN REVIEW PENDING", !head.includes("AGENT AT WORK") && !head.includes("PLAN REVIEW PENDING"), head, null, o);
	C.ck(`status row ends with ║ at col ${o.cols - 1}`, y >= 0 && o.at(y, o.cols - 1) === "║", o.row(y), null, o);
}

async function stepsFirstTickClock(R: Run) { // settled by the beat only: the 60 s tick is the first draw with a clock
	await R.sleep(1.5);
	await openSnap(R, false);
}
function checksFirstTickClock(C: Ctx) {
	const o = snapOf(C, "open"), y = o.where("⧗");
	C.ck("clock row shows /240 min", y >= 0 && o.row(y).includes("/240 min"), o.row(y), "⧗ N/240 min", o);
	C.ck("clock row is not ⧗ …", y >= 0 && !o.row(y).includes("⧗ …"), o.row(y), null, o);
}

async function stepsResumeBooking(R: Run) {
	await R.settle(); await R.typeText("/strategium-pause"); await R.key("enter"); await R.sleep(1.5);
	await R.typeText("/strategium-resume 240"); await R.key("enter"); await R.sleep(1.5); await R.snap("footer"); await openSnap(R, false);
}
function checksResumeBooking(C: Ctx) {
	const f = snapOf(C, "footer"), o = snapOf(C, "open"), y = f.where("strategium: demo-shot"), c = o.where("⧗");
	C.ck("footer run line shows /240 min", y >= 0 && f.row(y).includes("/240 min"), f.row(y), null, f);
	C.ck("cockpit clock shows /240 min", c >= 0 && o.row(c).includes("/240 min"), o.row(c), null, o);
	C.ck("cockpit clock row has a bar", c >= 0 && [..."▰▱"].some(g => o.row(c).includes(g)), o.row(c), "▰▱…", o);
}

async function stepsNoWidget(R: Run) {
	await R.snap("screen");
}
function checksNoWidget(C: Ctx) {
	const s = snapOf(C, "screen");
	C.ck("no cockpit box or title above the editor", !s.rowsText.some(r => ["╔", "┌", "STRATEGIUM"].some(g => r.includes(g))), null, null, s);
	C.ck("footer run line is there", s.has("strategium: demo-shot"), null, null, s);
}

async function stepsAsk(R: Run) {
	await R.typeText("replay-ask"); await R.key("enter"); await R.sleep(1.0); await openSnap(R); await R.snap("cockpit", true);
	writeFileSync(join(R.work, "go"), ""); // releases the fake stream: it now calls ask
	await R.waitFor(Buffer.from("REPLAY:"), 10); await R.waitQuiet(1.0, 3.0); await R.snap("dialog", true);
	// The form's hint line (html-form/dialog.ts): "←/→ change · enter next · ↑↓ move": → picks No, enter moves to the submit stop, enter submits. (↓ moves between stops: it would skip to submit with Yes.)
	await R.key("right"); await R.sleep(0.5); await R.key("enter"); await R.sleep(0.5); await R.key("enter"); await R.sleep(0.5);
	await R.waitFor(Buffer.from("REPLAY-ANSWER"), 10); await R.waitQuiet(1.0, 3.0); await R.snap("answered", true);
}
function checksAsk(C: Ctx) {
	const c = snapOf(C, "cockpit"), d = snapOf(C, "dialog"), a = snapOf(C, "answered");
	C.ck("cockpit: rows 0 and last are the frame", c.row(0).startsWith("╔═") && c.row(c.rows - 1).startsWith("╚═"), [cut(c.row(0), 0, 20), cut(c.row(c.rows - 1), 0, 20)], null, c);
	C.ck("dialog: cockpit closed, normal buffer", d.type === "normal" && !d.framed(), d.type, "normal, no frame", d);
	let y = d.where("Ask");
	for (const i of range(Math.max(y, 0), Math.min(y + 8, d.rows))) if (d.row(i)) C.say("dialog | " + d.row(i)); // the dialog as drawn, with its hint line
	C.ck("dialog: REPLAY: pick one, Yes and No on screen", d.has("REPLAY: pick one") && d.has("Yes") && d.has("No"), null, null, d);
	y = a.where("REPLAY-ANSWER"); // the answer prints as a JSON block under it
	C.ck("answered: REPLAY-ANSWER with No", y >= 0 && range(y, y + 5).map(i => a.row(i)).join(" ").includes('"pick": "No"'), null, null, a);
	C.ck("answered: no cancel on screen", !a.rowsText.some(r => r.toLowerCase().includes("cancel")), null, null, a);
	C.ck("replay.log: tool_call ask", C.logHas("tool_call", { name: "ask" }), C.R.logEvents().filter(e => e.ev === "tool_call" || e.ev === "tool_result"));
	C.ck("replay.log: tool_result ask isError false with No",
		C.R.logEvents().some(e => e.ev === "tool_result" && e.name === "ask" && e.isError === false && (e.text ?? "").includes("No")), C.R.logEvents().filter(e => e.ev === "tool_result"));
}

async function stepsRunEnd(R: Run) {
	await R.open(); unlinkSync(R.runfile); const end = now() + 65;
	while (R.altOpen() && now() < end) await Bun.sleep(500);
	await R.waitQuiet(1.5, 5.0); await R.snap("after");
}
function checksRunEnd(C: Ctx) {
	const s = snapOf(C, "after");
	C.ck("after: no cockpit frame, normal buffer", s.type === "normal" && !s.framed(), s.type, "normal, no frame", s);
	C.ck("after: footer has no demo-shot run line", !s.has("strategium: demo-shot"), null, null, s);
}

const HINT = "ALT + C to enter cockpit";
async function stepsFooterHint(R: Run) {
	await R.snap("w140"); await R.resize(100, 45); await R.waitQuiet(1.0, 3.0);
	// The footer reads the width once per draw (index.ts, "no resize hook in omp"): it redraws on the next 60 s tick or status refresh. /strategium-status refreshes it.
	await R.typeText("/strategium-status"); await R.key("enter"); await R.sleep(1.5); await R.snap("w100");
}
function checksFooterHint(C: Ctx) {
	for (const [n, s] of C.s) {
		const y = s.where(HINT), x = y >= 0 ? s.colOf(y, HINT) + HINT.length - 1 : -1;
		C.ck(`${n}: last char of the hint at col ${s.cols - 1}`, x === s.cols - 1, `col ${x}, gap ${s.cols - 1 - x}`, s.cols - 1, s);
		if (x !== s.cols - 1) C.say(`${n}: last 3 rows: ` + range(s.rows - 3, s.rows).map(i => JSON.stringify(s.row(i))).join(" / "));
	}
}

const ESC: Record<string, string[]> = { // name -> what is sent: win32 is Windows Terminal's real path; the others go through conhost's own input parser
	win32: KEYS.esc, plain: ["\x1b"], "csi-u": ["\x1b[27u"], "csi-u-mod": ["\x1b[27;1u"],
	"csi-u-events": ["\x1b[27;1:1u", "\x1b[27;1:3u"], "csi-u-caps": ["\x1b[27;65u"], "csi-u-num": ["\x1b[27;129u"],
};
async function stepsEscClose(R: Run) {
	R.notes = {};
	const inputs = () => R.logEvents().filter(e => e.ev === "input").map(e => e.data as string);
	for (const [v, seqs] of Object.entries(ESC)) {
		await R.open();
		if (!R.altOpen()) { R.notes[v] = null; continue; }
		const n = inputs().length;
		for (const s of seqs) { R.send(s); await R.sleep(0.03); }
		await R.sleep(1.5); await R.snap(v);
		R.notes[v] = [!R.altOpen(), inputs().slice(n).join(""), seqs];
		if (R.altOpen()) { await R.key("q"); await R.waitQuiet(1.0, 3.0); }
	}
}
function checksEscClose(C: Ctx) {
	for (const v of Object.keys(ESC)) {
		const n = C.R.notes[v] as [boolean, string, string[]] | null | undefined;
		if (n == null) { C.ck(`${v}: cockpit was open before the key`, false, "ERROR: the frame was not up, variant skipped"); continue; }
		if (!n[1]) { // omp never received a byte: conhost holds a lone ESC, so the variant tests nothing about the cockpit (omp saw the same single \x1b for the win32 record)
			C.say(`${v.padEnd(13)} skip: not delivered, omp's onTerminalInput saw nothing (conhost holds a lone ESC)`); continue;
		}
		const s = snapOf(C, v);
		C.ck(`${v}: closes (normal buffer, no frame, footer back)`, n[0] && s.type === "normal" && !s.framed() && s.has("strategium: demo-shot"), s.type, "normal, no frame", s);
		const sent = n[2].join(""), saw = n[1];
		C.say(`${v.padEnd(13)} closed=${n[0] ? "yes" : "NO "} sent=${JSON.stringify(sent)} onTerminalInput saw=${JSON.stringify(saw)}`
			+ (v !== "win32" && sent !== saw ? "  not faithful: conhost rewrote it" : ""));
	}
}

async function stepsQClose(R: Run) {
	await R.snap("before"); await R.open(); await R.key("q"); await R.waitQuiet(1.0, 3.0); await R.snap("after", true);
	await R.open(); await R.key("plain-q"); await R.waitQuiet(1.0, 3.0); await R.snap("after2");
}
function checksQClose(C: Ctx) {
	const b = snapOf(C, "before"), keep = (s: Snap) => s.rowsText.filter(r => !r.includes(" min")); // the clock row changes
	for (const n of ["after", "after2"]) {
		const s = snapOf(C, n);
		C.ck(`${n}: normal buffer, no frame`, s.type === "normal" && !s.framed(), s.type, "normal, no frame", s);
		C.ck(`${n}: footer and editor rows as before`, Bun.deepEquals(keep(s), keep(b)), null, null, s);
	}
}

async function stepsCapslock(R: Run) {
	await R.key("caps-altc"); await R.sleep(1.5); await R.snap("after");
	await R.typeText("/strategium-cockpit"); await R.key("enter"); await R.waitQuiet(1.0, 3.0); await R.snap("alternative", true);
}
function checksCapslock(C: Ctx) {
	const s = snapOf(C, "after");
	C.ck("no cockpit", s.type === "normal" && !s.framed(), s.type, "normal, no frame", s);
	C.ck("Nothing to copy on screen or in the stream", s.has("Nothing to copy") || C.R.out.includes("Nothing to copy"), null, null, s);
	C.ck("after: the footer hint names the cockpit key", s.has(HINT), null, HINT, s);
	const a = snapOf(C, "alternative");
	C.ck("alternative: /strategium-cockpit opens the cockpit", a.type === "alternate" && a.framed(), a.type, "alternate, framed", a);
}

async function stepsSelect(R: Run) {
	await R.typeText("/replay-select"); await R.key("enter"); await R.open(); await R.sleep(4);
	await R.key("down"); await R.key("enter"); await R.sleep(0.5); await R.snap("held");
	await R.key("q"); await R.waitQuiet(1.0, 3.0); await R.key("down"); await R.key("enter"); await R.sleep(1.0); await R.snap("after-q");
}
function checksSelect(C: Ctx) {
	const sel = C.R.logEvents().filter(e => e.ev === "select");
	C.ck("held: no select value (keys went to the cockpit)", sel.length === 0, sel);
	const s = snapOf(C, "after-q");
	C.ck("after-q: still no value", sel.length === 0, sel);
	C.ck("after-q: the select is still drawn (the omp limit F9 cannot reach)", s.type === "normal" && s.has("REPLAY select"), s.type, null, s);
}

async function stepsPonytail(R: Run) {
	await R.snap("screen");
}
function checksPonytail(C: Ctx) {
	C.ck("Strategium loaded: is in the stream", C.R.out.includes("Strategium loaded:"), null, null, snapOf(C, "screen"));
}

/** Chronicle entries in the saved runs/<SID>.cockpit, or null if there is no readable file. */
function cockpitCount(R: Run): number | null {
	try {
		const n = JSON.parse(readFileSync(join(R.state, "runs", SID + ".cockpit"), "utf8")).chronicle.length;
		return typeof n === "number" ? n : null;
	} catch {
		return null;
	}
}

/** The CHRONICLE rows of the open cockpit, newest first, without the frame. */
function chronicleRows(s: Snap) {
	const y = s.where("CHRONICLE");
	if (y < 0) return [];
	const end = range(y + 1, s.rows).find(i => s.row(i).startsWith("╚")) ?? s.rows;
	return range(y + 1, end).map(i => s.row(i).replace(/^[║ ]+|[║ ]+$/g, "")).filter(r => r);
}

type Mark = [mark: string, icon: string, squad: string, state: string];
/** (mark, icon, squad, state) of every squad line in the boxes, by squad; ▷ (the blink frame of ▶) is read as ▶. */
export function squadMarks(s: Snap): Mark[] {
	return [...s.rowsText.join("\n").matchAll(/([▶▷✓✗○])\s*(\S+)\s+squad (\w+) (forging|returned|failed|awaiting deployment)/gu)]
		.map(m => [m[1].replace("▷", "▶"), m[2], m[3], m[4]] as Mark)
		.sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
}

async function stepsCockpitRestart(R: Run) {
	await R.open(); await R.snap("before", true); R.notes = { before: cockpitCount(R) };
	await R.restart();
	await R.open(); await R.snap("after", true); R.notes.after = cockpitCount(R);
}
function checksCockpitRestart(C: Ctx) {
	const b = snapOf(C, "before"), a = snapOf(C, "after"), rb = chronicleRows(b), ra = chronicleRows(a);
	const want = ["station Skirmish", "Plan granted", "SQUAD alpha", "SQUAD beta", "SQUAD gamma", "SQUAD delta"];
	C.ck("before: CHRONICLE rows contain the seeded entries",
		want.every(x => rb.some(r => r.includes(x))) && rb.some(r => r.includes("✓ returned")) && rb.some(r => r.includes("✗ failed")), rb, want, b);
	C.ck("after: CHRONICLE rows equal before's, row for row", rb.length > 0 && Bun.deepEquals(ra, rb), ra, rb, a);
	const mb = squadMarks(b), ma = squadMarks(a), by = new Map(mb.map(([m, ic, sq]) => [sq, [m, ic]]));
	C.ck("before: agent marks are ▶ alpha, ✓ beta, veteran ▶ gamma (icon differs from alpha's), ✗ delta",
		mb.length === 4 && Bun.deepEquals(["alpha", "beta", "gamma", "delta"].map(q => (by.get(q) ?? ["?"])[0]), ["▶", "✓", "▶", "✗"]) && by.get("gamma")![1] !== by.get("alpha")![1],
		mb, null, b);
	C.ck("after: agent marks and veteran icon equal before's", Bun.deepEquals(ma, mb), ma, mb, a);
	C.ck("runs/<SID>.cockpit has the same number of chronicle entries after the restart (no duplicates)",
		C.R.notes.before != null && C.R.notes.after === C.R.notes.before, C.R.notes, null);
}

// name -> r (the regression), kind FIXED|KNOWN|OPEN, seed, ext (fake provider), ponytail, settle (false: wait only for the first heartbeat), steps, checks
type Replay = { r: string; kind: "FIXED" | "KNOWN" | "OPEN"; seed: string; ext?: boolean; ponytail?: boolean; settle?: boolean; steps: (R: Run) => Promise<void>; checks: (C: Ctx) => void };
export const REPLAYS: Record<string, Replay> = {
	"fullscreen-height": { r: "R9", kind: "FIXED", seed: "scriptorium", steps: stepsFullscreenHeight, checks: checksFullscreenHeight },
	"fullscreen-resize": { r: "R9/F6", kind: "FIXED", seed: "scriptorium", steps: stepsFullscreenResize, checks: checksFullscreenResize },
	"frame-edges": { r: "R4,R5", kind: "FIXED", seed: "skirmish", steps: stepsFrameEdges, checks: checksFrameEdges },
	"glyph-width": { r: "R2", kind: "FIXED", seed: "skirmish", steps: stepsGlyphWidth, checks: checksGlyphWidth },
	"seal-row": { r: "R3,#82", kind: "FIXED", seed: "scriptorium", steps: stepsSealRow, checks: checksSealRow },
	"seal-panel": { r: "#82", kind: "FIXED", seed: "seal-panel", steps: stepsSealPanel, checks: checksSealPanel },
	archmagos: { r: "R13", kind: "FIXED", seed: "scriptorium", steps: stepsArchmagos, checks: checksArchmagos },
	"agent-status": { r: "F11", kind: "FIXED", seed: "scriptorium", steps: stepsAgentStatus, checks: checksAgentStatus },
	"first-tick-clock": { r: "R6", kind: "FIXED", seed: "timed", settle: false, steps: stepsFirstTickClock, checks: checksFirstTickClock },
	"resume-booking": { r: "R7", kind: "FIXED", seed: "scriptorium", steps: stepsResumeBooking, checks: checksResumeBooking },
	"no-widget": { r: "R8", kind: "FIXED", seed: "scriptorium", steps: stepsNoWidget, checks: checksNoWidget },
	"ask-behind-cockpit": { r: "R10", kind: "FIXED", seed: "scriptorium", ext: true, steps: stepsAsk, checks: checksAsk },
	"run-end-closes": { r: "R12", kind: "FIXED", seed: "scriptorium", steps: stepsRunEnd, checks: checksRunEnd },
	"footer-hint": { r: "R14", kind: "FIXED", seed: "scriptorium", steps: stepsFooterHint, checks: checksFooterHint },
	"esc-close": { r: "R19", kind: "FIXED", seed: "scriptorium", ext: true, steps: stepsEscClose, checks: checksEscClose },
	"q-close": { r: "R19", kind: "FIXED", seed: "scriptorium", steps: stepsQClose, checks: checksQClose },
	"capslock-altc": { r: "R1", kind: "KNOWN", seed: "scriptorium", steps: stepsCapslock, checks: checksCapslock },
	"select-behind-cockpit": { r: "R10", kind: "KNOWN", seed: "scriptorium", ext: true, steps: stepsSelect, checks: checksSelect },
	"ponytail-notice": { r: "R16", kind: "OPEN", seed: "scriptorium", ponytail: true, settle: false, steps: stepsPonytail, checks: checksPonytail },
	"cockpit-restart": { r: "#19", kind: "FIXED", seed: "restart", steps: stepsCockpitRestart, checks: checksCockpitRestart },
};

// shortcut: only the entities Chromium's --dump-dom writes in text (amp, lt, gt, quot, apos, nbsp, numeric); a full table if that ever changes
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
function unescapeHtml(s: string) {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) =>
		e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? all));
}

export function parseSnaps(dom: string): Map<string, Snap> {
	const m = /<pre id="dump"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
	return m && m[1].trim() ? new Map((JSON.parse(unescapeHtml(m[1])) as Dump[]).map(d => [d.name, new Snap(d)])) : new Map();
}

/** difflib.unified_diff(a, b, from, to, lineterm="") on an LCS edit script: same headers and 3 lines of context; hunk bytes may differ. */
export function unifiedDiff(a: string[], b: string[], from: string, to: string, n = 3): string[] {
	const L = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
	const ops: [tag: string, line: string, ai: number, bi: number][] = [];
	let i = 0, j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) { ops.push([" ", a[i], i, j]); i++; j++; }
		else if (i < a.length && (j === b.length || L[i + 1][j] >= L[i][j + 1])) { ops.push(["-", a[i], i, j]); i++; } // deletions before insertions, as difflib
		else { ops.push(["+", b[j], i, j]); j++; }
	}
	const changes = ops.flatMap((o, k) => (o[0] === " " ? [] : [k]));
	if (changes.length === 0) return [];
	const groups: number[][] = [];
	for (const c of changes) {
		const g = groups.at(-1);
		if (g && c - g[g.length - 1] - 1 <= 2 * n) g.push(c); else groups.push([c]);
	}
	const span = (start: number, len: number) => (len === 1 ? `${start + 1}` : len === 0 ? `${start},0` : `${start + 1},${len}`);
	const out = [`--- ${from}`, `+++ ${to}`];
	for (const g of groups) {
		const h = ops.slice(Math.max(0, g[0] - n), Math.min(ops.length, g[g.length - 1] + n + 1));
		const aLen = h.filter(o => o[0] !== "+").length, bLen = h.filter(o => o[0] !== "-").length;
		out.push(`@@ -${span(h[0][2], aLen)} +${span(h[0][3], bLen)} @@`, ...h.map(o => o[0] + o[1]));
	}
	return out;
}

/** str.splitlines() for strings, Bun.inspect (pprint's role) for anything else. */
function linesOf(v: unknown) {
	if (typeof v !== "string") return Bun.inspect(v).split("\n");
	const l = v.split(/\r\n|\r|\n/);
	if (l.at(-1) === "") l.pop();
	return l;
}

/** Run one scenario; returns [result, first failing check]. Prints one line per check, then PASS/FAIL NAME (R). */
async function replay(name: string): Promise<[string, string | null]> {
	const sc = REPLAYS[name], sfx = SFX + "-" + name;
	const pdir = sc.ponytail ? findPony() : null;
	if (sc.ponytail && !pdir) {
		console.log(`SKIP ${name} (${sc.r}): ponytail plugin not found`);
		return ["SKIP", "ponytail plugin not found"];
	}
	const R = new Run(sc.seed, sfx, sc.ext ?? false, pdir);
	console.log(`== ${name} (${sc.r}, ${sc.kind})\n   omp: ${R.cmd}`);
	let err: string | null = null, C: Ctx;
	try {
		try {
			if (sc.settle ?? true) await R.settle(); else await R.waitBeat();
			await sc.steps(R);
		} catch (e) {
			err = `${(e as Error).name}: ${(e as Error).message}`;
		} finally {
			R.stop();
		}
		const data = R.out, prof = join(R.work, "edge-profile");
		const pev = (upto: number): PageEv[] =>
			R.events.flatMap((e): PageEv[] => (e[0] === "r" ? (e[1] <= upto ? [e] : []) : e[2] <= upto ? [["s", e[2], e[1]]] : []));
		for (const e of R.events) // <scenario>-<checkpoint>.raw/.html: the stream up to the checkpoint, resizes included
			if (e[0] === "s") page(`${name}-${e[1]}`, data.subarray(0, e[2]), pev(e[2]).filter(x => x[0] === "r"));
		let snaps = new Map<string, Snap>();
		if (R.events.some(e => e[0] === "s") && err === null) {
			page(`${name}-all`, data, pev(data.length));
			const dom = (await edgeRun(prof, ["--dump-dom", pathToFileURL(join(OUT, `${name}-all.html`)).href], true)).toString("utf8");
			snaps = parseSnaps(dom);
			const want = R.events.filter(e => e[0] === "s").length;
			if (snaps.size !== want) err = `edge returned ${snaps.size} snapshots of ${want}`;
			for (const e of R.events) if (e[0] === "s" && (e[3] || A.allPng) && !A.noPng && err === null) await shoot(prof, `${name}-${e[1]}`);
		}
		C = new Ctx(R, snaps);
		if (err === null) {
			try {
				sc.checks(C);
			} catch (e) {
				err = `checks raised ${(e as Error).name}: ${(e as Error).message}`;
			}
		}
	} finally {
		R.cleanup();
	}
	let first: string | null = null;
	for (const [n, ok, got, want, snap] of C.results) {
		console.log(`   ${ok ? "ok  " : "FAIL"} ${n}` + (ok ? "" : `: got ${repr(got)}` + (want !== null ? `, expected ${repr(want)}` : "")));
		if (ok) continue;
		first ??= n;
		if (got !== null && want !== null) for (const l of unifiedDiff(linesOf(want), linesOf(got), "expected", "got")) console.log("        " + l);
		if (snap !== null) {
			console.log(`        screen '${snap.name}' (${snap.cols}x${snap.rows}, ${snap.type}):`);
			for (const l of snap.dump()) console.log("        " + l);
		}
	}
	if (err !== null) { console.log(`   ERROR ${err}`); first ??= err; }
	for (const l of C.notes) console.log("   " + l);
	const res = first === null ? "PASS" : "FAIL";
	console.log(`${res} ${name} (${sc.r})`);
	return [res, first];
}

function shaOf(plugin: string) {
	for (const p of [plugin + ".sha", join(plugin, ".sha")]) if (existsSync(p)) return readFileSync(p, "utf8").trim();
	return "unknown (no .sha next to the plugin)";
}

export type Row = [name: string, r: string, kind: string, result: string, first: string | null];
export const TABLE_HEAD = `${"scenario".padEnd(24)} | ${"R".padEnd(6)} | ${"kind".padEnd(5)} | ${"result".padEnd(6)} | first failing check`;
export function tableRow([n, r, kind, res, first]: Row) {
	return `${n.padEnd(24)} | ${r.padEnd(6)} | ${kind.padEnd(5)} | ${res.padEnd(6)} | ${first ?? ""}`;
}
/** --all: 1 if any scenario that is not OPEN did not PASS. */
export function allExit(rows: Row[]) {
	return rows.some(([, , kind, res]) => kind !== "OPEN" && res !== "PASS") ? 1 : 0;
}

async function runReplays(): Promise<number> {
	if (A.replay !== null && !Object.hasOwn(REPLAYS, A.replay)) {
		console.log(`unknown replay ${JSON.stringify(A.replay)}; valid names:\n  ` + Object.keys(REPLAYS).join("\n  "));
		return 2;
	}
	const names = A.all ? Object.keys(REPLAYS) : [A.replay!];
	console.log(`plugin ${PLUGIN} sha ${shaOf(PLUGIN)}`);
	const rows: Row[] = [];
	for (const n of names) rows.push([n, REPLAYS[n].r, REPLAYS[n].kind, ...(await replay(n))]);
	if (!A.all) return rows[0][3] === "PASS" ? 0 : 1;
	console.log(`\nplugin ${PLUGIN} sha ${shaOf(PLUGIN)}\n${TABLE_HEAD}`);
	for (const row of rows) console.log(tableRow(row));
	return allExit(rows);
}

async function main(argv: string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		console.error(USAGE + "\nerror: " + parsed.error);
		return 2;
	}
	if (parsed.help) {
		console.log(USAGE);
		return 0;
	}
	if (process.platform !== "win32") {
		console.error("Windows only");
		return 1;
	}
	A = parsed;
	SFX = A.suffix ?? (A.ponytail ? "-ponytail" : "");
	OUT = resolve(A.out);
	mkdirSync(OUT, { recursive: true });
	PLUGIN = resolve(A.plugin);
	omp = find(A.omp, "omp", []);
	const pf = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter((p): p is string => !!p);
	// The replay checks read the screen through xterm.js in Edge, so --no-png only skips the PNGs there.
	edge = A.replay !== null || A.all || !A.noPng ? find(A.edge, "edge", pf.map(p => join(p, "Microsoft", "Edge", "Application", "msedge.exe"))) : null;
	const pony = A.ponytail === true
		? (findPony() ?? die("ponytail plugin not found under ~/.omp/plugins/cache/plugins: pass --ponytail=DIR"))
		: A.ponytail;
	const [css, js, u11] = vendored();
	PAGE = fill(fill(fill(PAGE_TEMPLATE, "@CSS@", css), "@XTERM@", js), "@U11@", u11);
	if (A.replay !== null || A.all) return runReplays();
	await capture(pony);
	return 0;
}

if (import.meta.main) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (e) {
		if (!(e instanceof Fatal)) throw e;
		console.error(e.message);
		process.exitCode = 1;
	}
}
