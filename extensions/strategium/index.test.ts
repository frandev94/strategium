import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { whereFrom } from "./index";
import { claim, load, lockPath, openKeys } from "./timer";

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
		},
		tools,
		commands,
		handlers,
		sent,
		calls,
		activeTools: () => active,
		setActive: (n: string[]) => {
			active = n;
		},
	};
}

const fakeCtx = (sid: string, cwd: string, notes: string[] = [], footer: string[] = []) => ({
	sessionManager: { getSessionId: () => sid },
	ui: { notify: (m: string) => notes.push(m), setStatus: (_k: string, v?: string) => footer.push(v ?? "") },
	cwd,
	setInterval: () => 0,
	agent: { kind: "main" },
});

// omp loads ~/.omp/agent/.env into the process; a default theatre there must not change what the tests expect.
delete process.env.STRATEGIUM_THEATRE;

const dirs: string[] = [];
afterEach(() => {
	setSystemTime();
	delete process.env.STRATEGIUM_STATE_DIR;
	delete process.env.STRATEGIUM_GLYPHS;
	delete process.env.STRATEGIUM_NOTIFY;
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
	const { pi, tools, commands, handlers, sent, calls, activeTools, setActive } = fakePi();
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
	return { dir, call, command, sub, sent, calls, seen, footer, notes, commands, handlers, ctx, start, todo, shown, activeTools, setActive };
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
	});
});

