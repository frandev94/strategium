import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { keyOf, parseTiers, whereFrom } from "./index";
import { cockpitView } from "./cockpit";
import { claim, type Ev, load, lockPath, nowIso, openKeys } from "./timer";

// The extension registers itself on a host. A fake one is enough: it hands back the tool it
// registered and does nothing else.
type Tool = { name: string; execute: (id: string, params: Record<string, unknown>, s: unknown, u: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }> };

const schema = () => {
	const s: Record<string, unknown> = {};
	for (const m of ["optional", "int", "positive", "nonnegative", "describe", "array", "boolean"]) s[m] = () => s;
	return s;
};

function fakePi() {
	const tools: Tool[] = [];
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
	const handlers: Record<string, ((e: unknown, ctx: unknown) => unknown)[]> = {};
	const sent: string[] = [];
	const calls: [unknown, unknown][] = [];
	const shortcuts: Record<string, { description?: string; handler: (ctx: unknown) => unknown }> = {};
	const conflicts: Record<string, unknown> = {};
	let active = ["read", "bash", "edit", "write", "task"];
	const zod = {
		object: () => schema(),
		string: () => schema(),
		number: () => schema(),
		enum: () => schema(),
		array: () => schema(),
		boolean: () => schema(),
	};
	return {
		pi: {
			zod,
			setLabel: () => {},
			getActiveTools: () => active,
			setActiveTools: async (n: string[]) => {
				active = n;
			},
			getAllTools: () => [],
			registerTool: (t: Tool) => tools.push(t),
			registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) => (commands[name] = cmd),
			on: (event: string, fn: (e: unknown, ctx: unknown) => unknown) => ((handlers[event] ??= []).push(fn)),
			sendUserMessage: (m: string) => sent.push(m),
			sendMessage: (m: { content: string }, o?: unknown) => calls.push([m, o]),
			registerShortcut: (key: string, s: { description?: string; handler: (ctx: unknown) => unknown }) => (shortcuts[key] = s),
			getShortcutConflict: (k: string) => conflicts[k],
		},
		tools,
		commands,
		handlers,
		sent,
		shortcuts,
		conflicts,
		calls,
		activeTools: () => active,
		setActive: (n: string[]) => {
			active = n;
		},
	};
}

// The host's view of the session, mutable per test. It starts busy (streaming), so no test but the idle ones can pause by idleness.
const fakeCtx = (sid: string, cwd: string, notes: string[] = [], footer: string[] = []) => {
	const host = { idle: false, pending: false, jobs: undefined as { running: unknown[] } | undefined, review: undefined as unknown };
	return {
		sessionManager: { getSessionId: () => sid },
		ui: { notify: (m: string) => void notes.push(m), setStatus: (_k: string, v?: string) => footer.push(v ?? "") },
		cwd,
		setInterval: (_fn: () => void, _ms: number) => 0,
		agent: { kind: "main" },
		host,
		isIdle: () => host.idle,
		hasPendingMessages: () => host.pending,
		getAsyncJobSnapshot: () => host.jobs,
		getPendingPlanReview: () => host.review,
	};
};

// omp switches sessions by mutating one SessionManager (setSessionFile): the id changes under the same object.
const shared = (sid: string, dir: string, footer: string[], notes: string[] = []) => {
	const sm = { sid, getSessionId: () => sm.sid };
	return { sm, ctx: { ...fakeCtx(sid, dir, notes, footer), sessionManager: sm } };
};

// omp loads ~/.omp/agent/.env into the process; a default theatre there must not change what the tests expect.
delete process.env.STRATEGIUM_THEATRE;

const dirs: string[] = [];
afterEach(() => {
	setSystemTime();
	delete process.env.STRATEGIUM_STATE_DIR;
	delete process.env.STRATEGIUM_COCKPIT_KEY;
	delete process.env.STRATEGIUM_COCKPIT_THEME;
	delete process.env.STRATEGIUM_GLYPHS;
	delete process.env.STRATEGIUM_NOTIFY;
	delete process.env.STRATEGIUM_IDLE_MIN;
	delete process.env.STRATEGIUM_ARCHMAGOS;
	delete process.env.STRATEGIUM_COMMIT;
	delete process.env.STRATEGIUM_TIERS;
	delete process.env.STRATEGIUM_SOUND;
	delete process.env.STRATEGIUM_VOLUME;
	delete process.env.STRATEGIUM_TOAST;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The alert events recorded in the day file of the fake clock.
const alertEvents = (dir: string) => load(join(dir, "2026-11-16.jsonl")).filter(e => e.event === "alert");

type Spawned = { cmd: string[]; env: Record<string, string> };
type Child = { exited: Promise<number>; unref(): void };
// The alarm spy the extension spawns through: records each call and answers with `impl` (default: a child that exits 0).
const alarm = {
	calls: [] as Spawned[],
	impl: (): Child => ({ exited: Promise.resolve(0), unref() {} }),
	spawn(o: Spawned) {
		alarm.calls.push({ cmd: o.cmd, env: o.env });
		return alarm.impl();
	},
	reset() {
		alarm.calls = [];
		alarm.impl = () => ({ exited: Promise.resolve(0), unref() {} });
	},
};
const alarmLines = () => alarm.calls.map(c => `${c.env.STRATEGIUM_P}|${c.env.STRATEGIUM_MSG}`);
const alarmFull = () => alarm.calls.map(c => `${c.env.STRATEGIUM_P}|${c.env.STRATEGIUM_SOUND}|${c.env.STRATEGIUM_MSG}|${c.env.STRATEGIUM_VOLUME}`);
const failAlarm = () => {
	alarm.impl = () => {
		throw new Error("spawn failed: missing alarm");
	};
};
const exitAlarm = (code: number) => {
	alarm.impl = () => ({ exited: Promise.resolve(code), unref() {} });
};

function setup(sid = "sess-0001", shared?: string) {
	const dir = shared ?? mkdtempSync(join(tmpdir(), "st-index-"));
	if (!shared) dirs.push(dir);
	process.env.STRATEGIUM_STATE_DIR = dir;
	// No test sounds the real alarm: the extension spawns through the spy.
	alarm.reset();
	delete process.env.STRATEGIUM_GLYPHS;
	// The alarm tests need notifications on; the tests of the default turn them off again.
	process.env.STRATEGIUM_NOTIFY = "1";
	const { pi, tools, commands, handlers, sent, calls, activeTools, setActive, shortcuts, conflicts } = fakePi();
	// What the footer and the alert had seen the moment each notification went out.
	const seen: { via: string; footer: string; events: number }[] = [];
	const sendMessage = pi.sendMessage;
	pi.sendMessage = (m: { content: string }, o?: unknown) => {
		seen.push({ via: "sendMessage", footer: footer.at(-1) ?? "", events: alertEvents(dir).length });
		return sendMessage(m, o);
	};
	extension(pi as never, { spawn: alarm.spawn });
	const tool = tools.find(t => t.name === "strategium")!;
	const notes: string[] = [];
	const footer: string[] = [];
	const ctx = fakeCtx(sid, dir, notes, footer);
	const notify = ctx.ui.notify;
	ctx.ui.notify = (m: string) => {
		seen.push({ via: "notify", footer: footer.at(-1) ?? "", events: alertEvents(dir).length });
		notify(m);
	};
	const call = async (params: Record<string, unknown>) => (await tool.execute("id", params, undefined, undefined, ctx)).content[0].text;
	const command = (args: string) => commands.strategium.handler(args, ctx);
	// The /strategium-<name> commands.
	const sub = (name: string, args = "") => commands[`strategium-${name}`].handler(args, ctx);
	// The session starts (it draws the footer), and the Captain updates the todo.
	const start = () => handlers.session_start[0]({}, ctx);
	const todo = (phases: unknown) => handlers.tool_result[0]({ toolName: "todo", isError: false, details: { phases } }, ctx);
	// The last footer line, without its colours.
	const shown = () => (footer.at(-1) ?? "").replace(/\x1b\[[0-9;]*m/g, "");
	return { dir, call, command, sub, sent, calls, seen, footer, notes, commands, handlers, shortcuts, conflicts, ctx, start, todo, shown, activeTools, setActive };
}

describe("the strategium tool", () => {
	test("begin opens the ticket and status names it", async () => {
		const { call } = setup();
		const begun = await call({ action: "begin", key: "K-1", booked: 120, theatre: "none" });
		expect(begun).toContain("K-1");
		expect(await call({ action: "status" })).toContain("RUN K-1");
	});

	test("the claim is taken, so a second session cannot begin the same ticket", async () => {
		const first = setup("sess-0001");
		await first.call({ action: "begin", key: "K-1", booked: 120 });
		const second = setup("sess-0002", first.dir);
		expect(await second.call({ action: "begin", key: "K-1", booked: 120 })).toContain("ERROR");
	});

	test("add records a manual correction and the report shows it", async () => {
		const { call } = setup();
		await call({ action: "begin", key: "K-1", booked: 120 });
		expect(await call({ action: "add", minutes: 30 })).toContain("ADDED +30 min");
		expect(await call({ action: "report" })).toContain("ADJUST K-1 30 min");
	});

	test("report refuses a date that is not a day", async () => {
		const { call } = setup();
		expect(await call({ action: "report", date: "../../../../home/user/.ssh/known_hosts" })).toContain("ERROR bad date");
	});

	test("end closes the run and releases the ticket", async () => {
		const { call } = setup();
		await call({ action: "begin", key: "K-1", booked: 120 });
		expect(await call({ action: "end" })).toContain("ENDED K-1");
		expect(await call({ action: "status" })).not.toContain("RUN K-1");
	});

	test("a run that crosses midnight closes its block in the day it started", async () => {
		const { call, dir } = setup();
		setSystemTime(new Date(2026, 10, 15, 23, 30, 0));
		await call({ action: "begin", key: "K-1", booked: 120 });
		setSystemTime(new Date(2026, 10, 16, 0, 30, 0));
		expect(await call({ action: "stop" })).toContain("STOPPED K-1");
		// The block lives in the day it started: it has to be closed there, or that day grows for ever.
		expect(openKeys(load(join(dir, "2026-11-15.jsonl")))).toEqual([]);
	});

	test("the state stays outside the repository", async () => {
		const { call, dir } = setup();
		await call({ action: "begin", key: "K-1", booked: 120 });
		await call({ action: "repo", repo: dir });
		expect(await call({ action: "status" })).toContain(`repo=${dir}`);
	});

	test("a run without a booking counts time and has no percentage", async () => {
		const { call } = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await call({ action: "begin", key: "dark-mode" });
		setSystemTime(new Date(2026, 10, 16, 9, 42, 0));
		const status = await call({ action: "status" });
		expect(status).toContain("dark-mode 42 min (no booking) running");
		expect(status).not.toContain("%");
	});

	test("a run without a booking resumes on a new day without asking for one", async () => {
		const { call } = setup();
		setSystemTime(new Date(2026, 10, 15, 17, 0, 0));
		await call({ action: "begin", key: "dark-mode" });
		await call({ action: "stop" });
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		const resumed = await call({ action: "start" });
		expect(resumed).toContain("resumed dark-mode");
		expect(resumed).not.toContain("ERROR");
	});

	test("a timed run still asks for today's booking on a new day", async () => {
		const { call } = setup();
		setSystemTime(new Date(2026, 10, 15, 17, 0, 0));
		await call({ action: "begin", key: "K-1", booked: 120 });
		await call({ action: "stop" });
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		expect(await call({ action: "start" })).toContain("today's booked minutes are needed");
		expect(await call({ action: "start", booked: 90 })).toContain("new shift for K-1 today, booked 90 min");
	});

	const storedRun = (dir: string) => JSON.parse(readFileSync(join(dir, "runs", "sess-0001.json"), "utf8"));

	test("an untimed run given a booking with start is timed from then", async () => {
		const { call, dir } = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await call({ action: "begin", key: "dark-mode" });
		setSystemTime(new Date(2026, 10, 16, 9, 30, 0));
		const out = await call({ action: "start", booked: 60 });
		expect(out).toContain("booked 60 min today");
		expect(out).not.toContain("new shift");
		expect(storedRun(dir).untimed).toBeUndefined();
		expect(await call({ action: "status" })).toContain("dark-mode 30/60 min (50%) running");
	});

	test("a stopped untimed run given a booking with start is timed", async () => {
		const { call, dir } = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await call({ action: "begin", key: "dark-mode" });
		setSystemTime(new Date(2026, 10, 16, 9, 10, 0));
		await call({ action: "stop" });
		setSystemTime(new Date(2026, 10, 16, 9, 20, 0));
		const out = await call({ action: "start", booked: 60 });
		expect(out).toContain("booked 60 min today");
		expect(out).not.toContain("new shift");
		expect(storedRun(dir).untimed).toBeUndefined();
		expect(await call({ action: "status" })).toContain("dark-mode 10/60 min (16%) running");
	});

	test("an idle-paused untimed run given a booking clears both marks", async () => {
		const { call, dir } = setup();
		await call({ action: "begin", key: "dark-mode" });
		const file = join(dir, "runs", "sess-0001.json");
		writeFileSync(file, JSON.stringify({ ...storedRun(dir), idle: true }));
		await call({ action: "start", booked: 60 });
		const run = storedRun(dir);
		expect(run.idle).toBeUndefined();
		expect(run.untimed).toBeUndefined();
	});
});

// The command hands the objective to the Captain; the workflow does not need a ticket.
describe("the /strategium command", () => {
	test("the command hides edit and ast_edit from the Captain at once", async () => {
		const { command, activeTools, setActive } = setup();
		setActive([...activeTools(), "edit", "ast_edit"]);
		await command('"add a dark mode"');
		expect(activeTools()).not.toContain("edit");
		expect(activeTools()).not.toContain("ast_edit");
	});

	test("free text in quotes is the objective", async () => {
		const { command, sent } = setup();
		await command('"add a dark mode"');
		expect(sent[0]).toContain('for the objective "add a dark mode"; no theatre was named: take the default theatre from the skill\'s Theatre section.');
		expect(sent[0]).not.toContain("with no theatre.");
	});

	test("an explicit none runs with no theatre", async () => {
		const { command, sent, call } = setup();
		await command('"add a dark mode" none');
		expect(sent[0]).toContain('for the objective "add a dark mode" with no theatre.');
		expect(sent[0]).not.toContain("no theatre was named");
		expect(await call({ action: "status" })).toContain("theatre=none");
	});

	test("an empty STRATEGIUM_THEATRE counts as none named", async () => {
		process.env.STRATEGIUM_THEATRE = "";
		try {
			const { command, sent } = setup();
			await command('"add a dark mode"');
			expect(sent[0]).toContain("no theatre was named");
		} finally {
			delete process.env.STRATEGIUM_THEATRE;
		}
	});

	test("a file is the objective, and a theatre may follow", async () => {
		const { command, sent, call } = setup();
		await command("@docs/spec.md acme");
		expect(sent[0]).toContain("for the objective @docs/spec.md with theatre skill://strategium-acme");
		expect(await call({ action: "status" })).toContain("RUN spec theatre=acme");
	});

	test("a theatre named with its prefix is not doubled", async () => {
		const { command, sent } = setup();
		await command("PROJ-1 strategium-acme");
		expect(sent[0]).toContain("theatre skill://strategium-acme.");
		expect(sent[0]).not.toContain("strategium-strategium-");
	});

	test("unquoted free text is refused: it would read as a key and a theatre", async () => {
		const { command, sent, notes, call } = setup();
		await command("make the header blue");
		expect(sent).toEqual([]);
		expect(notes[0]).toContain('"free text"');
		expect(await call({ action: "status" })).not.toContain("RUN");
	});

	test("the command begins the run at once, untimed, with a key from the objective", async () => {
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		const { command, call, sent, start, shown } = setup();
		await command('"add a dark mode"');
		const status = await call({ action: "status" });
		expect(status).toContain("RUN add-a-dark-mode theatre=none");
		expect(status).toContain("add-a-dark-mode 0 min (no booking) running");
		expect(sent[0]).toContain("Strategium run add-a-dark-mode has begun, untimed");
		expect(sent[0]).toContain("todo init the skeleton todo");
		expect(sent[0]).toContain("--to Scriptorium");
		start();
		expect(shown()).toContain("strategium: add-a-dark-mode");
		setSystemTime(new Date(2026, 10, 16, 9, 5, 0));
		expect(await call({ action: "status" })).toContain("add-a-dark-mode 5 min");
	});

	test("the key is a ticket as given, a file's base name or the free text's first words", () => {
		expect(keyOf("PROJ-123")).toBe("PROJ-123");
		expect(keyOf("@docs/Spec File.md")).toBe("spec-file");
		expect(keyOf("@C:\\work\\plan.v2.md")).toBe("plan-v2");
		expect(keyOf('"add a dark mode"')).toBe("add-a-dark-mode");
		expect(keyOf('"Añadir el modo oscuro a la cabecera"')).toBe("anadir-el-modo-oscuro");
		expect(keyOf('"supercalifragilistic expialidocious word"')).toBe("supercalifragilistic");
		expect(keyOf('"!!! ¿?"')).toBe("objective");
		expect(keyOf('"日本語"')).toBe("objective");
		// Free text keeps whole words up to 32 characters: exactly 32 stays, 33 drops the last word.
		expect(keyOf(`"${"a".repeat(10)} ${"b".repeat(10)} ${"c".repeat(10)}"`)).toBe(`${"a".repeat(10)}-${"b".repeat(10)}-${"c".repeat(10)}`);
		expect(keyOf(`"${"a".repeat(10)} ${"b".repeat(10)} ${"c".repeat(11)}"`)).toBe(`${"a".repeat(10)}-${"b".repeat(10)}`);
		// A first word longer than 32 is cut at exactly 32.
		expect(keyOf(`"${"x".repeat(40)}"`)).toBe("x".repeat(32));
		const tricky: [string, string][] = [
			['"🚀🔥 launch day 🎉"', "launch-day"],
			['"日本語のテキスト"', "objective"],
			['"..."', "objective"],
			['"Ünïcödé Çrème Brûlée à la façon"', "unicode-creme-brulee-a"],
			[`"${"palabra ".repeat(15).trim()}"`, "palabra-palabra-palabra-palabra"],
			["@a/b\\c.d.e", "c-d"],
			[`"${"x".repeat(40)}"`, "x".repeat(32)],
			["@docs/", "objective"],
			["@", "objective"],
			['"   "', "objective"],
		];
		for (const [input, expected] of tricky) {
			const key = keyOf(input);
			expect(key).toBe(expected);
			expect(key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(key.length).toBeLessThanOrEqual(32);
		}
	});

	test("the command redraws the footer at once: after a begin and after a failed begin", async () => {
		const s = setup();
		await s.start();
		await s.command('"add a dark mode"');
		expect(s.shown()).toContain("strategium: add-a-dark-mode");

		const a = setup("sess-0001");
		await a.call({ action: "begin", key: "K-1" });
		const b = setup("sess-0002", a.dir);
		await b.start();
		const before = b.footer.length;
		await b.command("K-1");
		expect(b.sent[0]).toContain("could not begin run K-1");
		expect(b.footer.length).toBeGreaterThan(before);
	});

	test("a key another session holds is not begun: the user and the Captain are told", async () => {
		const a = setup("sess-0001");
		await a.call({ action: "begin", key: "K-1" });
		const b = setup("sess-0002", a.dir);
		await b.command("K-1");
		expect(b.notes.join("\n")).toContain("is held by omp session");
		expect(b.sent[0]).toContain("could not begin run K-1");
		expect(await b.call({ action: "status" })).not.toContain("(this session)");
		expect(await a.call({ action: "status" })).toContain("RUN K-1");
		expect(await a.call({ action: "status" })).toContain("(this session)");
	});

	test("the command on this session's own run leaves it as it is", async () => {
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		const { command, call, sent, dir } = setup();
		await call({ action: "begin", key: "K-1", booked: 120 });
		const events = load(join(dir, "2026-11-16.jsonl")).length;
		await command("K-1");
		const run = JSON.parse(readFileSync(join(dir, "runs", "sess-0001.json"), "utf8"));
		expect(run.untimed).toBeUndefined();
		expect(load(join(dir, "2026-11-16.jsonl")).length).toBe(events);
		expect(sent[0]).toContain("is already this session's run");
	});
});

// Sounds and desktop notifications: off unless STRATEGIUM_NOTIFY or the session turns them on.
// A missing alarm binary makes the call fail at once, so a note "the alarm failed" proves the alarm ran, with no waiting.
describe("notifications", () => {
	const ran = (notes: string[]) => notes.some(n => n.includes("the alarm failed"));

	test("off by default: an unset STRATEGIUM_NOTIFY runs no alarm and says attention was silent", async () => {
		const s = setup();
		delete process.env.STRATEGIUM_NOTIFY;
		failAlarm();
		expect(await s.call({ action: "attention", message: "seal ready" })).toBe(
			"ATTENTION seal ready (silent: notifications are off; /strategium-config notify on)",
		);
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "end" });
		expect(ran(s.notes)).toBe(false);
	});

	test("/strategium-config notify on wins over STRATEGIUM_NOTIFY=0, for this session only", async () => {
		const s = setup();
		process.env.STRATEGIUM_NOTIFY = "0";
		failAlarm();
		await s.sub("config", "notify on");
		expect(s.notes.at(-1)).toContain("notify: on (this session)");
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "end" });
		expect(ran(s.notes)).toBe(true);
		const otherNotes: string[] = [];
		await s.commands["strategium-config"].handler("", fakeCtx("sess-0002", s.dir, otherNotes));
		expect(otherNotes[0]).toContain("notify: off (STRATEGIUM_NOTIFY)");
	});

	test("notify off from the tool silences the session even with STRATEGIUM_NOTIFY=1", async () => {
		const s = setup();
		failAlarm();
		expect(await s.call({ action: "notify", on: false })).toBe("NOTIFY off (this session)");
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "end" });
		expect(ran(s.notes)).toBe(false);
		expect(await s.call({ action: "notify" })).toBe("NOTIFY off (this session)");
	});

	test("config refuses anything but notify on|off", async () => {
		const s = setup();
		await s.sub("config", "theatre acme");
		expect(s.notes[0]).toContain("config takes notify on|off");
	});


	test.each([
		["defaults", [], "attention|1|seal ready|undefined"],
		["toast off", ["toast off"], "attention|1|undefined|undefined"],
		["sound off", ["sound off"], "attention|0|seal ready|undefined"],
	])("the alarm gets STRATEGIUM_SOUND and STRATEGIUM_MSG by channel: %s", async (_n, cmds, want) => {
		const s = setup();
		process.env.STRATEGIUM_NOTIFY = "1";
		for (const c of cmds) await s.sub("config", c);
		await s.call({ action: "attention", message: "seal ready" });
		expect(alarmFull()).toEqual([want]);
	});

	test.each([["30", "30"], ["33.6", "34"], ["-5", "0"]])("the alarm gets STRATEGIUM_VOLUME=%p as vox reads it: %p", async (env, want) => {
		const s = setup();
		process.env.STRATEGIUM_NOTIFY = "1";
		process.env.STRATEGIUM_VOLUME = env;
		await s.call({ action: "attention", message: "seal ready" });
		expect(alarmFull()).toEqual([`attention|1|seal ready|${want}`]);
	});

	test("/strategium-config volume wins over STRATEGIUM_VOLUME for this session", async () => {
		const s = setup();
		process.env.STRATEGIUM_NOTIFY = "1";
		process.env.STRATEGIUM_VOLUME = "30";
		await s.sub("config", "volume 70");
		expect(s.notes.at(-1)).toContain("volume: 70 (this session)");
		await s.call({ action: "attention", message: "seal ready" });
		expect(alarmFull()).toEqual(["attention|1|seal ready|70"]);
	});

	test("config volume <n> preview plays done at that volume even with notify off", async () => {
		const s = setup();
		await s.sub("config", "volume 35 preview");
		expect(alarmFull()).toEqual(["done|1|undefined|35"]);
	});

	test("a preview whose vox exits non-zero says so once", async () => {
		const s = setup();
		exitAlarm(1);
		await s.sub("config", "volume 35 preview");
		await s.sub("config", "volume 35 preview");
		await Bun.sleep(20);
		expect(s.notes.filter(n => n.includes("exited with code 1"))).toHaveLength(1);
	});

	test("config volume refuses more than 100 and shows the default 20 when unset", async () => {
		const s = setup();
		await s.sub("config", "volume 101");
		expect(s.notes.at(-1)).toContain("volume takes 0 to 100");
		await s.sub("config");
		expect(s.notes.at(-1)).toContain("volume: 20 (default)");
	});

	test("sound off and toast off run no alarm and attention says silent", async () => {
		const s = setup();
		process.env.STRATEGIUM_NOTIFY = "1";
		failAlarm();
		await s.sub("config", "sound off");
		await s.sub("config", "toast off");
		expect(await s.call({ action: "attention", message: "seal ready" })).toBe(
			"ATTENTION seal ready (silent: sound and toast are off; /strategium-config sound on or toast on)",
		);
		expect(ran(s.notes)).toBe(false);
	});

	test("notify off runs nothing whatever sound and toast say", async () => {
		const s = setup();
		process.env.STRATEGIUM_NOTIFY = "0";
		failAlarm();
		await s.sub("config", "sound on");
		await s.sub("config", "toast on");
		expect(await s.call({ action: "attention", message: "seal ready" })).toBe(
			"ATTENTION seal ready (silent: notifications are off; /strategium-config notify on)",
		);
		expect(ran(s.notes)).toBe(false);
	});

	test("attention names the channels that fired", async () => {
		const s = setup();
		process.env.STRATEGIUM_NOTIFY = "1";
		expect(await s.call({ action: "attention", message: "seal ready" })).toBe("ATTENTION seal ready (sound, toast)");
		await s.sub("config", "toast off");
		expect(await s.call({ action: "attention", message: "seal ready" })).toBe("ATTENTION seal ready (sound)");
		await s.sub("config", "toast on");
		await s.sub("config", "sound off");
		expect(await s.call({ action: "attention", message: "seal ready" })).toBe("ATTENTION seal ready (toast)");
	});

	test.each(["sound", "toast"])("config %s takes exactly on or off and leaves the setting unchanged otherwise", async name => {
		const s = setup();
		await s.sub("config", `${name} off`);
		for (const bad of ["onx", "on off", "offx", "maybe"]) {
			await s.sub("config", `${name} ${bad}`);
			expect(s.notes.at(-1)).toContain("config takes notify on|off");
			await s.sub("config");
			expect(s.notes.at(-1)).toContain(`${name}: off (this session)`);
		}
	});

	test("/strategium-config sound|toast win over env for this session and show their source", async () => {
		const s = setup();
		process.env.STRATEGIUM_TOAST = "off";
		await s.sub("config", "sound off");
		expect(s.notes.at(-1)).toContain("sound: off (this session)");
		expect(s.notes.at(-1)).toContain("toast: off (STRATEGIUM_TOAST)");
		await s.sub("config", "toast on");
		expect(s.notes.at(-1)).toContain("toast: on (this session)");
		const otherNotes: string[] = [];
		await s.commands["strategium-config"].handler("", fakeCtx("sess-0002", s.dir, otherNotes));
		expect(otherNotes[0]).toContain("sound: on (STRATEGIUM_SOUND)");
		expect(otherNotes[0]).toContain("toast: off (STRATEGIUM_TOAST)");
	});

	test("status shows NOTIFY, SOUND and TOAST", async () => {
		const s = setup();
		process.env.STRATEGIUM_NOTIFY = "0";
		await s.sub("config", "sound off");
		const out = await s.call({ action: "status" });
		expect(out).toContain("\nNOTIFY off (STRATEGIUM_NOTIFY)\nSOUND off (this session)\nTOAST on (STRATEGIUM_TOAST)");
	});
});

