import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index";
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

const fakeCtx = (sid: string, cwd: string, notes: string[] = []) => ({
	sessionManager: { getSessionId: () => sid },
	ui: { notify: (m: string) => notes.push(m), setStatus: () => {} },
	cwd,
	setInterval: () => 0,
	agent: { kind: "main" },
});

const dirs: string[] = [];
afterEach(() => {
	setSystemTime();
	delete process.env.STRATEGIUM_STATE_DIR;
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
	const ctx = fakeCtx(sid, dir, notes);
	const call = async (params: Record<string, unknown>) => (await tool.execute("id", params, undefined, undefined, ctx)).content[0].text;
	const command = (args: string) => commands.strategium.handler(args, ctx);
	return { dir, call, command, sent, notes, commands, handlers, ctx };
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
