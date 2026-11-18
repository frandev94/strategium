import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { keyOf, whereFrom } from "./index";
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
		},
		tools,
		commands,
		handlers,
		sent,
		shortcuts,
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
	delete process.env.STRATEGIUM_GLYPHS;
	delete process.env.STRATEGIUM_NOTIFY;
	delete process.env.STRATEGIUM_IDLE_MIN;
	delete process.env.STRATEGIUM_ARCHMAGOS;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The alert events recorded in the day file of the fake clock.
const alertEvents = (dir: string) => load(join(dir, "2026-11-16.jsonl")).filter(e => e.event === "alert");

function setup(sid = "sess-0001", shared?: string) {
	const dir = shared ?? mkdtempSync(join(tmpdir(), "st-index-"));
	if (!shared) dirs.push(dir);
	process.env.STRATEGIUM_STATE_DIR = dir;
	// No test sounds the user's real alarm.
	delete process.env.STRATEGIUM_ALARM;
	delete process.env.STRATEGIUM_GLYPHS;
	// The alarm tests need notifications on; the tests of the default turn them off again.
	process.env.STRATEGIUM_NOTIFY = "1";
	const { pi, tools, commands, handlers, sent, calls, activeTools, setActive, shortcuts } = fakePi();
	// What the footer and the alert had seen the moment each notification went out.
	const seen: { via: string; footer: string; events: number }[] = [];
	const sendMessage = pi.sendMessage;
	pi.sendMessage = (m: { content: string }, o?: unknown) => {
		seen.push({ via: "sendMessage", footer: footer.at(-1) ?? "", events: alertEvents(dir).length });
		return sendMessage(m, o);
	};
	extension(pi as never);
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
	return { dir, call, command, sub, sent, calls, seen, footer, notes, commands, handlers, shortcuts, ctx, start, todo, shown, activeTools, setActive };
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
	const FAIL_ALARM = "Z:/missing/strategium-alarm-bin";
	const ran = (notes: string[]) => notes.some(n => n.includes("the alarm failed"));
	afterEach(() => delete process.env.STRATEGIUM_ALARM);

	test("off by default: an unset STRATEGIUM_NOTIFY runs no alarm and says attention was silent", async () => {
		const s = setup();
		delete process.env.STRATEGIUM_NOTIFY;
		process.env.STRATEGIUM_ALARM = FAIL_ALARM;
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
		process.env.STRATEGIUM_ALARM = FAIL_ALARM;
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
		process.env.STRATEGIUM_ALARM = FAIL_ALARM;
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
		expect(whereFrom([phase("Scriptorium", ["\u{f047a} seal · Plan the squads", "in_progress"])])).toEqual({ station: "Scriptorium", seal: "Plan" });
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

	test("the footer shows station › task, also after a return arrow", async () => {
		const { call, todo, start, shown } = setup();
		await call({ action: "begin", key: "dark-mode" });
		todo([phase("Muster", ["[captain] Begin run and theatre status", "in_progress"])]);
		start();
		expect(shown()).toContain("dark-mode · Muster › Begin run and theatre status · ");
		todo(backToScriptorium);
		expect(shown()).toContain("dark-mode · ↩ Scriptorium › Redraft squad 2 · ");
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
		// The alarm command appends "<level>|<message>" to a file; the spawn is asynchronous, so poll.
		const recorder = (dir: string) => {
			const out = join(dir, "alarm.log");
			const script = join(dir, "rec.ts");
			writeFileSync(script, 'import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], `${process.env.STRATEGIUM_P}|${process.env.STRATEGIUM_MSG}\\n`);\n');
			process.env.STRATEGIUM_ALARM = `"${process.execPath}" "${script}" "${out}"`;
			return async (want: number) => {
				for (let i = 0; i < 100; i++) {
					const lines = existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : [];
					if (lines.length >= want) return lines;
					await Bun.sleep(50);
				}
				return existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : [];
			};
		};
		afterEach(() => delete process.env.STRATEGIUM_ALARM);

		test("the tool's end plays it once", async () => {
			const s = setup();
			const lines = recorder(s.dir);
			await s.call({ action: "begin", key: "K-1" });
			await s.call({ action: "end" });
			expect(await lines(1)).toEqual(["theme|K-1: run ended"]);
		});

		test("/strategium-end plays it too", async () => {
			const s = setup();
			const lines = recorder(s.dir);
			await s.call({ action: "begin", key: "K-1" });
			await s.sub("end");
			expect(await lines(1)).toEqual(["theme|K-1: run ended"]);
			expect(s.activeTools()).toContain("edit");
		});

		test("an end that fails plays nothing", async () => {
			const s = setup();
			const lines = recorder(s.dir);
			expect(await s.call({ action: "end" })).toContain("ERROR");
			await Bun.sleep(300);
			expect(await lines(0)).toEqual([]);
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
		expect(moved()).toEqual({ ...before, sid: "sess-B", agents: {}, stopped: [...before.stopped, slice] });
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
		const { s, sm, ctx } = await owner();
		await emit(s, "plan_review_requested", { sessionId: "sess-A" }, ctx);
		await emit(s, "plan_review_resolved", { sessionId: "sess-A", choice: "execute" }, ctx);
		// Another session took the key over meanwhile.
		writeFileSync(lockPath(s.dir, "K-1"), "sess-X");
		sm.sid = "sess-B";
		await emit(s, "session_switch", { reason: "new" }, ctx);
		expect(readFileSync(lockPath(s.dir, "K-1"), "utf8")).toBe("sess-X");
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
});

describe("attention without an alarm", () => {
	test("says it was silent and points at the setup skill", async () => {
		const { call } = setup();
		expect(await call({ action: "attention", message: "seal ready" })).toBe(
			"ATTENTION seal ready (silent: STRATEGIUM_ALARM is not set; see /skill:strategium-setup)",
		);
	});

	test("with an alarm set, it is not called silent", async () => {
		const { call } = setup();
		process.env.STRATEGIUM_ALARM = `"${process.execPath}" -e ""`;
		try {
			expect(await call({ action: "attention", message: "seal ready" })).toBe("ATTENTION seal ready");
		} finally {
			delete process.env.STRATEGIUM_ALARM;
		}
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
	const FAIL_ALARM = "Z:/missing/strategium-alarm-bin";
	const sorted = (a: string[]) => [...a].sort();
	afterEach(() => delete process.env.STRATEGIUM_ALARM);

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
		process.env.STRATEGIUM_ALARM = FAIL_ALARM;
		expect(await b.call({ action: "end", key: "K-1" })).toBe("ERROR K-1 belongs to session ess-0001; end it there, or take it over with that id");
		expect(b.activeTools()).toEqual(["read", "bash", "write", "task"]);
		expect(b.notes).toEqual([]);
	});

	test("a takeover end from a session without a run plays nothing and restores nothing", async () => {
		const a = setup("sess-0001");
		await a.call({ action: "begin", key: "K-1" });
		const c = setup("sess-0003", a.dir);
		process.env.STRATEGIUM_ALARM = FAIL_ALARM;
		expect(await c.call({ action: "end", key: "K-1", takeover: "sess-0001" })).toBe("ENDED K-1");
		expect(c.activeTools()).toEqual(FULL);
		expect(c.notes).toEqual([]);
	});

	test("an end without a run says so and plays nothing", async () => {
		const s = setup();
		process.env.STRATEGIUM_ALARM = FAIL_ALARM;
		expect(await s.call({ action: "end" })).toBe("ERROR no run to end in this session");
		expect(s.notes).toEqual([]);
	});

	test("a theme that cannot start is reported, and the run is still ended", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		process.env.STRATEGIUM_ALARM = FAIL_ALARM;
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
			expect(s.handlers.before_subagent_spawn[0]({ agent: "battle-brother" }, s.ctx)).toBeUndefined();
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
		expect(spawn("battle-brother")).toBeUndefined();
		await s.call({ action: "repo", repo: s.dir });
		for (const name of ["battle-brother", "Battle-Brother", "omp:battle-brother", "x/battle-brother"])
			expect(spawn(name)?.reason).toContain("declare the plan's squads first");
		expect(spawn("x/scout")).toBeUndefined();
		expect(spawn("OMP:Sonic")).toBeUndefined();
	});

	test("the whole roster passes, anything else is refused with the roster in the reason", async () => {
		const { spawn } = await run(disjoint);
		// The archmagos has its own guards (setting, mark, librarians, budget): see "the archmagos guard".
		for (const name of ROSTER.filter(n => n !== "archmagos")) expect(spawn(name)).toBeUndefined();
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
		expect(await s.call({ action: "status" })).toEndWith("ARCHMAGOS off (STRATEGIUM_ARCHMAGOS)");
		await s.call({ action: "begin", key: "K-1" });
		expect(await s.call({ action: "status" })).toEndWith("ARCHMAGOS off (STRATEGIUM_ARCHMAGOS)");
		for (const v of ["1", "true", "on", "YES", " 1 "]) {
			process.env.STRATEGIUM_ARCHMAGOS = v;
			expect(await s.call({ action: "status" })).toEndWith("ARCHMAGOS on (STRATEGIUM_ARCHMAGOS)");
		}
		process.env.STRATEGIUM_ARCHMAGOS = "0";
		expect(await s.call({ action: "status" })).toEndWith("ARCHMAGOS off (STRATEGIUM_ARCHMAGOS)");
		// Also with no run at all.
		const bare = setup("sess-0002");
		process.env.STRATEGIUM_ARCHMAGOS = "1";
		expect(await bare.call({ action: "status" })).toEndWith("ARCHMAGOS on (STRATEGIUM_ARCHMAGOS)");
	});

	test("STRATEGIUM_ARCHMAGOS only turns on for a whole word, not a part of one", async () => {
		const s = setup();
		for (const v of ["xon", "maybe-yes", "10", "1x", "yesno"]) {
			process.env.STRATEGIUM_ARCHMAGOS = v;
			expect(await s.call({ action: "status" })).toEndWith("ARCHMAGOS off (STRATEGIUM_ARCHMAGOS)");
		}
	});

	test("/strategium-config archmagos on wins over STRATEGIUM_ARCHMAGOS=0, for this session only", async () => {
		process.env.STRATEGIUM_ARCHMAGOS = "0";
		const s = setup();
		await s.sub("config", "archmagos on");
		expect(s.notes.at(-1)).toContain("archmagos: on (this session)");
		expect(await s.call({ action: "status" })).toEndWith("ARCHMAGOS on (this session)");
		const other = setup("sess-0002");
		await other.sub("config");
		expect(other.notes.at(-1)).toContain("archmagos: off (STRATEGIUM_ARCHMAGOS)");
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
		const { s, spawn, two } = await run();
		two();
		// Before the first archmagos there is nothing to redraft: the budget stays 1.
		expect(await s.call({ action: "redraft" })).toBe("ERROR K-1 has no archmagos to redraft");
		expect(spawn("archmagos")).toBeUndefined();
		expect(await s.call({ action: "redraft" })).toBe("REDRAFT K-1: one more archmagos may be spawned");
		expect(spawn("archmagos")).toBeUndefined();
		expect(spawn("archmagos")).toEqual({ block: true, reason: SPENT });
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
	const FAIL_ALARM = "Z:/missing/strategium-alarm-bin";
	const ran = (notes: string[]) => notes.some(n => n.includes("the alarm failed"));
	// The alarm command appends "<level>|<message>" to a file; the spawn is asynchronous, so poll.
	const recorder = (dir: string) => {
		const out = join(dir, "alarm.log");
		const script = join(dir, "rec.ts");
		writeFileSync(script, 'import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], `${process.env.STRATEGIUM_P}|${process.env.STRATEGIUM_MSG}\\n`);\n');
		process.env.STRATEGIUM_ALARM = `"${process.execPath}" "${script}" "${out}"`;
		return async (want: number) => {
			for (let i = 0; i < 100; i++) {
				const lines = existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : [];
				if (lines.length >= want) return lines;
				await Bun.sleep(50);
			}
			return existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : [];
		};
	};
	afterEach(() => delete process.env.STRATEGIUM_ALARM);

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
		const lines = recorder(on.dir);
		await at(on, 9, 2);
		await at(on, 9, 3);
		expect(on.notes.filter(n => n.includes("paused after 3 min idle")).length).toBe(1);
		expect(on.notes.find(n => n.includes("paused after"))).toContain("K-1");
		expect(await lines(1)).toEqual(["idle|K-1: paused, idle 3 min"]);
		// Nothing is posted into the session: a triggered turn would resume the clock at once.
		expect(on.calls).toEqual([]);
		expect(on.sent).toEqual([]);

		const off = await idler();
		process.env.STRATEGIUM_ALARM = FAIL_ALARM;
		await off.sub("config", "notify off");
		await at(off, 9, 2);
		await at(off, 9, 3);
		expect(off.notes.some(n => n.includes("paused after 3 min idle"))).toBe(true);
		// A failing alarm command reports itself at once, so no note proves nothing was spawned.
		expect(ran(off.notes)).toBe(false);
	});

	test("the idle notification and alarm name the configured minutes", async () => {
		const s = await idler();
		const lines = recorder(s.dir);
		await s.sub("config", "idle 5");
		await at(s, 9, 2);
		await at(s, 9, 4);
		await at(s, 9, 5);
		expect(s.notes.some(n => n.includes("paused after 5 min idle"))).toBe(true);
		expect(await lines(1)).toEqual(["idle|K-1: paused, idle 5 min"]);
	});

	test("a failing idle alarm is reported", async () => {
		const s = await idler();
		process.env.STRATEGIUM_ALARM = FAIL_ALARM;
		await at(s, 9, 2);
		await at(s, 9, 3);
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
		process.env.STRATEGIUM_ALARM = FAIL_ALARM;
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
		const lines = recorder(on.dir);
		await on.call({ action: "begin", key: "K-1" });
		await on.handlers.plan_review_requested[0]({ sessionId: "sess-0001" }, on.ctx);
		expect(await lines(1)).toEqual(["attention|K-1: your plan review is waiting"]);
		await Bun.sleep(300);
		expect(await lines(0)).toEqual(["attention|K-1: your plan review is waiting"]);

		const off = setup();
		process.env.STRATEGIUM_ALARM = FAIL_ALARM;
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
		process.env.STRATEGIUM_ALARM = FAIL_ALARM;
		await s.handlers.plan_review_requested[0]({ sessionId: "sess-0001" }, s.ctx);
		expect(ran(s.notes)).toBe(true);
	});
});

describe("cockpit", () => {
	const FAIL_ALARM = "Z:/missing/strategium-alarm-bin";
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
	// The alarm command appends "<level>|<message>" to a file; the spawn is asynchronous, so poll.
	const recorder = (dir: string) => {
		const out = join(dir, "alarm.log");
		const script = join(dir, "rec.ts");
		writeFileSync(script, 'import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], `${process.env.STRATEGIUM_P}|${process.env.STRATEGIUM_MSG}\\n`);\n');
		process.env.STRATEGIUM_ALARM = `"${process.execPath}" "${script}" "${out}"`;
		return async (want: number) => {
			for (let i = 0; i < 100; i++) {
				const lines = existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : [];
				if (lines.length >= want) return lines;
				await Bun.sleep(50);
			}
			return existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : [];
		};
	};
	afterEach(() => delete process.env.STRATEGIUM_ALARM);
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
		expect(s.notes.at(-1)).toContain("config takes notify on|off or idle <min>, or archmagos on|off; the other settings live in ~/.omp/agent/.env");
		await s.sub("config");
		expect(s.notes.at(-1)).not.toContain("cockpit:");
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
			expect(lines).toContain("awaiting orders");
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
				process.env.STRATEGIUM_ALARM = FAIL_ALARM;
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
				const lines = recorder(s.dir);
				await s.sub("cockpit");
				call(s, "tool_call", { toolName: "ask", input: {} });
				expect(ui.draws.closed).toBe(1);
				expect((await lines(1))[0]).toContain("attention|");
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
				process.env.STRATEGIUM_ALARM = FAIL_ALARM;
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

			test("opened while the session is idle it awaits orders; opened mid-turn the agent is at work", async () => {
				const { s, ui } = await running();
				host(s).idle = true;
				expect(await peek(s, ui)).toContain("○ AWAITING YOUR ORDERS");
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
				expect(view(ui)).toContain("AWAITING YOUR ORDERS");
				let n = ui.draws.n;
				host(s).idle = false;
				emit(s, "agent_start");
				expect(view(ui)).toContain("AGENT AT WORK");
				expect(ui.draws.n).toBeGreaterThan(n); // agent_start also refreshes the footer, which redraws the overlay
				n = ui.draws.n;
				Object.assign(host(s), { idle: true });
				emit(s, "agent_end");
				expect(view(ui)).toContain("AWAITING YOUR ORDERS");
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
				expect(view(ui)).toContain("AWAITING YOUR ORDERS");
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
					expect(view(ui)).toContain("AWAITING YOUR ORDERS");
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
			const lines = recorder(s.dir);
			s.todo(sealTodo("in_progress"));
			s.todo(sealTodo("completed"));
			expect(await lines(1)).toEqual(["done|K-1: seal Plan granted"]);
			s.todo(sealTodo("completed"));
			await Bun.sleep(300);
			expect(await lines(0)).toEqual(["done|K-1: seal Plan granted"]);
			expect(JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8")).phases).toEqual(sealTodo("completed"));
		});

		// A second seal, granted the normal way, proves the recorder is live: only its line may be in the file.
		const other = (status: string) => [{ name: "Other", tasks: [{ content: "[seal] Other", status }] }];
		async function control(s: ReturnType<typeof setup>, lines: (want: number) => Promise<string[]>) {
			s.todo(other("in_progress"));
			s.todo(other("completed"));
			expect(await lines(1)).toEqual(["done|K-1: seal Other granted"]);
			await Bun.sleep(300);
			expect(await lines(0)).toEqual(["done|K-1: seal Other granted"]);
		}

		test("a seal first seen granted does not sound", async () => {
			const { s } = await running();
			const lines = recorder(s.dir);
			s.todo(sealTodo("completed"));
			await control(s, lines);
		});

		test("with notifications off it stays silent", async () => {
			const { s } = await running();
			const lines = recorder(s.dir);
			await s.sub("config", "notify off");
			s.todo(sealTodo("in_progress"));
			s.todo(sealTodo("completed"));
			await s.sub("config", "notify on");
			await control(s, lines);
		});

		test("a failing alarm is reported", async () => {
			const { s } = await running();
			s.todo(sealTodo("in_progress"));
			process.env.STRATEGIUM_ALARM = FAIL_ALARM;
			s.todo(sealTodo("completed"));
			expect(s.notes.some(n => n.includes("the alarm failed"))).toBe(true);
		});

		test("without a UI a granted seal still sounds and nothing is drawn", async () => {
			const { s } = await running(false);
			const lines = recorder(s.dir);
			s.todo(sealTodo("in_progress"));
			s.todo(sealTodo("completed"));
			expect(await lines(1)).toEqual(["done|K-1: seal Plan granted"]);
		});

		test("a granted seal reaches the overlay", async () => {
			const { s, ui } = await running();
			recorder(s.dir);
			s.todo(sealTodo("in_progress"));
			s.todo(sealTodo("completed"));
			expect(await peek(s, ui)).toContain("granted");
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

		test("closing the session forgets the chronicle", async () => {
			const { s, ui } = await running();
			s.todo(sealTodo("in_progress"));
			expect(await chron(s, ui)).toContain("station Plan");
			shutdown(s);
			await s.start();
			const text = await peek(s, ui);
			expect(text).toContain("K-1");
			expect(text).not.toContain("station Plan");
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
	});
});