// The footer says where the run is, read from the todo: its phases are the stations.
describe("the station in the footer", () => {
	const phase = (name: string, ...tasks: [string, string][]) => ({ name, tasks: tasks.map(([content, status]) => ({ content, status })) });
	const skirmish = [
		phase("Scriptorium", ["[librarian] Plan", "completed"], ["[seal] Plan", "completed"]),
		phase("Skirmish", ["[battle-brother] Squad 1", "in_progress"]),
		phase("Inquisition", ["[inquisitor] Review", "pending"]),
	];
	const backToScriptorium = [
		phase("Scriptorium", ["[librarian] Redraft squad 2", "in_progress"]),
		phase("Skirmish", ["[battle-brother] Squad 1", "completed"]),
	];
	const waitingForPlan = [phase("Scriptorium", ["[librarian] Plan", "completed"], ["[seal] Plan", "in_progress"])];

	test("the active phase is the station, with its task text", () =>
		expect(whereFrom(skirmish)).toEqual({ station: "Skirmish", task: "Squad 1" }));
	test("a station before completed work is a return", () =>
		expect(whereFrom(backToScriptorium)).toEqual({ station: "Scriptorium", back: true, task: "Redraft squad 2" }));
	test("an active seal task waits for the user, with or without glyph tags, and carries no task", () => {
		expect(whereFrom(waitingForPlan)).toEqual({ station: "Scriptorium", seal: "Plan" });
		expect(whereFrom([phase("Scriptorium", ["\u{f047a} seal · Plan the squads", "in_progress"])])).toEqual({ station: "Scriptorium", seal: "Plan the squads" });
		expect(whereFrom([phase("Scriptorium", ["[seal] Demo (2)", "in_progress"])])).toEqual({ station: "Scriptorium", seal: "Demo (2)" });
	});
	test("the task drops a bracket tag or a glyph tag", () => {
		expect(whereFrom([phase("Muster", ["[captain] Begin run and theatre status", "in_progress"])])?.task).toBe("Begin run and theatre status");
		expect(whereFrom([phase("Muster", ["\u{f0a1} captain · Begin run", "in_progress"])])?.task).toBe("Begin run");
		expect(whereFrom([phase("Muster", ["🧭 captain · Begin run", "in_progress"])])?.task).toBe("Begin run");
	});
	test("the task is cut at 32 characters with an ellipsis", () => {
		const long = "x".repeat(40);
		expect(whereFrom([phase("Muster", [`[captain] ${long}`, "in_progress"])])?.task).toBe(`${"x".repeat(31)}…`);
		expect(whereFrom([phase("Muster", [`[captain] ${"y".repeat(32)}`, "in_progress"])])?.task).toBe("y".repeat(32));
		// An emoji (2 UTF-16 units) at the cut is kept whole, never split.
		expect(whereFrom([phase("Muster", [`[captain] ${"x".repeat(30)}🧭${"x".repeat(5)}`, "in_progress"])])?.task).toBe(`${"x".repeat(30)}🧭…`);
	});
	test("no active task, no station", () => expect(whereFrom([phase("Muster", ["[captain] Muster", "pending"])])).toBeUndefined());

	test("a redraft reopens Auspex with the return arrow", async () => {
		const reopened = [
			phase("Muster", ["[captain] Orders", "completed"]),
			phase("Auspex", ["[scout] Map", "completed"], ["[scout] Redraft refresh", "in_progress"]),
			phase("Scriptorium", ["[librarian] Plan", "completed"], ["[seal] Plan", "abandoned"]),
		];
		expect(whereFrom(reopened)).toEqual({ station: "Auspex", back: true, task: "Redraft refresh" });
		const { call, todo, start, shown } = setup();
		await call({ action: "begin", key: "dark-mode" });
		todo(reopened);
		start();
		expect(shown()).toContain("dark-mode · ↩ Auspex › Redraft refresh · ");
	});

	test("the footer shows station › task, also after a return arrow", async () => {
		const { call, todo, start, shown } = setup();
		await call({ action: "begin", key: "dark-mode" });
		todo([phase("Muster", ["[captain] Begin run and theatre status", "in_progress"])]);
		start();
		expect(shown()).toContain("dark-mode · Muster › Begin run and theatre status · ");
		todo(backToScriptorium);
		expect(shown()).toContain("dark-mode · ↩ Scriptorium › Redraft squad 2 · ");
		todo([phase("Muster", ["[captain] Orders", "in_progress"])]);
		expect(shown()).toContain("dark-mode · Muster › Orders · ");
		expect(shown()).not.toContain("⏳");
	});

	test("a user task appended to Debrief shows in the footer and in the CAPTAIN box", async () => {
		const { call, todo, start, shown } = setup();
		await call({ action: "begin", key: "dark-mode" });
		const debrief = [phase("Debrief", ["[captain] End the run and records", "completed"], ["[captain] Email the summary", "in_progress"])];
		todo(debrief);
		start();
		expect(shown()).toContain("dark-mode · Debrief › Email the summary · ");
		const captain = cockpitView({ key: "dark-mode", notes: {}, chronicle: [], phases: debrief }).boxes.find(x => x.title.includes("CAPTAIN"));
		expect(captain?.lines.map(l => l.text)).toContain("Email the summary");
	});

	test("the footer shows the station next to the time", async () => {
		const { call, todo, start, shown } = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await call({ action: "begin", key: "dark-mode" });
		todo(skirmish);
		// Within the 3-minute heartbeat gap, so the session start does not close the block as a crash.
		setSystemTime(new Date(2026, 10, 16, 9, 2, 0));
		start();
		expect(shown()).toContain("strategium: dark-mode · Skirmish › Squad 1 · 2 min");
	});

	// The hint is right-aligned with no-break spaces: omp collapses runs of plain spaces in a status line.
	describe("the cockpit hint on the footer line", () => {
		const HINT = "ALT + C to enter cockpit";
		const cols = (n: number | undefined) => Object.defineProperty(process.stdout, "columns", { value: n, configurable: true, writable: true });
		afterEach(() => void delete (process.stdout as { columns?: number }).columns);
		const begun = async () => {
			const r = setup();
			setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
			await r.call({ action: "begin", key: "dark-mode" });
			r.todo(skirmish);
			setSystemTime(new Date(2026, 10, 16, 9, 2, 0));
			return r;
		};

		test("a wide terminal ends the line with the hint at the last column", async () => {
			const { start, shown } = await begun();
			cols(140);
			start();
			const line = shown();
			expect(line.endsWith(HINT)).toBe(true);
			expect(line).toContain("strategium: dark-mode · Skirmish › Squad 1 · 2 min");
			expect(Bun.stringWidth(line)).toBe(140);
		});

		test("the hint names the configured key", async () => {
			process.env.STRATEGIUM_COCKPIT_KEY = "ctrl+shift+k";
			const { start, shown } = await begun();
			cols(140);
			start();
			const line = shown();
			expect(line.endsWith("CTRL + SHIFT + K to enter cockpit")).toBe(true);
			expect(Bun.stringWidth(line)).toBe(140);
		});

		test("the hint names a plus key as itself", async () => {
			process.env.STRATEGIUM_COCKPIT_KEY = "ctrl++";
			const { start, shown } = await begun();
			cols(140);
			start();
			expect(shown().endsWith("CTRL + + to enter cockpit")).toBe(true);
		});

		test("a terminal that is too narrow gets the footer as it is", async () => {
			const { start, shown } = await begun();
			cols(undefined);
			start();
			const plain = shown();
			cols(Bun.stringWidth(plain) + 2 + HINT.length - 1);
			start();
			expect(shown()).toBe(plain);
			cols(Bun.stringWidth(plain) + 2 + HINT.length);
			start();
			expect(shown()).toBe(`${plain}\u00a0\u00a0${HINT}`);
		});

		test("an unknown width gets no hint", async () => {
			const { start, shown } = await begun();
			cols(undefined);
			start();
			expect(shown()).not.toContain(HINT);
		});

		// omp's sanitizeHookStatusText collapses runs of spaces before drawing, so that is the width that must reach the last column.
		const drawn = (s: string) => Bun.stringWidth(s.replace(/ +/g, " "));

		test("the hint stays plain text with glyphs on", async () => {
			const { start, shown } = await begun();
			process.env.STRATEGIUM_GLYPHS = "1";
			cols(140);
			start();
			expect(shown().endsWith(HINT)).toBe(true);
			expect(drawn(shown())).toBe(140);
		});

		test("the hint reaches the last column on a return, whose glyph is followed by two spaces", async () => {
			const { start, shown, todo } = await begun();
			process.env.STRATEGIUM_GLYPHS = "1";
			todo(backToScriptorium);
			cols(140);
			start();
			expect(shown()).toContain("\u{f054c}  Scriptorium");
			expect(shown().endsWith(HINT)).toBe(true);
			expect(drawn(shown())).toBe(140);
		});

		test("a sub agent draws no footer and so no hint", async () => {
			const { start, footer, ctx } = await begun();
			cols(140);
			ctx.agent = { kind: "sub" };
			footer.length = 0;
			start();
			expect(footer).toEqual([]);
		});
	});

	test("a timed run keeps its booking next to the station", async () => {
		const { call, todo, start, shown } = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await call({ action: "begin", key: "PROJ-123", booked: 120 });
		todo(skirmish);
		setSystemTime(new Date(2026, 10, 16, 9, 2, 0));
		start();
		expect(shown()).toContain("PROJ-123 · Skirmish › Squad 1 · 🌍 2/120 min (1%)");
	});

	test("a seal waiting for the user and a return are marked, in emoji or in Nerd Font glyphs", async () => {
		const { call, todo, start, shown } = setup();
		await call({ action: "begin", key: "dark-mode" });
		todo(waitingForPlan);
		start();
		expect(shown()).toContain("dark-mode · ⏳ seal Plan · ");
		todo(backToScriptorium);
		expect(shown()).toContain("dark-mode · ↩ Scriptorium › Redraft squad 2 · ");
		process.env.STRATEGIUM_GLYPHS = "1";
		todo(waitingForPlan);
		expect(shown()).toContain("dark-mode · \u{f051f}  seal Plan · ");
		todo(backToScriptorium);
		expect(shown()).toContain("dark-mode · \u{f054c}  Scriptorium › Redraft squad 2 · ");
	});

	test("the footer shows a seal name cleaned and cut at 32, like a task", async () => {
		const { call, todo, start, shown } = setup();
		await call({ action: "begin", key: "dark-mode" });
		start();
		todo([phase("Scriptorium", [`[seal] ${"S".repeat(60)}`, "in_progress"])]);
		expect(shown()).toContain(`seal ${"S".repeat(31)}… · `);
		todo([phase("Scriptorium", ["[seal] Plan\x1b]0;pwn\x07", "in_progress"])]);
		expect(shown()).not.toContain("\x1b]");
		expect(shown()).toContain("seal Plan ]0;pwn  · ");
	});

	test("the station survives a restart of omp", async () => {
		const first = setup("sess-0001");
		await first.call({ action: "begin", key: "dark-mode" });
		first.todo(skirmish);
		const again = setup("sess-0001", first.dir);
		again.start();
		expect(again.shown()).toContain("dark-mode · Skirmish › Squad 1 · ");
	});
});

// The booking alert and the paused footer: what the footer line does besides showing the time.
describe("the booking alert in the footer", () => {
	test("a running run alerts once when it crosses a threshold", async () => {
		const { dir, call, start, shown, footer, notes, calls, seen } = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await call({ action: "begin", key: "K-1", booked: 4 });
		setSystemTime(new Date(2026, 10, 16, 9, 2, 0));
		start();
		expect(footer.at(-1)!.startsWith("\x1b[32m●\x1b[39m ")).toBe(true);
		expect(shown()).toContain("K-1 · 🌠 2/4 min (50%)");
		expect(notes).toEqual(["Strategium: 50% of the booking for K-1"]);
		expect(calls).toEqual([
			[
				{ customType: "strategium-timer", content: "TIMER 50% K-1 2/4 min", display: true, attribution: "agent" },
				{ deliverAs: "aside", triggerTurn: true },
			],
		]);
		expect(alertEvents(dir)).toHaveLength(1);
		expect(alertEvents(dir)[0].p).toBe(50);
		// The status call re-runs the footer; the alert is already recorded.
		await call({ action: "status" });
		expect(alertEvents(dir)).toHaveLength(1);
		expect(calls).toHaveLength(1);
		expect(notes).toEqual(["Strategium: 50% of the booking for K-1"]);
		// Both notifications went out after the footer showed 50% and the alert event was recorded.
		expect(seen).toEqual([
			{ via: "notify", footer: expect.stringContaining("2/4 min (50%)"), events: 1 },
			{ via: "sendMessage", footer: expect.stringContaining("2/4 min (50%)"), events: 1 },
		]);
	});

	test("a paused timed run says paused and never alerts", async () => {
		const { dir, call, start, shown, footer, notes, calls } = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await call({ action: "begin", key: "K-1", booked: 4 });
		setSystemTime(new Date(2026, 10, 16, 9, 2, 0));
		await call({ action: "stop" });
		start();
		expect(footer.at(-1)!.startsWith("\x1b[38;5;243m○\x1b[39m ")).toBe(true);
		expect(shown()).toContain("K-1 · 🌠 2/4 min (50%) paused");
		expect(notes).toEqual([]);
		expect(calls).toEqual([]);
		expect(alertEvents(dir)).toHaveLength(0);
	});

	test.each([
		["80%", 4],
		["100%", 5],
	])("a paused timed run at %s never alerts", async (_pct, minutes) => {
		const { dir, call, start, shown, notes, calls } = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await call({ action: "begin", key: "K-1", booked: 5 });
		setSystemTime(new Date(2026, 10, 16, 9, minutes, 0));
		await call({ action: "stop" });
		start();
		expect(shown()).toContain("paused");
		expect(notes).toEqual([]);
		expect(calls).toEqual([]);
		expect(alertEvents(dir)).toHaveLength(0);
	});

	test("a paused run without a booking says paused", async () => {
		const { call, start, shown } = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await call({ action: "begin", key: "dark-mode" });
		setSystemTime(new Date(2026, 10, 16, 9, 2, 0));
		await call({ action: "stop" });
		start();
		expect(shown()).toContain("strategium: dark-mode · paused");
	});
});

// The Captain's limits: what the plugin takes away while a run is open.
describe("the Captain's limits", () => {
	type Host = { handlers: Record<string, ((e: unknown, ctx: unknown) => unknown)[]>; ctx: unknown };
	type Verdict = { block?: true; reason?: string } | undefined;
	const toolCall = (s: Host, toolName: string, input: unknown) => s.handlers.tool_call[0]({ toolName, input }, s.ctx) as Verdict;
	const spawn = (s: Host, agent?: string) => s.handlers.before_subagent_spawn[0]({ agent }, s.ctx) as Verdict;
	const brothers = (n: number) => ({ tasks: Array.from({ length: n }, () => ({ agent: "battle-brother", isolated: true })) });
	const disjoint = [
		{ id: "S1", parallel: true, files: ["a.ts"] },
		{ id: "S2", parallel: true, files: ["b.ts"] },
	];

	test("begin hides edit and end brings it back", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		expect(s.activeTools()).toEqual(["read", "bash", "write", "task"]);
		await s.call({ action: "end" });
		expect(s.activeTools()).toContain("edit");
	});

	test("the edit guard blocks a repo edit even when edit is active again", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "repo", repo: s.dir });
		s.setActive([...s.activeTools(), "edit"]);
		expect(toolCall(s, "edit", { path: join(s.dir, "a.ts") })).toEqual({
			block: true,
			reason: "Strategium: the Captain does not edit repository files. Delegate this change to a battle-brother agent.",
		});
	});

	describe("the edit guard in every shape of a target", () => {
		const BLOCK = {
			block: true as const,
			reason: "Strategium: the Captain does not edit repository files. Delegate this change to a battle-brother agent.",
		};
		const editing = async () => {
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			await s.call({ action: "repo", repo: s.dir });
			s.setActive([...s.activeTools(), "edit"]);
			return s;
		};
		const outsideDir = () => {
			const d = mkdtempSync(join(tmpdir(), "st-outside-"));
			dirs.push(d);
			return d;
		};

		test("the host's underscored name _edit is guarded like edit", async () => {
			const s = await editing();
			expect(toolCall(s, "_edit", { path: join(s.dir, "a.ts") })).toEqual(BLOCK);
		});

		test("a file outside the repository passes", async () => {
			const s = await editing();
			const outside = outsideDir();
			expect(toolCall(s, "edit", { path: join(outside, "a.ts") })).toBeUndefined();
			expect(toolCall(s, "_edit", { path: join(outside, "a.ts") })).toBeUndefined();
		});

		test("a file in the worktrees next to the repository is guarded", async () => {
			const s = await editing();
			const wt = `${s.dir}-worktrees`;
			dirs.push(wt);
			mkdirSync(join(wt, "x"), { recursive: true });
			expect(toolCall(s, "edit", { path: join(wt, "x", "a.ts") })).toEqual(BLOCK);
		});

		test("a relative path is resolved against the session cwd, not the process cwd", async () => {
			const s = await editing();
			expect(toolCall(s, "edit", { path: "a.ts" })).toEqual(BLOCK);
			const elsewhere = { handlers: s.handlers, ctx: { ...(s.ctx as object), cwd: outsideDir() } };
			expect(toolCall(elsewhere, "edit", { path: "a.ts" })).toBeUndefined();
		});

		test.skipIf(process.platform === "linux")("a path written in another case still hits the repository", async () => {
			const s = await editing();
			expect(toolCall(s, "edit", { path: join(s.dir, "a.ts").toUpperCase() })).toEqual(BLOCK);
		});
	});

	test("an agent outside the roster is refused during a run, allowed without one", async () => {
		const s = setup();
		expect(spawn(s, "code-reviewer")).toBeUndefined();
		await s.call({ action: "begin", key: "K-1" });
		expect(spawn(s, "code-reviewer")?.block).toBe(true);
		expect(spawn(s, "scout")).toBeUndefined();
		expect(spawn(s)).toBeUndefined();
	});

	test("a battle-brother is refused until the squads are declared", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "repo", repo: s.dir });
		expect(toolCall(s, "task", brothers(1))?.reason).toContain("declare the plan's squads first");
		expect(spawn(s, "battle-brother")?.reason).toContain("declare the plan's squads first");
		expect(toolCall(s, "task", { tasks: [{ agent: "scout" }] })).toBeUndefined();
	});

	test("every parallel squad launches in one call; later calls pass", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "repo", repo: s.dir });
		expect(await s.call({ action: "slices", slices: disjoint })).toBe("SQUADS S1 (parallel), S2 (parallel)");
		expect(toolCall(s, "task", brothers(1))?.reason).toContain("launch every parallel squad (S1, S2) in one task call; this call has 1 battle-brother(s).");
		expect(toolCall(s, "task", brothers(2))).toBeUndefined();
		expect(toolCall(s, "task", brothers(1))).toBeUndefined();
	});

	test("bash runners and writes are blocked while the run has a repo", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		expect(toolCall(s, "bash", { command: "bun test" })).toBeUndefined();
		await s.call({ action: "repo", repo: s.dir });
		expect(toolCall(s, "bash", { command: "bun test" })?.block).toBe(true);
		expect(toolCall(s, "bash", { command: "git log" })).toBeUndefined();
		expect(toolCall(s, "bash", undefined)).toBeUndefined();
	});

	test("squads are checked: empty, ids, files and overlap", async () => {
		const s = setup();
		expect(await s.call({ action: "slices", slices: disjoint })).toBe("ERROR no active run in this session");
		await s.call({ action: "begin", key: "K-1" });
		expect(await s.call({ action: "slices", slices: [] })).toBe("ERROR declare at least one squad");
		expect(await s.call({ action: "slices", slices: [{ id: "", parallel: false, files: ["a"] }] })).toBe("ERROR every squad needs an id");
		expect(await s.call({ action: "slices", slices: [disjoint[0], disjoint[0]] })).toBe("ERROR duplicate squad id S1");
		expect(await s.call({ action: "slices", slices: [{ id: "S1", parallel: true, files: [] }] })).toBe("ERROR squad S1 lists no files");
	});

	test.skipIf(process.platform === "linux")("overlap is found across case and separators", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		const out = await s.call({
			action: "slices",
			slices: [
				{ id: "S1", parallel: true, files: ["alarm/vox.ts"] },
				{ id: "S2", parallel: true, files: ["ALARM\\vox.ts"] },
			],
		});
		expect(out).toStartWith("ERROR squads S1 and S2 are both parallel and both change alarm/vox.ts.");
	});

	describe("squads whose agents have stopped", () => {
		const a = { id: "S1g-device-site", parallel: true, files: ["src/cards/attachments.ts"] };
		const b = { id: "S2b-grid-device-site", parallel: true, files: ["src/cards/attachments.ts", "src/grid.ts"] };
		const brother = (name: string, slice: string) => ({ agent: "battle-brother", name, isolated: true, task: `Read local://K-1-plan.md; build squad ${slice}.` });
		// The host's two halves of a launch: the call (may be refused) and its result, with the agent ids it allocated.
		const launch = (s: Host, tasks: unknown[], ids: string[], status = "running") => {
			const verdict = toolCall(s, "task", { tasks });
			if (verdict?.block) return verdict;
			const details = { progress: ids.map((id, index) => ({ index, id, status })) };
			for (const h of s.handlers.tool_result) h({ toolName: "task", input: { tasks }, details, isError: false }, s.ctx);
			return undefined;
		};
		const end = (s: Host, ...ids: string[]) =>
			s.handlers.context[0]({ type: "context", messages: [{ role: "custom", customType: "async-result", details: { jobs: ids.map((label, i) => ({ jobId: `j-${label}-${i}`, type: "task", status: "completed", label })) } }] }, s.ctx);
		const start = async () => {
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			await s.call({ action: "repo", repo: s.dir });
			return s;
		};

		test("a stopped squad still listed is a warning, while a running one is an error", async () => {
			const s = await start();
			await s.call({ action: "slices", slices: [a, { ...b, files: ["src/grid.ts"] }] });
			launch(s, [brother("S1gDeviceSite", a.id), brother("Grid", b.id)], ["S1gDeviceSite", "Grid"]);
			expect(await s.call({ action: "slices", slices: [a, b] })).toStartWith("ERROR squads S1g-device-site and S2b-grid-device-site");
			end(s, "S1gDeviceSite");
			expect((await s.call({ action: "slices", slices: [a, b] })).split("\n")).toEqual([
				"WARN squad S1g-device-site is no longer active (its agent has stopped); sharing src/cards/attachments.ts with S2b-grid-device-site is not a conflict. " +
					'Remove it from the list, e.g. slices: [{"id":"S2b-grid-device-site","parallel":true,"files":["src/cards/attachments.ts","src/grid.ts"]}].',
				"SQUADS S2b-grid-device-site (parallel)",
			]);
		});

		test("a stopped squad cannot be launched again on files a running agent is changing", async () => {
			const s = await start();
			await s.call({ action: "slices", slices: [a, { ...b, files: ["src/grid.ts"] }] });
			launch(s, [brother("S1gDeviceSite", a.id), brother("Grid", b.id)], ["S1gDeviceSite", "Grid"]);
			end(s, "S1gDeviceSite");
			await s.call({ action: "slices", slices: [a, b] });
			// The penance would share attachments.ts with S2b, still running.
			expect(launch(s, [brother("S1gDeviceSite", a.id)], ["S1gDeviceSite-2"])?.reason).toBe(
				"Strategium: squad S1g-device-site changes src/cards/attachments.ts, which squad S2b-grid-device-site is changing right now. " +
					"Two agents working on the same file at the same time overwrite each other's changes. Wait until that agent has finished, then launch this one.",
			);
			end(s, "Grid");
			expect(launch(s, [brother("S1gDeviceSite", a.id)], ["S1gDeviceSite-2"])).toBeUndefined();
			// The first run's completion, still in the history, does not stop the penance.
			end(s, "S1gDeviceSite");
			expect(await s.call({ action: "slices", slices: [a, b] })).toStartWith("WARN squad S2b-grid-device-site is no longer active");
			end(s, "S1gDeviceSite-2");
			expect(await s.call({ action: "slices", slices: [a, b] })).toEndWith("SQUADS none");
		});

		test("a name reused for two slices: each agent id stops only its own squad", async () => {
			const s = await start();
			const x = { id: "S1", parallel: true, files: ["x.ts"] };
			const y = { id: "S2", parallel: true, files: ["y.ts"] };
			await s.call({ action: "slices", slices: [x, y] });
			launch(s, [brother("Builder", "S1"), brother("Builder", "S2")], ["Builder", "Builder-2"]);
			end(s, "Builder");
			const out = await s.call({ action: "slices", slices: [x, { ...y, files: ["x.ts", "y.ts"] }] });
			expect(out.split("\n")[0]).toStartWith("WARN squad S1 is no longer active");
			expect(out).toEndWith("SQUADS S2 (parallel)");
		});

		test("a squad stops only when every agent building it has ended", async () => {
			const s = await start();
			const x = { id: "S1", parallel: true, files: ["x.ts"] };
			const y = { id: "S2", parallel: true, files: ["x.ts"] };
			await s.call({ action: "slices", slices: [x] });
			// Two agents for one squad in one call are refused...
			expect(launch(s, [brother("A", "S1"), brother("B", "S1")], ["A", "B"])?.reason).toContain("which another agent for the same squad is changing right now");
			// ...and so is a second one while the first runs.
			launch(s, [brother("A", "S1")], ["A"]);
			expect(launch(s, [brother("B", "S1")], ["B"])?.reason).toContain("another agent for the same squad");
			// Should two run anyway (the host bound both), the first end leaves the squad running.
			for (const h of s.handlers.tool_result)
				h({ toolName: "task", input: { tasks: [brother("B", "S1")] }, details: { progress: [{ index: 0, id: "B", status: "running" }] }, isError: false }, s.ctx);
			end(s, "A");
			expect(await s.call({ action: "slices", slices: [x, y] })).toStartWith("ERROR squads S1 and S2");
			end(s, "B");
			expect(await s.call({ action: "slices", slices: [x, y] })).toStartWith("WARN squad S1 is no longer active");
		});

		test("an agent that already ended when its call returned never counts as running", async () => {
			const s = await start();
			await s.call({ action: "slices", slices: [a] });
			launch(s, [brother("S1gDeviceSite", a.id)], ["S1gDeviceSite"], "completed");
			expect(await s.call({ action: "slices", slices: [a, b] })).toStartWith("WARN squad S1g-device-site is no longer active");
		});

		const b2 = { ...b, files: ["src/grid.ts"] };
		const runOf = (s: Host & { dir: string }) => JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8"));
		// The result half of a launch for any tool name and context, without the call guard.
		const report = (s: Host, toolName: string, tasks: unknown[], ids: string[], ctx: unknown = s.ctx) => {
			const details = { progress: ids.map((id, index) => ({ index, id, status: "running" })) };
			for (const h of s.handlers.tool_result) h({ toolName, input: { tasks }, details, isError: false }, ctx);
		};
		const endAs = (s: Host, ctx: unknown, ...ids: string[]) =>
			s.handlers.context[0]({ type: "context", messages: [{ role: "custom", details: { jobs: ids.map(label => ({ jobId: `j-${label}`, type: "task", status: "completed", label })) } }] }, ctx);
		const subOf = (s: Host) => ({ ...(s.ctx as object), agent: { kind: "sub" } });

		test("a warning and an error come in one answer, warning first", async () => {
			const s = await start();
			const c = { id: "S3", parallel: true, files: ["src/grid.ts"] };
			await s.call({ action: "slices", slices: [a, b2] });
			launch(s, [brother("S1gDeviceSite", a.id), brother("Grid", b.id)], ["S1gDeviceSite", "Grid"]);
			end(s, "S1gDeviceSite");
			const lines = (await s.call({ action: "slices", slices: [a, b2, c] })).split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toStartWith("WARN squad S1g-device-site is no longer active");
			expect(lines[1]).toStartWith("ERROR squads S2b-grid-device-site and S3 are both parallel and both change src/grid.ts.");
		});

		test("a new squad on the files of a stopped squad is warned, and again on the next declaration", async () => {
			const s = await start();
			const c = { id: "S3", parallel: true, files: ["src/cards/attachments.ts"] };
			await s.call({ action: "slices", slices: [a, b2] });
			launch(s, [brother("S1gDeviceSite", a.id), brother("Grid", b.id)], ["S1gDeviceSite", "Grid"]);
			end(s, "S1gDeviceSite");
			const want = [
				"WARN squad S3 changes src/cards/attachments.ts, which squad S1g-device-site already changed and its agent has stopped. " +
					"Tell S3's agent what S1g-device-site changed there, so it builds on that work instead of undoing it.",
				"SQUADS S2b-grid-device-site (parallel), S3 (parallel)",
			];
			expect((await s.call({ action: "slices", slices: [b2, c] })).split("\n")).toEqual(want);
			expect((await s.call({ action: "slices", slices: [b2, c] })).split("\n")).toEqual(want);
		});

		test("a task that is still pending counts as running", async () => {
			const s = await start();
			await s.call({ action: "slices", slices: [a, b2] });
			launch(s, [brother("S1gDeviceSite", a.id), brother("Grid", b.id)], ["S1gDeviceSite", "Grid"], "pending");
			// Running, so the overlap is an error; a launch that is not counted as running reads as already stopped (a warning).
			expect(await s.call({ action: "slices", slices: [a, b] })).toStartWith("ERROR squads S1g-device-site and S2b-grid-device-site");
		});

		test("an agent launched in an earlier call keeps running when a later one ends", async () => {
			const s = await start();
			const x = { id: "S1", parallel: true, files: ["x.ts"] };
			const y = { id: "S2", parallel: false, files: ["y.ts"] };
			await s.call({ action: "slices", slices: [x, y] });
			launch(s, [brother("A", "S1")], ["A"]);
			launch(s, [brother("B", "S2")], ["B"]);
			end(s, "A");
			// S1 stopped (a warning, not an error) and S2 still runs: nobody may start on its files.
			expect(await s.call({ action: "slices", slices: [x, { ...y, parallel: true, files: ["x.ts", "y.ts"] }] })).toStartWith("WARN squad S1 is no longer active");
			expect(launch(s, [brother("C", "S2")], ["C"])?.reason).toContain("another agent for the same squad");
		});

		test("a squad relaunched after it left the list is listed again", async () => {
			const s = await start();
			await s.call({ action: "slices", slices: [a, b2] });
			launch(s, [brother("S1gDeviceSite", a.id), brother("Grid", b.id)], ["S1gDeviceSite", "Grid"]);
			end(s, "S1gDeviceSite");
			await s.call({ action: "slices", slices: [b2] });
			expect(launch(s, [brother("S1gDeviceSite", a.id)], ["S1gDeviceSite-2"])).toBeUndefined();
			expect(runOf(s).slices.map((x: { id: string }) => x.id)).toEqual([b.id, a.id]);
		});

		test("two agents of one squad ending together stop it once", async () => {
			const s = await start();
			const x = { id: "S1", parallel: true, files: ["x.ts"] };
			await s.call({ action: "slices", slices: [x] });
			report(s, "task", [brother("A", "S1"), brother("B", "S1")], ["A", "B"]);
			end(s, "A", "B");
			expect((await s.call({ action: "slices", slices: [{ id: "S2", parallel: true, files: ["x.ts"] }] })).split("\n")).toEqual([
				"WARN squad S2 changes x.ts, which squad S1 already changed and its agent has stopped. Tell S2's agent what S1 changed there, so it builds on that work instead of undoing it.",
				"SQUADS S2 (parallel)",
			]);
		});

		test("every agent that ends in one message is handled, not only the first", async () => {
			const s = await start();
			await s.call({ action: "slices", slices: [a, b2] });
			launch(s, [brother("S1gDeviceSite", a.id), brother("Grid", b.id)], ["S1gDeviceSite", "Grid"]);
			end(s, "S1gDeviceSite", "Grid");
			expect((await s.call({ action: "slices", slices: [a, b2] })).split("\n")).toEqual([
				"WARN squad S1g-device-site is no longer active (its agent has stopped). Remove it from the list.",
				"WARN squad S2b-grid-device-site is no longer active (its agent has stopped). Remove it from the list.",
				"SQUADS none",
			]);
		});

		test("a sub-agent's task result binds nothing and its context ends nothing", async () => {
			const s = await start();
			await s.call({ action: "slices", slices: [a, b2] });
			report(s, "task", [brother("S1gDeviceSite", a.id)], ["S1gDeviceSite"], subOf(s));
			end(s, "S1gDeviceSite");
			expect(await s.call({ action: "slices", slices: [a, b] })).toStartWith("ERROR squads S1g-device-site and S2b-grid-device-site");
			launch(s, [brother("S1gDeviceSite", a.id), brother("Grid", b.id)], ["S1gDeviceSite", "Grid"]);
			endAs(s, subOf(s), "S1gDeviceSite");
			expect(await s.call({ action: "slices", slices: [a, b] })).toStartWith("ERROR squads S1g-device-site and S2b-grid-device-site");
			end(s, "S1gDeviceSite");
			expect(await s.call({ action: "slices", slices: [a, b] })).toStartWith("WARN squad S1g-device-site is no longer active");
		});

		test("only a task result binds an agent, under either spelling of the name", async () => {
			const s = await start();
			await s.call({ action: "slices", slices: [a, { ...b2, parallel: false }] });
			report(s, "read", [brother("S1gDeviceSite", a.id)], ["S1gDeviceSite"]);
			end(s, "S1gDeviceSite");
			expect(await s.call({ action: "slices", slices: [a, b] })).toStartWith("ERROR squads S1g-device-site and S2b-grid-device-site");
			report(s, "_task", [brother("S1gDeviceSite", a.id)], ["S1gDeviceSite"]);
			end(s, "S1gDeviceSite");
			expect(await s.call({ action: "slices", slices: [a, b] })).toStartWith("WARN squad S1g-device-site is no longer active");
		});

		test("a sequential squad is held back too, with every shared file named", async () => {
			const s = await start();
			const x = { id: "S1", parallel: true, files: ["x.ts", "y.ts"] };
			const z = { id: "S2", parallel: false, files: ["y.ts", "x.ts"] };
			await s.call({ action: "slices", slices: [x, z] });
			launch(s, [brother("A", "S1")], ["A"]);
			expect(launch(s, [brother("B", "S2")], ["B"])?.reason).toStartWith("Strategium: squad S2 changes y.ts, x.ts, which squad S1 is changing right now.");
		});

		describe("which agents build a squad", () => {
			const stoppedWarning = "WARN squad S1g-device-site is no longer active";
			// Bound as running, so its end stops the squad (a warning); unbound, the overlap would stay an error.
			const bound = async (item: Record<string, unknown>) => {
				const s = await start();
				await s.call({ action: "slices", slices: [a, { ...b, parallel: false, files: ["src/grid.ts"] }] });
				expect(launch(s, [item], ["X"])).toBeUndefined();
				end(s, "X");
				return s.call({ action: "slices", slices: [a, b] });
			};
			test.each<[string, Record<string, unknown>]>([
				["by its name alone", { agent: "battle-brother", name: "S1gDeviceSite", task: "go" }],
				["a veteran", { agent: "veteran", name: "X", task: "build squad S1g-device-site" }],
				["an agent name with a prefix", { agent: "omp:Battle-Brother", name: "X", task: "build squad S1g-device-site" }],
				["a brief with a plan path and a squad", { agent: "battle-brother", name: "X", task: "Read local://K-1-plan.md; build squad S1g-device-site." }],
				["a brief in capitals", { agent: "battle-brother", name: "X", task: "Build Squad S1g-device-site." }],
				["a brief that still says slice", { agent: "battle-brother", name: "X", task: "Read local://K-1-plan.md; build slice S1g-device-site." }],
			])("is bound: %s", async (_label, item) => expect(await bound(item)).toStartWith(stoppedWarning));
		});
	});

	describe("the theme when the run ends", () => {

		test("the tool's end plays it once", async () => {
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			await s.call({ action: "end" });
			expect(alarmLines()).toEqual(["theme|K-1: run ended"]);
		});

		test("/strategium-end plays it too", async () => {
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			await s.sub("end");
			expect(alarmLines()).toEqual(["theme|K-1: run ended"]);
			expect(s.activeTools()).toContain("edit");
		});

		test("an end that fails plays nothing", async () => {
			const s = setup();
			expect(await s.call({ action: "end" })).toContain("ERROR");
			await Bun.sleep(300);
			expect(alarmLines()).toEqual([]);
		});
	});
});