// The command hands the objective to the Captain; the workflow does not need a ticket.
describe("the /strategium command", () => {
	test("free text in quotes is the objective", async () => {
		const { command, sent } = setup();
		await command('"add a dark mode"');
		expect(sent[0]).toContain('for the objective "add a dark mode" with no theatre');
	});

	test("a file is the objective, and a theatre may follow", async () => {
		const { command, sent } = setup();
		await command("@docs/spec.md acme");
		expect(sent[0]).toContain("for the objective @docs/spec.md with theatre skill://strategium-acme");
	});

	test("a theatre named with its prefix is not doubled", async () => {
		const { command, sent } = setup();
		await command("PROJ-1 strategium-acme");
		expect(sent[0]).toContain("theatre skill://strategium-acme.");
		expect(sent[0]).not.toContain("strategium-strategium-");
	});

	test("unquoted free text is refused: it would read as a key and a theatre", async () => {
		const { command, sent, notes } = setup();
		await command("make the header blue");
		expect(sent).toEqual([]);
		expect(notes[0]).toContain('"free text"');
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
		phase("Skirmish", ["[battle-brother] Slice 1", "in_progress"]),
		phase("Inquisition", ["[inquisitor] Review", "pending"]),
	];
	const backToScriptorium = [
		phase("Scriptorium", ["[librarian] Redraft slice 2", "in_progress"]),
		phase("Skirmish", ["[battle-brother] Slice 1", "completed"]),
	];
	const waitingForPlan = [phase("Scriptorium", ["[librarian] Plan", "completed"], ["[seal] Plan", "in_progress"])];

	test("the active phase is the station", () => expect(whereFrom(skirmish)).toEqual({ station: "Skirmish" }));
	test("a station before completed work is a return", () =>
		expect(whereFrom(backToScriptorium)).toEqual({ station: "Scriptorium", back: true }));
	test("an active seal task waits for the user, with or without glyph tags", () => {
		expect(whereFrom(waitingForPlan)).toEqual({ station: "Scriptorium", seal: "Plan" });
		expect(whereFrom([phase("Scriptorium", ["\u{f047a} seal · Plan the slices", "in_progress"])])?.seal).toBe("Plan");
	});
	test("no active task, no station", () => expect(whereFrom([phase("Muster", ["[captain] Muster", "pending"])])).toBeUndefined());

	test("the footer shows the station next to the time", async () => {
		const { call, todo, start, shown } = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await call({ action: "begin", key: "dark-mode" });
		todo(skirmish);
		// Within the 3-minute heartbeat gap, so the session start does not close the block as a crash.
		setSystemTime(new Date(2026, 10, 16, 9, 2, 0));
		start();
		expect(shown()).toContain("strategium: dark-mode · Skirmish · 2 min");
	});

	test("a timed run keeps its booking next to the station", async () => {
		const { call, todo, start, shown } = setup();
		setSystemTime(new Date(2026, 10, 16, 9, 0, 0));
		await call({ action: "begin", key: "PROJ-123", booked: 120 });
		todo(skirmish);
		setSystemTime(new Date(2026, 10, 16, 9, 2, 0));
		start();
		expect(shown()).toContain("PROJ-123 · Skirmish · 🌍 2/120 min (1%)");
	});

	test("a seal waiting for the user and a return are marked, in emoji or in Nerd Font glyphs", async () => {
		const { call, todo, start, shown } = setup();
		await call({ action: "begin", key: "dark-mode" });
		todo(waitingForPlan);
		start();
		expect(shown()).toContain("dark-mode · ⏳ seal Plan · ");
		todo(backToScriptorium);
		expect(shown()).toContain("dark-mode · ↩ Scriptorium · ");
		process.env.STRATEGIUM_GLYPHS = "1";
		todo(waitingForPlan);
		expect(shown()).toContain("dark-mode · \u{f051f}  seal Plan · ");
		todo(backToScriptorium);
		expect(shown()).toContain("dark-mode · \u{f054c}  Scriptorium · ");
	});

	test("the station survives a restart of omp", async () => {
		const first = setup("sess-0001");
		await first.call({ action: "begin", key: "dark-mode" });
		first.todo(skirmish);
		const again = setup("sess-0001", first.dir);
		again.start();
		expect(again.shown()).toContain("dark-mode · Skirmish · ");
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

	test("an agent outside the roster is refused during a run, allowed without one", async () => {
		const s = setup();
		expect(spawn(s, "code-reviewer")).toBeUndefined();
		await s.call({ action: "begin", key: "K-1" });
		expect(spawn(s, "code-reviewer")?.block).toBe(true);
		expect(spawn(s, "scout")).toBeUndefined();
		expect(spawn(s)).toBeUndefined();
	});

	test("a battle-brother is refused until the slices are declared", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "repo", repo: s.dir });
		expect(toolCall(s, "task", brothers(1))?.reason).toContain("declare the plan's slices first");
		expect(spawn(s, "battle-brother")?.reason).toContain("declare the plan's slices first");
		expect(toolCall(s, "task", { tasks: [{ agent: "scout" }] })).toBeUndefined();
	});

	test("every parallel slice launches in one call; later calls pass", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "repo", repo: s.dir });
		expect(await s.call({ action: "slices", slices: disjoint })).toBe("SLICES S1 (parallel), S2 (parallel)");
		expect(toolCall(s, "task", brothers(1))?.reason).toContain("launch every parallel slice (S1, S2) in one task call; this call has 1 battle-brother(s).");
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

	test("slices are checked: empty, ids, files and overlap", async () => {
		const s = setup();
		expect(await s.call({ action: "slices", slices: disjoint })).toBe("ERROR no active run in this session");
		await s.call({ action: "begin", key: "K-1" });
		expect(await s.call({ action: "slices", slices: [] })).toBe("ERROR slices needs at least one slice");
		expect(await s.call({ action: "slices", slices: [{ id: "", parallel: false, files: ["a"] }] })).toBe("ERROR every slice needs an id");
		expect(await s.call({ action: "slices", slices: [disjoint[0], disjoint[0]] })).toBe("ERROR duplicate slice id S1");
		expect(await s.call({ action: "slices", slices: [{ id: "S1", parallel: true, files: [] }] })).toBe("ERROR slice S1 lists no files");
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
		expect(out).toStartWith("ERROR slices S1 and S2 are both parallel and both change alarm/vox.ts.");
	});

	describe("slices whose agents have stopped", () => {
		const a = { id: "S1g-device-site", parallel: true, files: ["src/cards/attachments.ts"] };
		const b = { id: "S2b-grid-device-site", parallel: true, files: ["src/cards/attachments.ts", "src/grid.ts"] };
		const brother = (name: string, slice: string) => ({ agent: "battle-brother", name, isolated: true, task: `Read local://K-1-plan.md; build slice ${slice}.` });
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

		test("a stopped slice still listed is a warning, while a running one is an error", async () => {
			const s = await start();
			await s.call({ action: "slices", slices: [a, { ...b, files: ["src/grid.ts"] }] });
			launch(s, [brother("S1gDeviceSite", a.id), brother("Grid", b.id)], ["S1gDeviceSite", "Grid"]);
			expect(await s.call({ action: "slices", slices: [a, b] })).toStartWith("ERROR slices S1g-device-site and S2b-grid-device-site");
			end(s, "S1gDeviceSite");
			expect((await s.call({ action: "slices", slices: [a, b] })).split("\n")).toEqual([
				"WARN slice S1g-device-site is no longer active (its agent has stopped); sharing src/cards/attachments.ts with S2b-grid-device-site is not a conflict. " +
					'Remove it from the list, e.g. slices: [{"id":"S2b-grid-device-site","parallel":true,"files":["src/cards/attachments.ts","src/grid.ts"]}].',
				"SLICES S2b-grid-device-site (parallel)",
			]);
		});

		test("a stopped slice cannot be launched again on files a running agent is changing", async () => {
			const s = await start();
			await s.call({ action: "slices", slices: [a, { ...b, files: ["src/grid.ts"] }] });
			launch(s, [brother("S1gDeviceSite", a.id), brother("Grid", b.id)], ["S1gDeviceSite", "Grid"]);
			end(s, "S1gDeviceSite");
			await s.call({ action: "slices", slices: [a, b] });
			// The rally would share attachments.ts with S2b, still running.
			expect(launch(s, [brother("S1gDeviceSite", a.id)], ["S1gDeviceSite-2"])?.reason).toBe(
				"Strategium: slice S1g-device-site changes src/cards/attachments.ts, which slice S2b-grid-device-site is changing right now. " +
					"Two agents working on the same file at the same time overwrite each other's changes. Wait until that agent has finished, then launch this one.",
			);
			end(s, "Grid");
			expect(launch(s, [brother("S1gDeviceSite", a.id)], ["S1gDeviceSite-2"])).toBeUndefined();
			// The first run's completion, still in the history, does not stop the rally.
			end(s, "S1gDeviceSite");
			expect(await s.call({ action: "slices", slices: [a, b] })).toStartWith("WARN slice S2b-grid-device-site is no longer active");
			end(s, "S1gDeviceSite-2");
			expect(await s.call({ action: "slices", slices: [a, b] })).toEndWith("SLICES none");
		});

		test("a name reused for two slices: each agent id stops only its own slice", async () => {
			const s = await start();
			const x = { id: "S1", parallel: true, files: ["x.ts"] };
			const y = { id: "S2", parallel: true, files: ["y.ts"] };
			await s.call({ action: "slices", slices: [x, y] });
			launch(s, [brother("Builder", "S1"), brother("Builder", "S2")], ["Builder", "Builder-2"]);
			end(s, "Builder");
			const out = await s.call({ action: "slices", slices: [x, { ...y, files: ["x.ts", "y.ts"] }] });
			expect(out.split("\n")[0]).toStartWith("WARN slice S1 is no longer active");
			expect(out).toEndWith("SLICES S2 (parallel)");
		});

		test("a slice stops only when every agent building it has ended", async () => {
			const s = await start();
			const x = { id: "S1", parallel: true, files: ["x.ts"] };
			const y = { id: "S2", parallel: true, files: ["x.ts"] };
			await s.call({ action: "slices", slices: [x] });
			// Two agents for one slice in one call are refused...
			expect(launch(s, [brother("A", "S1"), brother("B", "S1")], ["A", "B"])?.reason).toContain("which another agent for the same slice is changing right now");
			// ...and so is a second one while the first runs.
			launch(s, [brother("A", "S1")], ["A"]);
			expect(launch(s, [brother("B", "S1")], ["B"])?.reason).toContain("another agent for the same slice");
			// Should two run anyway (the host bound both), the first end leaves the slice running.
			for (const h of s.handlers.tool_result)
				h({ toolName: "task", input: { tasks: [brother("B", "S1")] }, details: { progress: [{ index: 0, id: "B", status: "running" }] }, isError: false }, s.ctx);
			end(s, "A");
			expect(await s.call({ action: "slices", slices: [x, y] })).toStartWith("ERROR slices S1 and S2");
			end(s, "B");
			expect(await s.call({ action: "slices", slices: [x, y] })).toStartWith("WARN slice S1 is no longer active");
		});

		test("an agent that already ended when its call returned never counts as running", async () => {
			const s = await start();
			await s.call({ action: "slices", slices: [a] });
			launch(s, [brother("S1gDeviceSite", a.id)], ["S1gDeviceSite"], "completed");
			expect(await s.call({ action: "slices", slices: [a, b] })).toStartWith("WARN slice S1g-device-site is no longer active");
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

	// omp switches by mutating one SessionManager (setSessionFile): the id changes under the same object.
	const shared = (sid: string, dir: string, footer: string[]) => {
		const sm = { sid, getSessionId: () => sm.sid };
		return { sm, ctx: { ...fakeCtx(sid, dir, [], footer), sessionManager: sm } };
	};

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

		test("keeps hidden, repo, slices and launched", async () => {
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
			await s.call({ action: "begin", key: "K-1" });
			const stored = () => JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8"));
			expect(stored().untimed).toBe(true);
			await s.call({ action: "begin", key: "K-1", booked: 120 });
			expect(stored().untimed).toBeUndefined();
			expect(stored().key).toBe("K-1");
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
	const ROSTER = ["scout", "librarian", "battle-brother", "veteran", "apothecary", "inquisitor", "security-reviewer", "sonic", "task"];
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

	test("a sequential slice is not counted as parallel", async () => {
		const { tool } = await run([disjoint[0], { id: "S2", parallel: false, files: ["b.ts"] }]);
		expect(tool("task", brothers(1))).toBeUndefined();
	});

	test("the single form of task is judged like a batch item", async () => {
		const none = await run();
		expect(none.tool("task", { agent: "battle-brother", task: "x" })?.reason).toContain("declare the plan's slices first");
		const two = await run(disjoint);
		expect(two.tool("task", { agent: "battle-brother", task: "x" })?.reason).toContain("launch every parallel slice (S1, S2)");
		expect(two.tool("task", { agent: "scout", task: "x" })).toBeUndefined();
	});

	test("declaring the slices again resets the launch", async () => {
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
			expect(spawn(name)?.reason).toContain("declare the plan's slices first");
		expect(spawn("x/scout")).toBeUndefined();
		expect(spawn("OMP:Sonic")).toBeUndefined();
	});

	test("the whole roster passes, anything else is refused with the roster in the reason", async () => {
		const { spawn } = await run(disjoint);
		for (const name of ROSTER) expect(spawn(name)).toBeUndefined();
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
