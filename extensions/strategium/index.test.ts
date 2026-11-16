import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { whereFrom } from "./index";
import { load, openKeys } from "./timer";

// The extension registers itself on a host. A fake one is enough: it hands back the tool it
// registered and does nothing else.
type Tool = { name: string; execute: (id: string, params: Record<string, unknown>, s: unknown, u: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }> };

const schema = () => {
	const s: Record<string, unknown> = {};
	for (const m of ["optional", "int", "positive", "nonnegative", "describe"]) s[m] = () => s;
	return s;
};

function fakePi() {
	const tools: Tool[] = [];
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
	const handlers: Record<string, ((e: unknown, ctx: unknown) => unknown)[]> = {};
	const sent: string[] = [];
	const zod = {
		object: () => schema(),
		string: () => schema(),
		number: () => schema(),
		enum: () => schema(),
	};
	return {
		pi: {
			zod,
			setLabel: () => {},
			registerTool: (t: Tool) => tools.push(t),
			registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) => (commands[name] = cmd),
			on: (event: string, fn: (e: unknown, ctx: unknown) => unknown) => ((handlers[event] ??= []).push(fn)),
			sendUserMessage: (m: string) => sent.push(m),
			sendMessage: () => {},
		},
		tools,
		commands,
		handlers,
		sent,
	};
}

const fakeCtx = (sid: string, cwd: string, notes: string[] = [], footer: string[] = []) => ({
	sessionManager: { getSessionId: () => sid },
	ui: { notify: (m: string) => notes.push(m), setStatus: (_k: string, v?: string) => footer.push(v ?? "") },
	cwd,
	setInterval: () => 0,
	agent: { kind: "main" },
});

const dirs: string[] = [];
afterEach(() => {
	setSystemTime();
	delete process.env.STRATEGIUM_STATE_DIR;
	delete process.env.STRATEGIUM_GLYPHS;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(sid = "sess-0001", shared?: string) {
	const dir = shared ?? mkdtempSync(join(tmpdir(), "st-index-"));
	if (!shared) dirs.push(dir);
	process.env.STRATEGIUM_STATE_DIR = dir;
	const { pi, tools, commands, handlers, sent } = fakePi();
	extension(pi as never);
	const tool = tools.find(t => t.name === "strategium")!;
	const notes: string[] = [];
	const footer: string[] = [];
	const ctx = fakeCtx(sid, dir, notes, footer);
	const call = async (params: Record<string, unknown>) => (await tool.execute("id", params, undefined, undefined, ctx)).content[0].text;
	const command = (args: string) => commands.strategium.handler(args, ctx);
	// The session starts (it draws the footer), and the Captain updates the todo.
	const start = () => handlers.session_start[0]({}, ctx);
	const todo = (phases: unknown) => handlers.tool_result[0]({ toolName: "todo", isError: false, details: { phases } }, ctx);
	// The last footer line, without its colours.
	const shown = () => (footer.at(-1) ?? "").replace(/\x1b\[[0-9;]*m/g, "");
	return { dir, call, command, sent, notes, commands, handlers, ctx, start, todo, shown };
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

	test("unquoted free text is refused, so it never clashes with a subcommand", async () => {
		const { command, sent, notes } = setup();
		await command("make the header blue");
		expect(sent).toEqual([]);
		expect(notes[0]).toContain("put a free objective in quotes");
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