// omp opens a new session in the same process on "approve and execute": it emits session_switch, not session_start.
describe("footer after a switch", () => {
	test("the footer follows the new session and later refreshes keep it", async () => {
		const s = setup("sess-B");
		await s.call({ action: "begin", key: "omp-native" });
		const other = fakeCtx("sess-A", s.dir, [], s.footer);
		s.handlers.session_start[0]({}, other);
		expect(s.shown()).toBe("");
		await s.handlers.session_switch[0]({}, s.ctx);
		expect(s.shown()).toContain("omp-native");
		await s.call({ action: "status" });
		expect(s.shown()).toContain("omp-native");
	});

	test("a switch adds no second timer", async () => {
		const s = setup("sess-B");
		let timers = 0;
		s.ctx.setInterval = () => ++timers;
		await s.handlers.session_start[0]({}, s.ctx);
		await s.handlers.session_switch[0]({}, s.ctx);
		expect(timers).toBe(1);
	});

	test("switching to a session with no run gives the editing tools back", async () => {
		const s = setup("sess-A");
		await s.call({ action: "begin", key: "omp-native" });
		const { sm, ctx } = shared("sess-A", s.dir, s.footer);
		await s.handlers.session_start[0]({}, ctx);
		expect(s.activeTools()).toEqual(["read", "bash", "write", "task"]);
		sm.sid = "sess-B";
		await s.handlers.session_switch[0]({}, ctx);
		expect(s.activeTools()).toEqual(["read", "bash", "write", "task", "edit"]);
	});

	test("the footer follows the switch when the session manager is shared", async () => {
		const s = setup("sess-B");
		await s.call({ action: "begin", key: "omp-native" });
		const { sm, ctx } = shared("sess-A", s.dir, s.footer);
		await s.handlers.session_start[0]({}, ctx);
		expect(s.shown()).toBe("");
		sm.sid = "sess-B";
		await s.handlers.session_switch[0]({}, ctx);
		expect(s.shown()).toContain("omp-native");
		await s.call({ action: "status" });
		expect(s.shown()).toContain("omp-native");
	});
});

describe("the run follows an approved plan", () => {
	const emit = (s: { handlers: Record<string, ((e: unknown, ctx: unknown) => unknown)[]> }, event: string, e: object, ctx: unknown) =>
		s.handlers[event][0]({ ...e }, ctx);
	// A session that owns a run, on a session manager shared across switches, as omp does.
	async function owner() {
		const s = setup("sess-A");
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "repo", repo: s.dir });
		const notes: string[] = [];
		const { sm, ctx } = shared("sess-A", s.dir, s.footer, notes);
		await s.handlers.session_start[0]({}, ctx);
		await s.commands["strategium-config"].handler("notify off", ctx);
		await s.commands["strategium-config"].handler("sound off", ctx);
		await s.commands["strategium-config"].handler("toast off", ctx);
		return { s, sm, ctx, notes };
	}
	const files = (dir: string, sid: string) => ({ run: existsSync(join(dir, "runs", `${sid}.json`)), beat: existsSync(join(dir, "runs", `${sid}.beat`)) });

	test("approve and execute moves the run to the new session", async () => {
		const { s, sm, ctx, notes } = await owner();
		// A run with everything a run can carry: the move must copy all of it.
		const file = join(s.dir, "runs", "sess-A.json");
		const slice = { id: "S1", parallel: true, files: ["a.ts"] };
		writeFileSync(
			file,
			JSON.stringify({
				...JSON.parse(readFileSync(file, "utf8")),
				slices: [slice],
				agents: { "agent-1": slice },
				stopped: [{ id: "S0", parallel: false, files: ["z.ts"] }],
				where: { station: "Skirmish" },
				launched: true,
			}),
		);
		const before = JSON.parse(readFileSync(file, "utf8"));
		expect(before).toMatchObject({ untimed: true, hidden: ["edit"], repo: s.dir, launched: true });
		// omp's order: the review closes (old session id) before the new session exists, and the host restores
		// the plan-mode tool set both before and after the switch.
		await emit(s, "plan_review_requested", { sessionId: "sess-A" }, ctx);
		s.setActive([...s.activeTools(), "edit"]);
		await emit(s, "plan_review_resolved", { sessionId: "sess-A", choice: "execute" }, ctx);
		sm.sid = "sess-B";
		await emit(s, "session_switch", { reason: "new", previousSessionFile: "a.jsonl" }, ctx);
		const moved = () => JSON.parse(readFileSync(join(s.dir, "runs", "sess-B.json"), "utf8"));
		// The move carries every field; omp cancelled the old session's agents, so none is running and S1 is stopped.
		expect(moved()).toEqual({ ...before, sid: "sess-B", agents: {}, stopped: [...before.stopped, slice], where: undefined });
		s.setActive([...s.activeTools(), "edit"]);
		await emit(s, "before_agent_start", { prompt: "plan approved" }, ctx);
		expect(readFileSync(lockPath(s.dir, "K-1"), "utf8")).toBe("sess-B");
		expect(files(s.dir, "sess-A")).toEqual({ run: false, beat: false });
		expect(files(s.dir, "sess-B")).toEqual({ run: true, beat: true });
		expect(s.activeTools()).not.toContain("edit");
		expect(openKeys(load(join(s.dir, "2026-11-16.jsonl")))).toEqual(["K-1"]);
		await s.commands["strategium-status"].handler("", ctx);
		expect(notes.at(-1)).toMatch(/^RUN K-1 .* \(this session\)$/m);
		expect(notes.at(-1)).not.toContain("stale");
		await s.commands["strategium-config"].handler("", ctx);
		expect(notes.at(-1)).toContain("notify: off (this session)");
		expect(notes.at(-1)).toContain("sound: off (this session)");
		expect(notes.at(-1)).toContain("toast: off (this session)");
	});

	// omp hands a todo result to every tool_result handler: the station one and the one that keeps run.phases.
	const todoResult = (s: { handlers: Record<string, ((e: unknown, ctx: unknown) => unknown)[]> }, ctx: unknown, op: string, phases: unknown) =>
		Promise.all(s.handlers.tool_result.map(h => h({ toolName: "todo", isError: false, details: { op, phases } }, ctx)));
	const phase = (name: string, ...tasks: [string, string][]) => ({ name, tasks: tasks.map(([content, status]) => ({ content, status })) });
	const approve = async (s: Awaited<ReturnType<typeof owner>>["s"], sm: { sid: string }, ctx: unknown) => {
		await emit(s, "plan_review_requested", { sessionId: "sess-A" }, ctx);
		await emit(s, "plan_review_resolved", { sessionId: "sess-A", choice: "execute" }, ctx);
		sm.sid = "sess-B";
		await emit(s, "session_switch", { reason: "new" }, ctx);
	};
	const movedRun = (dir: string) => JSON.parse(readFileSync(join(dir, "runs", "sess-B.json"), "utf8"));

	test("the move carries the cockpit state to the new session and drops the old file", async () => {
		const { s, sm, ctx } = await owner();
		await todoResult(s, ctx, "start", [phase("Plan", ["[seal] Plan", "in_progress"])]);
		const cockpitFile = (sid: string) => join(s.dir, "runs", `${sid}.cockpit`);
		expect(existsSync(cockpitFile("sess-A"))).toBe(true);
		const before = JSON.parse(readFileSync(cockpitFile("sess-A"), "utf8"));
		expect(before.chronicle.map((e: { text: string }) => e.text)).toContain("station Plan");
		await approve(s, sm, ctx);
		expect(existsSync(cockpitFile("sess-A"))).toBe(false);
		expect(existsSync(cockpitFile("sess-B"))).toBe(true);
		expect(JSON.parse(readFileSync(cockpitFile("sess-B"), "utf8")).chronicle).toEqual(before.chronicle);
		// A restart of sess-B still has it.
		const again = setup("sess-B", s.dir);
		await again.start();
		expect(JSON.parse(readFileSync(cockpitFile("sess-B"), "utf8")).chronicle).toEqual(before.chronicle);
	});

	test("the move carries the prepared seal lines and the panel still shows on the new session", async () => {
		const { s, sm, ctx } = await owner();
		await todoResult(s, ctx, "start", [phase("Plan", ["[seal] Plan", "in_progress"])]);
		await s.call({ action: "seal", lines: ["Squads: a, b"] });
		const cockpitFile = (sid: string) => join(s.dir, "runs", `${sid}.cockpit`);
		expect(JSON.parse(readFileSync(cockpitFile("sess-A"), "utf8")).seal).toEqual({ id: "Plan", lines: ["Squads: a, b"] });
		await approve(s, sm, ctx);
		expect(JSON.parse(readFileSync(cockpitFile("sess-B"), "utf8")).seal).toEqual({ id: "Plan", lines: ["Squads: a, b"] });
		const again = setup("sess-B", s.dir);
		let comp: { render(w: number): string[]; handleInput?(d: string): void } | undefined;
		(again.ctx as unknown as { ui: Record<string, unknown> }).ui.custom = (factory: (...a: unknown[]) => typeof comp) => {
			comp = factory({ requestRender() {}, terminal: { rows: 40 } }, {}, {}, () => {});
			return new Promise(() => {});
		};
		(again.ctx as unknown as { hasUI: boolean }).hasUI = true;
		await again.start();
		await again.sub("cockpit");
		const t = comp!.render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		comp!.handleInput!("q");
		expect(t).toContain("SEAL PLAN · awaits you");
		expect(t).toContain("Squads: a, b");
	});

	const planStations = () => [
		phase("Muster", ["[captain] Objective", "completed"], ["[captain] Orders", "completed"]),
		phase("Auspex", ["[scout] Map", "completed"]),
		phase("Scriptorium", ["[librarian] Plan", "completed"], ["[seal] Plan", "in_progress"]),
	];
	// The hand-off: only the stations the approval starts; omp starts the first task by itself.
	const handOff = (at: "Deployment" | "Skirmish" = "Deployment") => [
		phase("Deployment", ["[captain] Branch and squads", at === "Deployment" ? "in_progress" : "completed"]),
		phase("Skirmish", ["[battle-brother] Squads", at === "Skirmish" ? "in_progress" : "pending"]),
		phase("Inquisition", ["[inquisitor] Review", "pending"]),
		phase("Extraction", ["[captain] Extract", "pending"]),
		phase("Debrief", ["[captain] Debrief", "pending"]),
	];
	const chronicleOf = (dir: string) =>
		(JSON.parse(readFileSync(join(dir, "runs", "sess-B.cockpit"), "utf8")).chronicle as { text: string }[]).map(e => e.text);

	test("the fresh session never shows a plan-mode station or Muster", async () => {
		const { s, sm, ctx } = await owner();
		await todoResult(s, ctx, "start", [phase("Muster", ["[captain] Objective", "in_progress"])]);
		expect(s.shown()).toContain("Muster › Objective");
		await todoResult(s, ctx, "done", [phase("Muster", ["[captain] Objective", "completed"]), phase("Auspex", ["[scout] Map", "in_progress"])]);
		await todoResult(s, ctx, "done", planStations());
		expect(s.shown()).toContain("seal Plan");
		expect(s.shown()).not.toContain("Deployment");
		await approve(s, sm, ctx);
		for (const word of ["seal Plan", "Scriptorium", "Muster"]) expect(s.shown()).not.toContain(word);
		await todoResult(s, ctx, "init", handOff());
		expect(s.shown()).toContain("Deployment › Branch and squads");
		for (const word of ["Scriptorium", "Muster"]) expect(s.shown()).not.toContain(word);
	});

	test("a hand-off init logs station Deployment once, and a compaction re-init moves nothing", async () => {
		const { s, sm, ctx } = await owner();
		await todoResult(s, ctx, "start", planStations());
		await approve(s, sm, ctx);
		await todoResult(s, ctx, "init", handOff());
		const count = (text: string) => chronicleOf(s.dir).filter(t => t === text).length;
		expect(count("station Deployment")).toBe(1);
		expect(count("station Muster")).toBe(0);
		await todoResult(s, ctx, "done", handOff("Skirmish"));
		expect(s.shown()).toContain("Skirmish");
		// A compaction rebuild shares stations with the current phases: no footer move, no second station entry.
		await todoResult(s, ctx, "init", handOff("Deployment"));
		expect(s.shown()).toContain("Skirmish");
		expect(count("station Deployment")).toBe(1);
	});

	test("a hand-off init logs the Plan grant once and no seal-waiting entry", async () => {
		const { s, sm, ctx } = await owner();
		await todoResult(s, ctx, "start", planStations());
		await approve(s, sm, ctx);
		const count = (text: string) => chronicleOf(s.dir).filter(t => t.includes(text)).length;
		const waiting = count("seal Plan awaits");
		await todoResult(s, ctx, "init", handOff());
		expect(count("Plan granted")).toBe(1);
		expect(count("seal Plan awaits")).toBe(waiting);
		await todoResult(s, ctx, "done", handOff("Skirmish"));
		expect(count("Plan granted")).toBe(1);
	});

	test("a rebuild init while the Plan seal waits (plan-mode compaction) logs no grant", async () => {
		const { s, sm, ctx } = await owner();
		await todoResult(s, ctx, "start", planStations());
		await approve(s, sm, ctx);
		await todoResult(s, ctx, "init", planStations());
		expect(chronicleOf(s.dir).filter(t => t.includes("Plan granted"))).toEqual([]);
	});

	test("an empty init while the Plan seal waits is no hand-off: no grant logged", async () => {
		const { s, sm, ctx } = await owner();
		await todoResult(s, ctx, "start", planStations());
		await approve(s, sm, ctx);
		await todoResult(s, ctx, "init", []);
		expect(chronicleOf(s.dir).filter(t => t.includes("Plan granted"))).toEqual([]);
	});

	test("a rebuild init still logs the seal grant once, and never a seal-waiting entry", async () => {
		const { s, sm, ctx } = await owner();
		await todoResult(s, ctx, "start", [phase("Plan", ["[seal] Plan", "in_progress"])]);
		await approve(s, sm, ctx);
		const chronicle = () =>
			(JSON.parse(readFileSync(join(s.dir, "runs", "sess-B.cockpit"), "utf8")).chronicle as { text: string }[]).map(e => e.text);
		const count = (text: string) => chronicle().filter(t => t.includes(text)).length;
		const waiting = count("seal Plan awaits");
		const init = [phase("Plan", ["[seal] Plan", "completed"]), phase("Muster", ["[captain] Objective", "in_progress"]), phase("Deployment", ["[captain] Branch and squads", "pending"])];
		await todoResult(s, ctx, "init", init);
		expect(count("Plan granted")).toBe(1);
		expect(count("seal Plan awaits")).toBe(waiting);
		const done = [phase("Plan", ["[seal] Plan", "completed"]), phase("Muster", ["[captain] Objective", "completed"]), phase("Deployment", ["[captain] Branch and squads", "in_progress"])];
		await todoResult(s, ctx, "done", done);
		expect(count("Plan granted")).toBe(1);
	});

	test("squads declared in plan mode survive approve and execute", async () => {
		const { s, sm, ctx } = await owner();
		const slices = [{ id: "S1", parallel: false, files: ["a.ts"] }];
		expect(await s.call({ action: "slices", slices })).toContain("SQUADS S1");
		await approve(s, sm, ctx);
		expect(movedRun(s.dir).slices).toEqual(slices);
		expect(((await s.handlers.before_subagent_spawn[0]({ agent: "battle-brother" }, ctx)) as { block?: true } | undefined)?.block).toBeUndefined();
	});

	test("booking and the archmagos mark recorded in plan mode survive the switch", async () => {
		process.env.STRATEGIUM_ARCHMAGOS = "1";
		const { s, sm, ctx, notes } = await owner();
		await s.call({ action: "begin", key: "K-1", booked: 60, archmagos: true });
		await approve(s, sm, ctx);
		expect(movedRun(s.dir).archmagos).toBe(true);
		await s.commands["strategium-status"].handler("", ctx);
		expect(notes.at(-1)).toContain("K-1 0/60 min");
		expect(notes.at(-1)).toMatch(/^RUN K-1 .* \(this session\)$/m);
	});

	test("the first init of a run still shows its first station", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		s.start();
		await todoResult(s, s.ctx, "init", [phase("Muster", ["[captain] Objective", "in_progress"], ["[captain] Orders", "pending"])]);
		expect(s.shown()).toContain("Muster › Objective");
		const cockpit = JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.cockpit"), "utf8"));
		expect(cockpit.chronicle.map((e: { text: string }) => e.text)).toContain("station Muster");
	});

	test.each(["resume", "fork"])("a %s with a review open moves nothing", async reason => {
		const { s, sm, ctx } = await owner();
		await emit(s, "plan_review_requested", { sessionId: "sess-A" }, ctx);
		sm.sid = "sess-B";
		await emit(s, "session_switch", { reason }, ctx);
		expect(readFileSync(lockPath(s.dir, "K-1"), "utf8")).toBe("sess-A");
		expect(files(s.dir, "sess-A").run).toBe(true);
		expect(files(s.dir, "sess-B").run).toBe(false);
	});

	test("a new session that already has a run keeps its own", async () => {
		const { s, sm, ctx } = await owner();
		const other = setup("sess-B", s.dir);
		await other.call({ action: "begin", key: "K-2" });
		const kept = JSON.parse(readFileSync(join(s.dir, "runs", "sess-B.json"), "utf8"));
		await emit(s, "plan_review_requested", { sessionId: "sess-A" }, ctx);
		sm.sid = "sess-B";
		await emit(s, "session_switch", { reason: "new" }, ctx);
		expect(JSON.parse(readFileSync(join(s.dir, "runs", "sess-B.json"), "utf8"))).toEqual(kept);
		expect(kept).toMatchObject({ key: "K-2", sid: "sess-B" });
		expect(readFileSync(lockPath(s.dir, "K-1"), "utf8")).toBe("sess-A");
		expect(files(s.dir, "sess-A").run).toBe(true);
	});

	test("a plain /new leaves the run with its session", async () => {
		const { s, sm, ctx } = await owner();
		sm.sid = "sess-B";
		await emit(s, "session_switch", { reason: "new" }, ctx);
		expect(readFileSync(lockPath(s.dir, "K-1"), "utf8")).toBe("sess-A");
		expect(files(s.dir, "sess-A").run).toBe(true);
		expect(files(s.dir, "sess-B").run).toBe(false);
		expect(s.activeTools()).toContain("edit");
	});

	test("a review closed in place does not move a later /new", async () => {
		const { s, sm, ctx } = await owner();
		await emit(s, "plan_review_requested", { sessionId: "sess-A" }, ctx);
		await emit(s, "plan_review_resolved", { sessionId: "sess-A", choice: "keep" }, ctx);
		sm.sid = "sess-B";
		await emit(s, "session_switch", { reason: "new" }, ctx);
		expect(readFileSync(lockPath(s.dir, "K-1"), "utf8")).toBe("sess-A");
		expect(files(s.dir, "sess-B").run).toBe(false);
	});

	test("a review in a session without a run moves nothing and hides nothing", async () => {
		const s = setup("sess-A");
		const { sm, ctx } = shared("sess-A", s.dir, s.footer);
		await s.handlers.session_start[0]({}, ctx);
		await emit(s, "plan_review_requested", { sessionId: "sess-A" }, ctx);
		await emit(s, "plan_review_resolved", { sessionId: "sess-A", choice: "execute" }, ctx);
		sm.sid = "sess-B";
		await emit(s, "session_switch", { reason: "new" }, ctx);
		await emit(s, "before_agent_start", { prompt: "plan approved" }, ctx);
		expect(files(s.dir, "sess-B").run).toBe(false);
		expect(existsSync(lockPath(s.dir, "K-1"))).toBe(false);
		expect(s.activeTools()).toContain("edit");
	});

	test("a claim error during the move does not break the session switch", async () => {
		const { s, sm, ctx, notes } = await owner();
		await emit(s, "plan_review_requested", { sessionId: "sess-A" }, ctx);
		await s.commands["strategium-config"].handler("archmagos on", ctx);
		await emit(s, "plan_review_resolved", { sessionId: "sess-A", choice: "execute" }, ctx);
		// Another session is taking the key over right now: a fresh takeover guard makes claim throw while sess-A still holds the lock.
		writeFileSync(`${lockPath(s.dir, "K-1")}.force`, `sess-X ${Date.now()}`);
		sm.sid = "sess-B";
		await emit(s, "session_switch", { reason: "new" }, ctx);
		expect(readFileSync(lockPath(s.dir, "K-1"), "utf8")).toBe("sess-A");
		const cfg = async (sid: string) => {
			sm.sid = sid;
			await s.commands["strategium-config"].handler("", ctx);
			return notes.at(-1) ?? "";
		};
		expect(await cfg("sess-B")).toContain("archmagos: off (STRATEGIUM_ARCHMAGOS)");
		expect(await cfg("sess-A")).toContain("archmagos: on (this session)");
		// The switch did not throw, and nothing moved to the new session.
		expect(files(s.dir, "sess-B").run).toBe(false);
	});

	test("an approval that never opened a new session does not move a later /new", async () => {
		const { s, sm, ctx } = await owner();
		await emit(s, "plan_review_requested", { sessionId: "sess-A" }, ctx);
		await emit(s, "plan_review_resolved", { sessionId: "sess-A", choice: "execute" }, ctx);
		await emit(s, "before_agent_start", { prompt: "plan approved" }, ctx);
		sm.sid = "sess-B";
		await emit(s, "session_switch", { reason: "new" }, ctx);
		expect(readFileSync(lockPath(s.dir, "K-1"), "utf8")).toBe("sess-A");
		expect(files(s.dir, "sess-B").run).toBe(false);
	});

	test("closing a plan review hides edit again", async () => {
		const { s, ctx } = await owner();
		s.setActive([...s.activeTools(), "edit", "ast_edit"]);
		await emit(s, "plan_review_resolved", { sessionId: "sess-A", choice: "keep" }, ctx);
		expect(s.activeTools()).not.toContain("edit");
		expect(s.activeTools()).not.toContain("ast_edit");
		expect(JSON.parse(readFileSync(join(s.dir, "runs", "sess-A.json"), "utf8")).hidden).toEqual(expect.arrayContaining(["edit", "ast_edit"]));
	});

	test("closing a review keeps the tools the run already hid when the host restored none", async () => {
		const { s, ctx } = await owner();
		await emit(s, "plan_review_resolved", { sessionId: "sess-A", choice: "keep" }, ctx);
		expect(JSON.parse(readFileSync(join(s.dir, "runs", "sess-A.json"), "utf8")).hidden).toEqual(["edit"]);
	});

	test("a sub-agent cannot open a review", async () => {
		const { s, sm, ctx } = await owner();
		await emit(s, "plan_review_requested", { sessionId: "sess-A" }, { ...ctx, agent: { kind: "sub" } });
		sm.sid = "sess-B";
		await emit(s, "session_switch", { reason: "new" }, ctx);
		expect(readFileSync(lockPath(s.dir, "K-1"), "utf8")).toBe("sess-A");
		expect(files(s.dir, "sess-B").run).toBe(false);
	});

	test("a sub-agent cannot close a review: no tools hidden, the review stays open", async () => {
		const { s, sm, ctx } = await owner();
		await emit(s, "plan_review_requested", { sessionId: "sess-A" }, ctx);
		s.setActive([...s.activeTools(), "edit"]);
		await emit(s, "plan_review_resolved", { sessionId: "sess-A", choice: "keep" }, { ...ctx, agent: { kind: "sub" } });
		expect(s.activeTools()).toContain("edit");
		sm.sid = "sess-B";
		await emit(s, "session_switch", { reason: "new" }, ctx);
		expect(readFileSync(lockPath(s.dir, "K-1"), "utf8")).toBe("sess-B");
	});

	test("every per-session setting moves with an approved plan and leaves the old session id", async () => {
		const s = setup("sess-A");
		await s.call({ action: "begin", key: "K-1" });
		const notes: string[] = [];
		const { sm, ctx } = shared("sess-A", s.dir, s.footer, notes);
		await s.handlers.session_start[0]({}, ctx);
		const config = (args = "") => s.commands["strategium-config"].handler(args, ctx);
		for (const a of ["notify off", "sound off", "toast off", "volume 40", "idle 7", "archmagos on", "commit on"]) await config(a);
		await s.handlers.plan_review_requested[0]({ sessionId: "sess-A" }, ctx);
		await s.handlers.plan_review_resolved[0]({ sessionId: "sess-A", choice: "execute" }, ctx);
		sm.sid = "sess-B";
		await s.handlers.session_switch[0]({ reason: "new" }, ctx);
		const mine = ["notify: off", "sound: off", "volume: 40", "toast: off", "idle: 7 min", "archmagos: on", "commit: on"];
		await config();
		for (const l of mine) expect(notes.at(-1)).toContain(`${l} (this session)`);
		sm.sid = "sess-A";
		await config();
		const old = notes.at(-1) ?? "";
		expect(old).not.toContain("(this session)");
		expect(old).toMatch(/volume: \d+ \(default\)/);
		for (const l of [
			"notify: on (STRATEGIUM_NOTIFY)",
			"sound: on (STRATEGIUM_SOUND)",
			"toast: on (STRATEGIUM_TOAST)",
			"idle: 3 min (STRATEGIUM_IDLE_MIN)",
			"archmagos: off (STRATEGIUM_ARCHMAGOS)",
			"commit: off (STRATEGIUM_COMMIT)",
		])
			expect(old).toContain(l);
		sm.sid = "sess-B";
		await config();
		for (const l of mine) expect(notes.at(-1)).toContain(`${l} (this session)`);
	});
});

describe("the bundled alarm", () => {
	test("attention with channels on names them and spawns the bundled vox with the current bun", async () => {
		const { call } = setup();
		expect(await call({ action: "attention", message: "seal ready" })).toBe("ATTENTION seal ready (sound, toast)");
		const vox = join(import.meta.dir, "../../alarm/vox.ts");
		expect(alarm.calls.map(c => c.cmd)).toEqual([[process.execPath, vox]]);
		expect(existsSync(vox)).toBe(true);
		// omp.exe is a compiled Bun binary: without BUN_BE_BUN it would run the omp CLI instead of vox.ts.
		expect(alarm.calls[0].env.BUN_BE_BUN).toBe("1");
	});

	test("a rejecting exited or a throwing notify never escapes as an unhandled rejection", async () => {
		const seen: unknown[] = [];
		const on = (e: unknown) => seen.push(e);
		process.on("unhandledRejection", on);
		try {
			const s = setup();
			alarm.impl = () => ({ exited: Promise.reject(new Error("boom")), unref() {} });
			await s.call({ action: "attention", message: "one" });
			exitAlarm(1);
			(s.ctx as unknown as { ui: { notify: () => void } }).ui.notify = () => {
				throw new Error("stale ctx");
			};
			await s.call({ action: "attention", message: "two" });
			await Bun.sleep(30);
		} finally {
			process.off("unhandledRejection", on);
		}
		expect(seen).toEqual([]);
	});

	test("a vox that exits non-zero is reported once per session, each session in turn", async () => {
		const a = setup("sess-0001");
		exitAlarm(1);
		await a.call({ action: "attention", message: "one" });
		await a.call({ action: "attention", message: "two" });
		await Bun.sleep(20);
		expect(a.notes.filter(n => n.includes("exited with code 1"))).toHaveLength(1);
		// The same extension instance, another session id: the warned set is per session, not global.
		a.ctx.sessionManager = { getSessionId: () => "sess-0002" };
		exitAlarm(1);
		await a.call({ action: "attention", message: "three" });
		await Bun.sleep(20);
		expect(a.notes.filter(n => n.includes("exited with code 1"))).toHaveLength(2);
	});

	test("a vox that exits 0 reports nothing", async () => {
		const s = setup();
		await s.call({ action: "attention", message: "one" });
		await Bun.sleep(20);
		expect(s.notes).toEqual([]);
	});

	test("notify off, or sound and toast off, spawn nothing", async () => {
		const s = setup();
		await s.call({ action: "notify", on: false });
		await s.call({ action: "attention", message: "one" });
		await s.call({ action: "notify", on: true });
		await s.sub("config", "sound off");
		await s.sub("config", "toast off");
		await s.call({ action: "attention", message: "two" });
		expect(alarm.calls).toEqual([]);
	});

	test("the config output has no alarm-command line", async () => {
		const s = setup();
		await s.sub("config");
		expect(s.notes.join("\n")).not.toMatch(/\balarm:|_ALARM/);
	});
});

// A block still open at midnight goes on in the new day, split at 00:00.
describe("the midnight rollover", () => {
	const T = (h: number, m: number, s = 0, day = 16) => new Date(2026, 10, day, h, m, s);
	const dayEvents = (dir: string, day = 16) => load(join(dir, `2026-11-${day}.jsonl`));
	const at = async (s: ReturnType<typeof setup>, h: number, m: number, sec = 0, day = 16) => {
		setSystemTime(T(h, m, sec, day));
		await s.sub("status");
	};
	// Ticks every 2 minutes (under the 3-minute heartbeat gap) from 23:31 to 23:59, then 00:01 on the 17th.
	const toMidnight = async (s: ReturnType<typeof setup>) => {
		for (let m = 31; m < 60; m += 2) await at(s, 23, m);
		await at(s, 0, 1, 0, 17);
	};
	const midnight = nowIso(T(0, 0, 0, 17));
	const reports = async (s: ReturnType<typeof setup>, today: string) => {
		expect(await s.call({ action: "report", date: "2026-11-16" })).toContain("K-1 23:30-00:00 (30 min)");
		expect(await s.call({ action: "report" })).toContain(today);
	};

	test("an untimed run counting at midnight goes on in the new day", async () => {
		const s = setup();
		setSystemTime(T(23, 30));
		await s.call({ action: "begin", key: "K-1" });
		await s.start();
		await toMidnight(s);
		expect(dayEvents(s.dir).at(-1)).toEqual({ ts: midnight, event: "stop", key: "K-1" });
		expect(dayEvents(s.dir, 17)).toEqual([{ ts: midnight, event: "start", key: "K-1" }]);
		expect(await s.call({ action: "status" })).toContain("K-1 1 min (no booking) running");
		await at(s, 0, 3, 0, 17);
		expect(await s.call({ action: "status" })).toContain("K-1 3 min (no booking) running");
		expect(s.shown()).toContain("K-1 · 3 min");
		expect(dayEvents(s.dir, 17).filter(e => e.event === "start").length).toBe(1);
		await reports(s, "K-1 00:00-now (3 min)");
	});

	test("a timed run counting at midnight counts unbooked until resume gives today's booking", async () => {
		const s = setup();
		setSystemTime(T(23, 30));
		await s.call({ action: "begin", key: "K-1", booked: 120 });
		await s.start();
		await toMidnight(s);
		expect(dayEvents(s.dir, 17)[0]).toEqual({ ts: midnight, event: "start", key: "K-1" });
		await at(s, 0, 3, 0, 17);
		expect(s.shown()).toContain("3 min · new day: /strategium-resume <min>");
		expect(s.shown().startsWith("●")).toBe(true);
		expect(dayEvents(s.dir, 17).some(e => e.event === "alert")).toBe(false);
		await s.sub("resume", "90");
		expect(s.notes.at(-1)).toBe("Strategium: new shift for K-1 today, booked 90 min");
		expect(await s.call({ action: "status" })).toContain("K-1 3/90 min (3%) running");
		await reports(s, "K-1 00:00-now (3 min)");
	});

	test.each([undefined, 120])("a paused run opens nothing at midnight (booked %p)", async booked => {
		const s = setup();
		setSystemTime(T(23, 30));
		await s.call({ action: "begin", key: "K-1", ...(booked ? { booked } : {}) });
		await s.start();
		await at(s, 23, 32);
		await s.call({ action: "stop" });
		await at(s, 0, 1, 0, 17);
		expect(dayEvents(s.dir, 17)).toEqual([]);
		expect(dayEvents(s.dir).filter(e => e.event === "stop")).toEqual([{ ts: nowIso(T(23, 32)), event: "stop", key: "K-1" }]);
		expect(s.shown().startsWith("○")).toBe(true);
	});

	test("an idle pause stamped before midnight and noticed after it opens nothing", async () => {
		const s = setup();
		setSystemTime(T(23, 56, 30));
		await s.call({ action: "begin", key: "K-1" });
		s.ctx.host.idle = true;
		await s.start();
		await at(s, 23, 58, 30);
		await at(s, 0, 0, 30, 17);
		expect(dayEvents(s.dir).at(-1)).toEqual({ ts: nowIso(T(23, 59, 30)), event: "stop", key: "K-1", reason: "idle" } as Ev);
		expect(dayEvents(s.dir, 17)).toEqual([]);
	});
});

// A reload of omp closes the session and opens it again: the run goes on by itself, unless the user stopped it.
describe("resume after a reload", () => {
	const reload = async (s: { handlers: Record<string, ((e: unknown, ctx: unknown) => unknown)[]>; ctx: unknown }) => {
		await s.handlers.session_shutdown[0]({}, s.ctx);
		await s.handlers.session_start[0]({}, s.ctx);
	};

	test("a run closed by the shutdown runs again on start", async () => {
		const s = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await s.call({ action: "begin", key: "dark-mode" });
		setSystemTime(new Date(2026, 10, 16, 9, 1, 0));
		await reload(s);
		expect(await s.call({ action: "status" })).toContain("dark-mode 1 min (no booking) running");
		expect(s.shown()).not.toContain("paused");
	});

	test("a run the user paused stays paused", async () => {
		const s = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await s.call({ action: "begin", key: "dark-mode" });
		await s.sub("pause");
		await reload(s);
		expect(await s.call({ action: "status" })).toContain("stopped");
		expect(s.shown()).toContain("paused");
	});

	test("a session that died while running resumes, the silent time stays unworked", async () => {
		const s = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await s.call({ action: "begin", key: "dark-mode" });
		setSystemTime(new Date(2026, 10, 16, 10, 0, 0));
		await s.handlers.session_start[0]({}, s.ctx);
		expect(await s.call({ action: "status" })).toContain("running");
		expect(s.shown()).not.toContain("paused");
		// The block closed at the last heartbeat (09:00): the hour away is not counted.
		expect(await s.call({ action: "status" })).toContain("dark-mode 0 min");
	});

	test("a new day without a booking stays paused and says what is needed", async () => {
		const s = setup();
		setSystemTime(new Date(2026, 10, 15, 23, 30, 0));
		await s.call({ action: "begin", key: "K-1", booked: 120 });
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await s.handlers.session_start[0]({}, s.ctx);
		expect(s.notes).toContain("Strategium: K-1 needs today's booking; /strategium-resume <min>");
		expect(s.shown()).toContain("new day: /strategium-resume");
	});

	test("the new-day prompt defers to the theatre's Muster for a day without booking", async () => {
		const s = setup();
		setSystemTime(new Date(2026, 10, 15, 23, 30, 0));
		await s.call({ action: "begin", key: "K-1", booked: 120, theatre: "github" });
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await s.handlers.session_start[0]({}, s.ctx);
		await s.sub("resume");
		expect(s.sent.at(-1)).toContain("including what to do when it is not booked today");
		expect(s.sent.at(-1)).not.toContain("tell me and stop");
	});

	test("an untimed run shut down yesterday runs again today", async () => {
		const s = setup();
		setSystemTime(new Date(2026, 10, 15, 23, 30, 0));
		await s.call({ action: "begin", key: "dark-mode" });
		setSystemTime(new Date(2026, 10, 15, 23, 40, 0));
		await s.handlers.session_shutdown[0]({}, s.ctx);
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await s.handlers.session_start[0]({}, s.ctx);
		expect(await s.call({ action: "status" })).toContain("dark-mode 0 min (no booking) running");
	});

	test("a timed run shut down yesterday stays paused and says what is needed", async () => {
		const s = setup();
		setSystemTime(new Date(2026, 10, 15, 23, 30, 0));
		await s.call({ action: "begin", key: "K-1", booked: 120 });
		setSystemTime(new Date(2026, 10, 15, 23, 40, 0));
		await s.handlers.session_shutdown[0]({}, s.ctx);
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await s.handlers.session_start[0]({}, s.ctx);
		expect(s.notes).toContain("Strategium: K-1 needs today's booking; /strategium-resume <min>");
		expect(s.shown()).toContain("new day: /strategium-resume");
	});

	test("the mark is spent: a pause after the resume survives the next reload", async () => {
		const s = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await s.call({ action: "begin", key: "dark-mode" });
		await reload(s);
		await s.sub("pause");
		await reload(s);
		expect(await s.call({ action: "status" })).toContain("stopped");
	});

	test("a run the user paused before the shutdown is not marked for resume", async () => {
		const s = setup();
		setSystemTime(new Date(2026, 10, 15, 23, 30, 0));
		await s.call({ action: "begin", key: "dark-mode" });
		await s.sub("pause");
		await s.handlers.session_shutdown[0]({}, s.ctx);
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await s.handlers.session_start[0]({}, s.ctx);
		expect(await s.call({ action: "status" })).not.toContain("running");
	});
});

// What the first version of S1 left unproven: each test below was seen red against the bug or a mutant of it.
describe("tools, begin and end", () => {
	const FULL = ["read", "bash", "edit", "write", "task"];
	const sorted = (a: string[]) => [...a].sort();

	test("end restores exactly the hidden tools and keeps the others", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "end" });
		expect(sorted(s.activeTools())).toEqual(sorted(FULL));
	});

	test("restoring a tool that is already active adds no duplicate", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		s.setActive([...s.activeTools(), "edit"]);
		await s.call({ action: "end" });
		expect(s.activeTools().filter(n => n === "edit")).toHaveLength(1);
	});

	test("ast_edit and the underscored names are hidden and restored", async () => {
		const s = setup();
		const all = ["read", "_edit", "_ast_edit", "ast_edit", "bash"];
		s.setActive(all);
		await s.call({ action: "begin", key: "K-1" });
		expect(s.activeTools()).toEqual(["read", "bash"]);
		await s.call({ action: "end" });
		expect(sorted(s.activeTools())).toEqual(sorted(all));
	});

	test("a reload hides the tools again for a run that is still ours", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		s.setActive(FULL);
		await s.handlers.session_start[0]({}, s.ctx);
		expect(s.activeTools()).toEqual(["read", "bash", "write", "task"]);
	});

	test("a reload leaves the tools alone when the run is gone", async () => {
		const s = setup();
		await s.handlers.session_start[0]({}, s.ctx);
		expect(s.activeTools()).toEqual(FULL);
	});

	test("a second begin under another key still restores the tools at the end", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "begin", key: "K-2" });
		await s.call({ action: "end" });
		expect(sorted(s.activeTools())).toEqual(sorted(FULL));
	});

	test("ending another session's run fails and neither restores tools nor plays the theme", async () => {
		const a = setup("sess-0001");
		await a.call({ action: "begin", key: "K-1" });
		const b = setup("sess-0002", a.dir);
		await b.call({ action: "begin", key: "K-2" });
		failAlarm();
		expect(await b.call({ action: "end", key: "K-1" })).toBe("ERROR K-1 belongs to session ess-0001; end it there, or take it over with that id");
		expect(b.activeTools()).toEqual(["read", "bash", "write", "task"]);
		expect(b.notes).toEqual([]);
	});

	test("a takeover end from a session without a run plays nothing and restores nothing", async () => {
		const a = setup("sess-0001");
		await a.call({ action: "begin", key: "K-1" });
		const c = setup("sess-0003", a.dir);
		failAlarm();
		expect(await c.call({ action: "end", key: "K-1", takeover: "sess-0001" })).toBe("ENDED K-1");
		expect(c.activeTools()).toEqual(FULL);
		expect(c.notes).toEqual([]);
	});

	test("an end without a run says so and plays nothing", async () => {
		const s = setup();
		failAlarm();
		expect(await s.call({ action: "end" })).toBe("ERROR no run to end in this session");
		expect(s.notes).toEqual([]);
	});

	test("a theme that cannot start is reported, and the run is still ended", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		failAlarm();
		expect(await s.call({ action: "end" })).toBe("ENDED K-1");
		expect(s.notes).toEqual([expect.stringMatching(/^Strategium: the alarm failed: /)]);
	});

	describe("a second begin on the same key", () => {
		const disjoint = [
			{ id: "S1", parallel: true, files: ["a.ts"] },
			{ id: "S2", parallel: true, files: ["b.ts"] },
		];
		const brothers = (n: number) => ({ tasks: Array.from({ length: n }, () => ({ agent: "battle-brother" })) });

		test("keeps hidden, repo, squads and launched", async () => {
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			await s.call({ action: "repo", repo: s.dir });
			await s.call({ action: "slices", slices: disjoint });
			expect(s.handlers.tool_call[0]({ toolName: "task", input: brothers(2) }, s.ctx)).toBeUndefined();
			await s.call({ action: "begin", key: "K-1" });
			expect(await s.call({ action: "status" })).toContain(`repo=${s.dir}`);
			expect((s.handlers.before_subagent_spawn[0]({ agent: "battle-brother" }, s.ctx) as { block?: true } | undefined)?.block).toBeUndefined();
			// launched survived: a single battle-brother is no longer refused.
			expect(s.handlers.tool_call[0]({ toolName: "task", input: brothers(1) }, s.ctx)).toBeUndefined();
			await s.call({ action: "end" });
			expect(sorted(s.activeTools())).toEqual(sorted(FULL));
		});

		test("an untimed run begun again with a booking is timed", async () => {
			const s = setup();
			setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
			await s.call({ action: "begin", key: "K-1" });
			const stored = () => JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8"));
			expect(stored().untimed).toBe(true);
			await s.call({ action: "begin", key: "K-1", booked: 120, spent: 30 });
			expect(stored().untimed).toBeUndefined();
			expect(stored().key).toBe("K-1");
			// The minutes already worked count toward the booking, and every reader sees it.
			expect(await s.call({ action: "status" })).toContain("K-1 30/120 min (25%) running");
			expect(await s.call({ action: "report" })).toContain("PRIOR K-1 30 min");
			await s.start();
			expect(s.shown()).toContain("30/120 min");
			expect(s.shown()).not.toContain("new day");
			await s.call({ action: "begin", key: "K-1", booked: 120 });
			expect(load(join(s.dir, "2026-11-16.jsonl")).filter(e => e.event === "start" && e.booked !== undefined)).toHaveLength(1);
		});

		test("begun again on a timed key without a booking, the day file keeps its events", async () => {
			const s = setup();
			setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
			await s.call({ action: "begin", key: "K-1", booked: 120 });
			const file = join(s.dir, "2026-11-16.jsonl");
			const before = load(file);
			await s.call({ action: "begin", key: "K-1" });
			expect(load(file)).toEqual(before);
			expect(await s.call({ action: "status" })).toContain("/120 min");
		});

		test("begun again on an open key with spent and no new booking appends an adjust", async () => {
			const s = setup();
			setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
			await s.call({ action: "begin", key: "K-1", booked: 120 });
			await s.call({ action: "begin", key: "K-1", spent: 30 });
			expect(load(join(s.dir, "2026-11-16.jsonl")).filter(e => e.event === "adjust")).toEqual([expect.objectContaining({ key: "K-1", prior: 30 })]);
			expect(await s.call({ action: "status" })).toContain("K-1 30/120 min");
			expect(await s.call({ action: "report" })).toContain("ADJUST K-1 30 min");
		});

		test("a takeover adopts the repo of the run it replaces", async () => {
			const a = setup("sess-0001");
			await a.call({ action: "begin", key: "K-1" });
			await a.call({ action: "repo", repo: a.dir });
			const b = setup("sess-0002", a.dir);
			await b.call({ action: "begin", key: "K-1", takeover: "sess-0001" });
			expect(await b.call({ action: "status" })).toContain(`repo=${a.dir}`);
		});
	});
});

describe("the Captain's hooks never throw and keep their wording", () => {
	const ROSTER = ["scout", "librarian", "archmagos", "battle-brother", "veteran", "apothecary", "inquisitor", "confessor", "security-reviewer", "sonic", "task"];
	type Verdict = { block?: true; reason?: string } | undefined;
	const disjoint = [
		{ id: "S1", parallel: true, files: ["a.ts"] },
		{ id: "S2", parallel: true, files: ["b.ts"] },
	];
	const brothers = (n: number) => ({ tasks: Array.from({ length: n }, () => ({ agent: "battle-brother" })) });
	async function run(slices?: unknown[]) {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "repo", repo: s.dir });
		if (slices) await s.call({ action: "slices", slices });
		const tool = (toolName: string, input: unknown, ctx: unknown = s.ctx) => s.handlers.tool_call[0]({ toolName, input }, ctx) as Verdict;
		const spawn = (agent: unknown, ctx: unknown = s.ctx) => s.handlers.before_subagent_spawn[0]({ agent }, ctx) as Verdict;
		return { s, tool, spawn };
	}

	test("two single calls stay refused: launched is only set by a call that passes", async () => {
		const { tool } = await run(disjoint);
		expect(tool("task", brothers(1))?.block).toBe(true);
		expect(tool("task", brothers(1))?.block).toBe(true);
	});

	test("a sequential squad is not counted as parallel", async () => {
		const { tool } = await run([disjoint[0], { id: "S2", parallel: false, files: ["b.ts"] }]);
		expect(tool("task", brothers(1))).toBeUndefined();
	});

	test("the single form of task is judged like a batch item", async () => {
		const none = await run();
		expect(none.tool("task", { agent: "battle-brother", task: "x" })?.reason).toContain("declare the plan's squads first");
		const two = await run(disjoint);
		expect(two.tool("task", { agent: "battle-brother", task: "x" })?.reason).toContain("launch every parallel squad (S1, S2)");
		expect(two.tool("task", { agent: "scout", task: "x" })).toBeUndefined();
	});

	test("declaring the squads again resets the launch", async () => {
		const { s, tool } = await run(disjoint);
		expect(tool("task", brothers(2))).toBeUndefined();
		expect(tool("task", brothers(1))).toBeUndefined();
		await s.call({ action: "slices", slices: disjoint });
		expect(tool("task", brothers(1))?.block).toBe(true);
	});

	test("a battle-brother spawn passes while the run has no repo, and agent names are normalised", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		const spawn = (agent: unknown) => s.handlers.before_subagent_spawn[0]({ agent }, s.ctx) as Verdict;
		expect(spawn("battle-brother")?.block).toBeUndefined();
		await s.call({ action: "repo", repo: s.dir });
		for (const name of ["battle-brother", "Battle-Brother", "omp:battle-brother", "x/battle-brother"])
			expect(spawn(name)?.reason).toContain("declare the plan's squads first");
		expect(spawn("x/scout")).toBeUndefined();
		expect(spawn("OMP:Sonic")).toBeUndefined();
	});

	test("the Review & merge reviewers pass during a run and reviewer is refused", async () => {
		const { spawn } = await run(disjoint);
		expect(spawn("inquisitor")).toBeUndefined();
		expect(spawn("confessor")).toBeUndefined();
		expect(spawn("reviewer")?.reason).toContain("during a run only these agents may be spawned");
	});

	test("the whole roster passes, anything else is refused with the roster in the reason", async () => {
		const { spawn } = await run(disjoint);
		// The archmagos has its own guards (setting, mark, librarians, budget): see "the archmagos guard".
		for (const name of ROSTER.filter(n => n !== "archmagos")) expect(spawn(name)?.block).toBeUndefined();
		expect(spawn("code-reviewer")).toEqual({
			block: true,
			reason: `Strategium: during a run only these agents may be spawned: ${ROSTER.join(", ")}.`,
		});
	});

	test("sub-agents and a context without a session are not judged", async () => {
		const { s, spawn, tool } = await run();
		const sub = { ...s.ctx, agent: { kind: "sub" } };
		expect(spawn("code-reviewer", sub)).toBeUndefined();
		expect(tool("bash", { command: "bun test" }, sub)).toBeUndefined();
		expect(spawn("code-reviewer", { agent: { kind: "main" } })).toBeUndefined();
		expect(spawn("code-reviewer")?.block).toBe(true);
	});

	test("ast_edit is refused for the Captain", async () => {
		const { tool } = await run();
		expect(tool("ast_edit", {})?.reason).toContain("does not edit repository files");
	});

	test("odd input never throws", async () => {
		const { tool } = await run(disjoint);
		expect(tool("bash", { command: 123 })).toBeUndefined();
		expect(tool("bash", undefined)).toBeUndefined();
		expect(tool("task", { tasks: [null] })).toBeUndefined();
		expect(tool("task", { tasks: "x" })).toBeUndefined();
		expect(tool("task", null)).toBeUndefined();
		expect(tool("write", undefined)).toBeUndefined();
		expect(tool("write", null)).toBeUndefined();
		expect(tool("edit", undefined)).toBeUndefined();
	});
});

describe("the archmagos setting", () => {
	const runOf = (dir: string) => JSON.parse(readFileSync(join(dir, "runs", "sess-0001.json"), "utf8"));

	test("off by default; STRATEGIUM_ARCHMAGOS turns it on (1, true, on, yes) and status reports it", async () => {
		const s = setup();
		expect(await s.call({ action: "status" })).toContain("ARCHMAGOS off (STRATEGIUM_ARCHMAGOS)\n");
		await s.call({ action: "begin", key: "K-1" });
		expect(await s.call({ action: "status" })).toContain("ARCHMAGOS off (STRATEGIUM_ARCHMAGOS)\n");
		for (const v of ["1", "true", "on", "YES", " 1 "]) {
			process.env.STRATEGIUM_ARCHMAGOS = v;
			expect(await s.call({ action: "status" })).toContain("ARCHMAGOS on (STRATEGIUM_ARCHMAGOS)\n");
		}
		process.env.STRATEGIUM_ARCHMAGOS = "0";
		expect(await s.call({ action: "status" })).toContain("ARCHMAGOS off (STRATEGIUM_ARCHMAGOS)\n");
		// Also with no run at all.
		const bare = setup("sess-0002");
		process.env.STRATEGIUM_ARCHMAGOS = "1";
		expect(await bare.call({ action: "status" })).toContain("ARCHMAGOS on (STRATEGIUM_ARCHMAGOS)\n");
	});

	test("STRATEGIUM_ARCHMAGOS only turns on for a whole word, not a part of one", async () => {
		const s = setup();
		for (const v of ["xon", "maybe-yes", "10", "1x", "yesno"]) {
			process.env.STRATEGIUM_ARCHMAGOS = v;
			expect(await s.call({ action: "status" })).toContain("ARCHMAGOS off (STRATEGIUM_ARCHMAGOS)\n");
		}
	});

	test("/strategium-config archmagos on wins over STRATEGIUM_ARCHMAGOS=0, for this session only", async () => {
		process.env.STRATEGIUM_ARCHMAGOS = "0";
		const s = setup();
		await s.sub("config", "archmagos on");
		expect(s.notes.at(-1)).toContain("archmagos: on (this session)");
		expect(await s.call({ action: "status" })).toContain("ARCHMAGOS on (this session)\n");
		const n: string[] = [];
		await s.commands["strategium-config"].handler("", shared("sess-0002", s.dir, s.footer, n).ctx);
		expect(n.at(-1)).toContain("archmagos: off (STRATEGIUM_ARCHMAGOS)");
		// Off wins over the env too, and a bad value is refused with the full usage.
		process.env.STRATEGIUM_ARCHMAGOS = "1";
		await s.sub("config", "archmagos off");
		expect(s.notes.at(-1)).toContain("archmagos: off (this session)");
		await s.sub("config", "archmagos maybe");
		expect(s.notes.at(-1)).toContain("config takes notify on|off or idle <min>, or archmagos on|off");
	});

	test("the archmagos setting follows an approved plan to the new session", async () => {
		const s = setup("sess-A");
		await s.call({ action: "begin", key: "K-1" });
		const notes: string[] = [];
		const { sm, ctx } = shared("sess-A", s.dir, s.footer, notes);
		await s.handlers.session_start[0]({}, ctx);
		await s.commands["strategium-config"].handler("archmagos on", ctx);
		await s.handlers.plan_review_requested[0]({ sessionId: "sess-A" }, ctx);
		await s.handlers.plan_review_resolved[0]({ sessionId: "sess-A", choice: "execute" }, ctx);
		sm.sid = "sess-B";
		await s.handlers.session_switch[0]({ reason: "new" }, ctx);
		await s.commands["strategium-config"].handler("", ctx);
		expect(notes.at(-1)).toContain("archmagos: on (this session)");
		expect(notes.at(-1)).toContain("commit: off (STRATEGIUM_COMMIT)");
		sm.sid = "sess-A";
		await s.commands["strategium-config"].handler("", ctx);
		expect(notes.at(-1)).toContain("archmagos: off (STRATEGIUM_ARCHMAGOS)");
	});

	test("begin archmagos: true marks the run, a same-key begin keeps it, archmagos: false clears it", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		expect(runOf(s.dir).archmagos).toBeUndefined();
		await s.call({ action: "begin", key: "K-1", archmagos: true });
		expect(runOf(s.dir).archmagos).toBe(true);
		await s.call({ action: "begin", key: "K-1" });
		expect(runOf(s.dir).archmagos).toBe(true);
		await s.call({ action: "begin", key: "K-1", archmagos: false });
		expect(runOf(s.dir).archmagos).toBeUndefined();
	});
});

describe("the commit setting", () => {
	test("off by default; STRATEGIUM_COMMIT turns it on (1, true, on, yes) and status reports it", async () => {
		const s = setup();
		expect(await s.call({ action: "status" })).toContain("COMMIT off (STRATEGIUM_COMMIT)\n");
		await s.call({ action: "begin", key: "K-1" });
		expect(await s.call({ action: "status" })).toContain("COMMIT off (STRATEGIUM_COMMIT)\n");
		for (const v of ["1", "true", "on", "YES", " 1 "]) {
			process.env.STRATEGIUM_COMMIT = v;
			expect(await s.call({ action: "status" })).toContain("COMMIT on (STRATEGIUM_COMMIT)\n");
		}
		process.env.STRATEGIUM_COMMIT = "0";
		expect(await s.call({ action: "status" })).toContain("COMMIT off (STRATEGIUM_COMMIT)\n");
		// Also with no run at all.
		const bare = setup("sess-0002");
		process.env.STRATEGIUM_COMMIT = "1";
		expect(await bare.call({ action: "status" })).toContain("COMMIT on (STRATEGIUM_COMMIT)\n");
	});

	test("STRATEGIUM_COMMIT only turns on for a whole word, not a part of one", async () => {
		const s = setup();
		for (const v of ["xon", "maybe-yes", "10", "1x", "yesno"]) {
			process.env.STRATEGIUM_COMMIT = v;
			expect(await s.call({ action: "status" })).toContain("COMMIT off (STRATEGIUM_COMMIT)\n");
		}
	});

	test("/strategium-config commit on wins over STRATEGIUM_COMMIT=0, for this session only", async () => {
		process.env.STRATEGIUM_COMMIT = "0";
		const s = setup();
		await s.sub("config", "commit on");
		expect(s.notes.at(-1)).toContain("commit: on (this session)");
		expect(await s.call({ action: "status" })).toContain("COMMIT on (this session)\n");
		const n: string[] = [];
		await s.commands["strategium-config"].handler("", shared("sess-0002", s.dir, s.footer, n).ctx);
		expect(n.at(-1)).toContain("commit: off (STRATEGIUM_COMMIT)");
		// Off wins over the env too, and a bad value is refused with the full usage.
		process.env.STRATEGIUM_COMMIT = "1";
		await s.sub("config", "commit off");
		expect(s.notes.at(-1)).toContain("commit: off (this session)");
		await s.sub("config", "commit maybe");
		expect(s.notes.at(-1)).toContain("or commit on|off");
	});

	test("the commit setting follows an approved plan to the new session", async () => {
		const s = setup("sess-A");
		await s.call({ action: "begin", key: "K-1" });
		const notes: string[] = [];
		const { sm, ctx } = shared("sess-A", s.dir, s.footer, notes);
		await s.handlers.session_start[0]({}, ctx);
		await s.commands["strategium-config"].handler("commit on", ctx);
		await s.handlers.plan_review_requested[0]({ sessionId: "sess-A" }, ctx);
		await s.handlers.plan_review_resolved[0]({ sessionId: "sess-A", choice: "execute" }, ctx);
		sm.sid = "sess-B";
		await s.handlers.session_switch[0]({ reason: "new" }, ctx);
		await s.commands["strategium-config"].handler("", ctx);
		expect(notes.at(-1)).toContain("commit: on (this session)");
		sm.sid = "sess-A";
		await s.commands["strategium-config"].handler("", ctx);
		expect(notes.at(-1)).toContain("commit: off (STRATEGIUM_COMMIT)");
	});
});

describe("the archmagos guard", () => {
	type Verdict = { block?: true; reason?: string } | undefined;
	const OFF =
		"Strategium: the archmagos is off in this session. The user turns it on with /strategium-config archmagos on or STRATEGIUM_ARCHMAGOS=1; until then the lead librarian merges the plan.";
	const UNMARKED =
		"Strategium: this run was not marked for the archmagos in Muster (strategium begin with archmagos: true); the lead librarian merges the plan.";
	const waits = (n: number) =>
		`Strategium: the archmagos integrates the librarians' parts: at least 2 librarians of this run must have finished first; ${n} have.`;
	const AGAIN = "Strategium: this run already spawned its archmagos. Only a redraft allows one more: call strategium action redraft first.";
	const SPENT = "Strategium: this run already spawned its archmagos and spent its one redraft.";
	const REFRESH =
		"Strategium: this run was redrafted and Auspex has not refreshed the map yet: a scout spawned after the redraft must finish before any librarian or archmagos.";
	const REDRAFT = "REDRAFT K-1: back to Auspex; no librarian or archmagos until a scout spawned now has finished";

	// A run with no repo and no squads: the librarians are counted all the same.
	async function run(opts: { on?: boolean; marked?: boolean } = {}) {
		const { on = true, marked = true } = opts;
		if (on) process.env.STRATEGIUM_ARCHMAGOS = "1";
		const s = setup();
		await s.call({ action: "begin", key: "K-1", ...(marked ? { archmagos: true } : {}) });
		const spawn = (agent: string) => s.handlers.before_subagent_spawn[0]({ agent }, s.ctx) as Verdict;
		// The host's task result: the agent of each item and the status and id it allocated.
		const result = (items: [string, string, string][]) => {
			const input = { tasks: items.map(([agent]) => ({ agent })) };
			const details = { progress: items.map(([, id, status], index) => ({ index, id, status })) };
			for (const h of s.handlers.tool_result) h({ toolName: "task", input, details, isError: false }, s.ctx);
		};
		const jobs = (status: string, ...ids: string[]) =>
			s.handlers.context[0]({ type: "context", messages: [{ role: "custom", details: { jobs: ids.map(label => ({ jobId: `j-${label}`, type: "task", status, label })) } }] }, s.ctx);
		const two = () => result([["librarian", "L1", "completed"], ["librarian", "L2", "completed"]]);
		return { s, spawn, result, jobs, two };
	}

	test("archmagos is refused while the setting is off, with the reason", async () => {
		const { spawn, two } = await run({ on: false });
		two();
		expect(spawn("archmagos")).toEqual({ block: true, reason: OFF });
	});

	test("archmagos is refused on a run not marked in Muster", async () => {
		const { spawn, two } = await run({ marked: false });
		two();
		expect(spawn("archmagos")).toEqual({ block: true, reason: UNMARKED });
	});

	test("archmagos waits for 2 finished librarians of the run, before any squads", async () => {
		const { spawn, result, jobs } = await run();
		expect(spawn("archmagos")).toEqual({ block: true, reason: waits(0) });
		// Running librarians, a finished scout and a failed librarian never count.
		result([["librarian", "L1", "running"], ["librarian", "L2", "pending"], ["scout", "S1", "completed"], ["librarian", "L4", "failed"]]);
		expect(spawn("archmagos")).toEqual({ block: true, reason: waits(0) });
		// A job that failed is not finished work.
		jobs("failed", "L1");
		expect(spawn("archmagos")).toEqual({ block: true, reason: waits(0) });
		// A running librarian that completes in a later context counts.
		jobs("completed", "L2");
		expect(spawn("archmagos")).toEqual({ block: true, reason: waits(1) });
		// One that completed in its task result counts too.
		result([["librarian", "L3", "completed"]]);
		expect(spawn("archmagos")).toBeUndefined();
	});

	test("a second archmagos is refused, also in the same task call", async () => {
		const { spawn, two } = await run();
		two();
		expect(spawn("archmagos")).toBeUndefined();
		expect(spawn("archmagos")).toEqual({ block: true, reason: AGAIN });
		expect(spawn("archmagos")).toEqual({ block: true, reason: AGAIN });
	});

	test("a redraft allows exactly one more archmagos", async () => {
		const none = setup("sess-0009");
		expect(await none.call({ action: "redraft" })).toBe("ERROR no active run in this session");
		const { s, spawn, result, two } = await run();
		two();
		expect(spawn("archmagos")).toBeUndefined();
		expect(await s.call({ action: "redraft" })).toBe(`${REDRAFT}; then one more archmagos may be spawned`);
		result([["scout", "S1", "completed"]]);
		expect(spawn("archmagos")).toBeUndefined();
		expect(spawn("archmagos")).toEqual({ block: true, reason: SPENT });
		expect(await s.call({ action: "redraft" })).toBe("ERROR the redraft of K-1 is spent (1 per run)");
	});

	test("redraft works without the archmagos, once per run", async () => {
		const { s, spawn } = await run({ on: false, marked: false });
		expect(spawn("librarian")).toBeUndefined();
		expect(await s.call({ action: "redraft" })).toBe(REDRAFT);
		expect(await s.call({ action: "redraft" })).toBe("ERROR the redraft of K-1 is spent (1 per run)");
		// The REFRESH guard comes before the setting check.
		expect(spawn("archmagos")).toEqual({ block: true, reason: REFRESH });
	});

	test("after a redraft, librarians and archmagos wait for a scout spawned after it", async () => {
		const { s, spawn, result, jobs, two } = await run();
		two();
		expect(spawn("archmagos")).toBeUndefined();
		result([["scout", "S0", "running"]]);
		expect(await s.call({ action: "redraft" })).toBe(`${REDRAFT}; then one more archmagos may be spawned`);
		expect(spawn("librarian")).toEqual({ block: true, reason: REFRESH });
		// The refresh itself must stay possible, or the redraft would deadlock.
		expect(spawn("scout")).toBeUndefined();
		expect(spawn("battle-brother")?.block).toBeUndefined();
		expect(spawn("archmagos")).toEqual({ block: true, reason: REFRESH });
		// S0 was spawned before the redraft: its end is no refresh.
		jobs("completed", "S0");
		expect(spawn("librarian")).toEqual({ block: true, reason: REFRESH });
		result([["scout", "S1", "running"]]);
		jobs("failed", "S1");
		expect(spawn("librarian")).toEqual({ block: true, reason: REFRESH });
		result([["scout", "S2", "pending"]]);
		jobs("completed", "S2");
		expect(spawn("librarian")).toBeUndefined();
		expect(spawn("archmagos")).toBeUndefined();
		expect(spawn("archmagos")).toEqual({ block: true, reason: SPENT });
	});

	test("a scout completed in its own task result refreshes the librarian path", async () => {
		const { s, spawn, result } = await run({ marked: false });
		await s.call({ action: "redraft" });
		expect(spawn("librarian")).toEqual({ block: true, reason: REFRESH });
		result([["scout", "S0", "failed"]]);
		expect(spawn("librarian")).toEqual({ block: true, reason: REFRESH });
		result([["scout", "S1", "completed"]]);
		expect(spawn("librarian")).toBeUndefined();
		// done never downgrades.
		result([["scout", "S1", "running"]]);
		expect(spawn("librarian")).toBeUndefined();
		expect(await s.call({ action: "redraft" })).toBe("ERROR the redraft of K-1 is spent (1 per run)");
	});

	test("a completed job of an id that is no running librarian changes nothing", async () => {
		const { spawn, result, jobs } = await run();
		result([["librarian", "L1", "running"], ["scout", "S1", "running"]]);
		jobs("completed", "S1", "X9");
		expect(spawn("archmagos")).toEqual({ block: true, reason: waits(0) });
		jobs("completed", "L1");
		expect(spawn("archmagos")).toEqual({ block: true, reason: waits(1) });
	});

	test("a librarian already done stays done when a later result reports it running", async () => {
		const { spawn, result, two } = await run();
		two();
		result([["librarian", "L1", "running"], ["librarian", "L2", "pending"]]);
		expect(spawn("archmagos")).toBeUndefined();
	});

	test("librarians reported running in a task result become done on their completed jobs", async () => {
		const { spawn, result, jobs } = await run();
		result([["librarian", "L1", "running"], ["librarian", "L2", "pending"]]);
		expect(spawn("archmagos")).toEqual({ block: true, reason: waits(0) });
		jobs("completed", "L1", "L2");
		expect(spawn("archmagos")).toBeUndefined();
	});

	test("the guards run in order: setting, mark, librarians, budget", async () => {
		const off = await run({ on: false, marked: false });
		expect(off.spawn("archmagos")).toEqual({ block: true, reason: OFF });
		const unmarked = await run({ marked: false });
		expect(unmarked.spawn("archmagos")).toEqual({ block: true, reason: UNMARKED });
		// Budget spent with no librarian on record: the librarians reason comes first.
		const { s, spawn, two } = await run();
		two();
		expect(spawn("archmagos")).toBeUndefined();
		const file = join(s.dir, "runs", "sess-0001.json");
		const saved = JSON.parse(readFileSync(file, "utf8"));
		delete saved.librarians;
		writeFileSync(file, JSON.stringify(saved));
		expect(spawn("archmagos")).toEqual({ block: true, reason: waits(0) });
	});
});

describe("reload, shutdown and the footer, pinned", () => {
	const runFileOf = (dir: string, sid: string) => join(dir, "runs", `${sid}.json`);

	test("the untimed run resumed the next day raises no silent-gap note", async () => {
		const s = setup();
		setSystemTime(new Date(2026, 10, 15, 23, 30, 0));
		await s.call({ action: "begin", key: "dark-mode" });
		await s.handlers.session_shutdown[0]({}, s.ctx);
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await s.handlers.session_start[0]({}, s.ctx);
		expect(s.notes).toEqual([]);
	});

	test("the shutdown releases the claim, clears the hooks and a new start registers the timer again", async () => {
		const a = setup("sess-0001");
		let timers = 0;
		a.ctx.setInterval = () => ++timers;
		await a.call({ action: "begin", key: "K-1" });
		await a.handlers.session_start[0]({}, a.ctx);
		const drawn = a.footer.length;
		await a.handlers.session_shutdown[0]({}, a.ctx);
		await a.call({ action: "status" });
		expect(a.footer.length).toBe(drawn);
		expect(existsSync(lockPath(a.dir, "K-1"))).toBe(false);
		// And another session can take the ticket.
		const b = setup("sess-0002", a.dir);
		expect(await b.call({ action: "begin", key: "K-1", takeover: "sess-0001" })).not.toContain("ERROR");
		await a.handlers.session_start[0]({}, a.ctx);
		expect(timers).toBe(2);
	});

	test("a ticket claimed by another session while we were away drops our run at start", async () => {
		const a = setup("sess-0001");
		await a.call({ action: "begin", key: "K-1" });
		await a.handlers.session_shutdown[0]({}, a.ctx);
		claim(a.dir, "K-1", "sess-0002");
		await a.handlers.session_start[0]({}, a.ctx);
		expect(existsSync(runFileOf(a.dir, "sess-0001"))).toBe(false);
		expect(a.shown()).toBe("");
		expect(await a.call({ action: "status" })).not.toContain("RUN K-1");
	});

	test("after another session took the ticket, the reload leaves the tools alone and the run does not run here", async () => {
		const a = setup("sess-0001");
		await a.call({ action: "begin", key: "K-1" });
		await a.handlers.session_shutdown[0]({}, a.ctx);
		claim(a.dir, "K-1", "sess-0002");
		const full = ["read", "bash", "edit", "write", "task"];
		a.setActive(full);
		await a.handlers.session_start[0]({}, a.ctx);
		expect(a.activeTools()).toEqual(full);
		expect(await a.call({ action: "status" })).not.toContain("this session");
		expect(a.shown()).toBe("");
	});

	test("after the ticket was claimed elsewhere, the reload neither books time nor shows the key running", async () => {
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		const a = setup("sess-0001");
		await a.call({ action: "begin", key: "K-1" });
		await a.handlers.session_shutdown[0]({}, a.ctx);
		claim(a.dir, "K-1", "sess-0002");
		const starts = () => load(join(a.dir, "2026-11-16.jsonl")).filter(e => e.event === "start").length;
		const before = starts();
		setSystemTime(new Date(2026, 10, 16, 9, 5, 0));
		await a.handlers.session_start[0]({}, a.ctx);
		expect(starts()).toBe(before);
		expect(await a.call({ action: "status" })).not.toMatch(/K-1.*running/);
	});

	test("the timer runs every minute", async () => {
		const s = setup();
		const delays: unknown[] = [];
		s.ctx.setInterval = (_fn: () => void, ms: unknown) => delays.push(ms);
		await s.handlers.session_start[0]({}, s.ctx);
		expect(delays).toEqual([60_000]);
	});

	test("a sub-agent session draws nothing and sets no timer", async () => {
		const s = setup();
		let timers = 0;
		s.ctx.setInterval = () => ++timers;
		await s.call({ action: "begin", key: "K-1" });
		const before = s.footer.length;
		await s.handlers.session_start[0]({}, { ...s.ctx, agent: { kind: "sub" } });
		expect(timers).toBe(0);
		expect(s.footer.length).toBe(before);
	});

	test("the timer callback beats, redraws, and clears the footer when the run is gone", async () => {
		const s = setup();
		let tick = () => {};
		s.ctx.setInterval = (fn: () => void) => {
			tick = fn;
			return 0;
		};
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await s.call({ action: "begin", key: "K-1" });
		setSystemTime(new Date(2026, 10, 16, 9, 1, 0));
		await s.handlers.session_start[0]({}, s.ctx);
		setSystemTime(new Date(2026, 10, 16, 9, 2, 0));
		const drawn = s.footer.length;
		tick();
		expect(s.footer.length).toBe(drawn + 1);
		expect(s.shown()).toContain("K-1");
		expect(readFileSync(join(s.dir, "runs", "sess-0001.beat"), "utf8")).toContain("T09:02:00");
		await s.call({ action: "end" });
		const afterEnd = s.footer.length;
		tick();
		expect(s.footer.length).toBe(afterEnd + 1);
		expect(s.shown()).toBe("");
	});

	test("every tool action and the session start redraw the footer", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.handlers.session_start[0]({}, s.ctx);
		const drawn = s.footer.length;
		await s.call({ action: "status" });
		expect(s.footer.length).toBe(drawn + 1);
		await s.call({ action: "end" });
		expect(s.footer.length).toBe(drawn + 2);
	});

	test("a switch to a new session draws its footer and later actions redraw it", async () => {
		const s = setup("sess-B");
		await s.call({ action: "begin", key: "omp-native" });
		await s.handlers.session_switch[0]({}, s.ctx);
		const drawn = s.footer.length;
		await s.call({ action: "status" });
		expect(s.footer.length).toBe(drawn + 1);
		expect(s.shown()).toContain("omp-native");
	});
});

describe("the idle pause", () => {
	const T = (h: number, m: number, s = 0, day = 16) => new Date(2026, 10, day, h, m, s);
	const dayEvents = (dir: string, day = 16) => load(join(dir, `2026-11-${day}.jsonl`));
	const starts = (dir: string, day = 16) => dayEvents(dir, day).filter(e => e.event === "start").length;
	const stops = (dir: string) => dayEvents(dir).filter(e => e.event === "stop") as (Ev & { reason?: string })[];
	const runMark = (dir: string) => JSON.parse(readFileSync(join(dir, "runs", "sess-0001.json"), "utf8")).idle;
	// A running run on an idle session, started at 9:00 on the fake clock.
	async function idler(booked?: number) {
		const s = setup();
		setSystemTime(T(9, 0));
		await s.call({ action: "begin", key: "K-1", ...(booked ? { booked } : {}) });
		s.ctx.host.idle = true;
		await s.start();
		return s;
	}
	// The timer ticks at a time of the fake clock: a footer refresh runs the same tick as the interval does.
	const at = async (s: Awaited<ReturnType<typeof idler>>, h: number, m: number, sec = 0) => {
		setSystemTime(T(h, m, sec));
		await s.sub("status");
	};
	const ran = (notes: string[]) => notes.some(n => n.includes("the alarm failed"));

	test("idle for the threshold pauses the clock with reason idle and marks the run", async () => {
		const s = await idler();
		await at(s, 9, 1);
		await at(s, 9, 2);
		expect(stops(s.dir)).toEqual([]);
		// The tick that notices comes late (9:04); the stop is stamped at 9:00 + 3 min.
		await at(s, 9, 4);
		expect(stops(s.dir)).toEqual([{ ts: nowIso(T(9, 3)), event: "stop", key: "K-1", reason: "idle" }]);
		expect(runMark(s.dir)).toBe(true);
		expect(s.shown()).toContain("paused");
		await at(s, 9, 5);
		expect(stops(s.dir).length).toBe(1);
	});

	test("a busy session never pauses: streaming, pending messages, a running job, an open plan review", async () => {
		const signals: [string, (h: ReturnType<typeof fakeCtx>["host"]) => void][] = [
			["streaming", h => (h.idle = false)],
			["pending messages", h => (h.pending = true)],
			["a running job", h => (h.jobs = { running: [{}] })],
			["an open plan review", h => (h.review = {})],
		];
		for (const [name, busy] of signals) {
			const s = await idler();
			busy(s.ctx.host);
			for (const m of [2, 4, 6, 8, 10]) await at(s, 9, m);
			expect(stops(s.dir), name).toEqual([]);
			// Once the signal clears the count starts there, not at 9:00.
			Object.assign(s.ctx.host, { idle: true, pending: false, jobs: undefined, review: undefined });
			await at(s, 9, 11);
			await at(s, 9, 13);
			expect(stops(s.dir), name).toEqual([]);
			await at(s, 9, 14);
			expect(stops(s.dir).length, name).toBe(1);
		}
	});

	type Idler = Awaited<ReturnType<typeof idler>>;
	const begins: [string, (s: Idler) => Promise<unknown>][] = [
		["the command", s => s.command('"other thing"')],
		["the tool", s => s.call({ action: "begin", key: "K-2" })],
	];
	for (const [via, begin] of begins) {
		test(`a begin by ${via} restarts the idle count`, async () => {
			const s = await idler();
			// The count started at 9:00; the begin at 9:02 restarts it, so 9:03 (3 min after 9:00) does not pause.
			setSystemTime(T(9, 2));
			await begin(s);
			await at(s, 9, 3);
			expect(stops(s.dir).filter(e => e.reason === "idle")).toEqual([]);
			await at(s, 9, 5);
			expect(stops(s.dir).filter(e => e.reason === "idle").length).toBe(1);
		});
	}

	test("a turn between two ticks restarts the idle count", async () => {
		const s = await idler();
		await at(s, 9, 2);
		// A short turn: it ends at 9:02:40, so the idle minutes count from there.
		setSystemTime(T(9, 2, 30));
		s.ctx.host.idle = false;
		await s.handlers.agent_start[0]({}, s.ctx);
		setSystemTime(T(9, 2, 40));
		await s.handlers.agent_end[0]({}, s.ctx);
		s.ctx.host.idle = true;
		await at(s, 9, 4);
		await at(s, 9, 5);
		expect(stops(s.dir)).toEqual([]);
		await at(s, 9, 6);
		expect(stops(s.dir)).toEqual([{ ts: nowIso(T(9, 5, 40)), event: "stop", key: "K-1", reason: "idle" }]);
	});

	test("the idle pause notifies and sounds the idle alarm only with notifications on", async () => {
		const on = await idler();
		await at(on, 9, 2);
		await at(on, 9, 3);
		expect(on.notes.filter(n => n.includes("paused after 3 min idle")).length).toBe(1);
		expect(on.notes.find(n => n.includes("paused after"))).toContain("K-1");
		expect(alarmLines()).toEqual(["idle|K-1: paused, idle 3 min"]);
		// Nothing is posted into the session: a triggered turn would resume the clock at once.
		expect(on.calls).toEqual([]);
		expect(on.sent).toEqual([]);

		const off = await idler();
		failAlarm();
		await off.sub("config", "notify off");
		await at(off, 9, 2);
		await at(off, 9, 3);
		expect(off.notes.some(n => n.includes("paused after 3 min idle"))).toBe(true);
		// A failing alarm command reports itself at once, so no note proves nothing was spawned.
		expect(ran(off.notes)).toBe(false);
	});

	test("the idle notification and alarm name the configured minutes", async () => {
		const s = await idler();
		await s.sub("config", "idle 5");
		await at(s, 9, 2);
		await at(s, 9, 4);
		await at(s, 9, 5);
		expect(s.notes.some(n => n.includes("paused after 5 min idle"))).toBe(true);
		expect(alarmLines()).toEqual(["idle|K-1: paused, idle 5 min"]);
	});

	test("a failing idle alarm is reported", async () => {
		const s = await idler();
		failAlarm();
		await at(s, 9, 2);
		await at(s, 9, 3);
		expect(ran(s.notes)).toBe(true);
	});

	test("a failing alarm on the silent-gap pause is reported", async () => {
		const s = await idler();
		s.ctx.host.idle = false;
		failAlarm();
		// A jump past the 3-minute heartbeat gap reads as a frozen machine.
		await at(s, 9, 10);
		expect(ran(s.notes)).toBe(true);
	});

	test("the next agent_start resumes an idle-paused run once", async () => {
		const s = await idler();
		await at(s, 9, 2);
		await at(s, 9, 3);
		expect(starts(s.dir)).toBe(1);
		setSystemTime(T(9, 30));
		s.ctx.host.idle = false;
		await s.handlers.agent_start[0]({}, s.ctx);
		expect(starts(s.dir)).toBe(2);
		expect(s.notes.at(-1)).toContain("resumed K-1");
		expect(runMark(s.dir)).toBeUndefined();
		await s.handlers.agent_start[0]({}, s.ctx);
		expect(starts(s.dir)).toBe(2);
	});

	test("a sleep while idle-counting marks the run, so the next agent_start resumes it", async () => {
		const s = await idler();
		await at(s, 9, 1);
		// The machine sleeps from 9:01 to 9:10: the block closes at the last beat, not at the threshold.
		await at(s, 9, 10);
		expect(stops(s.dir)).toEqual([{ ts: nowIso(T(9, 1)), event: "stop", key: "K-1" }]);
		expect(runMark(s.dir)).toBe(true);
		s.ctx.host.idle = false;
		await s.handlers.agent_start[0]({}, s.ctx);
		expect(starts(s.dir)).toBe(2);
		expect(runMark(s.dir)).toBeUndefined();
	});

	test("a sleep while busy leaves the run paused: agent_start does not resume it", async () => {
		const s = await idler();
		s.ctx.host.idle = false;
		await at(s, 9, 1);
		await at(s, 9, 10);
		expect(stops(s.dir)).toEqual([{ ts: nowIso(T(9, 1)), event: "stop", key: "K-1" }]);
		expect(runMark(s.dir)).toBeUndefined();
		await s.handlers.agent_start[0]({}, s.ctx);
		expect(starts(s.dir)).toBe(1);
	});

	test("pause, stop, resume and start spend the idle mark", async () => {
		const actions: [string, (s: Awaited<ReturnType<typeof idler>>) => unknown, boolean][] = [
			["/strategium-pause", s => s.sub("pause"), false],
			["the stop action", s => s.call({ action: "stop" }), false],
			["/strategium-resume", s => s.sub("resume"), true],
			["the start action", s => s.call({ action: "start" }), true],
		];
		// Untimed and timed runs both spend the mark.
		for (const booked of [undefined, 120]) for (const [name, act, resumes] of actions) {
			const s = await idler(booked);
			await at(s, 9, 2);
			await at(s, 9, 3);
			expect(runMark(s.dir), name).toBe(true);
			await act(s);
			expect(runMark(s.dir), name).toBeUndefined();
			const before = starts(s.dir);
			expect(before, name).toBe(resumes ? 2 : 1);
			// A turn after a stop by hand adds no start: the run stays paused.
			s.ctx.host.idle = false;
			await s.handlers.agent_start[0]({}, s.ctx);
			expect(starts(s.dir), name).toBe(before);
		}
	});

	test("a hand resume on a running clock restarts the idle count", async () => {
		for (const [name, act] of [
			["/strategium-resume", (s: Awaited<ReturnType<typeof idler>>) => s.sub("resume")],
			["the start action", (s: Awaited<ReturnType<typeof idler>>) => s.call({ action: "start" })],
		] as const) {
			const s = await idler();
			await at(s, 9, 2);
			await act(s);
			// Counted from 9:02 (the command), not from 9:00: 9:04 is only 2 min.
			await at(s, 9, 4);
			expect(stops(s.dir), name).toEqual([]);
			await at(s, 9, 5);
			expect(stops(s.dir), name).toEqual([{ ts: nowIso(T(9, 5)), event: "stop", key: "K-1", reason: "idle" }]);
		}
	});

	test("a reload with a stale idle count does not pause at once", async () => {
		const s = await idler();
		await at(s, 9, 1);
		await s.handlers.session_shutdown[0]({}, s.ctx);
		setSystemTime(T(9, 10));
		await s.start();
		expect(stops(s.dir).filter(e => e.reason === "idle")).toEqual([]);
		expect(starts(s.dir)).toBe(2);
	});

	test("a sub-agent's turn neither resumes the run nor restarts the idle count", async () => {
		const sub = (s: { ctx: object }) => ({ ...s.ctx, agent: { kind: "sub" } }) as never;
		// agent_start: an idle-paused run stays paused and marked.
		const paused = await idler();
		await at(paused, 9, 2);
		await at(paused, 9, 3);
		setSystemTime(T(9, 30));
		await paused.handlers.agent_start[0]({}, sub(paused));
		expect(starts(paused.dir)).toBe(1);
		expect(runMark(paused.dir)).toBe(true);
		// agent_start on a running clock does not move the count.
		const started = await idler();
		await at(started, 9, 2);
		setSystemTime(T(9, 2, 30));
		await started.handlers.agent_start[0]({}, sub(started));
		await at(started, 9, 3);
		expect(stops(started.dir).length).toBe(1);
		// agent_end does not move it either: the stop stays stamped 9:00 + 3 min.
		const ended = await idler();
		await at(ended, 9, 2);
		setSystemTime(T(9, 2, 30));
		await ended.handlers.agent_end[0]({}, sub(ended));
		await at(ended, 9, 3);
		expect(stops(ended.dir)).toEqual([{ ts: nowIso(T(9, 3)), event: "stop", key: "K-1", reason: "idle" }]);
	});

	test("the footer drops paused as soon as the resuming agent_start runs", async () => {
		const s = await idler();
		await at(s, 9, 2);
		await at(s, 9, 3);
		expect(s.shown()).toContain("paused");
		setSystemTime(T(9, 30));
		s.ctx.host.idle = false;
		await s.handlers.agent_start[0]({}, s.ctx);
		expect(s.shown()).not.toContain("paused");
	});

	test("an idle-paused timed run on a new day waits for its booking; an untimed one resumes", async () => {
		const timed = await idler(120);
		await at(timed, 9, 2);
		await at(timed, 9, 3);
		setSystemTime(T(9, 0, 0, 17));
		timed.ctx.host.idle = false;
		await timed.handlers.agent_start[0]({}, timed.ctx);
		expect(starts(timed.dir, 17)).toBe(0);
		expect(timed.notes.at(-1)).toContain("needs today's booking; /strategium-resume <min>");
		expect(runMark(timed.dir)).toBeUndefined();

		const untimed = await idler();
		await at(untimed, 9, 2);
		await at(untimed, 9, 3);
		setSystemTime(T(9, 0, 0, 17));
		untimed.ctx.host.idle = false;
		await untimed.handlers.agent_start[0]({}, untimed.ctx);
		expect(starts(untimed.dir, 17)).toBe(1);
	});

	test("the idle threshold follows STRATEGIUM_IDLE_MIN and /strategium-config idle, 0 turns it off", async () => {
		// 0 = off: nothing pauses however long the session is idle.
		process.env.STRATEGIUM_IDLE_MIN = "0";
		const off = await idler();
		for (const m of [2, 4, 6, 8, 10]) await at(off, 9, m);
		expect(stops(off.dir)).toEqual([]);
		await off.sub("config");
		expect(off.notes.at(-1)).toContain("idle: off (STRATEGIUM_IDLE_MIN)");

		// The env value moves the threshold: 5 min, not 3.
		process.env.STRATEGIUM_IDLE_MIN = "5";
		const five = await idler();
		for (const m of [2, 4]) await at(five, 9, m);
		expect(stops(five.dir)).toEqual([]);
		await at(five, 9, 5);
		expect(stops(five.dir)).toEqual([{ ts: nowIso(T(9, 5)), event: "stop", key: "K-1", reason: "idle" }]);
		await five.sub("config");
		expect(five.notes.at(-1)).toContain("idle: 5 min (STRATEGIUM_IDLE_MIN)");

		// The session setting wins over the env, and 0 there turns it off too.
		const own = await idler();
		await own.sub("config", "idle 2");
		expect(own.notes.at(-1)).toContain("idle: 2 min (this session)");
		await at(own, 9, 2);
		expect(stops(own.dir).length).toBe(1);
		const none = await idler();
		await none.sub("config", "idle 0");
		expect(none.notes.at(-1)).toContain("idle: off (this session)");
		for (const m of [2, 4, 6, 8, 10]) await at(none, 9, m);
		expect(stops(none.dir)).toEqual([]);

		// An invalid value is refused and invalid env falls back to 3.
		await none.sub("config", "idle x");
		expect(none.notes.at(-1)).toContain("config takes notify on|off or idle <min>");
		process.env.STRATEGIUM_IDLE_MIN = "soon";
		const dflt = await idler();
		await dflt.sub("config");
		expect(dflt.notes.at(-1)).toContain("idle: 3 min (STRATEGIUM_IDLE_MIN)");

		// Two digits are accepted, trailing junk is refused with the warning.
		await dflt.sub("config", "idle 10");
		expect(dflt.notes.at(-1)).toContain("idle: 10 min (this session)");
		await dflt.sub("config", "idle 5x");
		expect(dflt.notes.at(-1)).toContain("config takes notify on|off or idle <min>");

		// Spaces around the env value are trimmed; a negative one falls back to 3.
		process.env.STRATEGIUM_IDLE_MIN = " 5 ";
		const spaced = setup();
		await spaced.sub("config");
		expect(spaced.notes.at(-1)).toContain("idle: 5 min (STRATEGIUM_IDLE_MIN)");
		process.env.STRATEGIUM_IDLE_MIN = "-5";
		const negative = setup();
		await negative.sub("config");
		expect(negative.notes.at(-1)).toContain("idle: 3 min (STRATEGIUM_IDLE_MIN)");
	});

	test("the idle setting follows an approved plan to the new session", async () => {
		const s = setup("sess-A");
		await s.call({ action: "begin", key: "K-1" });
		const notes: string[] = [];
		const { sm, ctx } = shared("sess-A", s.dir, s.footer, notes);
		await s.handlers.session_start[0]({}, ctx);
		await s.commands["strategium-config"].handler("idle 7", ctx);
		await s.handlers.plan_review_requested[0]({ sessionId: "sess-A" }, ctx);
		await s.handlers.plan_review_resolved[0]({ sessionId: "sess-A", choice: "execute" }, ctx);
		sm.sid = "sess-B";
		await s.handlers.session_switch[0]({ reason: "new" }, ctx);
		await s.commands["strategium-config"].handler("", ctx);
		expect(notes.at(-1)).toContain("idle: 7 min (this session)");
	});

	test("idle 0 survives the plan-approval move as off", async () => {
		const s = setup("sess-A");
		await s.call({ action: "begin", key: "K-1" });
		const notes: string[] = [];
		const { sm, ctx } = shared("sess-A", s.dir, s.footer, notes);
		await s.handlers.session_start[0]({}, ctx);
		await s.commands["strategium-config"].handler("idle 0", ctx);
		await s.handlers.plan_review_requested[0]({ sessionId: "sess-A" }, ctx);
		await s.handlers.plan_review_resolved[0]({ sessionId: "sess-A", choice: "execute" }, ctx);
		sm.sid = "sess-B";
		await s.handlers.session_switch[0]({ reason: "new" }, ctx);
		await s.commands["strategium-config"].handler("", ctx);
		expect(notes.at(-1)).toContain("idle: off (this session)");
	});

	test("no idle pause without a running clock; a session closed while idle-paused resumes on its first turn", async () => {
		failAlarm();
		// No run at all.
		const bare = setup();
		setSystemTime(T(9, 0));
		bare.ctx.host.idle = true;
		await bare.start();
		await at(bare, 9, 2);
		await at(bare, 9, 4);
		expect(bare.notes.some(n => n.includes("idle"))).toBe(false);
		expect(ran(bare.notes)).toBe(false);
		// A clock the user stopped.
		const paused = await idler();
		await paused.sub("pause");
		await at(paused, 9, 2);
		await at(paused, 9, 4);
		expect(runMark(paused.dir)).toBeUndefined();
		expect(stops(paused.dir).every(e => e.reason === undefined)).toBe(true);
		// A failing alarm command reports itself at once, so no note proves nothing was spawned.
		expect(ran(paused.notes)).toBe(false);

		// Closed while idle-paused: no shutdown mark, so the reopened session stays paused until its first turn.
		const s = await idler();
		await at(s, 9, 2);
		await at(s, 9, 3);
		await s.handlers.session_shutdown[0]({}, s.ctx);
		expect(JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8")).closedBy).toBeUndefined();
		await s.start();
		expect(starts(s.dir)).toBe(1);
		s.ctx.host.idle = false;
		await s.handlers.agent_start[0]({}, s.ctx);
		expect(starts(s.dir)).toBe(2);
	});

	test("an open plan review calls the user once with the attention alarm, only with notifications on", async () => {
		const on = setup();
		await on.call({ action: "begin", key: "K-1" });
		await on.handlers.plan_review_requested[0]({ sessionId: "sess-0001" }, on.ctx);
		expect(alarmLines()).toEqual(["attention|K-1: your plan review is waiting"]);
		await Bun.sleep(300);
		expect(alarmLines()).toEqual(["attention|K-1: your plan review is waiting"]);

		const off = setup();
		failAlarm();
		await off.call({ action: "begin", key: "K-1" });
		await off.sub("config", "notify off");
		await off.handlers.plan_review_requested[0]({ sessionId: "sess-0001" }, off.ctx);
		// A session without a run: nothing to call about.
		const bare = setup();
		await bare.handlers.plan_review_requested[0]({ sessionId: "sess-0001" }, bare.ctx);
		// A failing alarm command reports itself (the awaited call surfaces it at once), so no note proves no spawn.
		expect(ran(off.notes)).toBe(false);
		expect(ran(bare.notes)).toBe(false);
	});

	test("a failing plan-review alarm is reported", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		failAlarm();
		await s.handlers.plan_review_requested[0]({ sessionId: "sess-0001" }, s.ctx);
		expect(ran(s.notes)).toBe(true);
	});
});

describe("the cockpit key", () => {
	const start = async (s: ReturnType<typeof setup>) => {
		for (const h of s.handlers.session_start) await h({}, s.ctx);
	};

	test("STRATEGIUM_COCKPIT_KEY registers that key instead of alt+c", () => {
		process.env.STRATEGIUM_COCKPIT_KEY = "ctrl+shift+k";
		expect(Object.keys(setup().shortcuts)).toEqual(["ctrl+shift+k"]);
	});

	test("/strategium-config cockpit-key saves the key for the next omp start", async () => {
		const s = setup();
		await s.sub("config", "cockpit-key F8");
		expect(s.notes.at(-1)).toContain("cockpit-key: alt+c (default); next omp start: f8 (/strategium-config)");
		expect(readFileSync(join(s.dir, "cockpit-key"), "utf8")).toBe("f8");
		expect(Object.keys(setup("sess-0002", s.dir).shortcuts)).toEqual(["f8"]);
		await s.sub("config", "cockpit-key default");
		expect(existsSync(join(s.dir, "cockpit-key"))).toBe(false);
		expect(s.notes.at(-1)).toContain("cockpit-key: alt+c (default)\n");
		expect(s.notes.at(-1)).not.toContain("next omp start");
	});

	test("the saved key wins over STRATEGIUM_COCKPIT_KEY", async () => {
		process.env.STRATEGIUM_COCKPIT_KEY = "ctrl+shift+k";
		const s = setup();
		await s.sub("config", "cockpit-key f8");
		expect(s.notes.at(-1)).toContain("cockpit-key: ctrl+shift+k (STRATEGIUM_COCKPIT_KEY); next omp start: f8 (/strategium-config)");
		expect(Object.keys(setup("sess-0002", s.dir).shortcuts)).toEqual(["f8"]);
	});

	test("config refuses a cockpit key that is not a key, and a reserved one", async () => {
		const s = setup();
		s.conflicts["ctrl+c"] = { kind: "reserved" };
		await s.sub("config", "cockpit-key hello");
		expect(s.notes.at(-1)).toContain("cockpit-key takes a key such as alt+c, ctrl+shift+k or f8, or default");
		await s.sub("config", "cockpit-key ctrl+c");
		expect(s.notes.at(-1)).toContain("ctrl+c is reserved by omp and never opens the cockpit; pick another key");
		expect(existsSync(join(s.dir, "cockpit-key"))).toBe(false);
	});

	test("config saves a key another extension holds and warns", async () => {
		const s = setup();
		s.conflicts.f8 = { kind: "extension", extensionPath: "/x/other" };
		await s.sub("config", "cockpit-key f8");
		expect(readFileSync(join(s.dir, "cockpit-key"), "utf8")).toBe("f8");
		expect(s.notes.at(-1)).toBe("Strategium: f8 is also a shortcut of /x/other, and only one of them runs; set another key with /strategium-config cockpit-key <key> or use /strategium-cockpit");
	});

	test("session_start warns when the cockpit key is taken", async () => {
		const s = setup();
		s.conflicts["alt+c"] = { kind: "keybinding", keybindings: ["app.foo"] };
		await start(s);
		expect(s.notes.some(n => n.includes("Strategium: alt+c is also omp's app.foo"))).toBe(true);
	});

	test("an invalid STRATEGIUM_COCKPIT_KEY falls back to alt+c and is reported", async () => {
		process.env.STRATEGIUM_COCKPIT_KEY = "Hello";
		const s = setup();
		expect(Object.keys(s.shortcuts)).toEqual(["alt+c"]);
		await start(s);
		expect(s.notes).toContain('Strategium: STRATEGIUM_COCKPIT_KEY "Hello" is not a key such as alt+c, ctrl+shift+k or f8; ignored');
	});

	test.each(["e", "space", "tab", "up", "1", "/", "shift+a", "shift+tab", "ctrl+ctrl+a", "alt+alt+c"])("config refuses the unusable cockpit key %s and writes no file", async k => {
		const s = setup();
		await s.sub("config", `cockpit-key ${k}`);
		expect(s.notes.at(-1)).toContain("cockpit-key takes a key such as alt+c, ctrl+shift+k or f8, or default");
		expect(existsSync(join(s.dir, "cockpit-key"))).toBe(false);
	});

	test.each(["e", "shift+a", "ctrl+ctrl+a"])("STRATEGIUM_COCKPIT_KEY=%s falls back to alt+c and is reported as ignored", async k => {
		process.env.STRATEGIUM_COCKPIT_KEY = k;
		const s = setup();
		expect(Object.keys(s.shortcuts)).toEqual(["alt+c"]);
		await start(s);
		expect(s.notes.some(n => n.includes(`"${k}" is not a key such as alt+c, ctrl+shift+k or f8; ignored`))).toBe(true);
	});

	test("a saved file holding a bare key falls back to the next source", () => {
		process.env.STRATEGIUM_COCKPIT_KEY = "f8";
		const first = setup();
		writeFileSync(join(first.dir, "cockpit-key"), "e");
		expect(Object.keys(setup("sess-0002", first.dir).shortcuts)).toEqual(["f8"]);
	});

	test.each(["f8", "shift+f8", "alt+c", "ctrl+shift+k", "super+k"])("config still accepts the cockpit key %s", async k => {
		const s = setup();
		await s.sub("config", `cockpit-key ${k}`);
		expect(readFileSync(join(s.dir, "cockpit-key"), "utf8")).toBe(k);
	});

	test.each([[" F8 ", "f8"], ["CTRL+K", "ctrl+k"]])("a hand-written cockpit-key file %j binds %s", (raw, bound) => {
		const first = setup();
		writeFileSync(join(first.dir, "cockpit-key"), raw);
		expect(Object.keys(setup("sess-0002", first.dir).shortcuts)).toEqual([bound]);
	});

	test.each([["F8", "f8"], ["CTRL+SHIFT+K", "ctrl+shift+k"]])("STRATEGIUM_COCKPIT_KEY=%s registers %s and the config names its source", async (raw, bound) => {
		process.env.STRATEGIUM_COCKPIT_KEY = raw;
		const s = setup();
		expect(Object.keys(s.shortcuts)).toEqual([bound]);
		await s.sub("config");
		expect(s.notes.at(-1)).toContain(`cockpit-key: ${bound} (STRATEGIUM_COCKPIT_KEY)\n`);
	});

	test("saving the key the env already binds still lists the next start's source", async () => {
		process.env.STRATEGIUM_COCKPIT_KEY = "f8";
		const s = setup();
		await s.sub("config", "cockpit-key f8");
		expect(s.notes.at(-1)).toContain("cockpit-key: f8 (STRATEGIUM_COCKPIT_KEY); next omp start: f8 (/strategium-config)");
	});

	test("a valid uppercase STRATEGIUM_COCKPIT_KEY is not reported as ignored", async () => {
		process.env.STRATEGIUM_COCKPIT_KEY = "F8";
		const s = setup();
		await start(s);
		expect(s.notes.some(n => n.includes("ignored"))).toBe(false);
	});

	test("session_start warns that a reserved cockpit key never opens the cockpit", async () => {
		const s = setup();
		s.conflicts["alt+c"] = { kind: "reserved" };
		await start(s);
		expect(s.notes).toContain("Strategium: alt+c is reserved by omp and never opens the cockpit; set another key with /strategium-config cockpit-key <key> or use /strategium-cockpit");
	});

	test("config saves f12 and refuses f13", async () => {
		const s = setup();
		await s.sub("config", "cockpit-key f13");
		expect(s.notes.at(-1)).toContain("cockpit-key takes a key");
		expect(existsSync(join(s.dir, "cockpit-key"))).toBe(false);
		await s.sub("config", "cockpit-key f12");
		expect(readFileSync(join(s.dir, "cockpit-key"), "utf8")).toBe("f12");
	});
});

describe("cockpit", () => {
	type Tui = { requestRender(): void; terminal: { rows: number } };
	type Comp = { render(w: number): string[]; handleInput?(d: string): void; dispose?(): void };
	// A UI context: the overlay calls are recorded; `hasUI` false leaves the same functions in place but unused.
	function uiCtx(s: ReturnType<typeof setup>, hasUI = true) {
		const opened: { options?: unknown; component: Comp }[] = [];
		const draws = { n: 0, closed: 0 };
		const tui: Tui = { requestRender: () => void draws.n++, terminal: { rows: 40 } };
		const c = s.ctx as unknown as Record<string, unknown> & { ui: Record<string, unknown> };
		// The helper's todo reaches handler [0] only; the cockpit's hooks come after it.
		s.todo = phases => s.handlers.tool_result.forEach(h => h({ toolName: "todo", isError: false, details: { phases } }, s.ctx));
		c.hasUI = hasUI;
		c.ui.custom = (factory: (t: Tui, th: unknown, k: unknown, done: () => void) => Comp, options?: unknown) => {
			opened.push({ options, component: factory(tui, {}, {}, () => void draws.closed++) });
			return new Promise(() => {});
		};
		return { opened, draws, tui };
	}
	const sealTodo = (status: string) => [{ name: "Plan", tasks: [{ content: "[seal] Plan", status }] }];
	// A run with the UI on, started like a session does.
	async function running(hasUI = true) {
		const s = setup();
		const ui = uiCtx(s, hasUI);
		await s.call({ action: "begin", key: "K-1" });
		await s.start();
		return { s, ui };
	}
	const shutdown = (s: ReturnType<typeof setup>) => s.handlers.session_shutdown.forEach(h => h({}, s.ctx));
	const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");
	// What the overlay shows now, without colours; it is closed again so no interval stays alive.
	async function peek(s: ReturnType<typeof setup>, ui: ReturnType<typeof uiCtx>) {
		await s.sub("cockpit");
		const comp = ui.opened.at(-1)!.component;
		const text = plain(comp.render(100).join("\n"));
		comp.handleInput!("q");
		return text;
	}
	// Only the chronicle part of the overlay: the squad and strategos boxes above it repeat words like "returned".
	const chron = async (s: ReturnType<typeof setup>, ui: ReturnType<typeof uiCtx>) => {
		const t = await peek(s, ui);
		return t.slice(t.indexOf("CHRONICLE"));
	};

	test("/strategium-config no longer takes cockpit on|off and lists no cockpit line", async () => {
		const s = setup();
		await s.sub("config", "cockpit on");
		expect(s.notes.at(-1)).toContain("config takes notify on|off or idle <min>, or archmagos on|off, or commit on|off, or sound on|off, or toast on|off, or volume <0-100> [preview], or cockpit-key <key>, or cockpit-theme <name>; the other settings live in ~/.omp/agent/.env");
		await s.sub("config");
		expect(s.notes.at(-1)).not.toContain("cockpit:");
	});

	describe("the cockpit theme", () => {
		const BG = /\x1b\[48;(?:2;24;13;16|5;\d+)m/; // blood-angels Night, at either colour depth
		const raw = (ui: ReturnType<typeof uiCtx>) => {
			const comp = ui.opened.at(-1)!.component;
			const out = comp.render(100).join("\n");
			comp.handleInput!("q");
			return out;
		};

		test("the default is blood-angels: config names it and the overlay is painted on Night", async () => {
			const { s, ui } = await running();
			await s.sub("config");
			expect(s.notes.at(-1)).toContain("cockpit-theme: blood-angels (default)");
			await s.sub("cockpit");
			expect(raw(ui)).toMatch(BG);
		});

		test("cockpit-theme saves the theme and applies it at once; default drops the file", async () => {
			const { s, ui } = await running();
			await s.sub("config", "cockpit-theme Cogitator");
			expect(readFileSync(join(s.dir, "cockpit-theme"), "utf8")).toBe("cogitator");
			expect(s.notes.at(-1)).toContain("cockpit-theme: cogitator (/strategium-config)");
			await s.sub("cockpit");
			expect(raw(ui)).not.toMatch(/\x1b\[48;/); // cogitator keeps the terminal's background
			await s.sub("config", "cockpit-theme default");
			expect(existsSync(join(s.dir, "cockpit-theme"))).toBe(false);
			expect(s.notes.at(-1)).toContain("cockpit-theme: blood-angels (default)");
			await s.sub("cockpit");
			expect(raw(ui)).toMatch(BG);
		});

		test("an open cockpit repaints with the new theme on its next render, without reopening", async () => {
			const { s, ui } = await running();
			await s.sub("cockpit");
			const comp = ui.opened.at(-1)!.component;
			expect(comp.render(100).join("\n")).toMatch(BG);
			await s.sub("config", "cockpit-theme cogitator");
			expect(comp.render(100).join("\n")).not.toMatch(/\x1b\[48;/);
			comp.handleInput!("q");
		});

		test("an unknown theme is refused with the list and writes no file", async () => {
			const s = setup();
			await s.sub("config", "cockpit-theme khorne");
			expect(s.notes.at(-1)).toContain("cockpit-theme takes blood-angels, ultramarines, dark-angels, cogitator or default");
			expect(existsSync(join(s.dir, "cockpit-theme"))).toBe(false);
		});

		test("STRATEGIUM_COCKPIT_THEME picks the theme, and a saved theme wins over it", async () => {
			process.env.STRATEGIUM_COCKPIT_THEME = "Ultramarines";
			const s = setup();
			await s.sub("config");
			expect(s.notes.at(-1)).toContain("cockpit-theme: ultramarines (STRATEGIUM_COCKPIT_THEME)");
			await s.sub("config", "cockpit-theme dark-angels");
			expect(s.notes.at(-1)).toContain("cockpit-theme: dark-angels (/strategium-config)");
		});

		test("an unknown STRATEGIUM_COCKPIT_THEME falls back to the default and is reported at start", async () => {
			process.env.STRATEGIUM_COCKPIT_THEME = "khorne";
			const s = setup();
			for (const h of s.handlers.session_start) await h({}, s.ctx);
			expect(s.notes).toContain('Strategium: STRATEGIUM_COCKPIT_THEME "khorne" is not a theme (blood-angels, ultramarines, dark-angels, cogitator); ignored');
			await s.sub("config");
			expect(s.notes.at(-1)).toContain("cockpit-theme: blood-angels (default)");
		});
	});

	describe("the cockpit with a run", () => {
		test("an untimed run shows its clock right after start, not on the next tick", async () => {
			const { s, ui } = await running();
			expect(await peek(s, ui)).toContain("⧗ 0 min");
		});

		test("a booking added to an untimed run shows its bar", async () => {
			const { s, ui } = await running();
			await s.sub("pause");
			await s.sub("resume", "240");
			expect(await peek(s, ui)).toContain("/240 min");
		});

		test("a sub agent draws nothing", async () => {
			const s = setup();
			const ui = uiCtx(s);
			await s.call({ action: "begin", key: "K-1" });
			s.ctx.agent = { kind: "sub" };
			await s.start();
			s.todo(sealTodo("in_progress"));
			await s.sub("cockpit");
			expect(ui.opened).toEqual([]);
		});
	});

	describe("the overlay", () => {
		test("with no run it warns", async () => {
			const s = setup();
			const ui = uiCtx(s);
			await s.sub("cockpit");
			expect(s.notes).toContain("Strategium: no active run in this session");
			expect(ui.opened).toEqual([]);
		});

		test("without a UI it warns", async () => {
			const { s, ui } = await running(false);
			await s.sub("cockpit");
			expect(s.notes).toContain("Strategium: the cockpit needs the interactive UI");
			expect(ui.opened).toEqual([]);
		});

		test("the command opens it as an overlay, a second open does nothing, Esc closes it and it opens again", async () => {
			const { s, ui } = await running();
			await s.sub("cockpit");
			expect(ui.opened.length).toBe(1);
			expect(ui.opened[0].options).toEqual({
				overlay: true,
				overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true, mouseTracking: false },
			});
			const lines = ui.opened[0].component.render(100).join("\n");
			expect(lines).toContain("no station yet");
			expect(lines).toContain("CHRONICLE");
			await s.sub("cockpit");
			expect(ui.opened.length).toBe(1);
			ui.opened[0].component.handleInput!("a");
			expect(ui.draws.closed).toBe(0);
			ui.opened[0].component.handleInput!("\x1b");
			expect(ui.draws.closed).toBe(1);
			await s.sub("cockpit");
			expect(ui.opened.length).toBe(2);
			ui.opened[1].component.handleInput!("q");
		});

		test("it is as tall as the terminal and follows a resize", async () => {
			const { s, ui } = await running();
			await s.sub("cockpit");
			expect(ui.opened[0].component.render(100)).toHaveLength(40);
			ui.tui.terminal.rows = 20;
			expect(ui.opened[0].component.render(100)).toHaveLength(20);
			ui.opened[0].component.handleInput!("q");
		});

		test("alt+c is registered and opens it", async () => {
			const { s, ui } = await running();
			expect(s.shortcuts["alt+c"].description).toBe("Open the Strategium cockpit");
			await s.shortcuts["alt+c"].handler(s.ctx);
			expect(ui.opened.length).toBe(1);
			ui.opened[0].component.handleInput!("q");
		});

		test("a configured key opens it", async () => {
			process.env.STRATEGIUM_COCKPIT_KEY = "f8";
			const { s, ui } = await running();
			expect(Object.keys(s.shortcuts)).toEqual(["f8"]);
			await s.shortcuts.f8.handler(s.ctx);
			expect(ui.opened.length).toBe(1);
			ui.opened[0].component.handleInput!("q");
		});

		test("closing the session closes it", async () => {
			const { s, ui } = await running();
			await s.sub("cockpit");
			shutdown(s);
			expect(ui.draws.closed).toBe(1);
		});

		test("the end of the run closes an open overlay", async () => {
			const { s, ui } = await running();
			await s.sub("cockpit");
			await s.sub("end");
			expect(ui.draws.closed).toBe(1);
		});

		describe("a decision closes the cockpit before its dialog opens", () => {
			const call = (s: ReturnType<typeof setup>, event: string, e: object, ctx: unknown = s.ctx) => s.handlers[event].forEach(h => h(e, ctx));
			const open = async () => {
				failAlarm();
				const r = await running();
				await r.s.sub("cockpit");
				expect(r.ui.opened.length).toBe(1);
				return r;
			};

			// The host owns the interval, so the test takes its place and counts what it clears.
			test.each(["ask", "_ask"])("a main-session %s call closes it and it opens again", async name => {
				const cleared: unknown[] = [];
				const real = { set: globalThis.setInterval, clear: globalThis.clearInterval };
				globalThis.setInterval = (() => 7) as never;
				globalThis.clearInterval = ((id: unknown) => void cleared.push(id)) as never;
				try {
					const { s, ui } = await open();
					const before = ui.draws.n;
					call(s, "tool_call", { toolName: name, input: {} });
					expect(ui.draws.closed).toBe(1);
					expect(cleared).toEqual([7]);
					expect(ui.draws.n).toBe(before);
					await s.sub("cockpit");
					expect(ui.opened.length).toBe(2);
					ui.opened[1].component.handleInput!("q");
				} finally {
					globalThis.setInterval = real.set;
					globalThis.clearInterval = real.clear;
				}
			});

			test("the ask call still raises the attention alarm", async () => {
				const { s, ui } = await running();
				await s.sub("cockpit");
				call(s, "tool_call", { toolName: "ask", input: {} });
				expect(ui.draws.closed).toBe(1);
				expect(alarmLines()[0]).toContain("attention|");
			});

			test.each(["tool_approval_requested", "plan_review_requested"])("%s closes it", async event => {
				const { s, ui } = await open();
				call(s, event, { sessionId: "sess-0001" });
				expect(ui.draws.closed).toBe(1);
				await s.sub("cockpit");
				expect(ui.opened.length).toBe(2);
				ui.opened[1].component.handleInput!("q");
			});

			test("another tool call leaves it open", async () => {
				const { s, ui } = await open();
				call(s, "tool_call", { toolName: "read", input: {} });
				expect(ui.draws.closed).toBe(0);
				ui.opened[0].component.handleInput!("q");
			});

			test.each(["tool_call", "tool_approval_requested", "plan_review_requested"])("a sub agent's %s leaves it open", async event => {
				const { s, ui } = await open();
				call(s, event, { toolName: "ask", input: {}, sessionId: "sess-0001" }, { ...(s.ctx as object), agent: { kind: "sub" } });
				expect(ui.draws.closed).toBe(0);
				ui.opened[0].component.handleInput!("q");
			});

			test("with no cockpit open the three events change nothing and do not throw", async () => {
				failAlarm();
				const { s, ui } = await running();
				expect(() => {
					call(s, "tool_call", { toolName: "ask", input: {} });
					call(s, "tool_approval_requested", {});
					call(s, "plan_review_requested", { sessionId: "sess-0001" });
				}).not.toThrow();
				expect(ui.draws.closed).toBe(0);
			});
		});

		describe("the header says what the agent is doing", () => {
			const host = (s: ReturnType<typeof setup>) => (s.ctx as unknown as { host: { idle: boolean; pending: boolean } }).host;
			const view = (ui: ReturnType<typeof uiCtx>) => plain(ui.opened.at(-1)!.component.render(100).join("\n"));
			const emit = (s: ReturnType<typeof setup>, event: string, ctx: unknown = s.ctx) => s.handlers[event].forEach(h => h({}, ctx));

			test("opened while the session is idle the vox is open; opened mid-turn the agent is at work", async () => {
				const { s, ui } = await running();
				host(s).idle = true;
				expect(await peek(s, ui)).toContain("○ VOX OPEN · esc to give orders");
				host(s).idle = false;
				expect(await peek(s, ui)).toContain("AGENT AT WORK");
			});

			test("a queued message keeps the agent at work although the session is idle", async () => {
				const { s, ui } = await running();
				Object.assign(host(s), { idle: true, pending: true });
				expect(await peek(s, ui)).toContain("AGENT AT WORK");
			});

			test("agent_start and agent_end change an open cockpit and repaint it without ticking", async () => {
				const { s, ui } = await running();
				host(s).idle = true;
				await s.sub("cockpit");
				expect(view(ui)).toContain("○ VOX OPEN · esc to give orders");
				let n = ui.draws.n;
				host(s).idle = false;
				emit(s, "agent_start");
				expect(view(ui)).toContain("AGENT AT WORK");
				expect(ui.draws.n).toBeGreaterThan(n); // agent_start also refreshes the footer, which redraws the overlay
				n = ui.draws.n;
				Object.assign(host(s), { idle: true });
				emit(s, "agent_end");
				expect(view(ui)).toContain("○ VOX OPEN · esc to give orders");
				expect(ui.draws.n).toBe(n + 1);
				ui.opened[0].component.handleInput!("q");
			});

			test("an agent_end with messages queued keeps it at work", async () => {
				const { s, ui } = await running();
				await s.sub("cockpit");
				Object.assign(host(s), { idle: true, pending: true });
				emit(s, "agent_end");
				expect(view(ui)).toContain("AGENT AT WORK");
				ui.opened[0].component.handleInput!("q");
			});

			test("a sub agent's agent_start and agent_end are ignored", async () => {
				const { s, ui } = await running();
				host(s).idle = true;
				await s.sub("cockpit");
				const n = ui.draws.n;
				emit(s, "agent_start", { ...(s.ctx as object), agent: { kind: "sub" } });
				emit(s, "agent_end", { ...(s.ctx as object), agent: { kind: "sub" } });
				expect(view(ui)).toContain("○ VOX OPEN · esc to give orders");
				expect(ui.draws.n).toBe(n);
				ui.opened[0].component.handleInput!("q");
			});

			test("the 500 ms redraw catches an idle that agent_end saw too early", async () => {
				const timers: { fn: () => void; ms: number }[] = [];
				const real = globalThis.setInterval;
				const { s, ui } = await running();
				globalThis.setInterval = ((fn: () => void, ms: number) => timers.push({ fn, ms })) as never;
				try {
					await s.sub("cockpit");
					emit(s, "agent_end"); // still streaming for the host
					expect(view(ui)).toContain("AGENT AT WORK");
					host(s).idle = true;
					timers[0].fn();
					expect(view(ui)).toContain("○ VOX OPEN · esc to give orders");
					ui.opened[0].component.handleInput!("q");
				} finally {
					globalThis.setInterval = real;
				}
			});

			test("an async job keeps the agent at work while the session is idle, and its end flips the open cockpit to awaiting", async () => {
				const timers: { fn: () => void; ms: number }[] = [];
				const real = globalThis.setInterval;
				const { s, ui } = await running();
				Object.assign(host(s), { idle: true, jobs: { running: [{}] } });
				globalThis.setInterval = ((fn: () => void, ms: number) => timers.push({ fn, ms })) as never;
				try {
					await s.sub("cockpit");
					expect(view(ui)).toContain("▶ AGENT AT WORK");
					emit(s, "agent_end"); // the turn ended, the job did not
					expect(view(ui)).toContain("AGENT AT WORK");
					Object.assign(host(s), { jobs: { running: [] } });
					timers[0].fn();
					expect(view(ui)).toContain("○ VOX OPEN · esc to give orders");
					ui.opened[0].component.handleInput!("q");
				} finally {
					globalThis.setInterval = real;
				}
			});

			test("a plan review still closes the cockpit, so the status never has to show it", async () => {
				const { s, ui } = await running();
				await s.sub("cockpit");
				s.handlers.plan_review_requested.forEach(h => h({ sessionId: "sess-0001" }, s.ctx));
				expect(ui.draws.closed).toBe(1);
			});
		});

		// The host owns the interval, so the test takes its place: the callback is driven by hand.
		test("every 500 ms the mark flips and the overlay repaints, until it closes", async () => {
			const timers: { fn: () => void; ms: number }[] = [];
			const cleared: unknown[] = [];
			const real = { set: globalThis.setInterval, clear: globalThis.clearInterval };
			const { s, ui } = await running();
			s.todo([{ name: "Plan", tasks: [{ content: "Draft", status: "in_progress" }] }]);
			globalThis.setInterval = ((fn: () => void, ms: number) => timers.push({ fn, ms })) as never;
			globalThis.clearInterval = ((id: unknown) => void cleared.push(id)) as never;
			try {
				await s.sub("cockpit");
				expect(timers.map(t => t.ms)).toEqual([500]);
				const comp = ui.opened[0].component;
				const text = () => plain(comp.render(100).join("\n"));
				expect(text()).toContain("▶");
				expect(text()).not.toContain("▷");
				const before = ui.draws.n;
				timers[0].fn();
				expect(ui.draws.n).toBe(before + 1);
				expect(text()).toContain("▷");
				expect(text()).not.toContain("▶");
				timers[0].fn();
				expect(text()).toContain("▶");
				expect(cleared).toEqual([]);
				comp.handleInput!("q");
				expect(cleared).toEqual([1]);
			} finally {
				globalThis.setInterval = real.set;
				globalThis.clearInterval = real.clear;
			}
		});

		test("a rejected overlay leaves the cockpit closed, so it opens again", async () => {
			const { s } = await running();
			let calls = 0;
			(s.ctx.ui as Record<string, unknown>).custom = () => {
				calls++;
				return calls === 1 ? Promise.reject(new Error("boom")) : new Promise(() => {});
			};
			await s.sub("cockpit");
			await Bun.sleep(0);
			await s.sub("cockpit");
			expect(calls).toBe(2);
		});

		test("a custom() that resolves without building the overlay (RPC) leaves it closed, so it opens again", async () => {
			const { s } = await running();
			let calls = 0;
			(s.ctx.ui as Record<string, unknown>).custom = () => {
				calls++;
				return Promise.resolve(undefined);
			};
			await s.sub("cockpit");
			await Bun.sleep(0);
			await s.sub("cockpit");
			expect(calls).toBe(2);
		});

		test("an overlay that rejects after it was built is closed cleanly", async () => {
			const { s, ui } = await running();
			const built: Comp[] = [];
			(s.ctx.ui as Record<string, unknown>).custom = (factory: (t: Tui, th: unknown, k: unknown, done: () => void) => Comp) => {
				built.push(factory(ui.tui, {}, {}, () => void ui.draws.closed++));
				return built.length === 1 ? Promise.reject(new Error("boom")) : new Promise(() => {});
			};
			await s.sub("cockpit");
			await Bun.sleep(0);
			expect(ui.draws.closed).toBe(1);
			await s.sub("cockpit");
			expect(built.length).toBe(2);
			built[1].handleInput!("q");
			expect(ui.draws.closed).toBe(2);
		});

		test("a todo and a task event repaint and refresh an open overlay", async () => {
			const { s, ui } = await running();
			await s.sub("cockpit");
			const comp = ui.opened[0].component;
			let n = ui.draws.n;
			s.todo(sealTodo("in_progress"));
			expect(ui.draws.n).toBeGreaterThan(n);
			expect(plain(comp.render(100).join("\n"))).toContain("seal Plan");
			n = ui.draws.n;
			s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [{ agent: "scout", name: "S", task: "look" }] }, details: { progress: [{ index: 0, id: "S", status: "running" }] }, isError: false }, s.ctx));
			expect(ui.draws.n).toBeGreaterThan(n);
			expect(plain(comp.render(100).join("\n"))).toContain("SCOUT");
			comp.handleInput!("q");
		});
	});

	describe("seals", () => {
		test("a granted seal sounds the done fanfare once and the todo is kept on the run", async () => {
			const { s } = await running();
			s.todo(sealTodo("in_progress"));
			s.todo(sealTodo("completed"));
			expect(alarmLines()).toEqual(["done|K-1: seal Plan granted"]);
			s.todo(sealTodo("completed"));
			await Bun.sleep(300);
			expect(alarmLines()).toEqual(["done|K-1: seal Plan granted"]);
			expect(JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8")).phases).toEqual(sealTodo("completed"));
		});

		// A second seal, granted the normal way, proves the recorder is live: only its line may be in the file.
		const other = (status: string) => [{ name: "Other", tasks: [{ content: "[seal] Other", status }] }];
		async function control(s: ReturnType<typeof setup>) {
			s.todo(other("in_progress"));
			s.todo(other("completed"));
			expect(alarmLines()).toEqual(["done|K-1: seal Other granted"]);
			await Bun.sleep(300);
			expect(alarmLines()).toEqual(["done|K-1: seal Other granted"]);
		}

		test("a seal first seen granted does not sound", async () => {
			const { s } = await running();
			s.todo(sealTodo("completed"));
			await control(s);
		});

		test("with notifications off it stays silent", async () => {
			const { s } = await running();
			await s.sub("config", "notify off");
			s.todo(sealTodo("in_progress"));
			s.todo(sealTodo("completed"));
			await s.sub("config", "notify on");
			await control(s);
		});

		test("a failing alarm is reported", async () => {
			const { s } = await running();
			s.todo(sealTodo("in_progress"));
			failAlarm();
			s.todo(sealTodo("completed"));
			expect(s.notes.some(n => n.includes("the alarm failed"))).toBe(true);
		});

		test("without a UI a granted seal still sounds and nothing is drawn", async () => {
			const { s } = await running(false);
			s.todo(sealTodo("in_progress"));
			s.todo(sealTodo("completed"));
			expect(alarmLines()).toEqual(["done|K-1: seal Plan granted"]);
		});

		test("a granted seal reaches the overlay", async () => {
			const { s, ui } = await running();
			s.todo(sealTodo("in_progress"));
			s.todo(sealTodo("completed"));
			expect(await peek(s, ui)).toContain("granted");
		});

		test("the Muster Orders task is no seal", async () => {
			const { s, ui } = await running();
			const orders = (status: string) => [{ name: "Muster", tasks: [{ content: "[captain] Orders", status }] }];
			s.todo(orders("in_progress"));
			s.todo(orders("completed"));
			await control(s);
			const t = await peek(s, ui);
			expect(t).not.toContain("Orders granted");
			expect(t).not.toContain("seal Orders");
		});
	});

	describe("the chronicle", () => {
		const brother = (name: string, agent = "battle-brother") => ({ agent, name, isolated: true, task: "build squad a." });
		const result = (s: ReturnType<typeof setup>, agent: string, status: string) =>
			s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [brother("A", agent)] }, details: { progress: [{ index: 0, id: "A", status }] }, isError: false }, s.ctx));
		const jobEnd = (s: ReturnType<typeof setup>, status: string) =>
			s.handlers.context.forEach(h => h({ type: "context", messages: [{ role: "custom", details: { jobs: [{ jobId: "j", type: "task", status, label: "A" }] } }] }, s.ctx));
		async function squad() {
			const r = await running();
			await r.s.call({ action: "slices", slices: [{ id: "a", parallel: false, files: ["a.ts"] }] });
			r.s.todo([{ name: "Skirmish", tasks: [{ content: "[battle-brother] Build squad a", status: "in_progress" }] }]);
			return r;
		}

		test("a task agent deployed in Auspex shows in SCOUTS, running then returned", async () => {
			const { s, ui } = await running();
			s.todo([{ name: "Muster", tasks: [{ content: "[captain] Plan", status: "completed" }] }, { name: "Auspex", tasks: [{ content: "[scout] Map the code", status: "in_progress" }] }]);
			result(s, "scout", "running");
			const overlay = await peek(s, ui);
			expect(overlay).toContain("SCOUTS");
			expect(overlay).toMatch(/│ ▶ A +│/);
			jobEnd(s, "completed");
			expect(await peek(s, ui)).toMatch(/│ ✓ A +│/);
		});

		test("an agent stays under its station when the todo is rebuilt in another order", async () => {
			const { s, ui } = await running();
			const muster = { name: "Muster", tasks: [{ content: "[captain] Plan", status: "completed" }] };
			const auspex = (status: string) => ({ name: "Auspex", tasks: [{ content: "[scout] Map the code", status }] });
			s.todo([muster, auspex("in_progress")]);
			result(s, "scout", "running");
			s.todo([auspex("in_progress"), muster]);
			expect(await peek(s, ui)).toMatch(/│ ▶ A +│/);
			s.todo([auspex("completed"), { name: "Muster", tasks: [{ content: "[captain] Plan", status: "in_progress" }] }]);
			expect(await peek(s, ui)).not.toMatch(/│ ▶ A +│/);
		});

		test("a deployed builder is logged, and its failure too, newest first", async () => {
			const { s, ui } = await squad();
			result(s, "battle-brother", "running");
			jobEnd(s, "failed");
			const entries = (await chron(s, ui)).split("\n").filter(l => l.includes("SQUAD a"));
			expect(entries).toHaveLength(2);
			expect(entries[0]).toContain("✗ failed");
			expect(entries[1]).toContain("† battle-brother deployed");
			expect(await peek(s, ui)).toMatch(/✗ † squad a failed/);
		});

		test("a builder that returns is logged once", async () => {
			const { s, ui } = await squad();
			result(s, "battle-brother", "running");
			jobEnd(s, "completed");
			jobEnd(s, "completed");
			expect((await chron(s, ui)).match(/returned/g)?.length).toBe(1);
		});

		test("the same running agent seen twice is deployed once", async () => {
			const { s, ui } = await squad();
			result(s, "battle-brother", "running");
			result(s, "battle-brother", "running");
			expect((await chron(s, ui)).match(/deployed/g)?.length).toBe(1);
		});

		test("a pending agent is deployed", async () => {
			const { s, ui } = await squad();
			result(s, "battle-brother", "pending");
			expect(await chron(s, ui)).toContain("deployed");
		});

		test("a completed task result logs the return and an unknown id logs nothing", async () => {
			const { s, ui } = await squad();
			result(s, "battle-brother", "completed");
			expect(await chron(s, ui)).not.toContain("returned");
			result(s, "battle-brother", "running");
			result(s, "battle-brother", "completed");
			const entries = (await chron(s, ui)).split("\n").filter(l => l.includes("SQUAD a"));
			expect(entries).toHaveLength(2);
			expect(entries[0]).toContain("✓ returned");
			result(s, "battle-brother", "completed");
			expect((await chron(s, ui)).match(/returned/g)?.length).toBe(1);
			expect(await peek(s, ui)).not.toMatch(/✗ † squad a failed/);
		});

		test.each(["failed", "aborted"])("a %s task result logs the failure and, once the agent is gone, marks the squad in the overlay", async status => {
			const { s, ui } = await squad();
			result(s, "battle-brother", "running");
			result(s, "battle-brother", status);
			const entries = (await chron(s, ui)).split("\n").filter(l => l.includes("SQUAD a"));
			expect(entries).toHaveLength(2);
			expect(entries[0]).toContain("✗ failed");
			// The host's job end removes the agent from the run; the next redraw shows the note.
			jobEnd(s, status);
			await s.call({ action: "status" });
			expect(await peek(s, ui)).toMatch(/✗ † squad a failed/);
		});

		test("a veteran for a squad is an escalation and the overlay box says so", async () => {
			const { s, ui } = await squad();
			result(s, "veteran", "running");
			expect(await chron(s, ui)).toContain("escalated to VETERAN");
			expect(await peek(s, ui)).toContain("‡ squad a");
		});

		test("a station change and a seal waiting are logged, the seal after the station", async () => {
			const { s, ui } = await running();
			s.todo([{ name: "Plan", tasks: [{ content: "[seal] Plan", status: "in_progress" }] }]);
			const text = await chron(s, ui);
			expect(text).toContain("station Plan");
			expect(text).toContain("seal Plan awaits the Chapter Master");
			expect(text.indexOf("awaits the Chapter Master")).toBeLessThan(text.indexOf("station Plan"));
		});

		test("the same seal waiting sent twice is logged once", async () => {
			const { s, ui } = await running();
			s.todo(sealTodo("in_progress"));
			s.todo(sealTodo("in_progress"));
			const text = await chron(s, ui);
			expect(text.match(/awaits the Chapter Master/g)?.length).toBe(1);
			expect(text.match(/station Plan/g)?.length).toBe(1);
		});

		test("closing the session empties the memory, and the saved state brings it back on the next start", async () => {
			const { s, ui } = await running();
			s.todo(sealTodo("in_progress"));
			expect(await chron(s, ui)).toContain("station Plan");
			shutdown(s);
			await s.start();
			const text = await peek(s, ui);
			expect(text).toContain("K-1");
			expect(text).toContain("station Plan");
		});

		test("a run with a new key starts a clean chronicle", async () => {
			const { s, ui } = await running();
			s.todo(sealTodo("in_progress"));
			expect(await chron(s, ui)).toContain("station Plan");
			await s.sub("end");
			await s.call({ action: "begin", key: "K-2" });
			await s.sub("status");
			const text = await peek(s, ui);
			expect(text).toContain("K-2");
			expect(text).not.toContain("station Plan");
		});

		describe("the cockpit after a restart", () => {
			const cockpitFile = (dir: string, sid = "sess-0001") => join(dir, "runs", `${sid}.cockpit`);
			const saved = (dir: string, sid?: string) => JSON.parse(readFileSync(cockpitFile(dir, sid), "utf8"));
			const squads = ["a", "b", "c", "d"].map(id => ({ id, parallel: true, files: [`${id}.ts`] }));
			const items = ["a", "b", "c", "d"].map(id => ({ agent: "battle-brother", name: id, isolated: true, task: `build squad ${id}.` }));
			// Agent ids are the squad ids; squad d is first built by a battle-brother, then escalated to a veteran.
			const deploy = (s: ReturnType<typeof setup>, statuses: Record<string, string>, agent?: string) =>
				s.handlers.tool_result.forEach(h =>
					h(
						{
							toolName: "task",
							input: { tasks: items.map(i => (agent ? { ...i, agent } : i)) },
							details: { progress: Object.entries(statuses).map(([id, status]) => ({ index: "abcd".indexOf(id[0]), id, status })) },
							isError: false,
						},
						s.ctx,
					),
				);
			const ends = (s: ReturnType<typeof setup>, ...jobs: [string, string][]) =>
				s.handlers.context.forEach(h => h({ type: "context", messages: [{ role: "custom", details: { jobs: jobs.map(([label, status]) => ({ jobId: `j${label}`, type: "task", status, label })) } }] }, s.ctx));
			// A run mid-Skirmish: a running, b returned, c failed, d escalated to a veteran, and a seal granted.
			async function midRun() {
				const { s, ui } = await running();
				await s.call({ action: "slices", slices: squads });
				s.todo([{ name: "Plan", tasks: [{ content: "[seal] Plan", status: "in_progress" }] }]);
				s.todo([{ name: "Plan", tasks: [{ content: "[seal] Plan", status: "completed" }] }, { name: "Skirmish", tasks: [{ content: "[battle-brother] Build squads", status: "in_progress" }] }]);
				deploy(s, { a: "running", b: "running", c: "running", d: "running" });
				ends(s, ["b", "completed"], ["c", "failed"]);
				deploy(s, { d2: "running" }, "veteran");
				return { s, ui };
			}
			// What the user sees, minus the clock row.
			const view = async (s: ReturnType<typeof setup>, ui: ReturnType<typeof uiCtx>) =>
				(await peek(s, ui)).split("\n").filter(l => !l.includes("⧗")).join("\n");
			// A new process on the same state dir. A shutdown first, unless it crashed.
			async function restart(s: ReturnType<typeof setup>, crash = false) {
				if (!crash) shutdown(s);
				const again = setup("sess-0001", s.dir);
				const ui = uiCtx(again);
				await again.start();
				return { s: again, ui };
			}

			test("write, reload, same view: chronicle, agents and marks", async () => {
				const { s, ui } = await midRun();
				const before = await view(s, ui);
				expect(before).toMatch(/▶ † squad a/);
				expect(before).toContain("✠ SEAL"); // the chronicle's who-column; the SEALS row shares the clock row, which view() drops
				expect(before).toContain("✓");
				expect(before).toContain("✗");
				expect(before).toContain("‡");
				const again = await restart(s);
				expect(await view(again.s, again.ui)).toBe(before);
			});

			test("the same after a crash, with no session_shutdown", async () => {
				const { s, ui } = await midRun();
				const before = await view(s, ui);
				const again = await restart(s, true);
				expect(await view(again.s, again.ui)).toBe(before);
			});

			test("three restarts leave no duplicates, and a replayed job end logs nothing", async () => {
				const { s, ui } = await midRun();
				const before = await view(s, ui);
				const count = () => saved(s.dir);
				const n = count().chronicle.length;
				let cur = { s, ui };
				for (let i = 0; i < 3; i++) {
					cur = await restart(cur.s, i === 1);
					ends(cur.s, ["b", "completed"], ["c", "failed"]);
					deploy(cur.s, { a: "running", b: "completed", c: "failed" });
				}
				expect(count().chronicle).toHaveLength(n);
				expect(count().deployed).toHaveLength(5);
				expect(await view(cur.s, cur.ui)).toBe(before);
			});

			test("end then begin of the same key starts clean, and so does a restart", async () => {
				const { s, ui } = await midRun();
				expect(existsSync(cockpitFile(s.dir))).toBe(true);
				await s.sub("end");
				expect(existsSync(cockpitFile(s.dir))).toBe(false);
				await s.call({ action: "begin", key: "K-1" });
				await s.sub("status");
				const fresh = await peek(s, ui);
				expect(fresh).toContain("K-1");
				for (const old of ["granted", "returned", "failed", "escalated"]) expect(fresh).not.toContain(old);
				const again = await restart(s);
				const text = await peek(again.s, again.ui);
				for (const old of ["granted", "returned", "failed", "escalated"]) expect(text).not.toContain(old);
			});

			test("a new key starts clean and ignores a file saved under another key", async () => {
				const { s, ui } = await midRun();
				await s.sub("end");
				writeFileSync(cockpitFile(s.dir), JSON.stringify({ key: "K-1", chronicle: [{ at: "10:00", who: "OLD", text: "stale entry" }], notes: {}, deployed: [] }));
				await s.call({ action: "begin", key: "K-2" });
				await s.sub("status");
				expect(await peek(s, ui)).not.toContain("stale entry");
				const again = await restart(s);
				const text = await peek(again.s, again.ui);
				expect(text).toContain("K-2");
				expect(text).not.toContain("stale entry");
				expect(saved(s.dir).key).toBe("K-2");
			});

			test("the chronicle keeps 200 entries on disk, the newest, and the overlay shows the newest first", async () => {
				const { s, ui } = await running();
				for (let i = 0; i < 205; i++) s.todo([{ name: `St${i}`, tasks: [{ content: "[captain] Go", status: "in_progress" }] }]);
				const file = saved(s.dir);
				expect(file.chronicle).toHaveLength(200);
				expect(file.chronicle.at(-1).text).toBe("station St204");
				expect(file.chronicle[0].text).toBe("station St5");
				const again = await restart(s);
				const text = await chron(again.s, again.ui);
				expect(text.indexOf("station St204")).toBeLessThan(text.indexOf("station St203"));
				expect(text).not.toContain("station St4 ");
			});

			test("an untouched tick writes nothing", async () => {
				const { s } = await midRun();
				const f = cockpitFile(s.dir);
				const before = readFileSync(f, "utf8");
				rmSync(f);
				// The same todo again: a redraw with nothing new to log.
				s.todo([{ name: "Plan", tasks: [{ content: "[seal] Plan", status: "completed" }] }, { name: "Skirmish", tasks: [{ content: "[battle-brother] Build squads", status: "in_progress" }] }]);
				expect(existsSync(f)).toBe(false);
				expect(before).toContain("station Skirmish");
			});

			test("a begin of another key starts clean when the restart comes before any draw", async () => {
				const { s } = await running();
				await s.call({ action: "begin", key: "K-2" });
				writeFileSync(cockpitFile(s.dir), JSON.stringify({ key: "K-1", chronicle: [{ at: "10:00", who: "OLD", text: "stale entry" }], notes: {}, deployed: [] }));
				const again = await restart(s, true);
				const text = await peek(again.s, again.ui);
				expect(text).toContain("K-2");
				expect(text).not.toContain("stale entry");
			});

			test("a saved file of 250 entries comes back as the newest 200", async () => {
				const { s } = await running();
				const chronicle = Array.from({ length: 250 }, (_, i) => ({ at: "10:00", who: "CAPTAIN", text: `entry-${String(i).padStart(3, "0")}` }));
				writeFileSync(cockpitFile(s.dir), JSON.stringify({ key: "K-1", chronicle, notes: {}, deployed: [] }));
				const again = await restart(s, true);
				again.ui.tui.terminal.rows = 1000;
				const shown = (await peek(again.s, again.ui)).match(/entry-\d{3}/g)!;
				expect(shown).toHaveLength(200);
				expect(shown).toContain("entry-249");
				expect(shown).not.toContain("entry-049");
			});

			test("a restart with nothing new does not rewrite the file", async () => {
				const { s } = await midRun();
				const pretty = JSON.stringify(saved(s.dir), null, 1);
				writeFileSync(cockpitFile(s.dir), pretty);
				await restart(s, true);
				expect(readFileSync(cockpitFile(s.dir), "utf8")).toBe(pretty);
			});

			test("a corrupt file starts the cockpit clean and the next draw replaces it with valid JSON", async () => {
				const { s, ui } = await midRun();
				writeFileSync(cockpitFile(s.dir), "{not json");
				await s.start();
				const text = await chron(s, ui);
				for (const old of ["granted", "returned", "failed", "escalated"]) expect(text).not.toContain(old);
				expect(saved(s.dir).key).toBe("K-1");
				expect(saved(s.dir).chronicle.map((e: { text: string }) => e.text).join()).not.toContain("granted");
			});

			test("a failed write keeps the state dirty and the next draw writes it", async () => {
				const { s } = await running();
				const f = cockpitFile(s.dir);
				rmSync(f, { force: true });
				mkdirSync(f); // the rename onto a directory fails
				const todo = [{ name: "Plan", tasks: [{ content: "[captain] Go", status: "in_progress" }] }];
				s.todo(todo);
				rmSync(f, { recursive: true });
				s.todo(todo); // nothing new to log: only dirty makes this draw write
				expect(saved(s.dir).chronicle.map((e: { text: string }) => e.text)).toContain("station Plan");
			});

			test("an entry that is no chronicle entry makes the file malformed", async () => {
				const { s } = await midRun();
				writeFileSync(cockpitFile(s.dir), JSON.stringify({ ...saved(s.dir), chronicle: [null] }));
				const again = await restart(s, true);
				again.s.todo([{ name: "Debrief", tasks: [{ content: "[captain] Report", status: "in_progress" }] }]);
				expect(saved(s.dir).chronicle.map((e: { text: string }) => e.text)).toEqual(["station Debrief"]);
			});

			test.each([
				["notes null", { notes: null }],
				["chronicle a string", { chronicle: "oops" }],
				["deployed not an array", { deployed: "x" }],
				["a deployed entry that is no [id, job]", { deployed: [["a", "x"]] }],
				["notes an array", { notes: [] }],
				["a numeric deployed id", { deployed: [[1, {}]] }],
			])("a saved file with %s starts clean", async (_n, bad) => {
				const { s } = await midRun();
				writeFileSync(cockpitFile(s.dir), JSON.stringify({ ...saved(s.dir), ...bad }));
				const again = await restart(s, true);
				again.s.todo([{ name: "Debrief", tasks: [{ content: "[captain] Report", status: "in_progress" }] }]);
				const file = saved(s.dir);
				expect(file.notes).toEqual({});
				expect(file.deployed).toEqual([]);
				expect(file.chronicle.map((e: { text: string }) => e.text)).toEqual(["station Debrief"]);
			});

			test("a plan-review move of a run the cockpit never drew loads the new session's file instead of carrying stale memory", async () => {
				// This process saw no run at start (cockpit memory has no key); another one then began K-1 under the same session id.
				const s = setup("sess-0001");
				const ui = uiCtx(s);
				await s.start();
				await setup("sess-0001", s.dir).call({ action: "begin", key: "K-1" });
				writeFileSync(cockpitFile(s.dir, "sess-0002"), JSON.stringify({ key: "K-1", chronicle: [{ at: "10:00", who: "DISK", text: "from disk" }], notes: {}, deployed: [] }));
				await s.handlers.plan_review_requested[0]({ sessionId: "sess-0001" }, s.ctx);
				s.ctx.sessionManager.getSessionId = () => "sess-0002";
				await s.handlers.session_switch[0]({ reason: "new" }, s.ctx);
				expect(await peek(s, ui)).toContain("from disk");
			});

			describe("another session takes the ticket", () => {
				const second = (s: ReturnType<typeof setup>) => setup("sess-0002", s.dir);

				test("a begin that takes another session's key removes its cockpit file", async () => {
					const { s } = await midRun();
					expect(existsSync(cockpitFile(s.dir))).toBe(true);
					await second(s).call({ action: "begin", key: "K-1", takeover: "sess-0001" });
					expect(existsSync(cockpitFile(s.dir))).toBe(false);
				});

				test("a session that finds its lock lost drops its cockpit file", async () => {
					const { s } = await midRun();
					writeFileSync(lockPath(s.dir, "K-1"), "sess-0002");
					expect(await s.call({ action: "repo", repo: s.dir })).toContain("ERROR");
					expect(existsSync(cockpitFile(s.dir))).toBe(false);
				});

				test("a session whose claim fails at start keeps no cockpit file", async () => {
					const { s } = await midRun();
					writeFileSync(lockPath(s.dir, "K-1"), "sess-0002");
					await restart(s, true);
					expect(existsSync(cockpitFile(s.dir))).toBe(false);
				});

				test("a later begin of the same key does not bring the lost run's cockpit back", async () => {
					const { s, ui } = await midRun();
					writeFileSync(lockPath(s.dir, "K-1"), "sess-0002");
					await s.call({ action: "repo", repo: s.dir });
					await s.call({ action: "begin", key: "K-1", takeover: "sess-0002" });
					const text = await peek(s, ui);
					for (const old of ["granted", "returned", "failed", "escalated"]) expect(text).not.toContain(old);
					expect(saved(s.dir).chronicle.map((e: { text: string }) => e.text).join()).not.toContain("granted");
				});
			});

			describe("the seal panel", () => {
				const waiting = (id = "Plan") => [{ name: "Scriptorium", tasks: [{ content: `[seal] ${id}`, status: "in_progress" }] }];
				const granted = (id = "Plan") => [{ name: "Scriptorium", tasks: [{ content: `[seal] ${id}`, status: "completed" }] }];
				async function sealed(id = "Plan") {
					const r = await running();
					r.s.todo(waiting(id));
					return r;
				}

				test("no run in this session: ERROR", async () => {
					expect(await setup().call({ action: "seal", lines: ["x"] })).toBe("ERROR no active run in this session");
				});

				test("no seal waits: ERROR, and nothing is stored", async () => {
					const { s } = await running();
					expect(await s.call({ action: "seal", lines: ["x"] })).toBe("ERROR no seal waits; start its [seal] task first");
					s.todo([{ name: "Scriptorium", tasks: [{ content: "[seal] Plan", status: "pending" }] }]);
					expect(await s.call({ action: "seal", lines: ["x"] })).toBe("ERROR no seal waits; start its [seal] task first");
					expect(saved(s.dir).seal).toBeUndefined();
				});

				test("stores the lines for the waiting seal and the overlay shows them", async () => {
					const { s, ui } = await sealed();
					expect(await s.call({ action: "seal", lines: ["Squads: a, b", "Merge bar: tests"] })).toBe("SEAL Plan panel 2 lines");
					const t = await peek(s, ui);
					expect(t).toContain("SEAL PLAN · awaits you");
					expect(t).toContain("Squads: a, b");
					expect(t).toContain("Merge bar: tests");
					expect(t).not.toContain("the details are in the Captain's message");
					expect(saved(s.dir).seal).toEqual({ id: "Plan", lines: ["Squads: a, b", "Merge bar: tests"] });
				});

				test("without lines the panel shows its default line", async () => {
					const { s, ui } = await sealed();
					expect(await s.call({ action: "seal" })).toBe("SEAL Plan panel 0 lines");
					expect(await peek(s, ui)).toContain("the details are in the Captain's message");
				});

				test("trailing blank lines are dropped before storing and counting; all blank stores none", async () => {
					const { s } = await sealed();
					expect(await s.call({ action: "seal", lines: ["a", "", "  ", "\x1b\t"] })).toBe("SEAL Plan panel 1 lines");
					expect(saved(s.dir).seal.lines).toEqual(["a"]);
					expect(await s.call({ action: "seal", lines: ["", " "] })).toBe("SEAL Plan panel 0 lines");
					expect(saved(s.dir).seal.lines).toEqual([]);
				});

				test("an oversized seal file is capped on load like the action caps it", async () => {
					const { s } = await sealed();
					await s.call({ action: "seal", lines: ["x"] });
					const lines = Array.from({ length: 300 }, (_, i) => `L${i}:${"y".repeat(900)}`);
					writeFileSync(cockpitFile(s.dir), JSON.stringify({ ...saved(s.dir), seal: { id: "Plan", lines } }));
					const again = await restart(s, true);
					await again.s.sub("cockpit");
					const comp = again.ui.opened.at(-1)!.component;
					const raw = plain(comp.render(2000).join("\n"));
					comp.handleInput!("q");
					expect(raw).not.toContain("y".repeat(501));
					expect(raw).not.toContain("L250:");
				});

				test("control characters become spaces: an escape sequence never reaches the overlay or the file", async () => {
					const { s, ui } = await sealed();
					await s.call({ action: "seal", lines: ["a\x1b[31mred\tb\x7f\x9bz\r\n", "\x1b]0;title\x07tail"] });
					expect(saved(s.dir).seal.lines).toEqual(["a [31mred b  z", " ]0;title tail"]);
					await s.sub("cockpit");
					const comp = ui.opened.at(-1)!.component;
					const raw = comp.render(100).join("\n");
					comp.handleInput!("q");
					expect(raw).toContain("a [31mred b  z");
					expect(raw.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
					expect(plain(raw)).toContain("]0;title tail");
				});

				test("it survives a restart, orderly or crashed", async () => {
					const { s, ui } = await sealed();
					await s.call({ action: "seal", lines: ["Squads: a"] });
					const before = await view(s, ui);
					const again = await restart(s);
					expect(await view(again.s, again.ui)).toBe(before);
					expect(before).toContain("Squads: a");
					const crashed = await restart(again.s, true);
					expect(await view(crashed.s, crashed.ui)).toBe(before);
				});

				test("granting that seal clears it from memory and file", async () => {
					const { s, ui } = await sealed();
					await s.call({ action: "seal", lines: ["Squads: a"] });
					s.todo(granted());
					expect(saved(s.dir).seal).toBeUndefined();
					expect(await peek(s, ui)).not.toContain("SEAL PLAN");
					// The same seal waiting again does not bring the old lines back.
					s.todo(waiting());
					const t = await peek(s, ui);
					expect(t).toContain("the details are in the Captain's message");
					expect(t).not.toContain("Squads: a");
				});

				test("lines read from the file are cleaned at render: no escape reaches the terminal", async () => {
					const { s } = await sealed();
					await s.call({ action: "seal", lines: ["x"] });
					writeFileSync(cockpitFile(s.dir), JSON.stringify({ ...saved(s.dir), seal: { id: "Plan", lines: ["a\x1b]0;PWN\x07tail", "b\u202ec"] } }));
					const again = await restart(s, true);
					await again.s.sub("cockpit");
					const comp = again.ui.opened.at(-1)!.component;
					const raw = comp.render(100).join("\n");
					comp.handleInput!("q");
					expect(raw).not.toContain("\x1b]");
					expect(raw.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/);
					expect(plain(raw)).toContain("a ]0;PWN tail");
				});

				test("a seal name from the todo text is cleaned wherever it is displayed", async () => {
					const { s, ui } = await running();
					s.todo(waiting("Plan\x1b]0;pwn\x07"));
					await s.sub("cockpit");
					const comp = ui.opened.at(-1)!.component;
					const raw = comp.render(140).join("\n");
					comp.handleInput!("q");
					expect(raw.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
					expect(plain(raw)).toContain("SEAL PLAN ]0;PWN  · awaits you");
				});

				test("the lines die with the wait: Plan back to pending, or a rebuild init, then waiting again shows the default line", async () => {
					const DEFAULT = "the details are in the Captain's message";
					const { s, ui } = await sealed();
					await s.call({ action: "seal", lines: ["Squads: a"] });
					s.todo([{ name: "Scriptorium", tasks: [{ content: "[seal] Plan", status: "pending" }] }]);
					expect(saved(s.dir).seal).toBeUndefined();
					s.todo(waiting());
					expect(await peek(s, ui)).toContain(DEFAULT);
					await s.call({ action: "seal", lines: ["Squads: b"] });
					s.handlers.tool_result.forEach(h =>
						h({ toolName: "todo", isError: false, details: { op: "init", phases: [{ name: "Muster", tasks: [{ content: "[captain] Objective", status: "in_progress" }] }, ...granted()] } }, s.ctx),
					);
					expect(saved(s.dir).seal).toBeUndefined();
					s.todo(waiting());
					const t = await peek(s, ui);
					expect(t).toContain(DEFAULT);
					expect(t).not.toContain("Squads: b");
				});

				test("lines that are all blank count as none: the default line shows", async () => {
					const { s, ui } = await sealed();
					await s.call({ action: "seal", lines: ["", "  ", "\t"] });
					expect(await peek(s, ui)).toContain("the details are in the Captain's message");
				});

				test("at most 200 lines of 500 characters are stored", async () => {
					const { s } = await sealed();
					expect(await s.call({ action: "seal", lines: Array.from({ length: 250 }, () => "y".repeat(600)) })).toBe("SEAL Plan panel 200 lines");
					const lines = saved(s.dir).seal.lines as string[];
					expect(lines).toHaveLength(200);
					expect(lines.every(l => l === "y".repeat(500))).toBe(true);
				});

				test("a seal call after the run key changed starts from a clean cockpit", async () => {
					const { s } = await sealed();
					await s.call({ action: "seal", lines: ["old"] });
					expect(saved(s.dir).chronicle.length).toBeGreaterThan(0);
					const runFile = join(s.dir, "runs", "sess-0001.json");
					writeFileSync(runFile, JSON.stringify({ ...JSON.parse(readFileSync(runFile, "utf8")), key: "K-2" }));
					writeFileSync(lockPath(s.dir, "K-2"), "sess-0001");
					await s.call({ action: "seal", lines: ["new"] });
					expect(saved(s.dir)).toMatchObject({ key: "K-2", chronicle: [], notes: {}, seal: { id: "Plan", lines: ["new"] } });
				});

				test("lines stored under run A are not shown by run B's panel", async () => {
					const { s, ui } = await sealed();
					await s.call({ action: "seal", lines: ["from A"] });
					await s.sub("end");
					await s.call({ action: "begin", key: "K-2" });
					s.todo(waiting());
					const t = await peek(s, ui);
					expect(t).toContain("the details are in the Captain's message");
					expect(t).not.toContain("from A");
				});

				test("a granted seal is gone from the file even after a crashed restart with no later write", async () => {
					const { s } = await sealed();
					await s.call({ action: "seal", lines: ["Squads: a"] });
					s.todo(granted());
					const again = await restart(s, true);
					expect(saved(again.s.dir).seal).toBeUndefined();
				});

				test("granting another seal keeps it", async () => {
					const { s, ui } = await running();
					const two = (other: string) => [{ name: "Scriptorium", tasks: [{ content: "[seal] Plan", status: "in_progress" }, { content: "[seal] Other", status: other }] }];
					s.todo(two("pending"));
					await s.call({ action: "seal", lines: ["Squads: a"] });
					s.todo(two("completed"));
					expect(saved(s.dir).seal).toEqual({ id: "Plan", lines: ["Squads: a"] });
					expect(await peek(s, ui)).toContain("Squads: a");
				});

				test("a malformed seal key is a clean start; an old file without one still loads its chronicle", async () => {
					const { s } = await sealed();
					await s.call({ action: "seal", lines: ["Squads: a"] });
					const file = saved(s.dir);
					for (const bad of [{ id: 5, lines: ["x"] }, { id: "Plan", lines: "x" }, { id: "Plan", lines: [1] }, { id: "Plan" }, "Plan", null]) {
						writeFileSync(cockpitFile(s.dir), JSON.stringify({ ...file, seal: bad }));
						const again = await restart(s, true);
						const t = await peek(again.s, again.ui);
						expect(t).not.toContain("station Scriptorium");
						expect(t).toContain("the details are in the Captain's message");
					}
					const { seal: _seal, ...old } = file;
					writeFileSync(cockpitFile(s.dir), JSON.stringify(old));
					const again = await restart(s, true);
					const t = await peek(again.s, again.ui);
					expect(t).toContain("station Scriptorium");
					expect(t).toContain("the details are in the Captain's message");
				});

				test("Demo (2) is whole in the footer, the chronicle and the grant line", async () => {
					const { s, ui } = await sealed("Demo (2)");
					expect(s.shown()).toContain("seal Demo (2)");
					expect(await chron(s, ui)).toContain("seal Demo (2) awaits the Chapter Master");
					s.todo(granted("Demo (2)"));
					expect(await chron(s, ui)).toContain("Demo (2) granted");
				});
			});
		});
	});

	describe("the booking clock", () => {
		// 3 min booked from 09:00; the clock reads 09:02, so 67 % and the 50 % alert.
		async function timed() {
			const s = setup();
			const ui = uiCtx(s);
			setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
			await s.call({ action: "begin", key: "K-1", booked: 3 });
			setSystemTime(new Date(2026, 10, 16, 9, 2, 0));
			await s.start();
			return { s, ui };
		}

		test("a timed run shows elapsed over booked, the bar and the percentage in the overlay", async () => {
			const { s, ui } = await timed();
			const overlay = await peek(s, ui);
			expect(overlay).toContain("⧗ 2/3 min");
			expect(overlay).toContain("▰");
			expect(overlay).toContain("▱");
			expect(overlay).toContain("67%");
		});

		test("a booking alert is written to the chronicle, once per threshold", async () => {
			const { s, ui } = await timed();
			const entries = async () => (await chron(s, ui)).split("\n").filter(l => l.includes("of the booking"));
			expect(await entries()).toHaveLength(1);
			expect((await entries())[0]).toContain("TIMER");
			expect((await entries())[0]).toContain("⧗ 50% of the booking");
			await s.call({ action: "status" });
			expect(await entries()).toHaveLength(1);
			setSystemTime(new Date(2026, 10, 16, 9, 3, 0));
			await s.call({ action: "status" });
			expect(await entries()).toHaveLength(2);
			expect((await entries())[0]).toContain("⧗ 100% of the booking");
		});
	});

	describe("agents spawned by eval", () => {
		const spawn = (s: ReturnType<typeof setup>, e: unknown) => s.handlers.before_subagent_spawn.forEach(h => h(e, s.ctx));
		const deployed = async (s: ReturnType<typeof setup>, ui: ReturnType<typeof uiCtx>) => (await chron(s, ui)).split("\n").filter(l => l.includes("deployed"));

		test("an eval spawn of a roster agent logs its role", async () => {
			const { s, ui } = await running();
			spawn(s, { invocationKind: "eval", agent: "scout" });
			expect(await deployed(s, ui)).toHaveLength(1);
			expect((await deployed(s, ui))[0]).toContain("SCOUT");
		});

		test("a spawn that is not from eval logs nothing", async () => {
			const { s, ui } = await running();
			spawn(s, { invocationKind: "task", agent: "scout" });
			spawn(s, { agent: "scout" });
			expect(await deployed(s, ui)).toEqual([]);
		});

		test("an agent outside the roster logs nothing", async () => {
			const { s, ui } = await running();
			spawn(s, { invocationKind: "eval", agent: "stranger" });
			expect(await deployed(s, ui)).toEqual([]);
		});

		test("an eval-spawned apothecary in Skirmish shows as a running line in APOTHECARIES", async () => {
			const { s, ui } = await running();
			s.todo([{ name: "Muster", tasks: [{ content: "[captain] Plan", status: "completed" }] }, { name: "Skirmish", tasks: [{ content: "[battle-brother] Build squad a", status: "in_progress" }] }]);
			spawn(s, { invocationKind: "eval", agent: "apothecary" });
			const overlay = await peek(s, ui);
			expect(overlay).toContain("APOTHECARIES");
			expect(overlay).toMatch(/│ ▶ eval-apothecary-1 +│/);
		});

		test.each([["an empty string", ""], ["a number", 7]])("an eval spawn whose spawnKey is %s keeps the eval-<agent>-<n> key", async (_name, spawnKey) => {
			const { s, ui } = await running();
			s.todo([{ name: "Muster", tasks: [{ content: "[captain] Plan", status: "completed" }] }, { name: "Skirmish", tasks: [{ content: "[battle-brother] Build squad a", status: "in_progress" }] }]);
			spawn(s, { invocationKind: "eval", agent: "apothecary", spawnKey });
			expect(await peek(s, ui)).toMatch(/│ ▶ eval-apothecary-1 +│/);
		});

		const cell = (id: string, status: string) => ({ role: "toolResult", toolCallId: "c1", toolName: "eval", isError: false, content: [], details: { cells: [{ statusEvents: [{ op: "agent", id, status }] }] } });
		const delivery = (id: string, status: string) => ({ role: "custom", customType: "async-result", details: { jobs: [{ jobId: id, type: "task", status, agentId: id, label: id }] } });
		const ctxMsg = (s: ReturnType<typeof setup>, ...messages: unknown[]) => s.handlers.context.forEach(h => h({ type: "context", messages }, s.ctx));
		async function skirmish() {
			const r = await running();
			r.s.todo([{ name: "Muster", tasks: [{ content: "[captain] Plan", status: "completed" }] }, { name: "Skirmish", tasks: [{ content: "[battle-brother] Build squad a", status: "in_progress" }] }]);
			spawn(r.s, { invocationKind: "eval", agent: "apothecary", spawnKey: "TestB" });
			return r;
		}

		test("an eval agent is registered under its spawnKey and shows ▶ while it runs", async () => {
			const { s, ui } = await skirmish();
			expect(await peek(s, ui)).toMatch(/│ ▶ TestB +│/);
		});

		test("an eval agent awaited by its cell ends with the cell, logged once", async () => {
			const { s, ui } = await skirmish();
			ctxMsg(s, cell("TestB", "completed"));
			ctxMsg(s, cell("TestB", "completed"));
			ctxMsg(s, delivery("TestB", "completed"));
			expect(await peek(s, ui)).toMatch(/│ ✓ TestB +│/);
			expect((await chron(s, ui)).split("returned")).toHaveLength(2);
		});

		test("an eval agent that fails in its cell shows ✗ and logs the failure", async () => {
			const { s, ui } = await skirmish();
			ctxMsg(s, cell("TestB", "failed"));
			expect(await peek(s, ui)).toMatch(/│ ✗ TestB +│/);
			expect(await chron(s, ui)).toContain("✗ failed");
		});

		test("an eval agent still running after its cell returns stays ▶, then ends with its async-result", async () => {
			const { s, ui } = await skirmish();
			ctxMsg(s, cell("TestB", "running"));
			expect(await peek(s, ui)).toMatch(/│ ▶ TestB +│/);
			ctxMsg(s, delivery("TestB", "completed"));
			expect(await peek(s, ui)).toMatch(/│ ✓ TestB +│/);
		});

		test("an eval spawn without spawnKey keeps the eval-<agent>-<n> key and stays ▶", async () => {
			const { s, ui } = await running();
			s.todo([{ name: "Skirmish", tasks: [{ content: "[battle-brother] Build squad a", status: "in_progress" }] }]);
			spawn(s, { invocationKind: "eval", agent: "apothecary" });
			ctxMsg(s, cell("other", "completed"));
			expect(await peek(s, ui)).toMatch(/│ ▶ eval-apothecary-1 +│/);
		});
	});
});

describe("cost tiers", () => {
	type Verdict = { block?: true; reason?: string; model?: string; note?: string } | undefined;
	type S = ReturnType<typeof setup>;
	const spawn = (s: S, agent: string, spawnKey?: string) => s.handlers.before_subagent_spawn[0]({ agent, spawnKey }, s.ctx) as Verdict;
	const DEFAULT = { light: "@smol:medium", standard: "@task:medium", heavy: "@slow:high" };
	const squads = [
		{ id: "S1", parallel: true, files: ["a.ts"], tier: "light" },
		{ id: "S2", parallel: true, files: ["b.ts"], tier: "heavy" },
		{ id: "S3", parallel: false, files: ["c.ts"] },
	];
	const begin = async (slices: unknown[] = squads) => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "repo", repo: s.dir });
		await s.call({ action: "slices", slices });
		return s;
	};

	test("slices shows a declared tier in the SQUADS line and none otherwise", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "repo", repo: s.dir });
		expect(await s.call({ action: "slices", slices: squads })).toBe("SQUADS S1 (parallel, light), S2 (parallel, heavy), S3");
		expect(await s.call({ action: "slices", slices: squads.map(({ tier: _t, ...q }) => q) })).toBe("SQUADS S1 (parallel), S2 (parallel), S3");
	});

	describe("status shows the TIERS line", () => {
		const tiersLine = async (s: S) => (await s.call({ action: "status" })).split("\n").find(l => l.startsWith("TIERS"));

		test("the defaults", async () => {
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			expect(await tiersLine(s)).toBe("TIERS light=@smol:medium standard=@task:medium heavy=@slow:high (default)");
		});

		test("an override from STRATEGIUM_TIERS, with the ignored entries", async () => {
			process.env.STRATEGIUM_TIERS = "light=anthropic/claude-haiku-5-5:low; heavy=@task:high;bogus=@x;standard=";
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			expect(await tiersLine(s)).toBe(
				"TIERS light=anthropic/claude-haiku-5-5:low standard=@task:medium heavy=@task:high (STRATEGIUM_TIERS); ignored: bogus=@x, standard=",
			);
		});

		test("the line sits right after COMMIT", async () => {
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			const lines = (await s.call({ action: "status" })).split("\n");
			expect(lines[lines.findIndex(l => l.startsWith("COMMIT")) + 1]).toStartWith("TIERS ");
		});
	});

	test("a parallel batch: each battle-brother gets its own squad's selector", async () => {
		const s = await begin();
		expect(spawn(s, "battle-brother", "S1")).toEqual({ model: DEFAULT.light, note: "Strategium tier light" });
		expect(spawn(s, "battle-brother", "S2")).toEqual({ model: DEFAULT.heavy, note: "Strategium tier heavy" });
		expect(spawn(s, "battle-brother", "S3")?.model).toBe(DEFAULT.standard);
	});

	test("STRATEGIUM_TIERS changes the selector a tier maps to", async () => {
		process.env.STRATEGIUM_TIERS = "light=@smol:low";
		const s = await begin();
		expect(spawn(s, "battle-brother", "S1")?.model).toBe("@smol:low");
		expect(spawn(s, "battle-brother", "S2")?.model).toBe(DEFAULT.heavy);
	});

	test("a second builder of a squad runs one tier up, and heavy stays heavy", async () => {
		const s = await begin();
		expect(spawn(s, "battle-brother", "S1")?.model).toBe(DEFAULT.light);
		expect(spawn(s, "battle-brother", "S1-2")?.model).toBe(DEFAULT.standard);
		expect(spawn(s, "battle-brother", "S1-3")?.model).toBe(DEFAULT.standard);
		expect(spawn(s, "battle-brother", "S2")?.model).toBe(DEFAULT.heavy);
		expect(spawn(s, "battle-brother", "S2-2")?.model).toBe(DEFAULT.heavy);
		expect(spawn(s, "battle-brother", "S2-3")?.model).toBe(DEFAULT.heavy);
	});

	test("property: the rung is never below the planned tier and never above heavy", async () => {
		const order = ["light", "standard", "heavy"] as const;
		for (const tier of order) {
			const s = await begin([{ id: "S1", parallel: false, files: ["a.ts"], tier }]);
			for (let n = 0; n < 4; n++) {
				const at = order.findIndex(t => DEFAULT[t] === spawn(s, "battle-brother", n ? `S1-${n + 1}` : "S1")?.model);
				expect(at).toBeGreaterThanOrEqual(order.indexOf(tier));
				expect(at).toBeLessThanOrEqual(2);
			}
		}
	});

	test("the veteran runs on the heavy tier", async () => {
		const s = await begin();
		expect(spawn(s, "veteran", "S1-3")).toEqual({ model: DEFAULT.heavy, note: "Strategium tier heavy" });
	});

	test("an item named X whose brief says build squad S1 gets S1's tier", async () => {
		const s = await begin([{ id: "S1", parallel: false, files: ["a.ts"], tier: "standard" }]);
		const input = { tasks: [{ agent: "battle-brother", name: "X", isolated: true, task: "Read local://K-1-plan.md; build squad S1." }] };
		expect(s.handlers.tool_call[0]({ toolName: "task", input }, s.ctx)).toBeUndefined();
		expect(spawn(s, "battle-brother", "X")?.model).toBe(DEFAULT.standard);
		expect(spawn(s, "battle-brother", "X-2")?.model).toBe(DEFAULT.heavy);
	});

	test("a squad id that is an Object.prototype key still gets its planned tier on the first builder", async () => {
		const s = await begin([
			{ id: "S1", parallel: true, files: ["a.ts"] },
			{ id: "constructor", parallel: true, files: ["b.ts"], tier: "light" },
		]);
		spawn(s, "battle-brother", "S1");
		expect(spawn(s, "battle-brother", "constructor")?.model).toBe(DEFAULT.light);
		expect(spawn(s, "battle-brother", "constructor-2")?.model).toBe(DEFAULT.standard);
	});

	const brotherItem = (name: string, slice: string) => ({ agent: "battle-brother", name, isolated: true, task: `Read local://K-1-plan.md; build squad ${slice}.` });
	const launchBrother = (s: S, tasks: unknown[], ids: string[]) => {
		expect(s.handlers.tool_call[0]({ toolName: "task", input: { tasks } }, s.ctx)).toBeUndefined();
		const details = { progress: ids.map((id, index) => ({ index, id, status: "running" })) };
		for (const h of s.handlers.tool_result) h({ toolName: "task", input: { tasks }, details, isError: false }, s.ctx);
	};
	const endAgents = (s: S, ...ids: string[]) =>
		s.handlers.context[0]({ type: "context", messages: [{ role: "custom", customType: "async-result", details: { jobs: ids.map((label, i) => ({ jobId: `j-${label}-${i}`, type: "task", status: "completed", label })) } }] }, s.ctx);

	test("a squad with parallel false and a tier prints the tier alone", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "repo", repo: s.dir });
		expect(await s.call({ action: "slices", slices: [{ id: "S1", parallel: false, files: ["a.ts"], tier: "light" }] })).toBe("SQUADS S1 (light)");
	});

	test("a squad whose agent stopped keeps its ladder when the list is declared again without it", async () => {
		const s = await begin([{ id: "S1", parallel: false, files: ["a.ts"], tier: "standard" }]);
		expect(spawn(s, "battle-brother", "S1")?.model).toBe(DEFAULT.standard);
		launchBrother(s, [brotherItem("S1", "S1")], ["S1"]);
		endAgents(s, "S1");
		await s.call({ action: "slices", slices: [{ id: "S2", parallel: false, files: ["b.ts"] }] });
		expect(spawn(s, "battle-brother", "S1-2")?.model).toBe(DEFAULT.heavy);
	});

	test("a stopped light squad never spawned yet still gets its own tier", async () => {
		const s = await begin([{ id: "S1", parallel: false, files: ["a.ts"], tier: "light" }]);
		launchBrother(s, [brotherItem("S1", "S1")], ["S1"]);
		endAgents(s, "S1");
		await s.call({ action: "slices", slices: [{ id: "S2", parallel: false, files: ["b.ts"] }] });
		expect(spawn(s, "battle-brother", "S1")?.model).toBe(DEFAULT.light);
	});

	test("a squad whose id ends in -<digits> wins over the squad before it", async () => {
		const s = await begin([
			{ id: "S1", parallel: true, files: ["a.ts"], tier: "light" },
			{ id: "S1-2", parallel: true, files: ["b.ts"], tier: "heavy" },
		]);
		expect(spawn(s, "battle-brother", "S1-2")?.model).toBe(DEFAULT.heavy);
	});

	test("a key folds onto a squad id, with or without a -<digits> suffix", async () => {
		const s = await begin([{ id: "A.1", parallel: false, files: ["a.ts"], tier: "standard" }]);
		expect(spawn(s, "battle-brother", "A1")?.model).toBe(DEFAULT.standard);
		expect(spawn(s, "battle-brother", "A1-2")?.model).toBe(DEFAULT.heavy);
	});

	test("an item named A-1 reaches squad A1 by folding the whole key", async () => {
		const s = await begin([{ id: "A1", parallel: false, files: ["a.ts"], tier: "light" }]);
		expect(spawn(s, "battle-brother", "A-1")?.model).toBe(DEFAULT.light);
	});

	test("a suffix of several digits is stripped", async () => {
		const s = await begin([{ id: "S1", parallel: false, files: ["a.ts"], tier: "standard" }]);
		expect(spawn(s, "battle-brother", "S1")?.model).toBe(DEFAULT.standard);
		expect(spawn(s, "battle-brother", "S1-12")?.model).toBe(DEFAULT.heavy);
	});

	test("a reused item name whose new brief names no squad loses its old squad within the run", async () => {
		const s = await begin([{ id: "S1", parallel: false, files: ["a.ts"], tier: "light" }]);
		expect(s.handlers.tool_call[0]({ toolName: "task", input: { tasks: [brotherItem("X", "S1")] } }, s.ctx)).toBeUndefined();
		const input = { tasks: [{ agent: "battle-brother", name: "X", isolated: true, task: "Fix the docs." }] };
		expect(s.handlers.tool_call[0]({ toolName: "task", input }, s.ctx)).toBeUndefined();
		expect(spawn(s, "battle-brother", "X")?.model).toBe(DEFAULT.standard);
	});

	test("a reused name that folds onto another squad's id still gets its own squad's ladder", async () => {
		const s = await begin([
			{ id: "S1", parallel: true, files: ["a.ts"], tier: "light" },
			{ id: "S12", parallel: true, files: ["b.ts"], tier: "heavy" },
		]);
		expect(spawn(s, "battle-brother", "S1")?.model).toBe(DEFAULT.light);
		expect(spawn(s, "battle-brother", "S1-2")?.model).toBe(DEFAULT.standard);
	});

	test("a brief name from a finished run does not route an item of the next run", async () => {
		const s = await begin([{ id: "S1", parallel: false, files: ["a.ts"], tier: "light" }]);
		expect(s.handlers.tool_call[0]({ toolName: "task", input: { tasks: [brotherItem("X", "S1")] } }, s.ctx)).toBeUndefined();
		await s.call({ action: "end" });
		await s.call({ action: "begin", key: "K-2" });
		await s.call({ action: "repo", repo: s.dir });
		await s.call({ action: "slices", slices: [{ id: "S1", parallel: false, files: ["a.ts"], tier: "light" }] });
		const input = { tasks: [{ agent: "battle-brother", name: "X", isolated: true, task: "Fix the docs." }] };
		expect(s.handlers.tool_call[0]({ toolName: "task", input }, s.ctx)).toBeUndefined();
		expect(spawn(s, "battle-brother", "X")?.model).toBe(DEFAULT.standard);
		expect(spawn(s, "battle-brother", "S1")?.model).toBe(DEFAULT.light);
	});

	test("a battle-brother matching no squad, or with no spawnKey, runs on standard", async () => {
		const s = await begin();
		expect(spawn(s, "battle-brother", "Mystery")?.model).toBe(DEFAULT.standard);
		expect(spawn(s, "battle-brother")?.model).toBe(DEFAULT.standard);
		expect(spawn(s, "battle-brother", "S9-2")?.model).toBe(DEFAULT.standard);
	});

	test("redraft resets the ladder", async () => {
		const s = await begin();
		spawn(s, "battle-brother", "S1");
		expect(spawn(s, "battle-brother", "S1-2")?.model).toBe(DEFAULT.standard);
		await s.call({ action: "redraft" });
		await s.call({ action: "slices", slices: squads });
		expect(spawn(s, "battle-brother", "S1")?.model).toBe(DEFAULT.light);
	});

	test.each(["inquisitor", "confessor", "apothecary", "scout", "librarian", "sonic", "task"])("a %s keeps its own tier: no model", async agent => {
		const s = await begin();
		expect(spawn(s, agent, "S1")?.model).toBeUndefined();
	});

	test("without a run nothing is routed", () => {
		const s = setup();
		expect(spawn(s, "battle-brother", "S1")).toBeUndefined();
	});

	describe("parsing STRATEGIUM_TIERS", () => {
		test("property: always light, standard and heavy, and only those", () => {
			const inputs = ["", "   ", ";;;", "=", "light", "light=", "=x", "__proto__=x", "toString=y;constructor=z", "light=a;light=b", "heavy==@x:high", " standard = @a ; ", "LIGHT=x", "light=@smol:low;nope=1"];
			for (const env of inputs) {
				const { selectors, ignored } = parseTiers(env);
				expect(Object.keys(selectors).sort()).toEqual(["heavy", "light", "standard"]);
				for (const v of Object.values(selectors)) expect(v.length).toBeGreaterThan(0);
				expect(Array.isArray(ignored)).toBe(true);
			}
		});

		test("valid entries override, invalid ones are reported and the rest keep their defaults", () => {
			expect(parseTiers("light=@smol:low;nope=1;=x;heavy=")).toEqual({
				selectors: { ...DEFAULT, light: "@smol:low" },
				ignored: ["nope=1", "=x", "heavy="],
			});
			expect(parseTiers(" standard = a,b:high ").selectors.standard).toBe("a,b:high");
			expect(parseTiers(undefined)).toEqual({ selectors: DEFAULT, ignored: [] });
		});
	});
});
