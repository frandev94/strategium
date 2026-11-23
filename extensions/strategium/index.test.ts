import { afterEach, describe, expect, setSystemTime, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { keyOf, parseTiers, readTranscript, ROSTER, whereFrom } from "./index";
import { allocateName, NAMED_AGENTS, type NameEntry } from "./names";
import { runOutcomes } from "./roster";
import { cockpitView } from "./cockpit";
import { append, claim, type Ev, load, lockPath, nowIso, openKeys, release } from "./timer";

// The extension registers itself on a host. A fake one is enough: it hands back the tool it
// registered and does nothing else.
type Tool = { name: string; description?: string; execute: (id: string, params: Record<string, unknown>, s: unknown, u: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }> };

const schema = () => {
	const s: Record<string, unknown> = {};
	for (const m of ["optional", "int", "positive", "nonnegative", "min", "max", "describe", "array", "boolean"]) s[m] = () => s;
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
delete process.env.STRATEGIUM_NAMES;
delete process.env.STRATEGIUM_VAULT;

const dirs: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	setSystemTime();
	delete process.env.STRATEGIUM_STATE_DIR;
	delete process.env.STRATEGIUM_COCKPIT_KEY;
	delete process.env.STRATEGIUM_COCKPIT_THEME;
	delete process.env.STRATEGIUM_RELIC;
	delete process.env.STRATEGIUM_NAMES;
	delete process.env.STRATEGIUM_VAULT;
	for (const k of Object.keys(process.env)) if (k.startsWith("STRATEGIUM_CASTER")) delete process.env[k];
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

function setup(sid = "sess-0001", shared?: string, deps: Record<string, unknown> = {}) {
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
	extension(pi as never, { spawn: alarm.spawn, ...deps });
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
	return { dir, tool, call, command, sub, sent, calls, seen, footer, notes, commands, handlers, shortcuts, conflicts, ctx, start, todo, shown, activeTools, setActive };
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

	describe("report splits the overlaps (#156)", () => {
		const day = (dir: string, d: number, rows: [number, number, "start" | "stop", string][]) => {
			for (const [h, m, event, key] of rows) append(join(dir, `2026-11-${d}.jsonl`), { ts: nowIso(new Date(2026, 10, d, h, m)), event, key });
		};

		test("each overlap is listed with its keys and range, and each key gets a split total", async () => {
			const { call, dir } = setup();
			setSystemTime(new Date(2026, 10, 16, 12, 0, 0));
			day(dir, 15, [[9, 0, "start", "A"], [9, 30, "start", "B"], [10, 0, "stop", "A"], [10, 30, "stop", "B"]]);
			const out = await call({ action: "report", date: "2026-11-15" });
			const lines = out.split("\n");
			const i = lines.findIndex(l => l.startsWith("OVERLAP 30 min"));
			expect(lines.slice(i + 1)).toEqual([
				"OVERLAP A+B 09:30-10:00 (30 min, 15 each)",
				"SPLIT A 45 min (measured after an equal split of the overlaps)",
				"SPLIT B 45 min (measured after an equal split of the overlaps)",
			]);
		});

		test("a block left open on a past day ends 23:59 in the block and the OVERLAP lines", async () => {
			const { call, dir } = setup();
			setSystemTime(new Date(2026, 10, 16, 12, 0, 0));
			day(dir, 15, [[9, 0, "start", "A"], [9, 30, "start", "B"]]);
			const out = await call({ action: "report", date: "2026-11-15" });
			expect(out).toContain("A 09:00-23:59 (");
			expect(out).toContain("B 09:30-23:59 (");
			expect(out).toMatch(/OVERLAP A\+B 09:30-23:59 \(/);
			expect(out).not.toContain("now");
		});

		test("the keys of an overlap are listed sorted, whichever started first", async () => {
			const { call, dir } = setup();
			setSystemTime(new Date(2026, 10, 16, 12, 0, 0));
			day(dir, 15, [[9, 0, "start", "B"], [9, 30, "start", "A"], [10, 0, "stop", "A"], [10, 0, "stop", "B"]]);
			expect(await call({ action: "report", date: "2026-11-15" })).toContain("OVERLAP A+B 09:30-10:00 (30 min, 15 each)");
		});

		test("an overlap interval shorter than a minute is not listed", async () => {
			const { call, dir } = setup();
			setSystemTime(new Date(2026, 10, 16, 12, 0, 0));
			day(dir, 15, [[9, 0, "start", "A"], [9, 30, "start", "B"], [10, 0, "start", "C"]]);
			append(join(dir, "2026-11-15.jsonl"), { ts: nowIso(new Date(2026, 10, 15, 10, 0, 30)), event: "stop", key: "C" });
			const out = await call({ action: "report", date: "2026-11-15" });
			expect(out).toMatch(/OVERLAP A\+B 09:30-10:00 \(30 min/);
			expect(out).not.toContain("A+B+C");
			expect(out).toContain("SPLIT C 0 min");
		});

		test("an interval still open ends in now", async () => {
			const { call, dir } = setup();
			setSystemTime(new Date(2026, 10, 16, 10, 0, 0));
			day(dir, 16, [[9, 0, "start", "A"], [9, 30, "start", "B"]]);
			expect(await call({ action: "report" })).toContain("OVERLAP A+B 09:30-now (30 min, 15 each)");
		});

		test("without an overlap the report has no OVERLAP or SPLIT line", async () => {
			const { call, dir } = setup();
			setSystemTime(new Date(2026, 10, 16, 12, 0, 0));
			day(dir, 15, [[9, 0, "start", "A"], [9, 30, "stop", "A"], [9, 30, "start", "B"], [10, 0, "stop", "B"]]);
			const out = await call({ action: "report", date: "2026-11-15" });
			expect(out).not.toMatch(/OVERLAP|SPLIT/);
			expect(out.split("\n")).toEqual([
				"A 09:00-09:30 (30 min)",
				"B 09:30-10:00 (30 min)",
				"TOTAL A measured 30 min, worked 30 min with prior and adjustments (~30 min)",
				"TOTAL B measured 30 min, worked 30 min with prior and adjustments (~30 min)",
			]);
		});
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
		expect(sent[0]).toContain("rule://strategium-captain");
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

	test("the move carries the plan-mode agents' live rows, keeping the newer row on a clash", async () => {
		const { s, sm, ctx } = await owner();
		const live = (sid: string, id: string, cost: number) => {
			mkdirSync(join(s.dir, "runs", `${sid}.live`), { recursive: true });
			writeFileSync(join(s.dir, "runs", `${sid}.live`, `${id}.json`), JSON.stringify({ since: 1, at: 1, busy: 0, cost }));
		};
		live("sess-A", "P", 0.5);
		live("sess-A", "Q", 0.1);
		live("sess-B", "Q", 0.9);
		await approve(s, sm, ctx);
		const read = (id: string) => JSON.parse(readFileSync(join(s.dir, "runs", "sess-B.live", `${id}.json`), "utf8")).cost;
		expect(read("P")).toBe(0.5);
		expect(read("Q")).toBe(0.9);
		expect(existsSync(join(s.dir, "runs", "sess-A.live"))).toBe(false);
	});

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

	test("the vault warns once across the plan hand-off (#151)", async () => {
		const v = mkdtempSync(join(tmpdir(), "st-vault-"));
		dirs.push(v);
		writeFileSync(join(v, ".strategium.json"), JSON.stringify({ daily: "Daily/{date}.md", heading: "## Log", line: "- {text}" }));
		process.env.STRATEGIUM_VAULT = v;
		const { s, sm, ctx, notes } = await owner();
		await todoResult(s, ctx, "start", planStations());
		await approve(s, sm, ctx);
		await todoResult(s, ctx, "init", handOff());
		const warned = (a: string[]) => a.filter(n => n.startsWith("Strategium: vault ") && n.includes("daily missing"));
		expect([...warned(s.notes), ...warned(notes)]).toHaveLength(1);
		expect(movedRun(s.dir).recorded).toEqual(["begin", "seal:Plan"]);
	});

	test("a mid-run rebuild init does not make the next done log the station again (#97)", async () => {
		const { s, ctx } = await owner();
		const stations = (muster: string, skirmish: string) => [phase("Muster", ["[captain] Objective", muster]), phase("Skirmish", ["[battle-brother] Squads", skirmish])];
		await todoResult(s, ctx, "start", stations("completed", "in_progress"));
		await todoResult(s, ctx, "init", stations("in_progress", "pending"));
		await todoResult(s, ctx, "done", stations("completed", "in_progress"));
		expect((JSON.parse(readFileSync(join(s.dir, "runs", "sess-A.cockpit"), "utf8")).chronicle as { text: string }[]).filter(e => e.text === "station Skirmish")).toHaveLength(1);
	});

	test("a restart then a rebuild init does not make the next done log the station again (#97)", async () => {
		const { s, ctx } = await owner();
		const stations = (muster: string, skirmish: string) => [phase("Muster", ["[captain] Objective", muster]), phase("Skirmish", ["[battle-brother] Squads", skirmish])];
		await todoResult(s, ctx, "start", stations("completed", "in_progress"));
		const again = setup("sess-A", s.dir);
		await again.start();
		await todoResult(again, again.ctx, "init", stations("in_progress", "pending"));
		await todoResult(again, again.ctx, "done", stations("completed", "in_progress"));
		const text = (JSON.parse(readFileSync(join(s.dir, "runs", "sess-A.cockpit"), "utf8")).chronicle as { text: string }[]).map(e => e.text);
		expect(text.filter(t => t === "station Skirmish")).toHaveLength(1);
	});

	test("a new run in the same session logs its first station even when the last run ended there (#97)", async () => {
		const { s, ctx } = await owner();
		const todo = [phase("Muster", ["[captain] Objective", "in_progress"])];
		await todoResult(s, ctx, "start", todo);
		await s.call({ action: "end" });
		await s.call({ action: "begin", key: "K-2" });
		await todoResult(s, ctx, "start", todo);
		const text = (JSON.parse(readFileSync(join(s.dir, "runs", "sess-A.cockpit"), "utf8")).chronicle as { text: string }[]).map(e => e.text);
		expect(text.filter(t => t === "station Muster")).toHaveLength(1);
		expect(load(join(s.dir, "2026-11-16.jsonl")).filter(e => e.event === "station" && e.key === "K-2")).toHaveLength(1);
	});

	test("a rebuild init while a seal waits logs seal awaits and its journal record once, and a seal asked again after its grant still logs (#97)", async () => {
		const { s, ctx } = await owner();
		const seal = (status: string, next: string) => [phase("Plan", ["[seal] Plan", status]), phase("Skirmish", ["[battle-brother] Squads", next])];
		await todoResult(s, ctx, "start", seal("in_progress", "pending"));
		await todoResult(s, ctx, "init", [phase("Muster", ["[captain] Objective", "in_progress"]), ...seal("pending", "pending")]);
		await todoResult(s, ctx, "done", seal("in_progress", "pending"));
		const asked = () => (JSON.parse(readFileSync(join(s.dir, "runs", "sess-A.cockpit"), "utf8")).chronicle as { text: string }[]).filter(e => e.text.includes("seal Plan awaits"));
		expect(asked()).toHaveLength(1);
		expect(load(join(s.dir, "2026-11-16.jsonl")).filter(e => e.event === "seal" && e.state === "asked")).toHaveLength(1);
		await todoResult(s, ctx, "done", seal("completed", "in_progress"));
		await todoResult(s, ctx, "done", seal("in_progress", "pending"));
		expect(asked()).toHaveLength(2);
	});

	const askedCount = (dir: string) => (JSON.parse(readFileSync(join(dir, "runs", "sess-A.cockpit"), "utf8")).chronicle as { text: string }[]).filter(e => e.text.includes("seal Plan awaits")).length;
	const askedEvents = (dir: string) => load(join(dir, "2026-11-16.jsonl")).filter(e => e.event === "seal" && e.state === "asked" && e.key === "K-1").length;

	test("a seal that waited, was left, and waits again after a restart is logged twice (#97)", async () => {
		const { s, ctx } = await owner();
		const plan = (status: string) => [phase("Draft", ["[captain] Draft", status === "in_progress" ? "completed" : "in_progress"]), phase("Plan", ["[seal] Plan", status])];
		await todoResult(s, ctx, "start", [phase("Plan", ["[seal] Plan", "in_progress"])]);
		await todoResult(s, ctx, "done", plan("pending"));
		const again = setup("sess-A", s.dir);
		await again.start();
		await todoResult(again, again.ctx, "done", plan("in_progress"));
		expect(askedCount(s.dir)).toBe(2);
		expect(askedEvents(s.dir)).toBe(2);
	});

	test("a restart then a rebuild init while a seal waits logs it once (#97)", async () => {
		const { s, ctx } = await owner();
		const seal = (status: string) => [phase("Plan", ["[seal] Plan", status]), phase("Skirmish", ["[battle-brother] Squads", "pending"])];
		await todoResult(s, ctx, "start", seal("in_progress"));
		const again = setup("sess-A", s.dir);
		await again.start();
		await todoResult(again, again.ctx, "init", [phase("Muster", ["[captain] Objective", "in_progress"]), ...seal("pending")]);
		await todoResult(again, again.ctx, "done", seal("in_progress"));
		expect(askedCount(s.dir)).toBe(1);
		expect(askedEvents(s.dir)).toBe(1);
	});

	test("a run that ended with a seal waiting does not hide it from the next run of the session (#97)", async () => {
		const { s, ctx } = await owner();
		const todo = [phase("Plan", ["[seal] Plan", "in_progress"])];
		await todoResult(s, ctx, "start", todo);
		await s.call({ action: "end" });
		await s.call({ action: "begin", key: "K-2" });
		await todoResult(s, ctx, "start", todo);
		expect(askedCount(s.dir)).toBe(1);
		expect(load(join(s.dir, "2026-11-16.jsonl")).filter(e => e.event === "seal" && e.state === "asked" && e.key === "K-2")).toHaveLength(1);
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
		expect(chronicle()).not.toContain("station Muster");
		expect(count("Plan granted")).toBe(1);
		expect(count("seal Plan awaits")).toBe(waiting);
		const done = [phase("Plan", ["[seal] Plan", "completed"]), phase("Muster", ["[captain] Objective", "completed"]), phase("Deployment", ["[captain] Branch and squads", "in_progress"])];
		await todoResult(s, ctx, "done", done);
		expect(count("Plan granted")).toBe(1);
	});

	test("a reverse init (to Scriptorium) while a Skirmish seal waits is no hand-off: no grant logged", async () => {
		const { s, ctx } = await owner();
		await todoResult(s, ctx, "start", [
			phase("Deployment", ["[captain] Branch and squads", "completed"]),
			phase("Skirmish", ["[battle-brother] Squads", "completed"], ["[seal] Demo", "in_progress"]),
			phase("Inquisition", ["[inquisitor] Review", "pending"]),
			phase("Debrief", ["[captain] Debrief", "pending"]),
		]);
		await todoResult(s, ctx, "init", [phase("Scriptorium", ["[librarian] Plan", "in_progress"], ["[seal] Plan", "pending"])]);
		const log = (JSON.parse(readFileSync(join(s.dir, "runs", "sess-A.cockpit"), "utf8")).chronicle as { text: string }[]).map(e => e.text);
		expect(log.filter(t => t.includes("Demo granted"))).toEqual([]);
		expect(log).not.toContain("station Muster");
	});

	test("a reverse init with the real shape (Muster/Auspex/Scriptorium) at Skirmish with a Demo seal waiting moves nothing and grants nothing", async () => {
		const { s, ctx } = await owner();
		await todoResult(s, ctx, "start", [
			phase("Deployment", ["[captain] Branch and squads", "completed"]),
			phase("Skirmish", ["[battle-brother] Squads", "completed"], ["[seal] Demo", "in_progress"]),
			phase("Inquisition", ["[inquisitor] Review", "pending"]),
			phase("Debrief", ["[captain] Debrief", "pending"]),
		]);
		expect(s.shown()).toContain("seal Demo");
		await todoResult(s, ctx, "init", [
			phase("Muster", ["[captain] Objective", "in_progress"], ["[captain] Orders", "pending"]),
			phase("Auspex", ["[scout] Map", "pending"]),
			phase("Scriptorium", ["[librarian] Plan", "pending"], ["[seal] Plan", "pending"]),
		]);
		const log = (JSON.parse(readFileSync(join(s.dir, "runs", "sess-A.cockpit"), "utf8")).chronicle as { text: string }[]).map(e => e.text);
		expect(s.shown()).toContain("seal Demo");
		expect(log).not.toContain("station Muster");
		expect(log.filter(t => t.includes("granted"))).toEqual([]);
	});

	test("a hand-off with a pending user task left in Scriptorium still logs the Plan grant once and moves the footer to Deployment", async () => {
		const { s, sm, ctx } = await owner();
		await todoResult(s, ctx, "start", [
			phase("Muster", ["[captain] Objective", "completed"]),
			phase("Scriptorium", ["[librarian] Plan", "completed"], ["[seal] Plan", "in_progress"], ["[user] Own errand", "pending"]),
		]);
		await approve(s, sm, ctx);
		await todoResult(s, ctx, "init", handOff());
		expect(chronicleOf(s.dir).filter(t => t.includes("Plan granted"))).toHaveLength(1);
		expect(s.shown()).toContain("Deployment");
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

	test("a key open over midnight, then begin with booked and via, records the via on the new day's start", async () => {
		const s = setup();
		setSystemTime(T(23, 30));
		await s.call({ action: "begin", key: "K-1" });
		await s.start();
		await toMidnight(s);
		const pb = { key: "P", reason: "parent booking" } as const;
		await s.call({ action: "begin", key: "K-1", booked: 90, via: pb });
		const last = dayEvents(s.dir, 17).filter(e => e.event === "start").at(-1)!;
		expect(last.booked).toBe(90);
		expect(last.via).toEqual(pb);
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
		expect((await c.call({ action: "end", key: "K-1", takeover: "sess-0001" })).split("\n").slice(0, 2)).toEqual(["ENDED K-1", expect.stringMatching(/^DEBRIEF /)]);
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
		expect((await s.call({ action: "end" })).split("\n").slice(0, 2)).toEqual(["ENDED K-1", expect.stringMatching(/^DEBRIEF /)]);
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
		expect(s.notes.at(-1)).toContain("config takes notify on|off or idle <min>, or archmagos on|off, or commit on|off, or sound on|off, or toast on|off, or volume <0-100> [preview], or cockpit-key <key>, or cockpit-theme <name>, or relic on|off|default, or caster on|off|default, or names on|off|default, or vault <absolute folder>|off|default; the other settings live in ~/.omp/agent/.env");
		await s.sub("config");
		expect(s.notes.at(-1)).not.toContain("cockpit:");
	});

	test("the host disposing the overlay frees the cockpit; a late dispose of an old overlay leaves the open one alone", async () => {
		const { s, ui } = await running();
		await s.sub("cockpit");
		expect(ui.opened.length).toBe(1);
		ui.opened[0].component.dispose!(); // the host tears it down: no Esc, no q
		await s.sub("cockpit");
		expect(ui.opened.length).toBe(2);
		ui.opened[0].component.dispose!(); // the old overlay, disposed late, while the new one is open
		await s.sub("cockpit");
		expect(ui.opened.length).toBe(2); // still refused: the cockpit is open
		ui.opened[1].component.dispose!();
		ui.opened[1].component.dispose!(); // idempotent
		await s.sub("cockpit");
		expect(ui.opened.length).toBe(3);
		ui.opened[2].component.handleInput!("q");
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

	describe("the relic look", () => {
		test("the default is off: config names it and the overlay is the plain frame", async () => {
			const { s, ui } = await running();
			await s.sub("config");
			expect(s.notes.at(-1)).toContain("relic: off (default)");
			await s.sub("cockpit");
			const comp = ui.opened.at(-1)!.component;
			const plainFrame = comp.render(100).join("\n");
			await s.sub("config", "relic on");
			expect(comp.render(100).join("\n")).not.toBe(plainFrame);
			expect(comp.render(100).join("\n")).toMatch(/[╍┅╌┄•]/);
			comp.handleInput!("q");
		});

		test("relic on|off saves the choice and applies it at once; default drops the file", async () => {
			const { s, ui } = await running();
			await s.sub("cockpit");
			const comp = ui.opened.at(-1)!.component;
			const before = comp.render(100).join("\n");
			await s.sub("config", "relic on");
			expect(readFileSync(join(s.dir, "relic"), "utf8")).toBe("on");
			expect(s.notes.at(-1)).toContain("relic: on (/strategium-config)");
			await s.sub("config", "relic off");
			expect(readFileSync(join(s.dir, "relic"), "utf8")).toBe("off");
			expect(s.notes.at(-1)).toContain("relic: off (/strategium-config)");
			expect(comp.render(100).join("\n")).toBe(before);
			await s.sub("config", "relic default");
			expect(existsSync(join(s.dir, "relic"))).toBe(false);
			expect(s.notes.at(-1)).toContain("relic: off (default)");
			comp.handleInput!("q");
		});

		test("STRATEGIUM_RELIC picks it (1/0), other values are ignored, and a saved choice wins", async () => {
			process.env.STRATEGIUM_RELIC = "1";
			const s = setup();
			await s.sub("config");
			expect(s.notes.at(-1)).toContain("relic: on (STRATEGIUM_RELIC)");
			await s.sub("config", "relic off");
			expect(s.notes.at(-1)).toContain("relic: off (/strategium-config)");
			process.env.STRATEGIUM_RELIC = "yes";
			await s.sub("config", "relic default");
			expect(s.notes.at(-1)).toContain("relic: off (default)");
			process.env.STRATEGIUM_RELIC = "0";
			const s0 = setup();
			await s0.sub("config");
			expect(s0.notes.at(-1)).toContain("relic: off (STRATEGIUM_RELIC)");
		});

		test("a bad relic argument is refused and writes no file", async () => {
			const s = setup();
			for (const bad of ["relic maybe", "relic ON", "relic Default"]) {
				await s.sub("config", bad);
				expect(s.notes.at(-1)).toContain("config takes");
			}
			expect(existsSync(join(s.dir, "relic"))).toBe(false);
		});
	});

	describe("the caster", () => {
		type Call = { model: unknown; context: { systemPrompt: string[]; messages: { role: string; content: string }[] }; options: { apiKey: unknown; disableReasoning: boolean; maxTokens: number; signal: AbortSignal } };
		const reply = (text: string, extra: object = {}) => ({ stopReason: "stop", content: [{ type: "text", text }], usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 150, cost: { total: 0.002 } }, ...extra });
		const timers: { fn: () => void; ms: number }[] = [];
		const realSet = globalThis.setInterval;
		afterEach(() => {
			globalThis.setInterval = realSet;
			timers.length = 0;
		});
		const t0 = (sec = 0) => setSystemTime(new Date(2026, 10, 16, 9, 0, sec));
		// The completion is the seam: a fake completeSimple that records what it was asked. The alias, model, auth and text code run for real.
		async function casting(o: { env?: Record<string, string>; answer?: (c: Call) => Promise<unknown>; resolve?: (spec: string) => unknown; auth?: boolean; open?: boolean } = {}) {
			Object.assign(process.env, o.env);
			const calls: Call[] = [];
			const completeSimple = (model: unknown, context: Call["context"], options: Call["options"]) => {
				const c = { model, context, options };
				calls.push(c);
				return (o.answer ?? (async () => reply("Alpha is green.")))(c);
			};
			t0();
			const s = setup("sess-0001", undefined, { completeSimple });
			const ui = uiCtx(s);
			Object.assign(s.ctx, {
				models: { resolve: o.resolve ?? ((spec: string) => ({ spec })) },
				modelRegistry: { hasConfiguredAuth: () => o.auth !== false, resolver: (_m: unknown, sid: string) => ({ resolverFor: sid }) },
			});
			await s.call({ action: "begin", key: "K-1" });
			await s.start();
			globalThis.setInterval = ((fn: () => void, ms: number) => timers.push({ fn, ms })) as never;
			if (o.open !== false) await s.sub("cockpit");
			return { s, ui, calls };
		}
		// Two frames: the caster looks at every second one, like the children's files.
		const tick = async () => {
			timers.at(-1)!.fn();
			timers.at(-1)!.fn();
			await Bun.sleep(0);
		};
		const shownText = (ui: { opened: { component: { render(w: number): string[] } }[] }) => plain(ui.opened.at(-1)!.component.render(100).join("\n"));
		const station = (s: { todo: (p: unknown) => void }, task: string) => s.todo([{ name: "Plan", tasks: [{ content: task, status: "in_progress" }] }]);
		const cockpitJson = (s: { dir: string }) => JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.cockpit"), "utf8"));
		const debriefOf = (s: { dir: string }) => readFileSync(join(s.dir, "debriefs", readdirSync(join(s.dir, "debriefs"))[0]), "utf8");

		test("off: no call and no CASTER box, and the run report never mentions the caster", async () => {
			const { s, ui, calls } = await casting();
			await tick();
			t0(300);
			station(s, "Draft");
			await tick();
			expect(calls).toHaveLength(0);
			expect(shownText(ui)).not.toContain("CASTER");
			await s.call({ action: "end" });
			expect(debriefOf(s)).not.toContain("caster");
		});

		test("on and open: one call through the resolved role alias, and the summary is drawn", async () => {
			const { ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" } });
			expect(shownText(ui)).toContain("listening…");
			await tick();
			expect(calls).toHaveLength(1);
			expect(calls[0].model).toEqual({ spec: "@smol" });
			expect(calls[0].options).toMatchObject({ disableReasoning: true, maxTokens: 200, apiKey: { resolverFor: "sess-0001" } });
			expect(calls[0].options.signal.aborted).toBe(false);
			expect(calls[0].context.messages[0].content).toContain("STATION: no station yet");
			expect(shownText(ui)).toContain("CASTER · no station yet");
			expect(shownText(ui)).toContain("Alpha is green.");
		});

		test("nothing changed for three intervals: still one call", async () => {
			const { ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" } });
			await tick();
			for (const sec of [61, 122, 183, 244]) {
				t0(sec);
				await tick();
			}
			expect(calls).toHaveLength(1);
			expect(shownText(ui)).toContain("Alpha is green.");
		});

		test("a changed state calls again only after the interval", async () => {
			const { s, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" } });
			await tick();
			t0(30);
			station(s, "Draft");
			await tick();
			expect(calls).toHaveLength(1);
			t0(61);
			await tick();
			expect(calls).toHaveLength(2);
			expect(calls[1].context.messages[0].content).toContain("STATION: Plan");
		});

		test("STRATEGIUM_CASTER_EVERY_MIN=2 is respected", async () => {
			const { s, calls } = await casting({ env: { STRATEGIUM_CASTER: "1", STRATEGIUM_CASTER_EVERY_MIN: "2" } });
			await tick();
			station(s, "Draft");
			t0(61);
			await tick();
			expect(calls).toHaveLength(1);
			t0(121);
			await tick();
			expect(calls).toHaveLength(2);
		});

		test("one call at a time: a state change while a call is in flight starts none", async () => {
			const { s, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: () => new Promise(() => {}) });
			await tick();
			station(s, "Draft");
			t0(300);
			await tick();
			expect(calls).toHaveLength(1);
		});

		test("closing the cockpit aborts the call in flight and no call starts after", async () => {
			const { s, ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: () => new Promise(() => {}) });
			await tick();
			expect(calls[0].options.signal.aborted).toBe(false);
			ui.opened[0].component.handleInput!("q");
			expect(calls[0].options.signal.aborted).toBe(true);
			station(s, "Draft");
			t0(300);
			await tick();
			expect(calls).toHaveLength(1);
		});

		test("the host disposing the overlay aborts the call in flight and no call starts after", async () => {
			const { s, ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: () => new Promise(() => {}) });
			await tick();
			ui.opened[0].component.dispose!();
			expect(calls[0].options.signal.aborted).toBe(true);
			station(s, "Draft");
			t0(300);
			await tick();
			expect(calls).toHaveLength(1);
		});

		test("a reply that lands after the close is not shown, but its cost is kept", async () => {
			let land!: (v: unknown) => void;
			const { s, ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: () => new Promise(r => (land = r)) });
			await tick();
			ui.opened[0].component.handleInput!("q");
			land(reply("Too late."));
			await Bun.sleep(0);
			expect(calls).toHaveLength(1);
			await s.sub("cockpit");
			expect(shownText(ui)).not.toContain("Too late.");
			expect(cockpitJson(s).caster).toEqual({ cost: 0.002, calls: 1, tokens_in: 100, tokens_out: 20, cache_read: 30, cache_write: 0 });
		});

		const cockpitPath = (s: { dir: string }) => join(s.dir, "runs", "sess-0001.cockpit");
		const pending = (landing: { land?: (v: unknown) => void }) => (): Promise<unknown> => new Promise(r => (landing.land = r));

		test("a reply that lands after `end` never recreates runs/<sid>.cockpit and its cost is written nowhere", async () => {
			const landing: { land?: (v: unknown) => void } = {};
			const { s, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: pending(landing) });
			await tick();
			expect(calls).toHaveLength(1);
			await s.call({ action: "end" });
			expect(existsSync(cockpitPath(s))).toBe(false);
			landing.land!(reply("Too late."));
			await Bun.sleep(0);
			expect(existsSync(cockpitPath(s))).toBe(false);
		});

		test("a reply that lands after the run changed is ignored and its cost is not added to the new run", async () => {
			const landing: { land?: (v: unknown) => void } = {};
			const { s, ui } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: pending(landing) });
			await tick();
			await s.call({ action: "end" });
			await s.call({ action: "begin", key: "K-2" });
			landing.land!(reply("Stale."));
			await Bun.sleep(0);
			await s.sub("cockpit");
			expect(shownText(ui)).not.toContain("Stale.");
			expect(existsSync(cockpitPath(s)) ? cockpitJson(s).caster : undefined).toBeUndefined();
		});

		test("ending the run aborts the call in flight", async () => {
			const { s, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: () => new Promise(() => {}) });
			await tick();
			expect(calls[0].options.signal.aborted).toBe(false);
			await s.call({ action: "end" });
			expect(calls[0].options.signal.aborted).toBe(true);
		});

		test("a session switch resets the cockpit and aborts the call in flight", async () => {
			const { s, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: () => new Promise(() => {}) });
			await tick();
			expect(calls[0].options.signal.aborted).toBe(false);
			await s.handlers.session_switch[0]({}, s.ctx);
			expect(calls[0].options.signal.aborted).toBe(true);
		});

		test("stopReason error is shown as `call failed: <errorMessage>`, one clean line cut to 40 characters, and its cost is added", async () => {
			const msg = `rate limited\n${"m".repeat(100)}`;
			const { s, ui } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: async () => reply("half", { stopReason: "error", errorMessage: msg, headers: { authorization: "Bearer SECRET" } }) });
			await tick();
			expect(shownText(ui)).toContain(`call failed: rate limited ${"m".repeat(27)}`);
			expect(shownText(ui)).not.toContain("m".repeat(28));
			expect(shownText(ui)).not.toContain("SECRET");
			expect(shownText(ui)).not.toContain("half");
			expect(cockpitJson(s).caster.calls).toBe(1);
		});

		test("the resolved model id is kept in the spend, shown in the run report and in /strategium-config", async () => {
			const { s } = await casting({ env: { STRATEGIUM_CASTER: "1" }, resolve: () => ({ id: `fast-${"x".repeat(60)}` }) });
			await s.sub("config");
			expect(s.notes.at(-1)).toContain("model @smol · every");
			await tick();
			const id = `fast-${"x".repeat(35)}`;
			expect(cockpitJson(s).caster.model).toBe(id);
			await s.sub("config");
			expect(s.notes.at(-1)).toContain(`caster: on (STRATEGIUM_CASTER) · model @smol → ${id} · every 1 min`);
			const again = setup("sess-0001", s.dir);
			await again.start();
			await again.call({ action: "end" });
			expect(debriefOf(s)).toContain(`| caster | caster | 1 call · ${id} | 100 | 20 | 30 |`);
		});

		describe("empty states", () => {
			const raw = (ui: { opened: { component: { render(w: number): string[] } }[] }) => ui.opened.at(-1)!.component.render(100);
			const sgr = (lines: string[], text: string) => lines.find(l => l.includes(text))!.split(text)[0].match(/(\x1b\[[0-9;]*m)[^\x1b]*$/)![1];
			const title = (lines: string[]) => plain(lines.find(l => plain(l).includes("CASTER ·"))!);

			test("`listening…` draws dim and with no age; a summary draws normal with its age", async () => {
				const { ui } = await casting({ env: { STRATEGIUM_CASTER: "1" } });
				const before = raw(ui);
				expect(title(before)).not.toMatch(/· (<1m|\d+m)/);
				const dim = sgr(before, "listening…");
				await tick();
				const after = raw(ui);
				expect(title(after)).toMatch(/· <1m/);
				expect(sgr(after, "Alpha is green.")).not.toBe(dim);
			});

			test("`nothing new` draws dim and with no age", async () => {
				const { ui } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: async () => reply("") });
				const dim = sgr(raw(ui), "listening…");
				await tick();
				const after = raw(ui);
				expect(plain(after.join("\n"))).toContain("nothing new");
				expect(title(after)).not.toMatch(/· (<1m|\d+m)/);
				expect(sgr(after, "nothing new")).toBe(dim);
			});
		});

		test("an abort caused by the close clears the attempt, so reopening calls again", async () => {
			const { s, ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: () => new Promise(() => {}) });
			await tick();
			ui.opened[0].component.handleInput!("q");
			await s.sub("cockpit");
			await tick();
			expect(calls).toHaveLength(2);
		});

		test("a failed call keeps the attempt: no retry on the same state, however long it waits", async () => {
			const { calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: async () => Promise.reject(new Error("boom")) });
			await tick();
			for (const sec of [61, 122, 183]) {
				t0(sec);
				await tick();
			}
			expect(calls).toHaveLength(1);
		});

		test("a throw is shown as `call failed: <message>`, cut to 40 characters, and never carries headers", async () => {
			const err = Object.assign(new Error(`bad ${"k".repeat(100)}`), { headers: { authorization: "Bearer SECRET" } });
			const { ui } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: async () => Promise.reject(err) });
			await tick();
			expect(shownText(ui)).toContain(`call failed: bad ${"k".repeat(36)}`);
			expect(shownText(ui)).not.toContain("k".repeat(37));
			expect(shownText(ui)).not.toContain("SECRET");
		});

		test("the 30 s timeout is a failed call with its reason", async () => {
			const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError")));
			try {
				const { ui } = await casting({
					env: { STRATEGIUM_CASTER: "1" },
					answer: c => (c.options.signal.aborted ? Promise.reject(c.options.signal.reason) : new Promise(() => {})),
				});
				await tick();
				expect(timeout).toHaveBeenCalledWith(30_000);
				expect(shownText(ui)).toContain("call failed: The operation timed out.");
			} finally {
				timeout.mockRestore();
			}
		});

		test("stopReason aborted is a failed call and its cost is added", async () => {
			const { s, ui } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: async () => reply("half an answer", { stopReason: "aborted" }) });
			await tick();
			expect(shownText(ui)).toContain("call failed");
			expect(shownText(ui)).not.toContain("half an answer");
			expect(cockpitJson(s).caster).toEqual({ cost: 0.002, calls: 1, tokens_in: 100, tokens_out: 20, cache_read: 30, cache_write: 0 });
		});

		test("a throw while building the facts leaves the caster not in flight", async () => {
			const real = Bun.stripANSI;
			const spy = spyOn(Bun, "stripANSI").mockImplementation(s => {
				if (s.startsWith("station: ")) throw new Error("facts"); // only casterFacts builds such a line
				return real(s);
			});
			const { s, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" } });
			try {
				await tick();
				expect(calls).toHaveLength(0);
			} finally {
				spy.mockRestore();
			}
			station(s, "Draft");
			t0(300);
			await tick();
			expect(calls).toHaveLength(1);
		});

		test("a disposed old overlay does not abort the call of the current one", async () => {
			const { s, ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer: () => new Promise(() => {}) });
			await tick();
			ui.opened[0].component.handleInput!("q");
			await s.sub("cockpit");
			await tick();
			expect(calls).toHaveLength(2);
			ui.opened[0].component.dispose!();
			expect(calls[1].options.signal.aborted).toBe(false);
			ui.opened[1].component.dispose!();
			expect(calls[1].options.signal.aborted).toBe(true);
		});

		test("an alias that does not resolve is one reason row and no call", async () => {
			const { ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, resolve: () => undefined });
			await tick();
			expect(calls).toHaveLength(0);
			expect(shownText(ui)).toContain("no model for @smol");
		});

		test("a host with no models API is the same reason row", async () => {
			const { s, ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, open: false });
			delete (s.ctx as Record<string, unknown>).models;
			await s.sub("cockpit");
			await tick();
			expect(calls).toHaveLength(0);
			expect(shownText(ui)).toContain("no model for @smol");
		});

		test("no configured auth is one reason row and no call", async () => {
			const { ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, auth: false });
			await tick();
			expect(calls).toHaveLength(0);
			expect(shownText(ui)).toContain("no auth");
		});

		test("a host with no model registry is no auth", async () => {
			const { s, ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, open: false });
			delete (s.ctx as Record<string, unknown>).modelRegistry;
			await s.sub("cockpit");
			await tick();
			expect(calls).toHaveLength(0);
			expect(shownText(ui)).toContain("no auth");
		});

		test("a bare model id is not a role alias: reason row, nothing resolved", async () => {
			let resolved = 0;
			const { ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1", STRATEGIUM_CASTER_MODEL: "x/y" }, resolve: () => void resolved++ });
			await tick();
			expect(calls).toHaveLength(0);
			expect(resolved).toBe(0);
			expect(shownText(ui)).toContain("not a role alias: x/y");
		});

		test("a role alias from STRATEGIUM_CASTER_MODEL is the one resolved", async () => {
			const { calls } = await casting({ env: { STRATEGIUM_CASTER: "1", STRATEGIUM_CASTER_MODEL: "@fast:low" } });
			await tick();
			expect(calls[0].model).toEqual({ spec: "@fast:low" });
		});

		for (const [name, answer] of [
			["rejects", async () => Promise.reject(new Error("net down"))],
			["returns stopReason error", async () => reply("", { stopReason: "error" })],
		] as const) {
			test(`completeSimple ${name}: call failed, and no second call for the same state`, async () => {
				const { ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" }, answer });
				await tick();
				expect(shownText(ui)).toContain("call failed");
				for (const sec of [61, 122, 183]) {
					t0(sec);
					await tick();
				}
				expect(calls).toHaveLength(1);
			});
		}

		test("the cost is summed in runs/<sid>.cockpit, survives a restart and is a caster row in the run report", async () => {
			const { s, calls } = await casting({ env: { STRATEGIUM_CASTER: "1" } });
			await tick();
			station(s, "Draft");
			t0(61);
			await tick();
			expect(calls).toHaveLength(2);
			expect(cockpitJson(s).caster).toEqual({ cost: 0.004, calls: 2, tokens_in: 200, tokens_out: 40, cache_read: 60, cache_write: 0 });
			const again = setup("sess-0001", s.dir);
			await again.start();
			await again.call({ action: "end" });
			expect(debriefOf(s)).toMatch(/\| caster \| caster \| 2 calls \| 200 \| 40 \| 60 \| \$0\.004 \|/);
			expect(debriefOf(s)).toContain("Agents and the cockpit caster only");
		});

		for (const bad of [{ cost: "x", calls: 1, tokens_in: 1, tokens_out: 1 }, { cost: 1, calls: 1.5, tokens_in: 1, tokens_out: 1 }, { cost: -1, calls: 1, tokens_in: 1, tokens_out: 1 }, { cost: 1, calls: 1, tokens_in: 1 }, "no", null]) {
			test(`a malformed caster field ${JSON.stringify(bad)} reads as none and does not void the rest`, async () => {
				const { s } = await casting({ env: { STRATEGIUM_CASTER: "1" } });
				await tick();
				writeFileSync(join(s.dir, "runs", "sess-0001.cockpit"), JSON.stringify({ ...cockpitJson(s), caster: bad }));
				const again = setup("sess-0001", s.dir);
				await again.start();
				await again.call({ action: "end" });
				expect(debriefOf(s)).not.toContain("| caster |");
			});
		}

		test("STRATEGIUM_CASTER_FAKE shows its text with no completeSimple call, and still counts the call", async () => {
			const { s, ui, calls } = await casting({ env: { STRATEGIUM_CASTER: "1", STRATEGIUM_CASTER_FAKE: "Fake commentary." }, resolve: () => undefined, auth: false });
			await tick();
			expect(calls).toHaveLength(0);
			expect(shownText(ui)).toContain("Fake commentary.");
			expect(cockpitJson(s).caster).toEqual({ cost: 0, calls: 1, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0 });
		});

		test("/strategium-config caster on|off|default saves the choice, applies it at once and wins over the env", async () => {
			const { s, ui } = await casting({ env: { STRATEGIUM_CASTER: "1" } });
			await s.sub("config");
			expect(s.notes.at(-1)).toContain("caster: on (STRATEGIUM_CASTER) · model @smol · every 1 min");
			await s.sub("config", "caster off");
			expect(readFileSync(join(s.dir, "caster"), "utf8")).toBe("off");
			expect(s.notes.at(-1)).toContain("caster: off (/strategium-config)");
			await tick();
			expect(shownText(ui)).not.toContain("CASTER");
			await s.sub("config", "caster on");
			expect(readFileSync(join(s.dir, "caster"), "utf8")).toBe("on");
			expect(s.notes.at(-1)).toContain("caster: on (/strategium-config)");
			await s.sub("config", "caster default");
			expect(existsSync(join(s.dir, "caster"))).toBe(false);
			expect(s.notes.at(-1)).toContain("caster: on (STRATEGIUM_CASTER)");
		});

		test("STRATEGIUM_CASTER=0 is off, any other value is ignored and said so; a bad interval or model is listed", async () => {
			process.env.STRATEGIUM_CASTER = "0";
			const s0 = setup();
			await s0.sub("config");
			expect(s0.notes.at(-1)).toContain("caster: off (STRATEGIUM_CASTER)");
			process.env.STRATEGIUM_CASTER = "yes";
			process.env.STRATEGIUM_CASTER_EVERY_MIN = "0";
			process.env.STRATEGIUM_CASTER_MODEL = "x/y";
			const s1 = setup();
			await s1.sub("config");
			const line = s1.notes.at(-1)!.split("\n").find(l => l.startsWith("caster:"))!;
			expect(line).toBe('caster: off (default) · model not a role alias: x/y · every 1 min · ignored: STRATEGIUM_CASTER "yes", STRATEGIUM_CASTER_EVERY_MIN "0"');
		});

		test("a bad caster argument is refused and writes no file", async () => {
			const s = setup();
			for (const bad of ["caster maybe", "caster ON", "caster Default"]) {
				await s.sub("config", bad);
				expect(s.notes.at(-1)).toContain("config takes");
			}
			expect(existsSync(join(s.dir, "caster"))).toBe(false);
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

	describe("the cursor", () => {
		const stations = (a: string, b: string, c: string) => [
			{ name: "Muster", tasks: [{ content: "one", status: a }] },
			{ name: "Auspex", tasks: [{ content: "two", status: b }] },
			{ name: "Deployment", tasks: [{ content: "three", status: c }] },
		];
		const open = async () => {
			const { s, ui } = await running();
			s.todo(stations("completed", "in_progress", "pending"));
			await s.sub("cockpit");
			return { s, comp: ui.opened.at(-1)!.component, ui };
		};
		const text = (c: { render(w: number): string[] }) => plain(c.render(100).join("\n"));

		test("left shows the previous station and right comes back to the active one", async () => {
			const { comp } = await open();
			const before = text(comp);
			comp.handleInput!("\x1b[D");
			expect(text(comp)).not.toBe(before);
			comp.handleInput!("\x1b[C");
			expect(text(comp)).toBe(before);
			comp.handleInput!("q");
		});

		test("down selects a line, and the selection survives a redraw of the run", async () => {
			const { s, comp } = await open();
			const before = text(comp);
			comp.handleInput!("\x1b[B");
			const selected = text(comp);
			expect(selected).not.toBe(before);
			expect(selected).toContain("▸");
			s.todo(stations("completed", "in_progress", "pending"));
			expect(text(comp)).toBe(selected);
			comp.handleInput!("q");
		});

		test("a station change drops the browsed station and shows the active one", async () => {
			const { s, comp } = await open();
			const active = text(comp);
			comp.handleInput!("\x1b[D");
			s.todo(stations("completed", "completed", "in_progress"));
			const moved = text(comp);
			comp.handleInput!("\x1b[D");
			comp.handleInput!("\x1b[C");
			expect(text(comp)).toBe(moved);
			expect(moved).not.toBe(active);
			comp.handleInput!("q");
		});

		test("Esc and q close in one press while browsing", async () => {
			for (const key of ["\x1b", "q"]) {
				const { comp, ui } = await open();
				comp.handleInput!("\x1b[D");
				comp.handleInput!("\x1b[B");
				comp.handleInput!(key);
				expect(ui.draws.closed).toBe(1);
			}
		});

		test("a reopened cockpit starts clean: no selection and no viewing note", async () => {
			const { s, comp, ui } = await open();
			comp.handleInput!("\x1b[B");
			comp.handleInput!("\x1b[D");
			expect(text(comp)).toContain("viewing");
			comp.handleInput!("q");
			await s.sub("cockpit");
			const again = text(ui.opened.at(-1)!.component);
			expect(again).not.toContain("▸");
			expect(again).not.toContain("viewing");
			ui.opened.at(-1)!.component.handleInput!("q");
			const saved = readFileSync(join(s.dir, "runs", "sess-0001.cockpit"), "utf8");
			expect(saved).not.toContain("nav");
			expect(saved).not.toContain("cursor");
		});

		test("a key keeps the agent status the host reported since the last redraw", async () => {
			const { s, comp } = await open();
			const host: { idle: boolean } = Reflect.get(s.ctx, "host");
			host.idle = false;
			s.handlers.agent_start.forEach(f => f({}, s.ctx));
			expect(text(comp)).toContain("AGENT AT WORK");
			host.idle = true;
			s.handlers.agent_end.forEach(f => f({}, s.ctx));
			expect(text(comp)).toContain("VOX OPEN");
			comp.handleInput!("\x1b[B");
			expect(text(comp)).toContain("VOX OPEN");
			comp.handleInput!("q");
		});

		test("browsing back to the station the run returns to does not leave a viewing note", async () => {
			const { s, comp } = await open();
			comp.handleInput!("\x1b[D"); // browse Muster while Auspex is active
			expect(text(comp)).toContain("viewing");
			s.todo(stations("completed", "completed", "in_progress")); // the run moves on to Deployment
			s.todo(stations("completed", "in_progress", "pending")); // and back to Auspex
			expect(text(comp)).not.toContain("viewing");
			comp.handleInput!("q");
		});

		test("a second down moves the marker to another line", async () => {
			const { s, comp } = await open();
			s.todo(stations("completed", "completed", "in_progress")); // a second chronicle entry
			comp.handleInput!("\x1b[B");
			const first = text(comp);
			comp.handleInput!("\x1b[B");
			const second = text(comp);
			expect(second).toContain("▸");
			expect(second).not.toBe(first);
			comp.handleInput!("q");
		});

		test("home after browsing shows the active station again", async () => {
			const { comp } = await open();
			const before = text(comp);
			comp.handleInput!("\x1b[D");
			expect(text(comp)).toContain("viewing");
			comp.handleInput!("\x1b[H");
			expect(text(comp)).toBe(before);
			comp.handleInput!("q");
		});

		test("the cursor stays on its line when a redraw adds a chronicle entry above it", async () => {
			const { s, comp } = await open();
			comp.handleInput!("\x1b[B");
			const marked = (t: string) => t.split("\n").find(l => l.includes("▸"))!;
			const line = marked(text(comp));
			s.todo(stations("completed", "completed", "in_progress")); // the station change logs a new entry
			const after = text(comp);
			expect(after).toContain("station Deployment");
			expect(marked(after)).toBe(line);
			comp.handleInput!("q");
		});

		test("a run key change with the cockpit open leaves no marker", async () => {
			const { s, comp } = await open();
			comp.handleInput!("\x1b[B");
			expect(text(comp)).toContain("▸");
			await s.call({ action: "end" });
			await s.call({ action: "begin", key: "K-2" });
			s.todo(stations("completed", "in_progress", "pending"));
			expect(text(comp)).not.toContain("▸");
			comp.handleInput!("q");
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

	describe("live agent status", () => {
		type S = ReturnType<typeof setup>;
		const T0 = new Date(2026, 10, 16, 9, 0, 0).getTime();
		const at = (ms: number) => setSystemTime(T0 + ms);
		const MIN = 60_000;
		const brother = (name: string) => ({ agent: "battle-brother", name, isolated: true, task: "build squad a." });
		const taskResult = (s: S, id: string) =>
			s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [brother(id)] }, details: { progress: [{ index: 0, id, status: "running" }] }, isError: false }, s.ctx));
		// A Captain with squad a forging and agent A deployed at T0.
		async function squad() {
			at(0);
			const r = await running();
			await r.s.call({ action: "slices", slices: [{ id: "a", parallel: false, files: ["a.ts"] }] });
			r.s.todo([{ name: "Skirmish", tasks: [{ content: "[battle-brother] Build squad a", status: "in_progress" }] }]);
			r.s.handlers.before_subagent_spawn.forEach(h => h({ agent: "battle-brother", spawnKey: "A" }, r.s.ctx));
			taskResult(r.s, "A");
			return r;
		}
		// A second extension instance in the same process (the same pid), as a subagent: one STRATEGIUM_STATE_DIR is shared.
		function child(s: S, id = "A") {
			const f = fakePi();
			extension(f.pi as never);
			const ctx = { ...fakeCtx("child-sid", s.dir), agent: { kind: "sub", id } };
			const fire = (event: string, e: unknown) => f.handlers[event]?.forEach(h => h(e, ctx));
			const phases = (done: number, total: number, current?: string) => [
				{
					name: "Work",
					tasks: [
						...Array.from({ length: done }, (_, i) => ({ content: `done ${i}`, status: "completed" })),
						...(current ? [{ content: current, status: "in_progress" }] : []),
						...Array.from({ length: total - done - (current ? 1 : 0) }, (_, i) => ({ content: `later ${i}`, status: "pending" })),
					],
				},
			];
			const todo = (done: number, total: number, current?: string) => fire("tool_result", { toolName: "todo", isError: false, details: { phases: phases(done, total, current) } });
			const start = (toolName: string, intent?: string) => fire("tool_execution_start", { toolName, intent });
			const end = (toolName: string) => fire("tool_execution_end", { toolName, isError: false });
			const tool = f.tools.find(t => t.name === "strategium")!;
			// The strategium tool called with this child's ctx (or `as`, another ctx).
			const call = async (params: Record<string, unknown>, as: unknown = ctx) => (await tool.execute("id", params, undefined, undefined, as)).content[0].text;
			return { fire, todo, start, end, call };
		}
		const liveFile = (s: S, id = "A") => join(s.dir, "runs", "sess-0001.live", `${id}.json`);
		const readLive = (s: S, id = "A") => JSON.parse(readFileSync(liveFile(s, id), "utf8"));
		const top = (t: string) => t.slice(0, t.indexOf("CHRONICLE"));

		test("a squad's own todo shows under its line: done/total, the ETA and the current task", async () => {
			const { s, ui } = await squad();
			const c = child(s);
			c.start("read", "Reading the cockpit");
			at(10 * MIN);
			c.todo(2, 5, "Write tests");
			expect(readLive(s)).toMatchObject({ done: 2, total: 5, current: "Write tests", tool: "read", intent: "Reading the cockpit" });
			const t = await peek(s, ui);
			expect(t).toContain("squad a forging");
			expect(t).toContain("10m · $? · 2/5 · ~15m · Write tests");
		});

		test("a child's signal writes its own row and the parent shows pct, eta and line in place of the todo's", async () => {
			const { s, ui } = await squad();
			const c = child(s);
			at(10 * MIN);
			c.todo(2, 5, "Write tests");
			at(10 * MIN + 2000); // past the 1 s throttle of the todo's write
			expect(await c.call({ action: "signal", line: "GREEN parser", eta_min: 4, pct: 60 })).toBe("SIGNAL ok");
			expect(readLive(s)).toMatchObject({ line: "GREEN parser", eta_min: 4, pct: 60, done: 2, total: 5 });
			const t = await peek(s, ui);
			expect(t).toContain("squad a forging");
			expect(t).toContain("10m · $? · 60% · ~4m · GREEN parser");
		});

		describe("signal", () => {
			const liveDir = (s: S) => join(s.dir, "runs", "sess-0001.live");
			const saved = (s: S) => JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.cockpit"), "utf8"));
			const blockedChild = async () => {
				const r = await squad();
				return { ...r, c: child(r.s) };
			};

			test("from the main session returns ERROR and writes no live file", async () => {
				const { s } = await squad();
				const c = child(s);
				expect(await c.call({ action: "signal", line: "x" }, s.ctx)).toBe("ERROR signal is for subagents: it writes the caller's own cockpit row");
				expect(existsSync(liveDir(s))).toBe(false);
			});

			test("with key, takeover or another agent's id returns ERROR and changes no file", async () => {
				const { s } = await squad();
				child(s, "B").start("read");
				const before = readFileSync(liveFile(s, "B"), "utf8");
				const c = child(s);
				for (const extra of [{ key: "OTHER" }, { takeover: "x" }, { agent: "B" }, { id: "B" }, { target: "B" }]) {
					expect(await c.call({ action: "signal", line: "x", ...extra })).toMatch(/^ERROR signal writes only your own row; it takes pct, eta_min, line, blocked \(got: \w+\)$/);
				}
				expect(readFileSync(liveFile(s, "B"), "utf8")).toBe(before);
				expect(existsSync(liveFile(s, "A"))).toBe(false);
			});

			test("with nothing to say, or a value out of range, returns ERROR", async () => {
				const { s } = await squad();
				const c = child(s);
				expect(await c.call({ action: "signal" })).toBe("ERROR signal needs pct, eta_min, line or blocked");
				for (const bad of [{ pct: 101 }, { pct: -1 }, { pct: 1.5 }, { eta_min: 10081 }, { eta_min: -1 }, { line: 7 }, { blocked: "yes" }]) {
					expect(await c.call({ action: "signal", ...bad })).toMatch(/^ERROR signal takes pct/);
				}
				expect(existsSync(liveFile(s, "A"))).toBe(false);
			});

			test("a live file with eta_min -1 or pct 101 drops the row without throwing", async () => {
				const { s, ui } = await squad();
				const c = child(s);
				c.todo(2, 5, "Write tests");
				at(10 * MIN);
				const base = readLive(s); // each bad value is tried alone on a good row, not carried to the next
				for (const bad of [{ eta_min: -1 }, { pct: 101 }, { blocked: "yes" }, { line: 5 }]) {
					writeFileSync(liveFile(s), JSON.stringify({ ...base, line: "kept?", ...bad }));
					const t = await peek(s, ui);
					expect(t).not.toContain("kept?");
					expect(t).not.toContain("2/5");
				}
			});

			test("signal sanitises the line and caps it at 200 characters", async () => {
				const { s } = await squad();
				const c = child(s);
				expect(await c.call({ action: "signal", line: `\x1b[31m${"w".repeat(300)}` })).toBe("SIGNAL ok");
				const line = readLive(s).line as string;
				expect(line).not.toContain("\x1b");
				expect(line).toHaveLength(200);
			});

			test("blocked: true without a line, or with one that cleans to nothing, returns ERROR and writes nothing", async () => {
				const { s } = await squad();
				const c = child(s);
				for (const line of [undefined, "", "\x1b[0m"]) {
					expect(await c.call({ action: "signal", blocked: true, ...(line === undefined ? {} : { line }) })).toMatch(/^ERROR signal blocked: true needs a non-empty line/);
				}
				expect(existsSync(liveFile(s, "A"))).toBe(false);
			});

			test("a sub with no agent id is refused", async () => {
				const { s } = await squad();
				expect(await child(s).call({ action: "signal", line: "x" }, { ...s.ctx, agent: { kind: "sub" } })).toBe("ERROR signal needs the caller's agent id");
				expect(existsSync(liveFile(s, "A"))).toBe(false);
			});

			test("a block survives the agent waiting in a tool call: one alarm, one entry, however the tool calls come and go", async () => {
				const { s, ui, c } = await blockedChild();
				c.start("strategium");
				await c.call({ action: "signal", blocked: true, line: "need the API shape" });
				c.end("strategium");
				c.start("wait");
				expect(readLive(s)).toMatchObject({ blocked: true, line: "need the API shape" });
				await peek(s, ui);
				expect(alarmLines()).toEqual(["attention|K-1: SQUAD a is blocked: need the API shape"]);
				expect((await chron(s, ui)).match(/blocked: /g)).toHaveLength(1);
			});

			test("a blocked row with a tool call in flight is not stalled", async () => {
				const { s, ui, c } = await blockedChild();
				await c.call({ action: "signal", blocked: true, line: "need the API shape" });
				at(2000); // past the 1 s throttle, so the tool start is written
				c.start("wait");
				at(20 * MIN);
				const t = top(await peek(s, ui));
				expect(t).toContain("blocked · ");
				expect(t).not.toContain("stalled");
			});

			test("block, unblock, block within 60 s rings and logs twice", async () => {
				const { s, ui, c } = await blockedChild();
				const block = async (line: string) => {
					await c.call({ action: "signal", blocked: true, line });
					await peek(s, ui);
				};
				const unblock = async () => {
					await c.call({ action: "signal", line: "go on" });
					await peek(s, ui);
				};
				await block("first");
				await unblock();
				at(10_000);
				await block("second");
				expect(alarmLines()).toEqual(["attention|K-1: SQUAD a is blocked: first", "attention|K-1: SQUAD a is blocked: second"]);
				expect((await chron(s, ui)).match(/blocked: /g)).toHaveLength(2);
			});

			test("a failing alarm for a block is told to the user", async () => {
				const { s, ui, c } = await blockedChild();
				failAlarm();
				await c.call({ action: "signal", blocked: true, line: "need the API shape" });
				await peek(s, ui);
				expect(s.notes.some(n => n.includes("spawn failed: missing alarm"))).toBe(true);
			});

			test("a saved blocked that is not true is dropped on load, so the live block rings again", async () => {
				const { s, ui, c } = await blockedChild();
				await c.call({ action: "signal", blocked: true, line: "need the API shape" });
				await peek(s, ui);
				const doc = saved(s);
				doc.deployed.find((d: [string, unknown]) => d[0] === "A")[1].blocked = "yes";
				writeFileSync(join(s.dir, "runs", "sess-0001.cockpit"), JSON.stringify(doc));
				const again = setup("sess-0001", s.dir); // setup resets the alarm spy
				const ui2 = uiCtx(again);
				await again.start();
				again.todo([{ name: "Skirmish", tasks: [{ content: "[battle-brother] Build squad a", status: "in_progress" }] }]);
				await peek(again, ui2);
				expect(alarmLines()).toHaveLength(1);
			});

			test("a child with no pointer gets ignored", async () => {
				const { s } = await squad();
				rmSync(join(s.dir, "runs", `${process.pid}.pid`));
				expect(await child(s).call({ action: "signal", pct: 5 })).toBe("SIGNAL ignored (no Strategium run)");
			});

			test("any other action from a sub still returns the main-session ERROR", async () => {
				const { s } = await squad();
				const c = child(s);
				for (const action of ["status", "begin", "end", "attention", "seal", "slices", "redraft"]) {
					expect(await c.call({ action, key: "K-9" })).toBe("ERROR strategium tool is for the main session only");
				}
			});

			test("blocked logs one warn entry and rings one attention alarm however often it is drawn, and the cockpit file keeps the mark", async () => {
				vi.useFakeTimers();
				const { s, ui, c } = await blockedChild();
				expect(await c.call({ action: "signal", blocked: true, line: "need the API shape" })).toBe("SIGNAL ok");
				await peek(s, ui); // draw 1
				await s.sub("cockpit"); // draw 2: the overlay timer's every second frame
				vi.advanceTimersByTime(1000);
				await s.sub("status"); // draw 3: the tick
				ui.opened.at(-1)!.component.handleInput!("q");
				expect(alarmLines()).toEqual(["attention|K-1: SQUAD a is blocked: need the API shape"]);
				expect((await chron(s, ui)).match(/blocked: need the API shape/g)).toHaveLength(1);
				expect(saved(s).deployed.find((d: [string, unknown]) => d[0] === "A")[1]).toMatchObject({ blocked: true });
				expect(top(await peek(s, ui))).toContain("blocked · ");
			});

			test("after a restart the same blocked row does not ring again", async () => {
				const { s, ui, c } = await blockedChild();
				await c.call({ action: "signal", blocked: true, line: "need the API shape" });
				await peek(s, ui);
				expect(alarmLines()).toHaveLength(1);
				const again = setup("sess-0001", s.dir);
				const ui2 = uiCtx(again);
				await again.start();
				again.todo([{ name: "Skirmish", tasks: [{ content: "[battle-brother] Build squad a", status: "in_progress" }] }]);
				expect(top(await peek(again, ui2))).toContain("blocked · ");
				expect(alarmLines()).toEqual([]);
			});

			test("an unblock then a new block rings and logs a second time", async () => {
				const { s, ui, c } = await blockedChild();
				await c.call({ action: "signal", blocked: true, line: "need the API shape" });
				await peek(s, ui);
				await c.call({ action: "signal", line: "go on" });
				expect(top(await peek(s, ui))).not.toContain("blocked · ");
				at(10_000);
				await c.call({ action: "signal", blocked: true, line: "need a decision" });
				await peek(s, ui);
				expect(alarmLines()).toEqual(["attention|K-1: SQUAD a is blocked: need the API shape", "attention|K-1: SQUAD a is blocked: need a decision"]);
				const t = await chron(s, ui);
				expect(t.match(/blocked: need/g)).toHaveLength(2);
			});

			test("a blocked row idle 6 minutes with no tool call in flight shows stalled and logs it once", async () => {
				const { s, ui, c } = await blockedChild();
				await c.call({ action: "signal", blocked: true, line: "need the API shape" });
				at(6 * MIN);
				expect(top(await peek(s, ui))).toContain("blocked · stalled 6m");
				await peek(s, ui);
				expect((await chron(s, ui)).match(/stalled 6m/g)).toHaveLength(1);
			});

			test("a second signal within a second reaches the file after the trailing write", async () => {
				vi.useFakeTimers();
				const { s, c } = await blockedChild();
				at(1000);
				await c.call({ action: "signal", line: "one" });
				at(1400);
				await c.call({ action: "signal", line: "two" });
				expect(readLive(s)).toMatchObject({ line: "one" });
				vi.advanceTimersByTime(600);
				expect(readLive(s)).toMatchObject({ line: "two" });
			});

			test("a change of blocked is written at once, and a second signal inside the second still leaves one alarm", async () => {
				vi.useFakeTimers();
				const { s, ui, c } = await blockedChild();
				at(1000);
				await c.call({ action: "signal", line: "one" });
				at(1200);
				c.start("strategium"); // a tool start inside the throttle window must not hold the block back
				await c.call({ action: "signal", blocked: true, line: "need the API shape" });
				expect(readLive(s)).toMatchObject({ blocked: true, line: "need the API shape" });
				at(1300);
				await c.call({ action: "signal", blocked: true, line: "still need it" });
				expect(readLive(s)).toMatchObject({ line: "need the API shape" });
				await peek(s, ui);
				vi.advanceTimersByTime(1000);
				expect(readLive(s)).toMatchObject({ line: "still need it" });
				await peek(s, ui);
				expect(alarmLines()).toEqual(["attention|K-1: SQUAD a is blocked: need the API shape"]);
				at(1400);
				await c.call({ action: "signal", line: "go on" });
				expect(readLive(s)).toMatchObject({ line: "go on" });
				expect(readLive(s).blocked).toBeUndefined();
			});

			test("escape and bidi characters in the line reach neither the chronicle, the file, the toast nor the alarm", async () => {
				const { s, ui, c } = await blockedChild();
				await c.call({ action: "signal", blocked: true, line: "ok" });
				// A hostile child writes its file by hand: the parent cleans what it reads.
				writeFileSync(liveFile(s), JSON.stringify({ ...readLive(s), line: "\x1b[31mred\u202e\u2028 boom\x07" }));
				await peek(s, ui);
				const all = alarm.calls.map(x => x.env.STRATEGIUM_MSG).join("\n") + readFileSync(join(s.dir, "runs", "sess-0001.cockpit"), "utf8");
				expect(all).toContain("boom");
				expect(all).not.toMatch(/[\x00-\x08\x0b-\x1f\u202e\u2028]|\\u001b|\\u202e|\\u2028/);
				expect(alarmLines()).toHaveLength(1);
			});
		});

		test("a scout without a todo shows its elapsed time and its last intent", async () => {
			at(0);
			const { s, ui } = await running();
			s.todo([{ name: "Auspex", tasks: [{ content: "[scout] Map the code", status: "in_progress" }] }]);
			s.handlers.before_subagent_spawn.forEach(h => h({ agent: "scout", spawnKey: "A" }, s.ctx));
			s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [{ agent: "scout", name: "A", task: "look" }] }, details: { progress: [{ index: 0, id: "A", status: "running" }] }, isError: false }, s.ctx));
			const c = child(s);
			at(3 * MIN);
			c.start("read", "Reading the cockpit");
			expect(await peek(s, ui)).toContain("3m · $? · Reading the cockpit");
		});

		test("a second update within a second reaches the file after the trailing write, and the parent shows it with only a redraw", async () => {
			vi.useFakeTimers();
			const { s, ui } = await squad();
			const c = child(s);
			at(1000);
			c.todo(2, 5, "Write tests");
			at(1400);
			c.todo(3, 5, "Run mutants");
			expect(readLive(s)).toMatchObject({ done: 2 });
			vi.advanceTimersByTime(600);
			expect(readLive(s)).toMatchObject({ done: 3, current: "Run mutants" });
			expect(await peek(s, ui)).toContain("3/5");
		});

		test("an open overlay redraws from the child's file on its own, every second frame", async () => {
			vi.useFakeTimers();
			const { s, ui } = await squad();
			const c = child(s);
			c.todo(2, 5, "Write tests");
			await s.sub("cockpit");
			const comp = ui.opened.at(-1)!.component;
			expect(plain(comp.render(100).join("\n"))).toContain("2/5");
			at(5000);
			c.todo(3, 5, "Run mutants");
			vi.advanceTimersByTime(500); // frame 1: no read of the files
			expect(plain(comp.render(100).join("\n"))).not.toContain("3/5");
			vi.advanceTimersByTime(500); // frame 2
			expect(plain(comp.render(100).join("\n"))).toContain("3/5");
			comp.handleInput!("q");
		});

		test("a deferred write after end does not bring the live dir back", async () => {
			vi.useFakeTimers();
			const { s } = await squad();
			const c = child(s);
			at(1000);
			c.todo(2, 5, "Write tests");
			at(1400);
			c.todo(3, 5, "Run mutants");
			await s.call({ action: "end" });
			vi.advanceTimersByTime(1000);
			expect(existsSync(join(s.dir, "runs", "sess-0001.live"))).toBe(false);
		});

		test("an agent id with slashes maps to one file inside the live dir", async () => {
			const { s } = await squad();
			child(s, "a/b\\c").start("read");
			const dir = join(s.dir, "runs", "sess-0001.live");
			expect(readdirSync(dir)).toEqual([`${encodeURIComponent("a/b\\c")}.json`]);
		});

		test("a pointer whose session id climbs out of runs/ writes nothing", async () => {
			const { s } = await squad();
			writeFileSync(join(s.dir, "evil.json"), "{}");
			writeFileSync(join(s.dir, "runs", `${process.pid}.pid`), "../evil");
			child(s).start("read");
			expect(existsSync(join(s.dir, "evil.live"))).toBe(false);
		});

		test("shutdown leaves a pointer that names another session", async () => {
			const { s } = await squad();
			writeFileSync(join(s.dir, "runs", `${process.pid}.pid`), "other-sid");
			shutdown(s);
			expect(readFileSync(join(s.dir, "runs", `${process.pid}.pid`), "utf8")).toBe("other-sid");
		});

		test("a session with no run removes the pointer before it spawns", async () => {
			const s = setup();
			mkdirSync(join(s.dir, "runs"), { recursive: true });
			writeFileSync(join(s.dir, "runs", `${process.pid}.pid`), "other-sid");
			s.handlers.before_subagent_spawn.forEach(h => h({ agent: "scout", spawnKey: "A" }, s.ctx));
			expect(existsSync(join(s.dir, "runs", `${process.pid}.pid`))).toBe(false);
		});

		test("end removes the pointer that names its session", async () => {
			const { s } = await squad();
			expect(existsSync(join(s.dir, "runs", `${process.pid}.pid`))).toBe(true);
			await s.call({ action: "end" });
			expect(existsSync(join(s.dir, "runs", `${process.pid}.pid`))).toBe(false);
		});

		test("begin sweeps the pointers of sessions that have no run", async () => {
			const { s } = await squad();
			writeFileSync(join(s.dir, "runs", "4242.pid"), "ghost-sid");
			writeFileSync(join(s.dir, "runs", "4343.pid"), "sess-0001");
			const other = setup("sess-0002", s.dir);
			await other.call({ action: "begin", key: "K-2" });
			expect(existsSync(join(s.dir, "runs", "4242.pid"))).toBe(false);
			expect(existsSync(join(s.dir, "runs", "4343.pid"))).toBe(true);
		});

		test("end never throws when a file of the run cannot be removed", async () => {
			const { s } = await squad();
			const stuck = join(s.dir, "runs", "sess-0001.cockpit");
			rmSync(stuck, { force: true });
			mkdirSync(join(stuck, "inner"), { recursive: true });
			expect((await s.call({ action: "end" })).split("\n").slice(0, 2)).toEqual(["ENDED K-1", expect.stringMatching(/^DEBRIEF /)]);
		});

		test("a saved agent with a non-numeric at or stalled is read as having none", async () => {
			const { s } = await running();
			s.todo([{ name: "Auspex", tasks: [{ content: "[scout] Map the code", status: "in_progress" }] }]);
			s.handlers.before_subagent_spawn.forEach(h => h({ agent: "scout", spawnKey: "A" }, s.ctx));
			s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [{ agent: "scout", name: "A", task: "look" }] }, details: { progress: [{ index: 0, id: "A", status: "running" }] }, isError: false }, s.ctx));
			await peek(s, uiCtx(s));
			const file = join(s.dir, "runs", "sess-0001.cockpit");
			const saved = JSON.parse(readFileSync(file, "utf8"));
			for (const [, d] of saved.deployed) Object.assign(d, { at: "soon", stalled: "x" });
			writeFileSync(file, JSON.stringify(saved));
			const again = setup("sess-0001", s.dir);
			const ui = uiCtx(again);
			await again.start();
			again.todo([{ name: "Auspex", tasks: [{ content: "[scout] Map the code", status: "in_progress" }] }]);
			at(10 * MIN);
			const text = await peek(again, ui);
			expect(text).not.toContain("stalled");
			expect(text).not.toContain("NaN");
		});

		describe("an agent with no live row", () => {
			async function scout() {
				at(0);
				const { s, ui } = await running();
				s.todo([{ name: "Auspex", tasks: [{ content: "[scout] Map the code", status: "in_progress" }] }]);
				s.handlers.before_subagent_spawn.forEach(h => h({ agent: "scout", spawnKey: "A" }, s.ctx));
				s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [{ agent: "scout", name: "A", task: "look" }] }, details: { progress: [{ index: 0, id: "A", status: "running" }] }, isError: false }, s.ctx));
				return { s, ui };
			}

			test("is never stalled, however long it is left: elapsed only", async () => {
				const { s, ui } = await scout();
				at(10 * MIN);
				expect(await chron(s, ui)).not.toContain("stalled");
				expect(top(await peek(s, ui))).not.toContain("stalled");
			});

			test("the 5 minutes count from its last live row once it has one", async () => {
				const { s, ui } = await scout();
				const c = child(s);
				at(10 * MIN);
				c.start("read");
				c.end("read");
				at(14 * MIN);
				expect(await chron(s, ui)).not.toContain("stalled");
			});
		});

		test("a returned agent is never stalled, however old its live file", async () => {
			const { s, ui } = await squad();
			const c = child(s);
			c.start("read");
			at(2000);
			c.end("read");
			s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [brother("A")] }, details: { progress: [{ index: 0, id: "A", status: "completed" }] }, isError: false }, s.ctx));
			at(10 * MIN);
			const t = await chron(s, ui);
			expect(t).toContain("returned");
			expect(t).not.toContain("stalled");
		});

		describe("detail", () => {
			const scout = (s: S, status: string) => s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [{ agent: "scout", task: "x" }] }, details: { progress: [{ index: 0, id: "S", status }] }, isError: false }, s.ctx));
			const done = (s: S) => scout(s, "completed");
			const show = (c: { render(w: number): string[] }) => plain(c.render(100).join("\n"));
			// Tab through the lines, Enter on each, until the open detail says `word`.
			const openDetail = (c: { render(w: number): string[]; handleInput?(d: string): void }, word: string) => {
				for (let i = 0; i < 20; i++) {
					c.handleInput!("\t");
					c.handleInput!("\r");
					if (show(c).includes(word)) return true;
					c.handleInput!("\x7f");
				}
				return false;
			};

			test("q closes from a detail; Esc backs out of it and the next Esc closes; Back at the top does nothing", async () => {
				const { s, ui } = await squad();
				await s.sub("cockpit");
				const c = ui.opened.at(-1)!.component;
				const top = show(c);
				c.handleInput!("\x7f");
				expect(show(c)).toBe(top);
				expect(ui.draws.closed).toBe(0);
				expect(openDetail(c, "back · q close")).toBe(true);
				c.handleInput!("\x1b");
				expect(ui.draws.closed).toBe(0);
				expect(show(c)).not.toContain("back · q close");
				expect(openDetail(c, "back · q close")).toBe(true);
				c.handleInput!("q");
				expect(ui.draws.closed).toBe(1);
				await s.sub("cockpit");
				const again = ui.opened.at(-1)!.component;
				expect(show(again)).not.toContain("back · q close");
				again.handleInput!("\x1b");
				expect(ui.draws.closed).toBe(2);
			});

			test("a keypress reads no file: the detail still opens after the run's files are gone", async () => {
				const { s, ui } = await squad();
				await s.sub("cockpit");
				const c = ui.opened.at(-1)!.component;
				rmSync(join(s.dir, "runs"), { recursive: true, force: true });
				expect(openDetail(c, "back · q close")).toBe(true);
				c.handleInput!("q");
			});

			describe("transcript", () => {
				const msg = (role: string, content: unknown, extra: object = {}) => JSON.stringify({ type: "message", message: { role, content, ...extra } });
				const say = (text: string) => msg("assistant", [{ type: "text", text }]);
				// The session file omp would report; a child's files sit in the dir named like it.
				const session = (s: S) => {
					const dir = join(s.dir, "sessions", "main");
					mkdirSync(dir, { recursive: true });
					(s.ctx.sessionManager as { getSessionFile?: () => string }).getSessionFile = () => join(s.dir, "sessions", "main.jsonl");
					return dir;
				};
				// Tab to the first line, ↓ to "squad a forging", Enter for its detail, Enter again for its newest agent's transcript.
				const open = (c: { render(w: number): string[]; handleInput?(d: string): void }) => {
					for (const k of ["\t", "\x1b[B", "\r"]) c.handleInput!(k);
					expect(show(c)).toContain("enter transcript");
					c.handleInput!("\r");
				};
				const ended = (s: S) => s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [brother("A")] }, details: { progress: [{ index: 0, id: "A", status: "completed" }] }, isError: false }, s.ctx));

				test("Enter on a squad's detail opens its newest agent's transcript from the session's child file; Back returns to the detail", async () => {
					const { s, ui } = await squad();
					writeFileSync(join(session(s), "A.jsonl"), [msg("user", [{ type: "text", text: "Build squad a" }]), say("EDITING-NOW"), msg("assistant", [{ type: "thinking", thinking: "SECRET-THINKING" }, { type: "toolCall", name: "read", intent: "Reading a.ts", arguments: { path: "a.ts" } }]), msg("toolResult", [{ type: "text", text: "line one\nline two" }], { toolName: "read", isError: false })].join("\n") + "\n");
					await s.sub("cockpit");
					const c = ui.opened.at(-1)!.component;
					open(c);
					const t = show(c);
					expect(t).toContain("TRANSCRIPT A");
					expect(t).toContain("user: Build squad a");
					expect(t).toContain("EDITING-NOW");
					expect(t).toContain("→ read Reading a.ts");
					expect(t).toContain("← read ok: line one");
					expect(t).not.toContain("SECRET-THINKING");
					c.handleInput!("\x7f");
					expect(show(c)).toContain("back · q close");
					expect(show(c)).not.toContain("TRANSCRIPT");
					c.handleInput!("q");
				});

				test("a missing file, a directory in its place and an unsafe agent id each give one reason row and read nothing outside the session dir", async () => {
					const { s, ui } = await squad();
					const dir = session(s);
					await s.sub("cockpit");
					const c = ui.opened.at(-1)!.component;
					open(c);
					expect(show(c)).toContain("no transcript yet: omp writes it after the agent's first reply");
					c.handleInput!("\x7f");
					mkdirSync(join(dir, "A.jsonl"));
					c.handleInput!("\r");
					expect(show(c)).toContain("transcript unreadable: not a regular file");
					c.handleInput!("q");
					// An id that climbs out of the dir: its file exists outside, and is not shown.
					writeFileSync(join(s.dir, "sessions", "evil.jsonl"), say("OUTSIDE") + "\n");
					taskResult(s, "../evil");
					await s.sub("cockpit");
					const e = ui.opened.at(-1)!.component;
					open(e);
					expect(show(e)).toContain("TRANSCRIPT ../evil");
					expect(show(e)).toContain("../evil: a nested agent; its transcript is not read");
					expect(show(e)).not.toContain("OUTSIDE");
					e.handleInput!("q");
				});

				test("only the last 512 KiB of the file are read: the partial first line is dropped and the head is not shown", async () => {
					const { s, ui } = await squad();
					const pad = "x".repeat(900);
					const lines = [say("HEAD-MARK")];
					for (let i = 0; i < 700; i++) lines.push(say(`${i} ${pad}`));
					lines.push(say("TAIL-MARK"));
					writeFileSync(join(session(s), "A.jsonl"), lines.join("\n") + "\n");
					await s.sub("cockpit");
					const c = ui.opened.at(-1)!.component;
					open(c);
					const t = show(c);
					expect(t).toContain("TAIL-MARK");
					expect(t).not.toContain("HEAD-MARK");
					c.handleInput!("q");
				});

				test("a finished agent shows its final answer from the .md, an active one none", async () => {
					const { s, ui } = await squad();
					const dir = session(s);
					writeFileSync(join(dir, "A.jsonl"), say("WORKING") + "\n");
					writeFileSync(join(dir, "A.md"), "FINAL-ANSWER-TEXT\n");
					await s.sub("cockpit");
					const c = ui.opened.at(-1)!.component;
					open(c);
					expect(show(c)).not.toContain("final answer:");
					c.handleInput!("q");
					ended(s);
					await s.sub("cockpit");
					const d = ui.opened.at(-1)!.component;
					open(d);
					expect(show(d)).toContain("final answer:");
					expect(show(d)).toContain("FINAL-ANSWER-TEXT");
					d.handleInput!("q");
				});

				test("scrolling inside the open transcript reads no file, and the 500 ms redraw re-reads it only when its size or mtime changed", async () => {
					vi.useFakeTimers();
					const { s, ui } = await squad();
					const file = join(session(s), "A.jsonl");
					writeFileSync(file, say("ROW-AAAA") + "\n");
					utimesSync(file, 1e9, 1e9); // a whole-second mtime, so it can be put back exactly
					await s.sub("cockpit");
					const c = ui.opened.at(-1)!.component;
					open(c);
					expect(show(c)).toContain("ROW-AAAA");
					// The one keypress that reads a file was Enter: scrolling still works with the file gone.
					rmSync(file);
					c.handleInput!("\x1b[A");
					c.handleInput!("\x1b[B");
					expect(show(c)).toContain("ROW-AAAA");
					// Same size, same mtime, other text: not re-read.
					writeFileSync(file, say("ROW-BBBB") + "\n");
					utimesSync(file, 1e9, 1e9);
					vi.advanceTimersByTime(2000);
					expect(show(c)).toContain("ROW-AAAA");
					expect(show(c)).not.toContain("ROW-BBBB");
					// Appended: re-read within a second.
					appendFileSync(file, say("ROW-CCCC") + "\n");
					vi.advanceTimersByTime(2000);
					expect(show(c)).toContain("ROW-BBBB");
					expect(show(c)).toContain("ROW-CCCC");
					c.handleInput!("q");
				});

				test("event-driven redraws within a second reuse the transcript without a stat; a second later it is re-read", async () => {
					vi.useFakeTimers();
					const { s, ui } = await squad();
					const file = join(session(s), "A.jsonl");
					writeFileSync(file, say("ROW-AAAA") + "\n");
					await s.sub("cockpit");
					const c = ui.opened.at(-1)!.component;
					open(c);
					appendFileSync(file, say("ROW-LATE") + "\n");
					const st = watch("lstatSync");
					ended(s);
					expect(st.mock.calls.filter(call => String(call[0]).endsWith("A.jsonl"))).toHaveLength(0);
					expect(show(c)).not.toContain("ROW-LATE");
					vi.advanceTimersByTime(1000);
					ended(s);
					expect(show(c)).toContain("ROW-LATE");
					c.handleInput!("q");
				});

				test("rewriting the answer with the log unchanged is read again", () => {
					const { dir, file } = tree();
					writeFileSync(join(dir, "A.jsonl"), say("W") + "\n");
					writeFileSync(join(dir, "A.md"), "ANSWER-ONE\n");
					utimesSync(join(dir, "A.md"), 1e9, 1e9);
					const a = readTranscript(file, "A", true);
					expect(a.lines).toContain("ANSWER-ONE");
					writeFileSync(join(dir, "A.md"), "ANSWER-TWO\n");
					utimesSync(join(dir, "A.md"), 2e9, 2e9);
					const b = readTranscript(file, "A", true, a);
					expect(b.lines).toContain("ANSWER-TWO");
					expect(b.lines).not.toContain("ANSWER-ONE");
				});

				test("a log over 512 KiB shows the agent's brief first, read once per open, never on a redraw", () => {
					const { dir, file } = tree();
					const user = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: text } });
					const pad = say("x".repeat(1000)) + "\n";
					writeFileSync(join(dir, "A.jsonl"), user("THE-BRIEF") + "\n" + pad.repeat(600) + say("TAIL-MARK") + "\n");
					expect(fs.statSync(join(dir, "A.jsonl")).size).toBeGreaterThan(512 * KB);
					const a = readTranscript(file, "A", false);
					expect(a.lines.slice(0, 2)).toEqual(["user: THE-BRIEF", "… earlier entries not shown"]);
					expect(a.lines.at(-1)).toBe("TAIL-MARK");
					const rd = watch("readSync");
					expect(readTranscript(file, "A", false, a)).toBe(a);
					expect(rd.mock.calls).toHaveLength(0);
				});

				test("the brief is found behind a 200 KiB session_init line, and never past the start of the tail", () => {
					const { dir, file } = tree();
					const user = (text: string) => JSON.stringify({ type: "message", message: { role: "user", content: text } });
					const init = JSON.stringify({ type: "session_init", systemPrompt: "p".repeat(200 * KB) }) + "\n";
					const pad = say("x".repeat(1000)) + "\n";
					writeFileSync(join(dir, "A.jsonl"), init + user("DEEP-BRIEF") + "\n" + pad.repeat(600) + say("TAIL-MARK") + "\n");
					expect(readTranscript(file, "A", false).lines.slice(0, 2)).toEqual(["user: DEEP-BRIEF", "… earlier entries not shown"]);
					// the only user message is beyond the 512 KiB head cap: no brief
					writeFileSync(join(dir, "B.jsonl"), init + pad.repeat(700) + user("TOO-FAR") + "\n" + pad.repeat(600));
					expect(readTranscript(file, "B", false).lines.join("\n")).not.toContain("TOO-FAR");
				});

				test("the throttle is keyed by id: another agent's transcript is read at once", async () => {
					vi.useFakeTimers();
					const { s, ui } = await squad();
					writeFileSync(join(session(s), "A.jsonl"), say("ROW-AAAA") + "\n");
					await s.sub("cockpit");
					const c = ui.opened.at(-1)!.component;
					open(c);
					expect(show(c)).toContain("ROW-AAAA");
					c.handleInput!("q");
					writeFileSync(join(session(s), "A.jsonl"), say("ROW-NEW") + "\n");
					await s.sub("cockpit");
					const d = ui.opened.at(-1)!.component;
					open(d);
					expect(show(d)).toContain("ROW-NEW");
					d.handleInput!("q");
				});

				test("with no transcript open the redraw never reads the child's file", async () => {
					vi.useFakeTimers();
					const { s, ui } = await squad();
					const dir = session(s);
					await s.sub("cockpit");
					const c = ui.opened.at(-1)!.component;
					for (const k of ["\t", "\x1b[B", "\r"]) c.handleInput!(k);
					writeFileSync(join(dir, "A.jsonl"), say("LATE-ROW") + "\n");
					vi.advanceTimersByTime(2000);
					expect(show(c)).not.toContain("LATE-ROW");
					c.handleInput!("\r");
					expect(show(c)).toContain("LATE-ROW");
					c.handleInput!("q");
				});

				// --- #125 penance: reasons, ids, byte budgets, links, cache ---
				const NO_SESSION = "no session file: this session is not saved, so its agents' transcripts are not either";
				const roots: string[] = [];
				const spies: { mockRestore(): void }[] = [];
				afterEach(() => {
					spies.splice(0).forEach(sp => sp.mockRestore());
					roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }));
				});
				const watch = <K extends "openSync" | "lstatSync" | "fstatSync" | "readSync">(name: K) => {
					const sp = spyOn(fs, name);
					spies.push(sp);
					return sp;
				};
				const bytes = (sp: { mock: { results: { value: unknown }[] } }) => sp.mock.results.reduce((n, r) => n + (r.value as number), 0);
				const KB = 1024;
				// A session file and the dir its children's files sit in, all under one temp root.
				const tree = () => {
					const root = mkdtempSync(join(tmpdir(), "rt-"));
					roots.push(root);
					mkdirSync(join(root, "main"));
					return { root, dir: join(root, "main"), file: join(root, "main.jsonl") };
				};

				test("every reason reads exactly as the Spec says", () => {
					const { dir, file } = tree();
					expect(readTranscript(undefined, "A", false).lines).toEqual([NO_SESSION]);
					expect(readTranscript(join(dir, "x.txt"), "A", false).lines).toEqual([NO_SESSION]);
					expect(readTranscript(file, "a.b", false).lines).toEqual(["a.b: a nested agent; its transcript is not read"]);
					expect(readTranscript(file, "a/b", false).lines).toEqual(["a/b: not a transcript id"]);
					expect(readTranscript(file, "A", false).lines).toEqual(["no transcript yet: omp writes it after the agent's first reply"]);
					mkdirSync(join(dir, "D.jsonl"));
					expect(readTranscript(file, "D", false).lines).toEqual(["transcript unreadable: not a regular file"]);
					writeFileSync(join(dir, "E.jsonl"), say("x") + "\n");
					watch("openSync").mockImplementation(() => {
						throw Object.assign(new Error("denied"), { code: "EACCES" });
					});
					expect(readTranscript(file, "E", false).lines).toEqual(["transcript unreadable: EACCES"]);
				});

				test("an id with a dot, a separator or a colon, or over 64 chars, never reaches fs, decoys inside and outside the dir or not", () => {
					const { root, dir, file } = tree();
					for (const base of [dir, root]) mkdirSync(join(base, "a"));
					const ids = ["a.b", "a/b", "a\\b", "a:b", "a".repeat(65), "", "..", "a b", "a\nb"];
					for (const id of ids) for (const base of [dir, root]) try { writeFileSync(join(base, `${id}.jsonl`), say("DECOY") + "\n"); } catch { /* not a legal name here: no decoy for it */ }
					const open = watch("openSync");
					const st = watch("lstatSync");
					const fst = watch("fstatSync");
					for (const id of ids) expect(readTranscript(file, id, false).lines.join()).not.toContain("DECOY");
					expect(open.mock.calls).toHaveLength(0);
					expect(st.mock.calls).toHaveLength(0);
					expect(fst.mock.calls).toHaveLength(0);
				});

				test("ids of 1 to 64 letters, digits, `_` and `-` are read, including one that starts with `_` or `-`", () => {
					const { dir, file } = tree();
					for (const id of ["_x", "-x", "a".repeat(64), "A1"]) {
						writeFileSync(join(dir, `${id}.jsonl`), say(`ROW-${id.length}`) + "\n");
						expect(readTranscript(file, id, false).lines).toEqual([`ROW-${id.length}`]);
					}
				});

				test("a 10 MB log and a 100 KiB answer read at most 512 KiB + 64 KiB and show the newest end", () => {
					const { dir, file } = tree();
					const pad = say("x".repeat(1000)) + "\n";
					writeFileSync(join(dir, "A.jsonl"), say("HEAD-MARK") + "\n" + pad.repeat(10_000) + say("TAIL-MARK") + "\n");
					writeFileSync(join(dir, "A.md"), `FIRST-LINE\n${"y".repeat(100 * KB)}\nEND-MARK\n`);
					expect(fs.statSync(join(dir, "A.jsonl")).size).toBeGreaterThan(10 * 1024 * KB);
					const rd = watch("readSync");
					const alloc = spyOn(Buffer, "allocUnsafe");
					spies.push(alloc);
					const t = readTranscript(file, "A", true).lines.join("\n");
					expect(bytes(rd)).toBeGreaterThan(0);
					expect(bytes(rd)).toBeLessThanOrEqual(512 * KB + 64 * KB + 512 * KB); // tail, answer and the head the brief is looked for in
					expect(Math.max(...alloc.mock.calls.map(c => c[0]))).toBeLessThanOrEqual(512 * KB); // never a buffer the size of the file
					expect(t).toContain("TAIL-MARK");
					expect(t).toContain("FIRST-LINE");
					expect(t).not.toContain("HEAD-MARK");
					expect(t).not.toContain("END-MARK");
					expect(t).toContain("… earlier entries not shown");
				});

				test("an answer over 64 KiB is read only up to 64 KiB", () => {
					const { dir, file } = tree();
					writeFileSync(join(dir, "A.jsonl"), say("W") + "\n");
					writeFileSync(join(dir, "A.md"), "y".repeat(200 * KB));
					const rd = watch("readSync");
					readTranscript(file, "A", true);
					expect(bytes(rd)).toBeLessThanOrEqual(KB + 64 * KB);
				});

				test("a file of exactly 512 KiB keeps its first line with no notice; one byte more cuts it", () => {
					const { dir, file } = tree();
					const first = say("FIRST-ROW") + "\n";
					const last = (extra: number) => say("x".repeat(512 * KB - first.length - 1 - say("").length + extra)) + "\n";
					writeFileSync(join(dir, "A.jsonl"), first + last(0));
					expect(fs.statSync(join(dir, "A.jsonl")).size).toBe(512 * KB);
					expect(readTranscript(file, "A", false).lines[0]).toBe("FIRST-ROW");
					writeFileSync(join(dir, "B.jsonl"), first + last(1));
					const b = readTranscript(file, "B", false).lines;
					expect(b[0]).toBe("… earlier entries not shown");
					expect(b).not.toContain("FIRST-ROW");
				});

				test("a symlink or a junction in place of the log is refused before it is opened", () => {
					const { root, dir, file } = tree();
					writeFileSync(join(root, "real.jsonl"), say("REAL") + "\n");
					mkdirSync(join(root, "realdir"));
					const link = (target: string, name: string, type: "file" | "junction") => {
						try {
							symlinkSync(target, join(dir, name), type);
							return true;
						} catch (e) {
							console.warn(`skipped ${type} link: creation refused (${(e as NodeJS.ErrnoException).code})`);
							return false;
						}
					};
					const open = watch("openSync");
					for (const [ok, id] of [[link(join(root, "real.jsonl"), "S.jsonl", "file"), "S"], [link(join(root, "realdir"), "J.jsonl", "junction"), "J"]] as const) {
						if (!ok) continue;
						expect(readTranscript(file, id, false).lines).toEqual(["transcript unreadable: not a regular file"]);
					}
					expect(open.mock.calls).toHaveLength(0);
				});

				test("what was opened must be a regular file: the handle's own stat decides", () => {
					const { dir, file } = tree();
					writeFileSync(join(dir, "A.jsonl"), say("ROW") + "\n");
					watch("fstatSync").mockImplementation((() => ({ isFile: () => false, size: 1, mtimeMs: 0 })) as unknown as typeof fs.fstatSync);
					expect(readTranscript(file, "A", false).lines).toEqual(["transcript unreadable: not a regular file"]);
				});

				test("switching to another agent never shows the first one's cached rows, even with the same size and mtime", () => {
					const { dir, file } = tree();
					writeFileSync(join(dir, "A.jsonl"), say("AAAA") + "\n");
					writeFileSync(join(dir, "B.jsonl"), say("BBBB") + "\n");
					for (const id of ["A", "B"]) utimesSync(join(dir, `${id}.jsonl`), 1e9, 1e9);
					const a = readTranscript(file, "A", false);
					expect(a.lines).toEqual(["AAAA"]);
					expect(readTranscript(file, "B", false, a).lines).toEqual(["BBBB"]);
				});

				test("an answer that appears later shows up although the log did not change", () => {
					const { dir, file } = tree();
					writeFileSync(join(dir, "A.jsonl"), say("W") + "\n");
					const a = readTranscript(file, "A", true);
					expect(a.lines).toContain("no final answer file");
					writeFileSync(join(dir, "A.md"), "FINAL-ANSWER-TEXT\n");
					const b = readTranscript(file, "A", true, a);
					expect(b.lines).toContain("final answer:");
					expect(b.lines).toContain("FINAL-ANSWER-TEXT");
				});

				test("an answer that is a directory or a symlink never hides the log's rows", () => {
					const { root, dir, file } = tree();
					writeFileSync(join(dir, "A.jsonl"), say("LOG-ROW") + "\n");
					mkdirSync(join(dir, "A.md"));
					expect(readTranscript(file, "A", true).lines).toEqual(["LOG-ROW", "no final answer file"]);
					writeFileSync(join(dir, "B.jsonl"), say("LOG-ROW") + "\n");
					writeFileSync(join(root, "real.md"), "LEAK\n");
					try {
						symlinkSync(join(root, "real.md"), join(dir, "B.md"), "file");
					} catch (e) {
						console.warn(`skipped file link: creation refused (${(e as NodeJS.ErrnoException).code})`);
						return;
					}
					expect(readTranscript(file, "B", true).lines).toEqual(["LOG-ROW", "no final answer file"]);
				});

				test("a session with no file, or one not ending in .jsonl, says so and does not throw", async () => {
					const { s, ui } = await squad();
					for (const getSessionFile of [undefined, () => "x.txt"]) {
						(s.ctx.sessionManager as { getSessionFile?: () => string }).getSessionFile = getSessionFile;
						await s.sub("cockpit");
						const c = ui.opened.at(-1)!.component;
						open(c);
						expect(show(c)).toContain("no session file");
						c.handleInput!("q");
					}
				});

				test("closing the cockpit, by q or by Esc from the top, drops the open transcript: a later redraw opens no log", async () => {
					const { s, ui } = await squad();
					writeFileSync(join(session(s), "A.jsonl"), say("ROW") + "\n");
					for (const close of [["q"], ["\x1b", "\x1b", "\x1b"]]) {
						await s.sub("cockpit");
						const c = ui.opened.at(-1)!.component;
						open(c);
						expect(show(c)).toContain("TRANSCRIPT A");
						const op = watch("openSync");
						for (const k of close) c.handleInput!(k);
						op.mockClear();
						ended(s);
						expect(op.mock.calls.filter(call => String(call[0]).endsWith("A.jsonl"))).toHaveLength(0);
						op.mockRestore();
					}
				});

				test("Enter opens the transcript although the run's files were deleted after the cockpit opened", async () => {
					const { s, ui } = await squad();
					writeFileSync(join(session(s), "A.jsonl"), say("STILL-HERE") + "\n");
					await s.sub("cockpit");
					const c = ui.opened.at(-1)!.component;
					rmSync(join(s.dir, "runs"), { recursive: true, force: true });
					open(c);
					expect(show(c)).toContain("STILL-HERE");
					c.handleInput!("q");
				});
			});

			test("the end of an agent is stored as `ended`, and a loaded state keeps it only as a number", async () => {
				const { s, ui } = await squad();
				scout(s, "running");
				at(MIN);
				done(s);
				await peek(s, ui);
				const file = join(s.dir, "runs", "sess-0001.cockpit");
				const saved = JSON.parse(readFileSync(file, "utf8"));
				expect(saved.deployed.find((d: unknown[]) => d[0] === "S")[1].ended).toBe(T0 + MIN);
				const ran = async (ended: unknown) => {
					saved.deployed.find((d: unknown[]) => d[0] === "S")[1].ended = ended;
					writeFileSync(file, JSON.stringify(saved));
					const r = setup("sess-0001", s.dir);
					const rui = uiCtx(r);
					await r.start();
					at(10 * MIN);
					await r.sub("cockpit");
					const c = rui.opened.at(-1)!.component;
					expect(openDetail(c, "returned")).toBe(true);
					const t = show(c);
					c.handleInput!("q");
					return t;
				};
				expect(await ran(T0 + MIN)).toContain("ran 1m");
				expect(await ran("soon")).toContain("elapsed unknown");
			});

			test("a finished agent's last live row is read once, so its detail keeps the cost after the file is gone", async () => {
				const { s, ui } = await squad();
				scout(s, "running");
				mkdirSync(join(s.dir, "runs", "sess-0001.live"), { recursive: true });
				writeFileSync(liveFile(s, "S"), JSON.stringify({ since: T0, at: T0, busy: 0, cost: 0.42, line: "wrapping up" }));
				at(MIN);
				done(s);
				rmSync(join(s.dir, "runs", "sess-0001.live"), { recursive: true, force: true });
				await s.sub("cockpit");
				const c = ui.opened.at(-1)!.component;
				expect(openDetail(c, "cost: $0.42")).toBe(true);
				expect(show(c)).toContain("ran 1m");
				c.handleInput!("q");
			});

			describe("a finished agent's row", () => {
				const evalSpawn = (s: S) => s.handlers.before_subagent_spawn.forEach(h => h({ invocationKind: "eval", agent: "scout", spawnKey: "E" }, s.ctx));
				const evalEnd = (s: S) => s.handlers.context.forEach(h => h({ type: "context", messages: [{ role: "toolResult", toolName: "eval", isError: false, content: [], details: { cells: [{ statusEvents: [{ op: "agent", id: "E", status: "completed" }] }] } }] }, s.ctx));
				const writeRow = (s: S, id: string, row: object) => {
					mkdirSync(join(s.dir, "runs", "sess-0001.live"), { recursive: true });
					writeFileSync(liveFile(s, id), JSON.stringify({ busy: 0, ...row }));
				};
				const detailOf = async (s: S, ui: ReturnType<typeof uiCtx>, word: string) => {
					await s.sub("cockpit");
					const c = ui.opened.at(-1)!.component;
					let found = false;
					for (let i = 0; i < 20 && !found; i++) {
						c.handleInput!("\x1b[B");
						c.handleInput!("\r");
						found = show(c).includes(word);
						if (!found) c.handleInput!("\x7f");
					}
					const t = show(c);
					c.handleInput!("q");
					return found ? t : undefined;
				};

				test("an id spawned again does not inherit the row of the agent that ended under it; its own live row wins", async () => {
					const { s, ui } = await squad();
					evalSpawn(s);
					writeRow(s, "E", { since: T0, at: T0, cost: 0.42, line: "old line" });
					at(MIN);
					evalEnd(s);
					at(2 * MIN);
					evalSpawn(s);
					const fresh = await detailOf(s, ui, "scout E · running");
					expect(fresh).toContain("cost: unknown");
					expect(fresh).not.toContain("old line");
					writeRow(s, "E", { since: T0 + 2 * MIN, at: T0 + 2 * MIN, cost: 0.99 });
					expect(await detailOf(s, ui, "scout E · running")).toContain("cost: $0.99");
				});

				test("after a restart a returned agent's row is read once, at the first draw, if it is not older than its deploy", async () => {
					const { s } = await squad();
					scout(s, "running");
					writeRow(s, "S", { since: T0, at: T0, cost: 0.42 });
					at(MIN);
					done(s);
					const r = setup("sess-0001", s.dir);
					const rui = uiCtx(r);
					await r.start();
					expect(await detailOf(r, rui, "scout S · returned")).toContain("cost: $0.42");
					writeRow(r, "S", { since: T0, at: T0, cost: 9 });
					expect(await detailOf(r, rui, "scout S · returned")).toContain("cost: $0.42");
				});

				test("a miss at the first draw is read again when the detail opens: a file that shows up later shows its cost", async () => {
					const { s } = await squad();
					scout(s, "running");
					at(MIN);
					done(s);
					const r = setup("sess-0001", s.dir);
					const rui = uiCtx(r);
					await r.start();
					await r.sub("cockpit");
					const c = rui.opened.at(-1)!.component;
					for (let i = 0; i < 20 && !show(c).includes("scout S · returned"); i++) {
						c.handleInput!("\x1b[B");
						c.handleInput!("\r");
						if (!show(c).includes("scout S · returned")) c.handleInput!("\x7f");
					}
					expect(show(c)).toContain("cost: unknown");
					writeRow(r, "S", { since: T0, at: T0, cost: 9 });
					evalSpawn(r); // a redraw while the detail is open
					expect(show(c)).toContain("cost: $9");
					c.handleInput!("q");
				});

				test("a row older than the deploy never enters the detail of the returned agent", async () => {
					const { s, ui } = await squad();
					at(MIN);
					scout(s, "running");
					writeRow(s, "S", { since: T0 - 5 * MIN, at: T0 - 4 * MIN, cost: 7 });
					at(2 * MIN);
					done(s);
					expect(await detailOf(s, ui, "scout S · returned")).toContain("cost: unknown");
				});

				// The same extension instance serves two sessions (omp mutates one SessionManager): the rows read for session A must not be the rows of session B.
				test("a session switch drops the rows read for the previous session: its saved state brings the agent back with no row", async () => {
					const { s, ui } = await squad();
					evalSpawn(s);
					writeRow(s, "E", { since: T0, at: T0, cost: 0.42 });
					at(MIN);
					evalEnd(s);
					expect(await detailOf(s, ui, "scout E · returned")).toContain("cost: $0.42"); // read, and kept in `final`
					await s.handlers.session_shutdown[0]({}, s.ctx);
					const runs = join(s.dir, "runs");
					writeFileSync(join(runs, "sess-0002.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(runs, "sess-0001.json"), "utf8")), sid: "sess-0002" }));
					copyFileSync(join(runs, "sess-0001.cockpit"), join(runs, "sess-0002.cockpit"));
					rmSync(join(runs, "sess-0001.live"), { recursive: true, force: true });
					s.ctx.sessionManager = { getSessionId: () => "sess-0002" };
					await s.handlers.session_switch[0]({}, s.ctx);
					expect(await detailOf(s, ui, "scout E · returned")).toContain("cost: unknown");
				});

				const into = (c: { render(w: number): string[]; handleInput?(d: string): void }, title: string) => {
					for (let i = 0; i < 20 && !show(c).includes(title); i++) {
						c.handleInput!("\x1b[B");
						c.handleInput!("\r");
						if (!show(c).includes(title)) c.handleInput!("\x7f");
					}
					expect(show(c)).toContain(title);
				};

				test("a miss is also read again while the detail of the agent's squad is open", async () => {
					const { s } = await squad();
					at(MIN);
					s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [brother("A")] }, details: { progress: [{ index: 0, id: "A", status: "completed" }] }, isError: false }, s.ctx));
					const r = setup("sess-0001", s.dir);
					const rui = uiCtx(r);
					await r.start();
					await r.sub("cockpit");
					const c = rui.opened.at(-1)!.component;
					into(c, "agents (1):");
					expect(show(c)).toContain("cost: unknown");
					writeRow(r, "A", { since: T0, at: T0, cost: 9 });
					evalSpawn(r); // a redraw while the squad's detail is open
					expect(show(c)).toContain("cost: $9");
					c.handleInput!("q");
				});

				test("a miss is not read again while no detail is open: the row that shows up later waits for the next draw after the detail opens", async () => {
					const { s } = await squad();
					at(MIN);
					s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [brother("A")] }, details: { progress: [{ index: 0, id: "A", status: "completed" }] }, isError: false }, s.ctx));
					const r = setup("sess-0001", s.dir);
					const rui = uiCtx(r);
					await r.start();
					await r.sub("cockpit");
					const c = rui.opened.at(-1)!.component;
					writeRow(r, "A", { since: T0, at: T0, cost: 9 });
					evalSpawn(r); // a redraw with the detail closed: the miss stays
					into(c, "agents (1):"); // opening a detail recomputes from the last input, reading no file
					expect(show(c)).toContain("cost: unknown");
					evalSpawn(r); // the first draw with the detail open reads it again
					expect(show(c)).toContain("cost: $9");
					c.handleInput!("q");
				});
			});

			describe("keys through handleInput", () => {
				const DOWN = "\x1b[B";
				test("down + enter opens the detail with its title, backspace and CSI-u backspace return with the line selected, a redraw keeps the detail, and the file saves no detail", async () => {
					const { s, ui } = await squad();
					scout(s, "running");
					await s.sub("cockpit");
					const c = ui.opened.at(-1)!.component;
					c.handleInput!(DOWN);
					const list = show(c);
					const sel = list.split("\n").find(l => l.includes("▸"))!;
					c.handleInput!("\r");
					const opened = show(c);
					expect(opened).toContain("back · q close");
					for (const back of ["\b", "\x1b[127u"]) {
						c.handleInput!(back);
						expect(show(c).split("\n").find(l => l.includes("▸"))).toBe(sel);
						c.handleInput!("\r");
						expect(show(c)).toBe(opened);
					}
					at(MIN);
					done(s); // a redraw while the detail is open
					expect(show(c)).toContain("back · q close");
					expect(JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.cockpit"), "utf8"))).not.toHaveProperty("detail");
					c.handleInput!("q");
				});
			});
		});

		describe("stalled", () => {
			test("5 min with no tool call logs one entry however often it is drawn, and a newer tool call clears the gold", async () => {
				const { s, ui } = await squad();
				const c = child(s);
				c.start("read");
				at(2000);
				c.end("read");
				at(2000 + 6 * MIN);
				expect(top(await peek(s, ui))).toContain("stalled 6m");
				await peek(s, ui);
				expect((await chron(s, ui)).match(/stalled 6m/g)).toHaveLength(1);
				const saved = JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.cockpit"), "utf8"));
				expect(saved.deployed).toEqual([["A", expect.objectContaining({ stalled: T0 + 2000 })]]);
				c.start("bash");
				expect(top(await peek(s, ui))).not.toContain("stalled");
			});

			test("a tool call still in flight is not stalled, however long it runs", async () => {
				const { s, ui } = await squad();
				const c = child(s);
				c.start("bash", "Running the tests");
				at(20 * MIN);
				const t = await peek(s, ui);
				expect(t).not.toContain("stalled");
				expect(t).toContain("20m · $? · Running the tests");
			});

			test("the 5 minutes count from the end of the last tool call", async () => {
				const { s, ui } = await squad();
				const c = child(s);
				c.start("bash");
				at(10 * MIN);
				c.end("bash");
				at(14 * MIN);
				expect(await peek(s, ui)).not.toContain("stalled");
				at(16 * MIN);
				expect(top(await peek(s, ui))).toContain("stalled 6m");
			});
		});

		test("an eval spawn whose key matches no live file shows its elapsed time only", async () => {
			at(0);
			const { s, ui } = await running();
			s.todo([{ name: "Auspex", tasks: [{ content: "[scout] Map the code", status: "in_progress" }] }]);
			s.handlers.before_subagent_spawn.forEach(h => h({ invocationKind: "eval", agent: "scout", spawnKey: "E" }, s.ctx));
			const c = child(s, "other");
			c.start("read", "Reading elsewhere");
			at(4 * MIN);
			const t = await peek(s, ui);
			expect(t).toMatch(/│ +4m · \$\? +│/);
			expect(t).not.toContain("Reading elsewhere");
		});

		test("a stale pointer makes the child write nothing", async () => {
			const { s } = await squad();
			rmSync(join(s.dir, "runs", "sess-0001.json"));
			const c = child(s);
			c.start("read", "Reading");
			c.todo(1, 2, "x");
			expect(existsSync(join(s.dir, "runs", "sess-0001.live"))).toBe(false);
		});

		test("with no pointer at all the child writes nothing", async () => {
			at(0);
			const { s } = await running();
			child(s).start("read", "Reading");
			expect(existsSync(join(s.dir, "runs", "sess-0001.live"))).toBe(false);
		});

		test("end removes the live files, and shutdown the pointer", async () => {
			const { s } = await squad();
			child(s).start("read");
			expect(existsSync(liveFile(s))).toBe(true);
			expect(readFileSync(join(s.dir, "runs", `${process.pid}.pid`), "utf8")).toBe("sess-0001");
			shutdown(s);
			expect(existsSync(join(s.dir, "runs", `${process.pid}.pid`))).toBe(false);
			await s.call({ action: "end" });
			expect(existsSync(join(s.dir, "runs", "sess-0001.live"))).toBe(false);
		});

		// A recent `at`, so only the shape or size of the file, not the age, can make the reader ignore it.
		const row = (over: object) => JSON.stringify({ since: T0, at: T0, intent: "SHOWN", ...over });
		test.each([
			["not JSON", "{nope"],
			["too big", row({ current: "x".repeat(5000) })],
			["wrong shape", row({ since: "1" })],
			["a negative number", row({ since: -1 })],
			["a fraction", row({ at: 1.5 })],
			["a number for the text", row({ current: 7 })],
			["a string for busy", row({ busy: "x" })],
		])("a live file that is %s is ignored", async (_why, body) => {
			const { s, ui } = await squad();
			mkdirSync(join(s.dir, "runs", "sess-0001.live"), { recursive: true });
			writeFileSync(liveFile(s), body);
			at(4 * MIN); // before the 5 minutes a deployed agent with no valid row may idle
			const t = await peek(s, ui);
			expect(t).toContain("4m");
			expect(t).not.toContain("SHOWN");
			expect(t).not.toContain("stalled");
		});

		test("a re-deployed id is not stalled by the previous agent's old live file", async () => {
			const { s, ui } = await squad();
			mkdirSync(join(s.dir, "runs", "sess-0001.live"), { recursive: true });
			writeFileSync(liveFile(s), JSON.stringify({ since: T0 - 12 * MIN, at: T0 - 10 * MIN, intent: "OLDAGENT" }));
			at(1 * MIN);
			const t = await peek(s, ui);
			expect(t).not.toContain("OLDAGENT");
			expect(await chron(s, ui)).not.toContain("stalled");
		});

		test("a todo's abandoned task is not counted in the total", async () => {
			const { s } = await squad();
			child(s).fire("tool_result", { toolName: "todo", isError: false, details: { phases: [{ name: "W", tasks: [{ content: "a", status: "completed" }, { content: "b", status: "abandoned" }, { content: "c", status: "pending" }] }] } });
			expect(readLive(s)).toMatchObject({ done: 1, total: 2 });
		});

		test("a tool named with a leading underscore is shown by its bare name", async () => {
			const { s } = await squad();
			child(s).start("_read");
			expect(readLive(s)).toMatchObject({ tool: "read" });
		});

		test("an id with a star maps to a file name Windows accepts", async () => {
			const { s } = await squad();
			child(s, "a*b").start("read");
			expect(readdirSync(join(s.dir, "runs", "sess-0001.live"))).toEqual(["a%2Ab.json"]);
		});

		test("an overlay tick with its lock unreadable leaves the run file alone", async () => {
			vi.useFakeTimers();
			const { s, ui } = await squad();
			await s.sub("cockpit");
			rmSync(lockPath(s.dir, "K-1"), { force: true });
			vi.advanceTimersByTime(1000);
			expect(existsSync(join(s.dir, "runs", "sess-0001.json"))).toBe(true);
			ui.opened.at(-1)!.component.handleInput!("q");
		});

		test("a sub agent's tool_call is still not judged", async () => {
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			await s.call({ action: "repo", repo: s.dir });
			const call = (ctx: unknown) => s.handlers.tool_call[0]({ toolName: "task", input: { tasks: [brother("A")] } }, ctx);
			expect((call(s.ctx) as { block?: boolean }).block).toBe(true);
			expect(call({ ...s.ctx, agent: { kind: "sub", id: "A" } })).toBeUndefined();
		});

		describe("agent cost", () => {
			// omp's UsageStatistics, as `getUsageStatistics()` returns it: cost includes the nested subagents', subagentCost is their part.
			type Stats = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number; subagentCost: number };
			const stats = (cost: number, subagentCost = 0): Stats => ({ input: 1200, output: 300, cacheRead: 4000, cacheWrite: 50, totalTokens: 5550, cost, subagentCost });
			const none: Stats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, subagentCost: 0 };
			// omp's own per-agent figure (registry/agent-lifecycle.ts directCost): the sum is taken before rounding.
			const omp = (...st: Stats[]) => `$${st.reduce((n, x) => n + (x.cost - x.subagentCost), 0).toFixed(2)}`;
			const fresh = async (booked?: number) => {
				at(0);
				const s = setup();
				await s.call({ action: "begin", key: "K-1", ...(booked ? { booked } : {}) });
				const ui = uiCtx(s);
				await s.start();
				s.handlers.before_subagent_spawn.forEach(h => h({ agent: "scout" }, s.ctx)); // the pointer the children read
				return { s, ui };
			};
			const deploy = (s: S, id: string, agent: string) =>
				s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [{ agent, task: "x" }] }, details: { progress: [{ index: 0, id, status: "running" }] }, isError: false }, s.ctx));
			// A subagent session with its own usage object; `box` changes what the session reports.
			const kid = (s: S, id: string, st?: Stats) => {
				const f = fakePi();
				extension(f.pi as never);
				const box = { stats: st as unknown, fail: false };
				const sm: Record<string, unknown> = {
					getSessionId: () => `child-${id}`,
					getUsageStatistics: () => {
						if (box.fail) throw new Error("cross-thread session view");
						return box.stats;
					},
				};
				const ctx = { ...fakeCtx(`child-${id}`, s.dir), agent: { kind: "sub", id }, sessionManager: sm };
				const fire = (event: string, e: unknown = {}) => f.handlers[event]?.forEach(h => h(e, ctx));
				return { box, sm, fire, message: () => fire("message_end", { message: { role: "assistant" } }) };
			};
			const debriefText = (s: S) => readFileSync(join(s.dir, "debriefs", readdirSync(join(s.dir, "debriefs"))[0]), "utf8");

			test("1: a sub's assistant message_end writes the usage, cost minus its nested subagents'; a trailing write holds the later figures", async () => {
				vi.useFakeTimers();
				const { s } = await fresh();
				const c = kid(s, "A", stats(0.4, 0.1));
				c.message();
				expect(readLive(s)).toMatchObject({ tokens_in: 1200, tokens_out: 300, cache_read: 4000, cache_write: 50 });
				expect(readLive(s).cost).toBeCloseTo(0.3, 10);
				c.box.stats = stats(0.9, 0.1);
				at(300);
				c.message(); // inside the 1 s throttle: scheduled, not written
				expect(readLive(s).cost).toBeCloseTo(0.3, 10);
				c.box.stats = stats(1.1, 0.1); // changes again before the timer: the write reads when it runs
				vi.advanceTimersByTime(900);
				expect(readLive(s).cost).toBeCloseTo(1.0, 10);
			});

			test("2: agent_end writes at once past the throttle, and shutdown flushes a pending write", async () => {
				const { s } = await fresh();
				const c = kid(s, "A", stats(0.1));
				c.message();
				c.box.stats = stats(0.2);
				at(100);
				c.fire("agent_end");
				expect(readLive(s).cost).toBeCloseTo(0.2, 10);
				at(5000);
				c.message(); // writes (past the throttle)
				c.box.stats = stats(0.7);
				at(5100);
				c.message(); // pending
				expect(readLive(s).cost).toBeCloseTo(0.2, 10);
				c.fire("session_shutdown");
				expect(readLive(s).cost).toBeCloseTo(0.7, 10);
			});

			test("3: no tokens, no price, a missing or throwing getUsageStatistics: unknown fields are absent, nothing throws", async () => {
				const { s } = await fresh();
				const zero = kid(s, "A", none);
				const unpriced = kid(s, "B", stats(0));
				const thrower = kid(s, "C", stats(0.5));
				thrower.box.fail = true;
				const missing = kid(s, "D", stats(0.5));
				missing.sm.getUsageStatistics = undefined;
				for (const c of [zero, unpriced, thrower, missing]) expect(() => c.message()).not.toThrow();
				for (const id of ["A", "C", "D"]) expect(Object.keys(readLive(s, id)).filter(k => /^(cost|tokens_|cache_)/.test(k))).toEqual([]);
				expect(readLive(s, "B")).toMatchObject({ tokens_in: 1200, tokens_out: 300 });
				expect(readLive(s, "B")).not.toHaveProperty("cost");
			});

			test("4: the overlay shows $0.42 after the elapsed span, and $? for an active agent with no cost", async () => {
				const { s, ui } = await squad();
				const a = kid(s, "A", stats(0.42));
				a.message();
				deploy(s, "B", "scout");
				kid(s, "B", none).message();
				at(10 * MIN);
				a.message();
				const t = await peek(s, ui);
				expect(t).toContain("10m · $0.42");
				expect(t).toContain("$?");
				expect(t).not.toContain("$0.00");
			});

			test("5: a live file with a bad cost or token field is ignored without throwing and its row shows $?", async () => {
				const { s, ui } = await squad();
				at(10 * MIN);
				const base = `"since":${T0},"at":${T0 + 10 * MIN},"busy":0,"line":"kept?"`;
				for (const bad of ['"cost":-1', '"cost":"0.4"', '"cost":null', '"cost":1e999', '"tokens_in":1.5', '"cache_read":-2', '"tokens_out":"9"']) {
					mkdirSync(join(s.dir, "runs", "sess-0001.live"), { recursive: true });
					writeFileSync(liveFile(s), `{${base},${bad}}`);
					const t = await peek(s, ui);
					expect(t).not.toContain("kept?");
					expect(t).toContain("$?");
				}
			});

			test("5b: a live file with a huge finite cost is ignored", async () => {
				const { s, ui } = await squad();
				at(10 * MIN);
				mkdirSync(join(s.dir, "runs", "sess-0001.live"), { recursive: true });
				writeFileSync(liveFile(s), `{"since":${T0},"at":${T0 + 10 * MIN},"busy":0,"line":"kept?","cost":1e308}`);
				const t = await peek(s, ui);
				expect(t).not.toContain("kept?");
				expect(t).toContain("$?");
			});

			test("6b: when saving the cockpit fails, end still names the roles from memory", async () => {
				const { s } = await fresh();
				rmSync(join(s.dir, "runs", "sess-0001.cockpit"), { force: true });
				mkdirSync(join(s.dir, "runs", "sess-0001.cockpit")); // writeAtomic cannot replace a directory
				deploy(s, "A", "inquisitor");
				kid(s, "A", stats(0.4)).message();
				await s.call({ action: "end" });
				expect(debriefText(s)).toContain(`| inquisitor | 1 | ${omp(stats(0.4))} |`);
			});

			test("6: end writes the Cost section: role totals equal omp's cost − subagentCost over the same stats, unknowns stay ?", async () => {
				const { s } = await fresh();
				const A = stats(0.4, 0.1), B = stats(0.25), C = stats(0.33), E = stats(0.07);
				for (const [id, role] of [["A", "battle-brother"], ["B", "battle-brother"], ["C", "inquisitor"], ["D", "scout"]]) deploy(s, id, role);
				for (const [id, st] of [["A", A], ["B", B], ["C", C], ["D", none], ["E", E]] as const) kid(s, id, st).message();
				const out = await s.call({ action: "end" });
				const md = debriefText(s);
				expect(md).toContain("## Cost");
				expect(md).toContain(`| battle-brother | 2 | ${omp(A, B)} |`);
				expect(md).toContain(`| inquisitor | 1 | ${omp(C)} |`);
				expect(md).toContain("| scout | 1 | ? |");
				expect(md).toContain(`| other | 1 | ${omp(E)} |`);
				expect(md).toContain(`| Total (agents) | 5 | ${omp(A, B, C, E)} + ? |`);
				expect(out.split("\n").some(l => l.startsWith("COST (agents, list price) "))).toBe(true);
			});

			test("7: after a parent restart the roles and squads come from the saved cockpit and the costs are the same", async () => {
				const { s } = await fresh();
				const A = stats(0.4, 0.1), C = stats(0.33);
				await s.call({ action: "slices", slices: [{ id: "a", parallel: false, files: ["a.ts"] }] });
				s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [{ agent: "battle-brother", name: "A", isolated: true, task: "build squad a." }] }, details: { progress: [{ index: 0, id: "A", status: "running" }] }, isError: false }, s.ctx));
				deploy(s, "C", "inquisitor");
				kid(s, "A", A).message();
				kid(s, "C", C).message();
				const restarted = setup("sess-0001", s.dir);
				await restarted.call({ action: "end" });
				const md = debriefText(s);
				expect(md).toContain(`| battle-brother | 1 | ${omp(A)} |`);
				expect(md).toContain(`| inquisitor | 1 | ${omp(C)} |`);
				expect(md).toMatch(/\| A \| battle-brother \| a \|/);
			});

			test("8: a timed run prints the cost per booked hour, an untimed one does not", async () => {
				const timed = await fresh(120);
				kid(timed.s, "A", stats(0.6)).message();
				await timed.s.call({ action: "end" });
				expect(debriefText(timed.s)).toContain("Cost per booked hour: $0.30 (agents only; total $0.60 over 120 booked min)");
				const untimed = await fresh();
				kid(untimed.s, "A", stats(0.6)).message();
				await untimed.s.call({ action: "end" });
				expect(debriefText(untimed.s)).not.toContain("Cost per booked hour");
			});

			test("9: a live file older than the run is left out, and a file name that does not decode is skipped", async () => {
				const { s } = await fresh();
				kid(s, "A", stats(0.2)).message();
				const dir = join(s.dir, "runs", "sess-0001.live");
				writeFileSync(join(dir, "OLD.json"), JSON.stringify({ since: T0 - 3_600_000, at: T0 - 3_600_000, busy: 0, cost: 9.99, tokens_in: 5 }));
				writeFileSync(join(dir, "%E0%A4%A.json"), JSON.stringify({ since: T0, at: T0, busy: 0, cost: 8.88 }));
				const out = await s.call({ action: "end" });
				expect(out).toContain("ENDED K-1");
				const md = debriefText(s);
				expect(md).not.toContain("9.99");
				expect(md).not.toContain("8.88");
				expect(md).not.toContain("OLD");
				expect(md).toContain("| other | 1 | $0.20 |");
			});

			test("10: a sub's message_end moves the live at", async () => {
				const { s } = await fresh();
				const c = kid(s, "A", stats(0.1));
				c.message();
				const before = readLive(s).at;
				at(2000);
				c.message();
				expect(readLive(s).at).toBe(before + 2000);
			});

			test("11: a sub's message_end of another role is ignored: at and the figures stay", async () => {
				const { s } = await fresh();
				const c = kid(s, "A", stats(0.1));
				c.message();
				const before = readLive(s);
				c.box.stats = stats(0.9);
				at(2000);
				c.fire("message_end", { message: { role: "user" } });
				expect(readLive(s)).toEqual(before);
			});

			test("12: a shutdown with no pending write and no agent_end still writes the latest usage", async () => {
				const { s } = await fresh();
				const c = kid(s, "A", stats(0.1));
				c.message(); // writes at once: nothing pending afterwards
				c.box.stats = stats(0.5);
				at(100);
				c.fire("session_shutdown");
				expect(readLive(s).cost).toBeCloseTo(0.5, 10);
			});
		});
	});

	describe("the rate action (#141)", () => {
		type S = ReturnType<typeof setup>;
		const deploy = (s: S, id: string, agent = "scout") => s.handlers.before_subagent_spawn.forEach(h => h({ invocationKind: "eval", agent, spawnKey: id }, s.ctx));
		const good = { action: "rate", agent: "Scout1", rating: "proven", evidence: ["I-3"], model: "@task", effort: "medium" };
		const runFile = (s: S) => JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8")) as { ratings?: Record<string, unknown> };
		// The agent's row shows only under a station, so the todo has one with a scout task.
		const rigged = async () => {
			const { s, ui } = await running();
			s.todo([{ name: "Auspex", tasks: [{ content: "[scout] Recon", status: "in_progress" }] }]);
			deploy(s, "Scout1");
			return { s, ui };
		};

		test("records the rating in the run file and says so; a re-rate replaces it and says what it was", async () => {
			const { s } = await rigged();
			expect(await s.call(good)).toBe("RATED Scout1 proven model=@task effort=medium evidence=1");
			expect(runFile(s).ratings).toEqual({ Scout1: { rating: "proven", evidence: ["I-3"], model: "@task", effort: "medium" } });
			expect(await s.call({ ...good, rating: "proven-regression", evidence: ["I-4", "I-5"], effort: "HIGH" })).toBe("RATED Scout1 proven-regression (was proven) model=@task effort=high evidence=2");
			expect(runFile(s).ratings).toEqual({ Scout1: { rating: "proven-regression", evidence: ["I-4", "I-5"], model: "@task", effort: "high" } });
		});

		test("each refusal, in order, writes nothing", async () => {
			const { s } = await rigged();
			const refused = (p: object) => s.call({ ...good, ...p });
			expect(await refused({ agent: undefined })).toBe("ERROR rate needs agent");
			expect(await refused({ agent: "Ghost" })).toBe("ERROR Ghost is not an agent of this run: pass the agent id the task result shows");
			expect(await refused({ rating: "great" })).toBe("ERROR rating must be proven, proven-regression or corrupted");
			expect(await refused({ rating: undefined })).toBe("ERROR rating must be proven, proven-regression or corrupted");
			expect(await refused({ evidence: undefined })).toBe("ERROR rate needs evidence: finding IDs, the failing check or the breached rule");
			expect(await refused({ evidence: [] })).toBe("ERROR rate needs evidence: finding IDs, the failing check or the breached rule");
			expect(await refused({ evidence: ["  "] })).toBe("ERROR rate needs evidence: finding IDs, the failing check or the breached rule");
			expect(await refused({ evidence: Array(9).fill("x") })).toBe("ERROR at most 8 evidence items");
			expect(await refused({ evidence: ["x".repeat(201)] })).toBe("ERROR evidence item too long (max 200 characters)");
			expect(await refused({ model: undefined })).toBe("ERROR rate needs model: the model the agent ran on, e.g. @task");
			expect(await refused({ model: "m".repeat(61) })).toBe("ERROR model too long (max 60 characters)");
			for (const effort of [undefined, "", "two words", "9x", "x".repeat(17)]) expect(await refused({ effort })).toBe("ERROR effort must be one word such as low, medium, high or default");
			expect(runFile(s).ratings).toBeUndefined();
		});

		test("no run, no rating", async () => {
			expect(await setup().call(good)).toBe("ERROR no active run in this session");
		});

		test("a subagent cannot rate", async () => {
			const { s } = await rigged();
			s.ctx.agent = { kind: "sub" };
			expect(await s.call(good)).toBe("ERROR strategium tool is for the main session only");
			expect(runFile(s).ratings).toBeUndefined();
		});

		test("corrupted is sticky: only a corrupted rating replaces it", async () => {
			const { s } = await rigged();
			await s.call({ ...good, rating: "corrupted", evidence: ["I-9"] });
			for (const rating of ["proven", "proven-regression"]) expect(await s.call({ ...good, rating })).toBe("ERROR Scout1 is corrupted for the rest of the run");
			expect(await s.call({ ...good, rating: "corrupted", evidence: ["I-10"] })).toBe(`RATED Scout1 corrupted (was corrupted) model=@task effort=medium evidence=1\nLESSON write local://K-1-lessons.md for Scout1; start evidence with cause: <why>`);
			expect(runFile(s).ratings).toEqual({ Scout1: { rating: "corrupted", evidence: ["I-10"], model: "@task", effort: "medium" } });
		});

		test("a corrupted non-builder: the short LESSON line; proven and proven-regression print none (#142)", async () => {
			const { s } = await rigged();
			expect(await s.call({ ...good, rating: "corrupted" })).toMatch(/^RATED Scout1 corrupted model=@task effort=medium evidence=1\nLESSON write local:\/\/\S+-lessons\.md for Scout1; start evidence with cause: <why>$/);
			const t0 = await rigged();
			expect(await t0.s.call({ ...good, rating: "corrupted", evidence: ["cause: the check was skipped", "I-3"] })).toMatch(/^RATED Scout1 corrupted model=@task effort=medium evidence=2\nLESSON write local:\/\/\S+-lessons\.md for Scout1$/);
			const t = await rigged();
			for (const rating of ["proven", "proven-regression"]) expect(await t.s.call({ ...good, rating })).not.toContain("LESSON");
		});

		test("the rating shows on the agent's row, and after a restart the saved run and registry still know it", async () => {
			const { s, ui } = await rigged();
			expect(await peek(s, ui)).not.toContain("✦");
			await s.call(good);
			expect(await peek(s, ui)).toContain("✦");
			const r = setup("sess-0001", s.dir);
			const rui = uiCtx(r);
			await r.start();
			expect(await peek(r, rui)).toContain("✦");
			expect(await r.call({ ...good, rating: "corrupted" })).toContain("(was proven)");
		});

		test("an open cockpit redraws with the badge right after rate, without reopening", async () => {
			const { s, ui } = await rigged();
			await s.sub("cockpit");
			const comp = ui.opened.at(-1)!.component;
			expect(plain(comp.render(100).join("\n"))).not.toContain("✦");
			await s.call(good);
			const shown = plain(comp.render(100).join("\n"));
			comp.handleInput!("q");
			expect(shown).toContain("✦");
		});

		test("a hand-edited run file keeps only the entries that pass the same checks", async () => {
			const { s } = await rigged();
			await s.call(good);
			const file = join(s.dir, "runs", "sess-0001.json");
			const run = JSON.parse(readFileSync(file, "utf8"));
			const ok = run.ratings.Scout1;
			run.ratings = { Scout1: ok, "": ok, "bad\nkey": ok, ["k".repeat(129)]: ok, A: { ...ok, rating: "great" }, B: { ...ok, evidence: [] }, C: { ...ok, evidence: Array(9).fill("x") }, D: { ...ok, model: "" }, E: { ...ok, effort: "Two Words" }, F: "proven", G: { ...ok, extra: 1 } };
			writeFileSync(file, JSON.stringify(run));
			const r = setup("sess-0001", s.dir);
			await r.start();
			expect(await r.call({ action: "end" })).toContain("RATINGS 2: proven 2");
		});

		test("a run file whose ratings is not an object reads as none", async () => {
			const { s } = await rigged();
			const file = join(s.dir, "runs", "sess-0001.json");
			writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ratings: ["x"] }));
			const r = setup("sess-0001", s.dir);
			await r.start();
			expect(await r.call({ action: "end" })).not.toContain("RATINGS");
		});

		test("end puts the ratings in the debrief and the result", async () => {
			const { s } = await rigged();
			await s.call(good);
			const out = await s.call({ action: "end" });
			expect(out).toContain("RATINGS 1: proven 1");
			const dir = join(s.dir, "debriefs");
			expect(readFileSync(join(dir, readdirSync(dir)[0]), "utf8")).toContain("## Ratings");
		});

		test("without a rate call the end result, the debrief and the run file have no ratings", async () => {
			const { s } = await rigged();
			expect(runFile(s).ratings).toBeUndefined();
			expect("ratings" in runFile(s)).toBe(false);
			const out = await s.call({ action: "end" });
			expect(out).not.toContain("RATINGS");
			const dir = join(s.dir, "debriefs");
			expect(readFileSync(join(dir, readdirSync(dir)[0]), "utf8")).not.toContain("Ratings");
		});

		test("a redraft keeps the ratings", async () => {
			const { s } = await rigged();
			await s.call(good);
			await s.call({ action: "redraft" });
			expect(runFile(s).ratings).toHaveProperty("Scout1");
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

// The run's debrief, written by `end` from what the hooks recorded in the day file, the run file and the cockpit file.
describe("the debrief at end", () => {
	type S = ReturnType<typeof setup>;
	const at = (h: number, m: number) => setSystemTime(new Date(2026, 10, 16, h, m, 0));
	const events = (dir: string) => load(join(dir, "2026-11-16.jsonl"));
	const ph = (name: string, ...tasks: [string, string][]) => ({ name, tasks: tasks.map(([content, status]) => ({ content, status })) });
	const STATIONS = ["Muster", "Auspex", "Scriptorium", "Deployment"];
	// omp hands every todo result to all the tool_result handlers. The seal sits in Scriptorium: waiting, or granted once the run is past it.
	const todo = (s: S, active: string, opts: { seal?: true; op?: string } = {}) => {
		const i = STATIONS.indexOf(active);
		const phases = STATIONS.map((name, j) =>
			ph(
				name,
				[`[captain] ${name}`, j < i ? "completed" : j === i ? (opts.seal ? "completed" : "in_progress") : "pending"],
				...(name === "Scriptorium" ? [["[seal] Plan", j < i ? "completed" : j === i && opts.seal ? "in_progress" : "pending"] as [string, string]] : []),
			),
		);
		s.handlers.tool_result.forEach(h => h({ toolName: "todo", isError: false, details: { ...(opts.op ? { op: opts.op } : {}), phases } }, s.ctx));
	};
	const spawn = (s: S, e: object) => s.handlers.before_subagent_spawn[0](e, s.ctx) as { block?: true; model?: string } | undefined;
	const brother = { agent: "battle-brother", name: "S1", task: "build squad S1" };
	const launched = (s: S, id: string) => s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [brother] }, details: { progress: [{ index: 0, id, status: "running" }] }, isError: false }, s.ctx));
	const ended = (s: S, id: string, status: string) =>
		s.handlers.context.forEach(h => h({ type: "context", messages: [{ role: "custom", customType: "async-result", details: { jobs: [{ jobId: `j-${id}`, type: "task", status, label: id }] } }] }, s.ctx));
	const squads = [{ id: "S1", parallel: false, files: ["a.ts"], tier: "light" }];
	const debriefFile = (dir: string) => {
		const files = readdirSync(join(dir, "debriefs"));
		expect(files).toHaveLength(1);
		return join(dir, "debriefs", files[0]);
	};
	const begun = async (s: S) => {
		at(9, 0);
		await s.call({ action: "begin", key: "K-1", theatre: "github" });
		await s.call({ action: "repo", repo: s.dir });
	};

	test("(a) a finished run: the file, the exact markdown, the rows that add up, the seal wait, the spawns and the reported sections", async () => {
		const s = setup();
		await begun(s);
		todo(s, "Muster");
		at(9, 10);
		todo(s, "Auspex");
		at(9, 12);
		spawn(s, { agent: "scout", modelRole: "smol" });
		at(9, 20);
		todo(s, "Scriptorium");
		at(9, 25);
		spawn(s, { agent: "librarian", patterns: ["anthropic/claude-opus-4"] });
		at(9, 35);
		todo(s, "Scriptorium", { seal: true });
		at(9, 40);
		await s.call({ action: "stop" });
		at(9, 50);
		await s.call({ action: "start" });
		at(9, 55);
		todo(s, "Deployment");
		at(10, 0);
		await s.call({ action: "slices", slices: squads });
		expect(spawn(s, { agent: "battle-brother", spawnKey: "S1" })?.model).toBe("@smol:medium");
		launched(s, "bb1");
		at(10, 10);
		ended(s, "bb1", "completed");
		at(10, 20);
		const cockpit = join(s.dir, "runs", "sess-0001.cockpit");
		expect(existsSync(cockpit)).toBe(true);
		const out = await s.call({ action: "end", reported: { apothecary: { killed: 5, survived: 1, crashes: 0 }, review: { pass: 2 } } });
		const lines = out.split("\n");
		const file = debriefFile(s.dir);
		expect(file).toMatch(/[\\/]debriefs[\\/]K-1-[0-9a-f]{8}-2026-11-16T10-20-00\.md$/);
		expect(lines).toEqual([
			"ENDED K-1",
			`DEBRIEF ${file}`,
			"TIME 70 min active, 10 min paused: Muster 10, Auspex 10, Scriptorium 25, Deployment 25",
			"SEALS Plan 20m",
			"SPAWNS 3: battle-brother 1, librarian 1, scout 1",
			"COST (agents, list price) ? · battle-brother ?",
		]);
		const markdown = readFileSync(file, "utf8");
		expect(markdown).toBe(
			[
				"# Debrief K-1",
				"",
				"Theatre github · 11-16 09:00 → 11-16 10:20 · plugin numbers are exact except the Model requested column; (reported) sections come from the agents.",
				"",
				"## Time per station",
				"",
				"| Station | Active (min) | Paused (min) |",
				"|---|---|---|",
				"| Muster | 10 | 0 |",
				"| Auspex | 10 | 0 |",
				"| Scriptorium | 25 | 10 |",
				"| Deployment | 25 | 0 |",
				"| Total | 70 | 10 |",
				"",
				"## Seals",
				"",
				"| Seal | Asked | Granted | Wait (min) |",
				"|---|---|---|---|",
				"| Plan | 11-16 09:35 | 11-16 09:55 | 20 |",
				"",
				"## Squads",
				"",
				"| Squad | Tier | Builder runs | Penances | Veteran runs | Last result | State |",
				"|---|---|---|---|---|---|---|",
				"| S1 | light | 1 | 0 | 0 | ok | stopped |",
				"",
				"## Agents spawned",
				"",
				"| Role | Spawns |",
				"|---|---|",
				"| battle-brother | 1 |",
				"| librarian | 1 |",
				"| scout | 1 |",
				"| Total | 3 |",
				"",
				"| Model requested | Spawns |",
				"|---|---|",
				"| @smol | 1 |",
				"| @smol:medium | 1 |",
				"| anthropic/claude-opus-4 | 1 |",
				"| Total | 3 |",
				"",
				"Model requested: the selector Strategium asked of the host; the host may run another.",
				"",
				"## Cost",
				"",
				"Costs are omp's list-price estimates: each agent's own spend as omp prices it (its cost minus its nested subagents', computed as omp's agent view computes it). Tokens include nested subagents'; cost does not. Agents only: the Captain's own session is not included. A subscription plan pays differently. ?: no usage recorded, or a model without a price in omp.",
				"",
				"| Agent | Role | Squad | Tokens in | Tokens out | Cache | Cost |",
				"|---|---|---|---|---|---|---|",
				"| bb1 | battle-brother | S1 | ? | ? | ? | ? |",
				"",
				"| Role | Agents | Cost | Share |",
				"|---|---|---|---|",
				"| battle-brother | 1 | ? |  |",
				"| Total (agents) | 1 | ? | — |",
				"",
				"## Apothecary (reported)",
				"",
				"| Mutants killed | Survivors | Fuzz crashes |",
				"|---|---|---|",
				"| 5 | 1 | 0 |",
				"",
				"## Review (reported)",
				"",
				"| Merge bar PASS | Merge bar FAIL | Findings opened | Fixed | NOT REPRODUCED |",
				"|---|---|---|---|---|",
				"| 2 | — | — | — | — |",
				"",
			].join("\n"),
		);
		// The rows add up to the Total row, and the agents' numbers stay out of the plugin's sections.
		const rows = markdown.split("## Seals")[0].split("\n").filter(l => /^\| \S.* \| \d+ \| \d+ \|$/.test(l) && !l.startsWith("| Station"));
		const cells = (l: string) => l.split("|").slice(2, 4).map(Number);
		const total = rows.find(l => l.startsWith("| Total"))!;
		const body = rows.filter(l => l !== total);
		expect([0, 1].map(i => body.reduce((n, l) => n + cells(l)[i], 0))).toEqual(cells(total));
		expect(markdown.split("## Apothecary (reported)")[0]).not.toMatch(/Survivors|NOT REPRODUCED/);
		expect(existsSync(cockpit)).toBe(false);
		expect(existsSync(join(s.dir, "runs", "sess-0001.json"))).toBe(false);
		expect(events(s.dir).filter(e => e.event === "spawn").map(e => [e.role, e.model, e.tier, e.squad])).toEqual([
			["scout", "@smol", undefined, undefined],
			["librarian", "anthropic/claude-opus-4", undefined, undefined],
			["battle-brother", "@smol:medium", "light", "S1"],
		]);
	});

	// A restart: the session closes at 09:20 and the run comes back at 09:50, or the process dies after its heartbeat at 09:20.
	const restarted = async (crash: boolean) => {
		const s = setup();
		await begun(s);
		todo(s, "Muster");
		at(9, 10);
		todo(s, "Auspex");
		at(9, 20);
		if (crash) writeFileSync(join(s.dir, "runs", "sess-0001.beat"), nowIso());
		else await s.handlers.session_shutdown[0]({}, s.ctx);
		const again = setup("sess-0001", s.dir);
		at(9, 50);
		await again.start();
		at(10, 0);
		return again.call({ action: "end" });
	};
	for (const crash of [false, true])
		test(`(${crash ? "c" : "b"}) a run ${crash ? "that crashed" : "closed with session_shutdown"} still reports the stations before the restart, the gap as paused`, async () => {
			const out = await restarted(crash);
			expect(out).toContain("TIME 30 min active, 30 min paused: Muster 10, Auspex 20");
			const markdown = readFileSync(out.split("\n")[1].slice("DEBRIEF ".length), "utf8");
			expect(markdown).toContain("| Muster | 10 | 0 |\n| Auspex | 20 | 30 |\n| Total | 30 | 30 |");
		});

	test("(d) a blocked spawn adds no spawn event: a battle-brother before the squads, an agent off the roster", async () => {
		const s = setup();
		await begun(s);
		expect(spawn(s, { agent: "battle-brother", spawnKey: "S1" })?.block).toBe(true);
		expect(spawn(s, { agent: "wizard" })?.block).toBe(true);
		expect(events(s.dir).filter(e => e.event === "spawn")).toEqual([]);
		expect(spawn(s, { agent: "scout" })?.block).toBeUndefined();
		expect(events(s.dir).filter(e => e.event === "spawn")).toHaveLength(1);
	});

	test("(e) a debriefs path that cannot be written still ends the run and hands back the markdown", async () => {
		const s = setup();
		await begun(s);
		writeFileSync(join(s.dir, "debriefs"), "in the way");
		const lines = (await s.call({ action: "end" })).split("\n");
		expect(lines[0]).toBe("ENDED K-1");
		expect(lines[1]).toStartWith("DEBRIEF not written: ");
		expect(lines.join("\n")).toContain("# Debrief K-1");
		expect(await s.call({ action: "status" })).not.toContain("RUN K-1");
		expect(s.activeTools()).toContain("edit");
	});

	test("(f) a takeover begin keeps since, and a takeover end writes the debrief of the run it took", async () => {
		const a = setup("sess-0001");
		await begun(a);
		todo(a, "Muster");
		at(9, 30);
		const c = setup("sess-0003", a.dir);
		await c.call({ action: "begin", key: "K-1", theatre: "github", takeover: "sess-0001" });
		const since = () => JSON.parse(readFileSync(join(a.dir, "runs", "sess-0003.json"), "utf8")).since as string;
		expect(since()).toStartWith("2026-11-16T09:00:00");
		at(9, 40);
		await c.call({ action: "begin", key: "K-1", theatre: "github" });
		expect(since()).toStartWith("2026-11-16T09:00:00");

		const b = setup("sess-0004");
		await begun(b);
		todo(b, "Muster");
		at(9, 30);
		const d = setup("sess-0005", b.dir);
		const out = await d.call({ action: "end", key: "K-1", takeover: "sess-0004" });
		expect(out.split("\n").slice(0, 2)).toEqual(["ENDED K-1", `DEBRIEF ${debriefFile(b.dir)}`]);
		expect(readFileSync(debriefFile(b.dir), "utf8")).toContain("| Muster | 0 | 30 |");
	});

	test("(g) a rebuild init appends no station event", async () => {
		const s = setup();
		await begun(s);
		todo(s, "Muster");
		at(9, 10);
		todo(s, "Auspex", { op: "init" });
		expect(events(s.dir).filter(e => e.event === "station").map(e => e.station)).toEqual(["Muster"]);
	});

	test("(h) report lists no key that has only station events", async () => {
		const s = setup();
		at(9, 0);
		append(join(s.dir, "2026-11-16.jsonl"), { ts: nowIso(), event: "station", key: "K-9", station: "Muster" });
		append(join(s.dir, "2026-11-16.jsonl"), { ts: nowIso(), event: "spawn", key: "K-9", role: "scout" });
		expect(await s.call({ action: "report" })).toBe("IDLE");
		await s.call({ action: "begin", key: "K-1" });
		expect(await s.call({ action: "report" })).not.toContain("K-9");
	});

	test("(i) a squad whose builder failed shows failed as its last result, read from the saved cockpit", async () => {
		const s = setup();
		await begun(s);
		await s.call({ action: "slices", slices: squads });
		spawn(s, { agent: "battle-brother", spawnKey: "S1" });
		launched(s, "bb1");
		at(9, 10);
		ended(s, "bb1", "failed");
		const out = await s.call({ action: "end" });
		expect(readFileSync(out.split("\n")[1].slice("DEBRIEF ".length), "utf8")).toContain("| S1 | light | 1 | 0 | 0 | failed | stopped |");
	});

	const summary = (out: string) => out.split("\n").slice(2);
	const mdOf = (out: string) => readFileSync(out.split("\n")[1].slice("DEBRIEF ".length), "utf8");

	test("(j) the squad table counts two builders, the veteran, the running builder and an archmagos spawn that passed its guards", async () => {
		process.env.STRATEGIUM_ARCHMAGOS = "1";
		const s = setup();
		at(9, 0);
		await s.call({ action: "begin", key: "K-1", theatre: "github", archmagos: true });
		await s.call({ action: "repo", repo: s.dir });
		const libs = [{ agent: "librarian" }, { agent: "librarian" }];
		s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: libs }, details: { progress: [{ index: 0, id: "L1", status: "completed" }, { index: 1, id: "L2", status: "completed" }] }, isError: false }, s.ctx));
		expect(spawn(s, { agent: "archmagos" })?.block).toBeUndefined();
		await s.call({ action: "slices", slices: squads });
		spawn(s, { agent: "battle-brother", spawnKey: "S1" });
		spawn(s, { agent: "battle-brother", spawnKey: "S1" });
		spawn(s, { agent: "veteran", spawnKey: "S1" });
		launched(s, "bb1");
		ended(s, "bb1", "completed");
		launched(s, "bb2");
		// Both lists name S1 (a stale stop mark next to a live builder): the running builder wins.
		const runFile = join(s.dir, "runs", "sess-0001.json");
		writeFileSync(runFile, JSON.stringify({ ...JSON.parse(readFileSync(runFile, "utf8")), stopped: squads }));
		at(9, 30);
		const out = await s.call({ action: "end" });
		expect(mdOf(out)).toContain("| S1 | light→standard→heavy | 2 | 1 | 1 | ok | running |");
		expect(summary(out).slice(-2)).toEqual(["SPAWNS 4: battle-brother 2, archmagos 1, veteran 1", "COST (agents, list price) ? · battle-brother ?"]);
	});

	test("(k) a run across midnight counts the events of both days", async () => {
		const s = setup();
		setSystemTime(new Date(2026, 10, 16, 23, 50, 0));
		await s.call({ action: "begin", key: "K-1", theatre: "github" });
		spawn(s, { agent: "scout" });
		setSystemTime(new Date(2026, 10, 17, 0, 10, 0));
		spawn(s, { agent: "scout" });
		setSystemTime(new Date(2026, 10, 17, 0, 20, 0));
		const out = await s.call({ action: "end" });
		expect(summary(out)).toEqual(["TIME 30 min active, 0 min paused: (before the todo) 30", "SEALS none", "SPAWNS 2: scout 2", "COST none"]);
		expect(mdOf(out)).toContain("11-16 23:50 → 11-17 00:20");
	});

	test("(l) a previous run of the same key, ended earlier the same day, is not counted", async () => {
		const s = setup();
		at(9, 0);
		await s.call({ action: "begin", key: "K-1", theatre: "github" });
		spawn(s, { agent: "scout" });
		at(9, 30);
		await s.call({ action: "end" });
		at(10, 0);
		await s.call({ action: "begin", key: "K-1", theatre: "github" });
		spawn(s, { agent: "librarian" });
		at(10, 30);
		const out = await s.call({ action: "end" });
		expect(summary(out)).toEqual(["TIME 30 min active, 0 min paused: (before the todo) 30", "SEALS none", "SPAWNS 1: librarian 1", "COST none"]);
	});

	test("(m) a squad id longer than a table cell still counts its builder, and a spawnKey of no squad stores none", async () => {
		const s = setup();
		await begun(s);
		const id = `S${"x".repeat(80)}`;
		await s.call({ action: "slices", slices: [{ id, parallel: false, files: ["a.ts"], tier: "light" }] });
		spawn(s, { agent: "battle-brother", spawnKey: id });
		spawn(s, { agent: "battle-brother", spawnKey: "nothing-like-it" });
		expect(events(s.dir).filter(e => e.event === "spawn").map(e => e.squad)).toEqual([id, undefined]);
		at(9, 10);
		expect(mdOf(await s.call({ action: "end" }))).toContain(`| ${id.slice(0, 60)} | light | 1 | 0 | 0 | ok | not built |`);
	});

	test("(n) a run stopped before end has no pause tail", async () => {
		const s = setup();
		await begun(s);
		at(9, 10);
		await s.call({ action: "stop" });
		at(9, 40);
		const out = await s.call({ action: "end" });
		expect(summary(out)[0]).toBe("TIME 10 min active, 0 min paused: (before the todo) 10");
		expect(mdOf(out)).toContain("→ 11-16 09:10");
	});

	test("(o) after a redraft a reused squad id counts only its new builds, the spawn totals keep all", async () => {
		const s = setup();
		await begun(s);
		await s.call({ action: "slices", slices: squads });
		spawn(s, { agent: "battle-brother", spawnKey: "S1" });
		at(9, 10);
		await s.call({ action: "redraft" });
		expect(events(s.dir).filter(e => e.event === "redraft")).toHaveLength(1);
		at(9, 20);
		spawn(s, { agent: "battle-brother", spawnKey: "S1" });
		at(9, 30);
		const out = await s.call({ action: "end" });
		expect(mdOf(out)).toContain("| S1 | light | 1 | 0 | 0 | ok | not built |");
		expect(mdOf(out)).toContain("| (before redraft) | light | 1 | 0 | 0 | — | — |");
		expect(mdOf(out)).not.toContain("(unmatched)");
		expect(summary(out).slice(-2)).toEqual(["SPAWNS 2: battle-brother 2", "COST none"]);
	});

	test("(p) the last result comes from the cockpit in memory when the saved file is behind", async () => {
		const s = setup();
		await begun(s);
		await s.call({ action: "slices", slices: squads });
		spawn(s, { agent: "battle-brother", spawnKey: "S1" });
		// The file cannot be rewritten: only memory knows the builder failed.
		const file = join(s.dir, "runs", "sess-0001.cockpit");
		rmSync(file, { force: true });
		mkdirSync(file);
		launched(s, "bb1");
		at(9, 10);
		ended(s, "bb1", "failed");
		expect(mdOf(await s.call({ action: "end" }))).toContain("| S1 | light | 1 | 0 | 0 | failed | stopped |");
	});

	test("a takeover end reports the saved cockpit, not the notes of the ending session's own cockpit", async () => {
		const a = setup("sess-0001");
		await begun(a);
		await a.call({ action: "slices", slices: squads });
		spawn(a, { agent: "battle-brother", spawnKey: "S1" });
		launched(a, "bb1");
		at(9, 10);
		ended(a, "bb1", "failed");
		// Session B runs another key with its own cockpit, then takes K-1 over.
		const b = setup("sess-0002", a.dir);
		await b.call({ action: "begin", key: "K-2", theatre: "github" });
		await b.call({ action: "slices", slices: squads });
		spawn(b, { agent: "battle-brother", spawnKey: "S1" });
		launched(b, "bb9");
		ended(b, "bb9", "completed");
		expect(mdOf(await b.call({ action: "end", key: "K-1", takeover: "sess-0001" }))).toContain("| S1 | light | 1 | 0 | 0 | failed | stopped |");
	});
});

describe("agent names (#133)", () => {
	type S = ReturnType<typeof setup>;
	type Verdict = { block?: true; reason?: string; model?: string; note?: string } | undefined;
	const SQUADS = [
		{ id: "S1", parallel: true, files: ["a.ts"], tier: "light" },
		{ id: "S2", parallel: true, files: ["b.ts"] },
		{ id: "S3", parallel: false, files: ["c.ts"] },
	];
	const open = async (on = true, repo = true) => {
		if (on) process.env.STRATEGIUM_NAMES = "1";
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		if (repo) await s.call({ action: "repo", repo: s.dir });
		await s.call({ action: "slices", slices: SQUADS });
		return s;
	};
	const nameOf = async (s: S, params: Record<string, unknown>) => {
		const out = await s.call({ action: "name", ...params });
		expect(out).toMatch(/^NAME \S+$/);
		return out.slice(5);
	};
	const spawn = (s: S, agent: string, spawnKey?: string, extra: object = {}) => s.handlers.before_subagent_spawn[0]({ agent, spawnKey, ...extra }, s.ctx) as Verdict;
	const task = (s: S, items: object[]) => s.handlers.tool_call[0]({ toolName: "task", input: { tasks: items } }, s.ctx) as Verdict;
	const item = (agent: string, name?: string, extra: object = {}) => ({ agent, name, task: "do the work", ...extra });
	const saved = (s: S) => JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8")) as { names?: Record<string, unknown>[]; agents?: Record<string, { id: string }>; builds?: Record<string, number> };
	const GUARD = "strategium action name";

	describe("names off (the default)", () => {
		test("name is an ERROR naming the setting, slices has no NAMES line, and no names are written", async () => {
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			await s.call({ action: "repo", repo: s.dir });
			expect(await s.call({ action: "name", agent: "scout" })).toBe("ERROR names are off: /strategium-config names on or STRATEGIUM_NAMES=1");
			expect(await s.call({ action: "slices", slices: SQUADS })).toBe("SQUADS S1 (parallel, light), S2 (parallel), S3");
			expect(saved(s).names).toBeUndefined();
		});

		test("nothing is refused: a squad-id name and an unnamed item pass, and so does an unlabelled eval spawn", async () => {
			const s = await open(false);
			expect(task(s, [item("battle-brother", "S1", { isolated: true }), item("battle-brother", "S2", { isolated: true }), item("scout")])).toBeUndefined();
			expect(spawn(s, "battle-brother", "S1")?.block).toBeUndefined();
			expect(spawn(s, "apothecary", "whatever", { invocationKind: "eval" })?.block).toBeUndefined();
			expect(saved(s).names).toBeUndefined();
		});
	});

	describe("allocation through the action", () => {
		test("Brother, then Penitent after its spawn, then Veteran: one surname, and the run file keeps them", async () => {
			const s = await open();
			const brother = await nameOf(s, { agent: "battle-brother", squad: "S1" });
			expect(brother).toMatch(/^Brother[A-Z][a-z]+$/);
			expect(await nameOf(s, { agent: "battle-brother", squad: "S1" })).toBe(brother);
			expect(spawn(s, "battle-brother", brother)?.block).toBeUndefined();
			const surname = brother.slice("Brother".length);
			expect(await nameOf(s, { agent: "battle-brother", squad: "S1" })).toBe(`Penitent${surname}`);
			expect(await nameOf(s, { agent: "veteran", squad: "S1" })).toBe(`Veteran${surname}`);
			expect(saved(s).names?.[0]).toMatchObject({ name: brother, agent: "battle-brother", squad: "S1", spawned: true });
		});

		test("each role has its title, with Interrogator, Adept and the Servitor designation", async () => {
			const s = await open();
			const titles: [string, RegExp][] = [
				["librarian", /^Librarian[A-Z]/],
				["archmagos", /^Archmagos[A-Z]/],
				["scout", /^Scout[A-Z]/],
				["inquisitor", /^Inquisitor[A-Z]/],
				["confessor", /^Confessor[A-Z]/],
				["apothecary", /^Apothecary[A-Z]/],
				["security-reviewer", /^Interrogator[A-Z]/],
				["task", /^Adept[A-Z]/],
				["sonic", /^Servitor[A-Z]{2}[1-9][0-9]?$/],
			];
			for (const [agent, re] of titles) expect(await nameOf(s, { agent })).toMatch(re);
		});

		test("30 calls: no duplicate, every name <= 28, and no digit except in a servitor", async () => {
			const s = await open();
			const agents = ["scout", "librarian", "sonic", "task", "inquisitor", "confessor"];
			const all: string[] = [];
			for (let i = 0; i < 30; i++) all.push(await nameOf(s, { agent: agents[i % agents.length] }));
			expect(new Set(all).size).toBe(30);
			for (const n of all) {
				expect(n.length).toBeLessThanOrEqual(28);
				if (!n.startsWith("Servitor")) expect(n).not.toMatch(/\d/);
			}
		});

		test("three parallel calls hand out three distinct names", async () => {
			const s = await open();
			const got = await Promise.all([1, 2, 3].map(() => nameOf(s, { agent: "scout" })));
			expect(new Set(got).size).toBe(3);
			expect(saved(s).names?.filter(e => e.agent === "scout").length).toBe(3);
		});

		test("a later run of the same session never gets a name an earlier one issued", async () => {
			const s = await open();
			const first = await Promise.all(Array.from({ length: 3 }, () => nameOf(s, { agent: "archmagos" })));
			await s.call({ action: "end" });
			await s.call({ action: "begin", key: "K-2" });
			const second = await Promise.all(Array.from({ length: 3 }, () => nameOf(s, { agent: "archmagos" })));
			for (const n of second) expect(first).not.toContain(n);
		});

		test("errors: no agent, a builder without a declared squad, again with no earlier name", async () => {
			const s = await open();
			const before = saved(s).names?.length;
			expect(await s.call({ action: "name" })).toStartWith("ERROR");
			expect(await s.call({ action: "name", agent: "battle-brother", squad: "nope" })).toStartWith("ERROR");
			expect(await s.call({ action: "name", agent: "battle-brother" })).toStartWith("ERROR");
			expect(await s.call({ action: "name", agent: "scout", again: true })).toStartWith("ERROR");
			expect(saved(s).names?.length).toBe(before);
		});

		test("again keeps the persona once the name has spawned", async () => {
			const s = await open();
			const first = await nameOf(s, { agent: "inquisitor" });
			expect(await nameOf(s, { agent: "inquisitor", again: true })).toBe(first);
			spawn(s, "inquisitor", first);
			const next = await nameOf(s, { agent: "inquisitor", again: true });
			expect(next).not.toBe(first);
			expect(next).toStartWith(first);
		});
	});

	describe("slices NAMES line", () => {
		test("one name per live parallel squad, stable while unspawned, skipped once that squad's Brother has spawned", async () => {
			const s = await open();
			const names = (out: string) => out.split("\n").find(l => l.startsWith("NAMES "));
			const out = await s.call({ action: "slices", slices: SQUADS });
			expect(out.split("\n")[0]).toBe("SQUADS S1 (parallel, light), S2 (parallel), S3");
			const line = names(out)!;
			expect(line).toMatch(/^NAMES S1=Brother[A-Z][a-z]+, S2=Brother[A-Z][a-z]+$/);
			expect(names(await s.call({ action: "slices", slices: SQUADS }))).toBe(line);
			const s1 = line.match(/S1=(\w+)/)![1];
			spawn(s, "battle-brother", s1);
			expect(names(await s.call({ action: "slices", slices: SQUADS }))).toMatch(/^NAMES S2=Brother[A-Z][a-z]+$/);
		});

		test("a refused squad list writes no names", async () => {
			const s = await open();
			const before = saved(s).names;
			await s.call({ action: "slices", slices: [{ id: "A", parallel: true, files: ["x"] }, { id: "B", parallel: true, files: ["x"] }] });
			expect(saved(s).names).toEqual(before);
		});
	});

	describe("the guard (names on)", () => {
		test("handed-out names pass, with or without a repo", async () => {
			for (const repo of [true, false]) {
				const s = await open(true, repo);
				const a = await nameOf(s, { agent: "scout" });
				const b = await nameOf(s, { agent: "battle-brother", squad: "S1" });
				const c = await nameOf(s, { agent: "battle-brother", squad: "S2" });
				expect(task(s, [item("scout", a), item("battle-brother", b, { isolated: true }), item("battle-brother", c, { isolated: true })])).toBeUndefined();
			}
		});

		test("a missing, foreign, wrong-agent, already-spawned or duplicate name refuses the whole call, naming the action", async () => {
			const s = await open();
			const scout = await nameOf(s, { agent: "scout" });
			const other = await nameOf(s, { agent: "scout" });
			const lib = await nameOf(s, { agent: "librarian" });
			spawn(s, "scout", other);
			const refused: [string, object[]][] = [
				["missing", [item("scout")]],
				["blank", [item("scout", "  ")]],
				["foreign", [item("scout", "Whoever")]],
				["wrong agent", [item("scout", lib)]],
				["already spawned", [item("scout", other)]],
				["duplicate", [item("scout", scout), item("scout", scout)]],
				["one bad item in a good call", [item("librarian", lib), item("scout", "Nope")]],
				["an item without agent is a task", [{ name: scout, task: "x" }]],
			];
			for (const [why, items] of refused) {
				const v = task(s, items);
				expect([why, v?.block]).toEqual([why, true]);
				expect(v?.reason).toContain(GUARD);
				expect(v?.reason).toEndWith("call strategium action name");
			}
		});

		test("a builder's refusal reason asks for its squad too", async () => {
			const s = await open();
			expect(task(s, [item("battle-brother", "S1", { isolated: true })])?.reason).toContain("squad");
		});

		test("an eval spawn needs a handed-out label (the suffix omp adds is ignored) and spawns once", async () => {
			const s = await open();
			const evalSpawn = (key?: string) => spawn(s, "apothecary", key, { invocationKind: "eval" });
			expect(evalSpawn("Nobody")?.reason).toContain(GUARD);
			expect(evalSpawn(undefined)?.block).toBe(true);
			const name = await nameOf(s, { agent: "apothecary" });
			expect(evalSpawn(`${name}-2`)?.block).toBeUndefined();
			expect(evalSpawn(name)?.reason).toContain(GUARD);
		});

		test("an eval spawn refused for a missing or unknown label says how to pass the label", async () => {
			const s = await open();
			for (const key of [undefined, "Nobody"]) expect(spawn(s, "apothecary", key, { invocationKind: "eval" })?.reason).toEndWith("(pass label=<name> from strategium action name)");
		});

		test("a builder name a redraft retired is refused even if it never spawned", async () => {
			const s = await open();
			const old = await nameOf(s, { agent: "battle-brother", squad: "S1" });
			await s.call({ action: "redraft" });
			await s.call({ action: "slices", slices: SQUADS });
			expect(task(s, [item("battle-brother", old, { isolated: true })])?.reason).toContain(`has the name ${old}, which a redraft retired`);
		});

		test("a spawned archmagos is marked spawned and name archmagos again hands out another name", async () => {
			process.env.STRATEGIUM_ARCHMAGOS = "1";
			process.env.STRATEGIUM_NAMES = "1";
			const s = setup();
			await s.call({ action: "begin", key: "K-1", archmagos: true });
			await s.call({ action: "repo", repo: s.dir });
			const name = await nameOf(s, { agent: "archmagos" });
			const file = join(s.dir, "runs", "sess-0001.json");
			writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), librarians: { a: "done", b: "done" } }));
			const r = setup("sess-0001", s.dir);
			expect(r.handlers.before_subagent_spawn[0]({ agent: "archmagos", spawnKey: name, invocationKind: "eval" }, r.ctx)).toBeUndefined();
			expect(saved(r).names?.find(e => e.name === name)?.spawned).toBe(true);
			expect(await nameOf(r, { agent: "archmagos", again: true })).not.toBe(name);
		});

		test("the Brother names slices issued in one run are not reused in the next run of the session", async () => {
			const random = spyOn(Math, "random").mockReturnValue(0); // a fixed draw: only the issued set keeps run 2's names apart
			try {
				const s = await open();
				const first = (saved(s).names ?? []).map(e => e.name);
				expect(first.length).toBeGreaterThan(0);
				await s.call({ action: "end", key: "K-1" });
				await s.call({ action: "begin", key: "K-2" });
				await s.call({ action: "repo", repo: s.dir });
				await s.call({ action: "slices", slices: SQUADS });
				const second = (JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8")).names ?? []).map((e: { name: string }) => e.name);
				expect(second.length).toBe(first.length);
				for (const n of second) expect(first).not.toContain(n);
			} finally {
				random.mockRestore();
			}
		});

		test("a scout named once cannot be spawned twice across two task calls", async () => {
			const s = await open();
			const name = await nameOf(s, { agent: "scout" });
			expect(spawn(s, "scout", name)?.block).toBeUndefined();
			expect(spawn(s, "scout", `${name}-2`)?.reason).toContain(`has the name ${name}, which has already spawned`);
		});

		test("a veteran named once cannot be spawned twice", async () => {
			const s = await open();
			const name = await nameOf(s, { agent: "veteran", squad: "S1" });
			expect(spawn(s, "veteran", name)?.block).toBeUndefined();
			expect(spawn(s, "veteran", `${name}-2`)?.reason).toContain(`has the name ${name}, which has already spawned`);
		});

		test("the name action takes a qualified agent such as strategium:scout", async () => {
			const s = await open();
			expect(await nameOf(s, { agent: "strategium:scout" })).toMatch(/^Scout[A-Z]/);
		});

		test("a spawn marks only a name handed out for that agent", async () => {
			const s = await open();
			const brother = await nameOf(s, { agent: "battle-brother", squad: "S1" });
			spawn(s, "scout", brother); // a task spawn: the tool_call guard is not in play, so only markSpawned's agent check protects the name
			expect(saved(s).names?.find(e => e.name === brother)?.spawned).toBeUndefined();
		});

		test("a builder whose squad is no longer declared is still marked spawned", async () => {
			const s = await open();
			const name = await nameOf(s, { agent: "battle-brother", squad: "S1" });
			await s.call({ action: "slices", slices: [{ id: "S2", parallel: true, files: ["b.ts"] }] });
			expect(spawn(s, "battle-brother", name)?.block).toBeUndefined();
			expect(saved(s).names?.find(e => e.name === name)?.spawned).toBe(true);
		});

		test("slices lists the new Brother of a squad after a redraft", async () => {
			const s = await open();
			await s.call({ action: "redraft" });
			const out = await s.call({ action: "slices", slices: SQUADS });
			const fresh = saved(s).names?.find(e => e.squad === "S1" && !e.old)?.name;
			expect(fresh).toStartWith("Brother");
			expect(out).toMatch(new RegExp(`^NAMES .*S1=${fresh}`, "m"));
		});

		test("a role named before a redraft still passes the guard after it", async () => {
			const s = await open();
			const scout = await nameOf(s, { agent: "scout" });
			await s.call({ action: "redraft" });
			expect(task(s, [item("scout", scout)])).toBeUndefined();
		});

		test("an agent outside the roster is left to the spawn hook, not the name check", async () => {
			const s = await open();
			expect(task(s, [item("not-in-roster")])).toBeUndefined();
			expect(spawn(s, "not-in-roster")?.reason).toContain("only these agents may be spawned");
		});

		test("every roster agent can be named, and nothing else", () => {
			expect([...NAMED_AGENTS].sort()).toEqual([...ROSTER].sort());
		});

		test("two separate task spawns of one builder name cannot both spawn it", async () => {
			const s = await open();
			const name = await nameOf(s, { agent: "battle-brother", squad: "S1" });
			expect(spawn(s, "battle-brother", name)?.block).toBeUndefined();
			expect(spawn(s, "battle-brother", `${name}-2`)?.reason).toContain(`has the name ${name}, which has already spawned`);
		});

		test("a refused spawn leaves its name unspent", async () => {
			const s = await open();
			const name = await nameOf(s, { agent: "archmagos" });
			expect(spawn(s, "archmagos", name)?.block).toBe(true); // the archmagos is off in this session
			expect(saved(s).names?.[0]?.spawned).toBeUndefined();
			expect(await nameOf(s, { agent: "archmagos", again: true })).toBe(name);
		});
	});

	describe("storage across a restart", () => {
		test("the same names, the same surname continued, and the guard still accepts a handed-out name", async () => {
			const s = await open();
			const brother = await nameOf(s, { agent: "battle-brother", squad: "S1" });
			const scout = await nameOf(s, { agent: "scout" });
			spawn(s, "battle-brother", brother);
			const r = setup("sess-0001", s.dir);
			expect(saved(s).names?.map(e => e.name)).toEqual(expect.arrayContaining([brother, scout]));
			expect(r.handlers.tool_call[0]({ toolName: "task", input: { tasks: [item("scout", scout)] } }, r.ctx)).toBeUndefined();
			expect(r.handlers.tool_call[0]({ toolName: "task", input: { tasks: [item("scout", "Stranger")] } }, r.ctx)).toMatchObject({ block: true });
			expect(await r.call({ action: "name", agent: "battle-brother", squad: "S1" })).toBe(`NAME Penitent${brother.slice("Brother".length)}`);
		});

		test("malformed entries in the run file are dropped when it is read", async () => {
			const s = await open();
			const good = await nameOf(s, { agent: "scout" });
			const file = join(s.dir, "runs", "sess-0001.json");
			const run = JSON.parse(readFileSync(file, "utf8"));
			const before = run.names.length;
			run.names.push({ name: "bad name!", agent: "scout", surname: "x" }, { name: 7 }, null, { name: "TooLong".repeat(6), agent: "scout", surname: "x" }, { name: "Ghost", agent: "nobody", surname: "x" }, { name: good, agent: "scout", surname: "dup" });
			writeFileSync(file, JSON.stringify(run));
			const r = setup("sess-0001", s.dir);
			const call = (name: string) => r.handlers.tool_call[0]({ toolName: "task", input: { tasks: [item("scout", name)] } }, r.ctx) as Verdict;
			expect(call(good)).toBeUndefined();
			for (const bad of ["bad name!", "Ghost", "TooLong".repeat(6)]) expect(call(bad)?.block).toBe(true);
			expect(await r.call({ action: "name", agent: "scout" })).toMatch(/^NAME /);
			const kept = saved(r).names?.map(e => e.name);
			expect(kept).toContain(good);
			expect(kept?.length).toBe(before + 1); // the entries that were there, plus the scout just named
		});

		test("a run file whose names is not a list reads as no names", async () => {
			const s = await open();
			const file = join(s.dir, "runs", "sess-0001.json");
			writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), names: "oops" }));
			const r = setup("sess-0001", s.dir);
			expect(await r.call({ action: "name", agent: "scout" })).toMatch(/^NAME /);
		});
	});

	describe("mapping a builder to its squad through its name", () => {
		const launch = (s: S, items: object[], ids: string[]) =>
			s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: items }, details: { progress: ids.map((id, index) => ({ index, id, status: "running" })) }, isError: false }, s.ctx));

		test("a tool_result binds each agent id to its squad, with a brief that never says build squad", async () => {
			const s = await open();
			const one = await nameOf(s, { agent: "battle-brother", squad: "S1" });
			const two = await nameOf(s, { agent: "battle-brother", squad: "S2" });
			const items = [item("battle-brother", one, { isolated: true }), item("battle-brother", two, { isolated: true })];
			expect(task(s, items)).toBeUndefined();
			launch(s, items, ["bb-1", "bb-2"]);
			expect([saved(s).agents?.["bb-1"]?.id, saved(s).agents?.["bb-2"]?.id]).toEqual(["S1", "S2"]);
		});

		test("the tier hook finds the squad by the name, suffix included, and the ladder climbs", async () => {
			const s = await open();
			const name = await nameOf(s, { agent: "battle-brother", squad: "S1" });
			expect(spawn(s, "battle-brother", name)).toEqual({ model: "@smol:medium", note: "Strategium tier light" });
			const next = await nameOf(s, { agent: "battle-brother", squad: "S1" });
			expect(spawn(s, "battle-brother", `${next}-2`)?.model).toBe("@task:medium");
			expect(saved(s).builds).toEqual({ S1: 2 });
		});

		test("the spawned mark and builds are written together", async () => {
			const s = await open();
			const name = await nameOf(s, { agent: "battle-brother", squad: "S1" });
			spawn(s, "battle-brother", name);
			expect(saved(s).builds).toEqual({ S1: 1 });
			expect(saved(s).names?.[0]?.spawned).toBe(true);
		});

		test("a veteran named for S2 runs heavy and records its squad", async () => {
			const s = await open();
			const name = await nameOf(s, { agent: "veteran", squad: "S2" });
			expect(spawn(s, "veteran", name)?.model).toBe("@slow:high");
			expect(saved(s).names?.find(e => e.name === name)?.spawned).toBe(true);
		});

		test("after a redraft the same squad id gets a new surname and is a Brother again", async () => {
			const s = await open();
			const old = await nameOf(s, { agent: "battle-brother", squad: "S1" });
			spawn(s, "battle-brother", old);
			await s.call({ action: "redraft" });
			expect(saved(s).names?.[0]?.old).toBe(true);
			await s.call({ action: "slices", slices: SQUADS });
			const fresh = await nameOf(s, { agent: "battle-brother", squad: "S1" });
			expect(fresh).toStartWith("Brother");
			expect(fresh.slice("Brother".length)).not.toBe(old.slice("Brother".length));
		});
	});

	describe("the setting", () => {
		const line = async (s: S) => (await s.call({ action: "status" })).split("\n").find(l => l.startsWith("NAMES "));

		test("status shows NAMES off (default)", async () => {
			const s = setup();
			expect(await line(s)).toBe("NAMES off (default)");
		});

		test("names on|off saves the choice and applies at once; default drops the file", async () => {
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			await s.sub("config", "names on");
			expect(readFileSync(join(s.dir, "names"), "utf8")).toBe("on");
			expect(s.notes.at(-1)).toContain("names: on (/strategium-config)");
			expect(await line(s)).toBe("NAMES on (/strategium-config)");
			expect(await s.call({ action: "name", agent: "scout" })).toMatch(/^NAME Scout/);
			await s.sub("config", "names off");
			expect(readFileSync(join(s.dir, "names"), "utf8")).toBe("off");
			expect(await s.call({ action: "name", agent: "scout" })).toStartWith("ERROR names are off");
			await s.sub("config", "names default");
			expect(existsSync(join(s.dir, "names"))).toBe(false);
			expect(s.notes.at(-1)).toContain("names: off (default)");
		});

		test("STRATEGIUM_NAMES picks it (1/0), other values are ignored, and a saved choice wins", async () => {
			process.env.STRATEGIUM_NAMES = "1";
			const s = setup();
			expect(await line(s)).toBe("NAMES on (STRATEGIUM_NAMES)");
			await s.sub("config", "names off");
			expect(await line(s)).toBe("NAMES off (/strategium-config)");
			process.env.STRATEGIUM_NAMES = "yes";
			await s.sub("config", "names default");
			expect(await line(s)).toBe("NAMES off (default)");
		});

		test("a bad names argument is refused and writes no file", async () => {
			const s = setup();
			for (const bad of ["names maybe", "names ON", "names"]) {
				await s.sub("config", bad);
				expect(s.notes.at(-1)).toContain("config takes");
			}
			expect(existsSync(join(s.dir, "names"))).toBe(false);
		});
	});
});

// The service record (#134): what a squad's builders did goes in the run file, and `end` folds it into the shared roster.
describe("service record (#134)", () => {
	type S = ReturnType<typeof setup>;
	type Counters = { passed: number; penances: number; falls: number; squads: number; purity: number; halo: number; laurel: number };
	const SQ = [
		{ id: "S1", parallel: true, files: ["a.ts"] },
		{ id: "S2", parallel: true, files: ["b.ts"] },
		{ id: "S3", parallel: false, files: ["c.ts"] },
	];
	const svc = (o: Partial<Counters> = {}): Counters => ({ passed: 0, penances: 0, falls: 0, squads: 0, purity: 0, halo: 0, laurel: 0, ...o });
	const seed = (dir: string, brothers: object) => writeFileSync(join(dir, "roster.json"), JSON.stringify({ version: 1, brothers }));
	const roster = (dir: string) => JSON.parse(readFileSync(join(dir, "roster.json"), "utf8")).brothers as Record<string, Counters>;
	// Names on, a run with the three squads declared; `brothers` seeds the roster before the squads get their names.
	const open = async (o: { sid?: string; dir?: string; key?: string; brothers?: object; raw?: string } = {}) => {
		process.env.STRATEGIUM_NAMES = "1";
		const dir = o.dir ?? mkdtempSync(join(tmpdir(), "st-roster-"));
		if (!o.dir) dirs.push(dir);
		if (o.brothers) seed(dir, o.brothers);
		if (o.raw !== undefined) writeFileSync(join(dir, "roster.json"), o.raw);
		const s = setup(o.sid ?? "sess-0001", dir);
		await s.call({ action: "begin", key: o.key ?? "K-1" });
		await s.call({ action: "repo", repo: dir });
		const slices = await s.call({ action: "slices", slices: SQ });
		return { ...s, slices };
	};
	type Opened = Awaited<ReturnType<typeof open>>;
	const surname = (name: string) => name.replace(/^(Brother|Penitent|Veteran)/, "");
	const lastLine = (out: string) => out.split("\n").at(-1)!;
	const nameFor = async (s: S, agent: string, squad: string) => lastLine(await s.call({ action: "name", agent, squad })).slice(5);
	const spawn = (s: S, agent: string, spawnKey: string) => s.handlers.before_subagent_spawn[0]({ agent, spawnKey }, s.ctx);
	// The task call's result: `status` running is a background builder, anything else a blocking one that returned.
	const returned = (s: S, agent: string, name: string, squad: string, status: string) => {
		const event = { toolName: "task", input: { tasks: [{ agent, name, task: `build squad ${squad}` }] }, details: { progress: [{ index: 0, id: name, status }] }, isError: false };
		for (const h of s.handlers.tool_result) h(event, s.ctx);
	};
	// One builder of `squad` is named, spawned and returns with `status`.
	const build = async (s: S, squad: string, status = "completed", agent = "battle-brother") => {
		const name = await nameFor(s, agent, squad);
		spawn(s, agent, name);
		returned(s, agent, name, squad, status);
		return name;
	};
	const bash = (s: S, command: string, extra: object = {}, ctx: object = s.ctx) => {
		for (const h of s.handlers.tool_result) h({ toolName: "bash", input: { command }, isError: false, details: {}, ...extra }, ctx);
	};
	const merge = (s: S, extra: object = {}, ctx: object = s.ctx) => bash(s, "gh pr merge 7 --merge --delete-branch", extra, ctx);
	const runFile = (s: S, sid = "sess-0001") => JSON.parse(readFileSync(join(s.dir, "runs", `${sid}.json`), "utf8")) as { ended?: Record<string, string>; merged?: unknown; names?: { surname: string; squad?: string; old?: true }[] };
	const edit = (s: S, change: (run: Record<string, unknown>) => void) => {
		const file = join(s.dir, "runs", "sess-0001.json");
		const run = JSON.parse(readFileSync(file, "utf8"));
		change(run);
		writeFileSync(file, JSON.stringify(run));
	};

	describe("record events", () => {
		test("a squad that passes on its first build earns a Purity Seal", async () => {
			const s = await open();
			const name = await build(s, "S1");
			expect(runFile(s).ended).toEqual({ S1: "ok" });
			expect(await s.call({ action: "end" })).toEndWith("ROSTER 1 squad(s) recorded");
			expect(roster(s.dir)[surname(name)]).toEqual(svc({ passed: 1, squads: 1, purity: 1 }));
		});

		test("a pass after a failed first build is one penance and no honour; a new builder clears the failure", async () => {
			const s = await open();
			const first = await build(s, "S1", "failed");
			expect(runFile(s).ended).toEqual({ S1: "failed" });
			const again = await nameFor(s, "battle-brother", "S1");
			expect(again).toBe(`Penitent${surname(first)}`);
			spawn(s, "battle-brother", again);
			expect(runFile(s).ended).toBeUndefined();
			returned(s, "battle-brother", again, "S1", "completed");
			await s.call({ action: "end" });
			expect(roster(s.dir)[surname(first)]).toEqual(svc({ passed: 1, penances: 1, squads: 1 }));
		});

		test("a builder still running at end leaves no outcome and no roster file", async () => {
			const s = await open();
			const name = await build(s, "S1", "running");
			expect(runFile(s).ended).toBeUndefined();
			expect(await s.call({ action: "end" })).not.toContain("ROSTER");
			expect(existsSync(join(s.dir, "roster.json"))).toBe(false);
		});

		test("a background builder's end comes through the context message", async () => {
			const s = await open();
			const name = await build(s, "S1", "running");
			const job = (status: string) => ({ type: "context", messages: [{ role: "custom", details: { jobs: [{ jobId: "j1", type: "task", status, label: name }] } }] });
			for (const h of s.handlers.context) h(job("failed"), s.ctx);
			expect(runFile(s).ended).toEqual({ S1: "failed" });
		});

		test("a veteran that saves the squad is worth two passes and an Iron Halo", async () => {
			const s = await open();
			const first = await build(s, "S1", "failed");
			await build(s, "S1", "completed", "veteran");
			await s.call({ action: "end" });
			expect(roster(s.dir)[surname(first)]).toEqual(svc({ passed: 2, squads: 1, halo: 1 }));
		});

		test("a veteran that fails leaves the squad fallen", async () => {
			const s = await open();
			const first = await build(s, "S1", "failed");
			await build(s, "S1", "failed", "veteran");
			await s.call({ action: "end" });
			expect(roster(s.dir)[surname(first)]).toEqual(svc({ falls: 1, squads: 1 }));
		});

		test("a redraft forgets the squads' outcomes: retired brothers earn no record", async () => {
			const s = await open();
			await build(s, "S2");
			await s.call({ action: "redraft" });
			expect(runFile(s).ended).toBeUndefined();
			expect(await s.call({ action: "end" })).not.toContain("ROSTER");
			expect(existsSync(join(s.dir, "roster.json"))).toBe(false);
		});

		test("a merge by the Captain's gh pr merge crowns every brother when all passed first", async () => {
			const s = await open();
			const a = await build(s, "S1");
			const b = await build(s, "S2");
			merge(s);
			expect(runFile(s).merged).toBe(true);
			await s.call({ action: "end" });
			expect(roster(s.dir)[surname(a)].laurel).toBe(1);
			expect(roster(s.dir)[surname(b)].laurel).toBe(1);
		});

		test("glab mr merge counts too", async () => {
			const s = await open();
			const a = await build(s, "S1");
			bash(s, "glab mr merge 3 --yes");
			await s.call({ action: "end" });
			expect(roster(s.dir)[surname(a)].laurel).toBe(1);
		});

		test("no Laurel when one squad needed a penance", async () => {
			const s = await open();
			const a = await build(s, "S1");
			await build(s, "S2", "failed");
			await build(s, "S2");
			merge(s);
			await s.call({ action: "end" });
			expect(roster(s.dir)[surname(a)].laurel).toBe(0);
		});

		test("no Laurel without a merge, or when the merge failed, was a subagent's or only started in the background", async () => {
			const sub = { ...({} as object), agent: { kind: "sub", id: "x" } };
			const cases: [string, (s: Opened) => void][] = [
				["no merge", () => {}],
				["another command", s => bash(s, "gh pr view 7")],
				["isError", s => merge(s, { isError: true })],
				["exit code", s => merge(s, { details: { exitCode: 1 } })],
				["async", s => bash(s, "gh pr merge 7", { input: { command: "gh pr merge 7", async: true } })],
				["background by the host", s => merge(s, { details: { async: { state: "running", jobId: "bg_1" } } })],
				["subagent", s => merge(s, {}, { ...s.ctx, ...sub })],
			];
			for (const [label, act] of cases) {
				const s = await open();
				const a = await build(s, "S1");
				act(s);
				expect(runFile(s).merged, label).toBeUndefined();
				await s.call({ action: "end" });
				expect(roster(s.dir)[surname(a)].laurel, label).toBe(0);
			}
		});

		test("only a command that starts with gh pr merge or glab mr merge, after cd steps, is a merge", async () => {
			const yes = ["gh pr merge 7 --merge --delete-branch", "glab mr merge 3 --yes", "cd /repo && gh pr merge 7", "cd a && cd b && glab mr merge 3", "gh pr merge 7 && echo done", "gh pr merge 7 2>&1", "gh pr merge 7 >&2"];
			const no = ["echo gh pr merge 7", "gh pr merge 7 --auto", "gh pr merge --auto 7", "gh pr merge --help", "gh pr merge -h", "gh pr merge 7 | tail", "gh pr merge 7 || true", "gh pr merge 7; echo hi", "git log && gh pr merge 7", "gh pr view 7 # gh pr merge", "gh pr merge 7 &", "gh pr merge 7 & echo hi"];
			for (const [list, want] of [[yes, true], [no, undefined]] as const) {
				for (const command of list) {
					const s = await open();
					await build(s, "S1");
					bash(s, command);
					expect(runFile(s).merged, command).toBe(want as true | undefined);
				}
			}
		}, 20000);

		test("a hand-edited run file is sanitized on load: junk outcomes and a non-true merge are ignored", async () => {
			const s = await open();
			const a = await build(s, "S1");
			edit(s, run => {
				run.merged = "yes";
				run.ended = { S1: "ok", S2: "bogus", S3: 5, ["__proto__"]: "ok" };
			});
			await s.call({ action: "end" });
			expect(roster(s.dir)).toEqual({ [surname(a)]: svc({ passed: 1, squads: 1, purity: 1 }) });
		});
	});

	describe("outcomes", () => {
		test("an aborted or cancelled builder is no fall: the squad ends without an outcome and the record stays empty", async () => {
			const s = await open();
			await build(s, "S1", "aborted");
			expect(runFile(s).ended).toBeUndefined();
			expect(await s.call({ action: "end" })).not.toContain("ROSTER");
			expect(existsSync(join(s.dir, "roster.json"))).toBe(false);
			for (const status of ["aborted", "cancelled"]) {
				const t = await open({ sid: `sess-${status}` });
				const name = await build(t, "S1", "running");
				const job = { type: "context", messages: [{ role: "custom", details: { jobs: [{ jobId: "j1", type: "task", status, label: name }] } }] };
				for (const h of t.handlers.context) h(job, t.ctx);
				expect(runFile(t, `sess-${status}`).ended, status).toBeUndefined();
				expect(await t.call({ action: "end" }), status).not.toContain("ROSTER");
			}
		});

		test("a blocking builder that returns cancelled leaves its squad without an outcome", async () => {
			const s = await open();
			const name = await nameFor(s, "battle-brother", "S1");
			spawn(s, "battle-brother", name);
			edit(s, run => {
				run.ended = { S1: "ok" };
			});
			returned(s, "battle-brother", name, "S1", "cancelled");
			expect(runFile(s).ended).toBeUndefined();
		});

		test("a run file whose ended is not an object is read as no outcomes", async () => {
			const s = await open();
			await build(s, "S1");
			edit(s, run => {
				run.ended = "ok";
			});
			expect(await s.call({ action: "end" })).not.toContain("ROSTER");
			expect(existsSync(join(s.dir, "roster.json"))).toBe(false);
		});

		test("a builder end over a junk ended rewrites the run file with a clean object (M18)", async () => {
			const s = await open();
			await build(s, "S1");
			edit(s, run => {
				run.ended = "ok";
			});
			await build(s, "S2", "failed");
			expect(runFile(s).ended).toEqual({ S2: "failed" });
		});

		test("a squad that failed and then was aborted has no outcome either", async () => {
			const s = await open();
			await build(s, "S1", "failed");
			const again = await nameFor(s, "battle-brother", "S1");
			spawn(s, "battle-brother", again);
			returned(s, "battle-brother", again, "S1", "aborted");
			expect(runFile(s).ended).toBeUndefined();
			await s.call({ action: "end" });
			expect(existsSync(join(s.dir, "roster.json"))).toBe(false);
		});

		test("a merge with a builder still unfinished earns no Laurel for the squads that did finish", async () => {
			const s = await open();
			const a = await build(s, "S1");
			await build(s, "S2", "running");
			merge(s);
			await s.call({ action: "end" });
			expect(roster(s.dir)[surname(a)]).toEqual(svc({ passed: 1, squads: 1, purity: 1 }));
		});

		test("the roster is written before the claim is released", async () => {
			const s = await open();
			await build(s, "S1");
			let heldAtWrite: boolean | undefined;
			const real = fs.renameSync;
			const sp = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
				if (String(to).endsWith("roster.json")) heldAtWrite = existsSync(lockPath(s.dir, "K-1"));
				return real(from, to);
			}) as typeof fs.renameSync);
			try {
				await s.call({ action: "end" });
			} finally {
				sp.mockRestore();
			}
			expect(heldAtWrite).toBe(true);
			expect(existsSync(lockPath(s.dir, "K-1"))).toBe(false);
		});
	});

	describe("allocation", () => {
		test("two parallel squads get the best available brothers in rank order, the next squad recruits", async () => {
			const s = await open({ brothers: { Alpha: svc({ passed: 9 }), Bravo: svc({ passed: 5, falls: 1 }), Cyril: svc({ passed: 5 }) } });
			expect(s.slices).toContain("NAMES S1=BrotherAlpha, S2=BrotherCyril");
			expect(await nameFor(s, "battle-brother", "S3")).toBe("BrotherBravo");
		});

		test("a ranked free brother comes back in the next run of the same omp session, with an epithet (CB1)", async () => {
			const s = await open({ brothers: { Alpha: svc({ passed: 9 }), Bravo: svc({ passed: 5 }), Cyril: svc({ passed: 1 }) } });
			const bySquad = () => Object.fromEntries((runFile(s).names ?? []).filter(n => n.squad).map(n => [n.squad, n.surname]));
			await nameFor(s, "battle-brother", "S3");
			expect(bySquad()).toEqual({ S1: "Alpha", S2: "Bravo", S3: "Cyril" });
			await s.call({ action: "end" });
			await s.call({ action: "begin", key: "K-2" });
			await s.call({ action: "repo", repo: s.dir });
			const second = await s.call({ action: "slices", slices: SQ });
			const third = await nameFor(s, "battle-brother", "S3");
			expect(bySquad()).toEqual({ S1: "Alpha", S2: "Bravo", S3: "Cyril" });
			expect(second).toMatch(/S1=BrotherAlpha[A-Z]/);
			expect(second).toMatch(/S2=BrotherBravo[A-Z]/);
			expect(third).toMatch(/^BrotherCyril[A-Z]/);
		});

		test("a run file holding JSON null or a non-object is skipped when other runs are scanned", async () => {
			const dir = mkdtempSync(join(tmpdir(), "st-roster-junk-"));
			dirs.push(dir);
			mkdirSync(join(dir, "runs"));
			for (const [f, body] of [["null.json", "null"], ["str.json", '"x"'], ["num.json", "7"]]) writeFileSync(join(dir, "runs", f), body);
			const s = await open({ dir, brothers: { Alpha: svc({ passed: 9 }) } });
			expect(s.slices).toContain("S1=BrotherAlpha");
		});

		test("a run file that is an object without key and sid is skipped (N7)", async () => {
			const dir = mkdtempSync(join(tmpdir(), "st-roster-empty-"));
			dirs.push(dir);
			mkdirSync(join(dir, "runs"));
			writeFileSync(join(dir, "runs", "empty.json"), "{}");
			const s = await open({ dir, brothers: { Alpha: svc({ passed: 9 }) } });
			expect(s.slices).toContain("S1=BrotherAlpha");
			expect(await nameFor(s, "battle-brother", "S3")).toStartWith("Brother");
		});

		test("a quiet run file does not free a brother while the heartbeat is fresh", async () => {
			const a = await open({ brothers: { Alpha: svc({ passed: 9 }) } });
			const old = new Date(Date.now() - 25 * 3_600_000);
			utimesSync(join(a.dir, "runs", "sess-0001.json"), old, old);
			writeFileSync(join(a.dir, "runs", "sess-0001.beat"), new Date().toISOString());
			expect((await open({ dir: a.dir, sid: "sess-0002", key: "K-2" })).slices).not.toContain("Alpha");
		});

		test("with the record used up, a squad recruits a name nobody has recorded", async () => {
			const s = await open({ brothers: { Alpha: svc({ passed: 9 }) } });
			expect(s.slices).toContain("S1=BrotherAlpha");
			const third = surname(await nameFor(s, "battle-brother", "S3"));
			expect(third).not.toBe("Alpha");
			expect(runFile(s).names?.map(n => n.surname)).toContain(third);
		});

		test("a roster read leaves no lock behind", async () => {
			const s = await open({ brothers: { Alpha: svc({ passed: 1 }) } });
			expect(existsSync(join(s.dir, "roster.lock"))).toBe(false);
		});
	});

	describe("reserve", () => {
		test("a corrupted brother is never handed out", async () => {
			const s = await open({ brothers: { Dire: svc({ passed: 99, falls: 3 }), Good: svc({ passed: 1 }) } });
			expect(s.slices).toContain("S1=BrotherGood");
			expect(await s.call({ action: "slices", slices: SQ })).not.toContain("Dire");
			expect(runFile(s).names?.some(n => n.surname === "Dire")).toBe(false);
		});

		test("a brother in another session's open run is skipped, and handed out again once that run ends", async () => {
			const a = await open({ brothers: { Alpha: svc({ passed: 9 }) } });
			expect(a.slices).toContain("S1=BrotherAlpha");
			const b = await open({ dir: a.dir, sid: "sess-0002", key: "K-2" });
			expect(b.slices).not.toContain("Alpha");
			await a.call({ action: "end" });
			expect(await nameFor(b, "battle-brother", "S3")).toBe("BrotherAlpha");
		});

		test("a brother of a run that redrafted is free again", async () => {
			const a = await open({ brothers: { Alpha: svc({ passed: 9 }) } });
			await a.call({ action: "redraft" });
			const b = await open({ dir: a.dir, sid: "sess-0002", key: "K-2" });
			expect(b.slices).toContain("S1=BrotherAlpha");
		});

		test("a brother whose run no longer holds its claim is free again", async () => {
			const a = await open({ brothers: { Alpha: svc({ passed: 9 }) } });
			release(a.dir, "K-1", "sess-0001");
			const b = await open({ dir: a.dir, sid: "sess-0002", key: "K-2" });
			expect(b.slices).toContain("S1=BrotherAlpha");
		});

		test("a held run quiet for 25 h is free; one quiet for 23 h still holds its brothers (a paused run may not beat)", async () => {
			const quiet = async (hours: number) => {
				const a = await open({ brothers: { Alpha: svc({ passed: 9 }) } });
				const old = new Date(Date.now() - hours * 3_600_000);
				for (const f of ["sess-0001.json", "sess-0001.beat"]) if (existsSync(join(a.dir, "runs", f))) utimesSync(join(a.dir, "runs", f), old, old);
				return (await open({ dir: a.dir, sid: "sess-0002", key: "K-2" })).slices;
			};
			expect(await quiet(25)).toContain("S1=BrotherAlpha");
			expect(await quiet(23)).not.toContain("Alpha");
		});

		test("with 48 of the 49 pool surnames corrupted in the roster, the squad gets the 49th", async () => {
			const pool: string[] = [];
			const held: NameEntry[] = [];
			for (;;) {
				const r = allocateName(held, { agent: "battle-brother", squad: `p${pool.length}` });
				if ("error" in r) break;
				held.push(r.entry);
				pool.push(r.entry.surname);
			}
			expect(pool.length).toBe(49);
			const brothers = Object.fromEntries(pool.slice(0, 48).map(n => [n, svc({ falls: 3 })]));
			const s = await open({ brothers });
			expect(s.slices).toContain(`S1=Brother${pool[48]}`);
		});
	});

	describe("restart", () => {
		test("facts set before an omp restart still land in the roster", async () => {
			const before = await open();
			const name = await build(before, "S1");
			merge(before);
			const after = setup("sess-0001", before.dir);
			expect(await after.call({ action: "end" })).toEndWith("ROSTER 1 squad(s) recorded");
			expect(roster(before.dir)[surname(name)]).toEqual(svc({ passed: 1, squads: 1, purity: 1, laurel: 1 }));
		});
	});

	describe("corrupt roster", () => {
		test("names are still handed out with a WARN, and the file stays byte-identical after end", async () => {
			const raw = '{"version":1,"brothers":{"lower":{}}}';
			const s = await open({ raw });
			expect(s.slices).toMatch(/WARN roster .*roster\.json unreadable \(.+\): names come from the pool; fix or delete it/);
			expect(s.slices).toMatch(/NAMES S1=Brother[A-Z]/);
			const name = await build(s, "S1");
			expect(await s.call({ action: "name", agent: "battle-brother", squad: "S3" })).toContain("WARN roster");
			expect(await s.call({ action: "end" })).toMatch(/\nWARN ROSTER not written: roster unreadable/);
			expect(readFileSync(join(s.dir, "roster.json"), "utf8")).toBe(raw);
			expect(name).toMatch(/^Brother/);
		});

		test("a busy lock never stops a name or the end, and a roster that stays busy loses only that run's record", async () => {
			const s = await open();
			// A directory is a lock nobody can take over, however old: the end waits out its whole budget.
			mkdirSync(join(s.dir, "roster.lock"));
			const out = await s.call({ action: "name", agent: "battle-brother", squad: "S3" });
			expect(out).toMatch(/^WARN roster busy.*\nNAME Brother/);
			await build(s, "S1");
			expect(await s.call({ action: "end" })).toEndWith("WARN ROSTER not written: roster busy");
			expect(existsSync(join(s.dir, "roster.json"))).toBe(false);
		}, 30000);

		test("a lock left by a dead process is taken at once, at a name and at the end", async () => {
			const s = await open();
			const dead = Bun.spawnSync({ cmd: [process.execPath, "-e", "0"] }).pid;
			writeFileSync(join(s.dir, "roster.lock"), `${dead}-token`);
			const t0 = Date.now();
			expect(await s.call({ action: "name", agent: "battle-brother", squad: "S3" })).not.toContain("WARN");
			await build(s, "S1");
			writeFileSync(join(s.dir, "roster.lock"), `${dead}-token`);
			expect(await s.call({ action: "end" })).toEndWith("ROSTER 1 squad(s) recorded");
			expect(Date.now() - t0).toBeLessThan(1500);
		});

		test("the end waits past a live holder's stale age instead of losing the record", async () => {
			const s = await open();
			const name = await build(s, "S1");
			const lock = join(s.dir, "roster.lock");
			writeFileSync(lock, `${process.pid}-token`);
			const old = new Date(Date.now() - 7000);
			utimesSync(lock, old, old); // 3 s from stale: more than the 2 s a name waits
			expect(await s.call({ action: "end" })).toEndWith("ROSTER 1 squad(s) recorded");
			expect(roster(s.dir)[surname(name)].squads).toBe(1);
		}, 15000);
	});

	describe("names off, context", () => {
		test("a builder job that completes records no outcome", async () => {
			delete process.env.STRATEGIUM_NAMES;
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			await s.call({ action: "repo", repo: s.dir });
			await s.call({ action: "slices", slices: SQ });
			s.handlers.before_subagent_spawn[0]({ agent: "battle-brother", spawnKey: "S1" }, s.ctx);
			const event = { toolName: "task", input: { tasks: [{ agent: "battle-brother", name: "S1", task: "build squad S1" }] }, details: { progress: [{ index: 0, id: "S1", status: "running" }] }, isError: false };
			for (const h of s.handlers.tool_result) h(event, s.ctx);
			const job = { type: "context", messages: [{ role: "custom", details: { jobs: [{ jobId: "j1", type: "task", status: "completed", label: "S1" }] } }] };
			for (const h of s.handlers.context) h(job, s.ctx);
			expect(JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8")).ended).toBeUndefined();
		});
	});

	describe("names off", () => {
		test("no roster read, write or lock; no run-file field; end prints what main prints", async () => {
			delete process.env.STRATEGIUM_NAMES;
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			await s.call({ action: "repo", repo: s.dir });
			await s.call({ action: "slices", slices: SQ });
			const event = { toolName: "task", input: { tasks: [{ agent: "battle-brother", name: "S1", task: "build squad S1" }] }, details: { progress: [{ index: 0, id: "S1", status: "completed" }] }, isError: false };
			s.handlers.before_subagent_spawn[0]({ agent: "battle-brother", spawnKey: "S1" }, s.ctx);
			for (const h of s.handlers.tool_result) h(event, s.ctx);
			merge(s);
			const run = JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8"));
			expect(run.ended).toBeUndefined();
			expect(run.merged).toBeUndefined();
			expect(await s.call({ action: "end" })).not.toContain("ROSTER");
			expect(existsSync(join(s.dir, "roster.json"))).toBe(false);
			expect(existsSync(join(s.dir, "roster.lock"))).toBe(false);
		});

		test("a corrupted async builder: the LESSON names its squad from the cockpit registry, not run.names (#142)", async () => {
			delete process.env.STRATEGIUM_NAMES;
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			await s.call({ action: "repo", repo: s.dir });
			await s.call({ action: "slices", slices: SQ });
			s.handlers.before_subagent_spawn[0]({ agent: "battle-brother", spawnKey: "S1" }, s.ctx);
			const event = { toolName: "task", input: { tasks: [{ agent: "battle-brother", name: "S1", task: "build squad S1" }] }, details: { progress: [{ index: 0, id: "S1", status: "running" }] }, isError: false };
			for (const h of s.handlers.tool_result) h(event, s.ctx);
			const out = await s.call({ action: "rate", agent: "S1", rating: "corrupted", evidence: ["I-3"], model: "@task", effort: "medium" });
			expect(out).toEndWith("LESSON write local://K-1-lessons.md for S1 before the next round of squad S1; start evidence with cause: <why>");
		});
	});

	describe("parallel writes", () => {
		test("two real processes add 50 each to one brother and every increment lands", async () => {
			const dir = mkdtempSync(join(tmpdir(), "st-roster-par-"));
			dirs.push(dir);
			const rosterPath = join(import.meta.dir, "roster.ts").replaceAll("\\", "/");
			const script = `import { updateRoster } from "${rosterPath}"; const dir = ${JSON.stringify(dir)}; let failed = 0;
for (let i = 0; i < 50; i++) { const err = updateRoster(dir, b => { const n = { ...b }; const s = n.Lorenzo ?? { passed: 0, penances: 0, falls: 0, squads: 0, purity: 0, halo: 0, laurel: 0 }; n.Lorenzo = { ...s, passed: s.passed + 1 }; return n; }, 10000); if (err) failed++; }
console.log("FAILED " + failed);`;
			const procs = [0, 1].map(() => Bun.spawn({ cmd: [process.execPath, "-e", script], stdout: "pipe" }));
			const outs = await Promise.all(procs.map(p => new Response(p.stdout).text()));
			expect(outs.map(o => o.trim())).toEqual(["FAILED 0", "FAILED 0"]);
			expect(roster(dir).Lorenzo.passed).toBe(100);
			expect(existsSync(join(dir, "roster.lock"))).toBe(false);
		});
	});

	describe("ratings feed the record (#141, D6)", () => {
		const rate = (s: S, agent: string, rating: string) => s.call({ action: "rate", agent, rating, evidence: ["I-3"], model: "@task", effort: "medium" });
		// A builder that is named, spawned and still running, so the cockpit registry knows its id.
		const running = async (s: S, squad: string) => {
			const name = await nameFor(s, "battle-brother", squad);
			spawn(s, "battle-brother", name);
			returned(s, "battle-brother", name, squad, "running");
			return name;
		};

		test("a corrupted latest builder: the FALL line, and at end a fall in the roster even though its job completed", async () => {
			const s = await open();
			const name = await running(s, "S1");
			expect(await rate(s, name, "corrupted")).toBe(`RATED ${name} corrupted model=@task effort=medium evidence=1\nFALL ${surname(name)} squad S1 falls at end unless a later builder replaces it\nLESSON write local://K-1-lessons.md for ${name} before the next round of squad S1; start evidence with cause: <why>`);
			returned(s, "battle-brother", name, "S1", "completed");
			expect(await s.call({ action: "end" })).toContain("ROSTER 1 squad(s) recorded");
			expect(roster(s.dir)[surname(name)]).toEqual(svc({ falls: 1, squads: 1 }));
		});

		test("a builder spawned by a blocking task, never in the cockpit registry, can be rated", async () => {
			const s = await open();
			const name = await nameFor(s, "battle-brother", "S1");
			spawn(s, "battle-brother", name);
			expect(await rate(s, name, "corrupted")).toContain(`FALL ${surname(name)} squad S1`);
			expect(await rate(s, `${name}-2`, "corrupted")).toBe(`ERROR ${name}-2 is not an agent of this run: pass the agent id the task result shows`);
			const unspawned = await nameFor(s, "battle-brother", "S2");
			expect(await rate(s, unspawned, "proven")).toBe(`ERROR ${unspawned} is not an agent of this run: pass the agent id the task result shows`);
		});

		test("an invented Name-N for a spawned name is refused", async () => {
			const s = await open();
			const name = await nameFor(s, "battle-brother", "S1");
			spawn(s, "battle-brother", name);
			expect(await rate(s, `${name}-2`, "corrupted")).toBe(`ERROR ${name}-2 is not an agent of this run: pass the agent id the task result shows`);
		});

		test("Name and Name-2 are two agents: each keeps its own rating", async () => {
			const s = await open();
			const name = await running(s, "S1");
			returned(s, "battle-brother", `${name}-2`, "S1", "running");
			expect(await rate(s, name, "corrupted")).toStartWith("RATED");
			expect(await rate(s, `${name}-2`, "proven")).toBe(`RATED ${name}-2 proven model=@task effort=medium evidence=1`);
			const file = JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8"));
			expect(Object.entries(file.ratings).map(([k, v]) => [k, (v as { rating: string }).rating])).toEqual([[name, "corrupted"], [`${name}-2`, "proven"]]);
		});

		test("end by takeover over a hand-edited invalid corrupted entry records no fall", async () => {
			const a = await open();
			const name = await running(a, "S1");
			returned(a, "battle-brother", name, "S1", "completed");
			const file = join(a.dir, "runs", "sess-0001.json");
			writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ratings: { [name]: { rating: "corrupted" } } }));
			const c = setup("sess-0003", a.dir);
			expect(await c.call({ action: "end", key: "K-1", takeover: "sess-0001" })).toContain("ROSTER 1 squad(s) recorded");
			expect(roster(a.dir)[surname(name)]).toEqual(svc({ passed: 1, squads: 1, purity: 1 }));
		});

		test("rate corrupted, redraft, end: no fall reaches roster.json", async () => {
			const s = await open();
			const name = await running(s, "S1");
			await rate(s, name, "corrupted");
			await s.call({ action: "redraft" });
			await s.call({ action: "end" });
			const file = join(s.dir, "roster.json");
			expect((existsSync(file) ? roster(s.dir) : {})[surname(name)]?.falls ?? 0).toBe(0);
		});

		test("a hand-edited invalid corrupted entry does not block a proven re-rate, and a non-object ratings is not written back", async () => {
			const s = await open();
			const name = await running(s, "S1");
			const file = join(s.dir, "runs", "sess-0001.json");
			const edit = (ratings: unknown) => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ratings }));
			edit({ [name]: { rating: "corrupted" } });
			expect(await rate(s, name, "proven")).toBe(`RATED ${name} proven model=@task effort=medium evidence=1`);
			edit("junk");
			await rate(s, name, "proven");
			expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).ratings)).toEqual([name]);
		});

		test("a proven builder has no FALL line and the record is the plain pass", async () => {
			const s = await open();
			const name = await running(s, "S1");
			expect(await rate(s, name, "proven")).not.toContain("FALL");
			expect(await rate(s, name, "proven-regression")).not.toContain("FALL");
			returned(s, "battle-brother", name, "S1", "completed");
			await s.call({ action: "end" });
			expect(roster(s.dir)[surname(name)]).toEqual(svc({ passed: 1, squads: 1, purity: 1 }));
		});

		test("a corrupted round-1 builder followed by a penance: no FALL line for the old one and the penance result stays", async () => {
			const s = await open();
			const first = await running(s, "S1");
			returned(s, "battle-brother", first, "S1", "completed");
			const penance = await running(s, "S1");
			expect(await rate(s, first, "corrupted")).not.toContain("FALL");
			returned(s, "battle-brother", penance, "S1", "completed");
			await s.call({ action: "end" });
			expect(roster(s.dir)[surname(first)]).toMatchObject({ falls: 0, passed: 1 });
		});

		test("a corrupted scout never touches the roster", async () => {
			const s = await open();
			const name = await running(s, "S1");
			const scout = lastLine(await s.call({ action: "name", agent: "scout" })).slice(5);
			s.handlers.before_subagent_spawn[0]({ invocationKind: "eval", agent: "scout", spawnKey: scout }, s.ctx);
			expect(await rate(s, scout, "corrupted")).not.toContain("FALL");
			returned(s, "battle-brother", name, "S1", "completed");
			await s.call({ action: "end" });
			expect(roster(s.dir)[surname(name)]).toEqual(svc({ passed: 1, squads: 1, purity: 1 }));
		});
	});
});

// Names, honours and the record in the cockpit, the chronicle and the debrief (#135).
describe("names in the cockpit (#135)", () => {
	type Comp = { render(w: number): string[]; handleInput?(d: string): void };
	const SQ = [
		{ id: "S1", parallel: true, files: ["a.ts"] },
		{ id: "S2", parallel: true, files: ["b.ts"] },
		{ id: "S3", parallel: false, files: ["c.ts"] },
	];
	const LORENZO = { passed: 4, penances: 0, falls: 0, squads: 4, purity: 4, halo: 0, laurel: 0 };
	const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");
	// A run with the three squads and a UI; `on` false leaves names off, `brothers` or `raw` seed roster.json.
	const open = async (o: { on?: boolean; brothers?: object; raw?: string } = {}) => {
		if (o.on !== false) process.env.STRATEGIUM_NAMES = "1";
		const dir = mkdtempSync(join(tmpdir(), "st-names-cockpit-"));
		dirs.push(dir);
		if (o.brothers) writeFileSync(join(dir, "roster.json"), JSON.stringify({ version: 1, brothers: o.brothers }));
		if (o.raw !== undefined) writeFileSync(join(dir, "roster.json"), o.raw);
		const s = setup("sess-0001", dir);
		const opened: Comp[] = [];
		const c = s.ctx as unknown as { hasUI: boolean; ui: Record<string, unknown> };
		c.hasUI = true;
		c.ui.custom = (factory: (t: unknown, th: unknown, k: unknown, done: () => void) => Comp) => {
			opened.push(factory({ requestRender() {}, terminal: { rows: 60 } }, {}, {}, () => {}));
			return new Promise(() => {});
		};
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "repo", repo: dir });
		await s.call({ action: "slices", slices: SQ });
		const phases = [{ name: "Skirmish", tasks: [{ content: "[battle-brother] Squads", status: "in_progress" }] }];
		s.handlers.tool_result.forEach(h => h({ toolName: "todo", isError: false, details: { phases } }, s.ctx));
		return { ...s, opened };
	};
	type Opened = Awaited<ReturnType<typeof open>>;
	const task = (s: Opened, agent: string, id: string, status: string) =>
		s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [{ agent, name: id, task: "build squad S1" }] }, details: { progress: [{ index: 0, id, status }] }, isError: false }, s.ctx));
	const named = async (s: Opened, agent: string, squad = "S1") => (await s.call({ action: "name", agent, squad })).split("\n").at(-1)!.slice(5);
	const cockpitFile = (s: Opened) => JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.cockpit"), "utf8")) as { chronicle: { text: string }[]; deployed: [string, Record<string, unknown>][] };
	const texts = (s: Opened) => cockpitFile(s).chronicle.map(e => e.text);
	// The overlay as it is now, without colours; closed again so no interval stays alive.
	const peek = async (s: Opened) => {
		await s.sub("cockpit");
		const comp = s.opened.at(-1)!;
		const text = plain(comp.render(120).join("\n"));
		comp.handleInput!("q");
		return text;
	};
	const detail = async (s: Opened, squad = "S1") => {
		await s.sub("cockpit");
		const comp = s.opened.at(-1)!;
		for (let i = 0; i < 40 && !plain(comp.render(120).join("\n")).split("\n").some(l => l.includes("▸") && l.includes(squad)); i++) comp.handleInput!("\x1b[B");
		comp.handleInput!("\r");
		const text = plain(comp.render(120).join("\n"));
		comp.handleInput!("q");
		return text;
	};

	test("names off: the chronicle, the cockpit file and the end result are today's", async () => {
		const s = await open({ on: false });
		task(s, "battle-brother", "S1", "running");
		task(s, "battle-brother", "S1", "completed");
		expect(texts(s).filter(t => /deployed|returned/.test(t))).toEqual(["† battle-brother deployed", "✓ returned"]);
		expect(cockpitFile(s).deployed[0][1]).not.toHaveProperty("name");
		const out = await s.call({ action: "end" });
		expect(out).not.toContain("HONOURS");
		expect(readFileSync(join(s.dir, "debriefs", readdirSync(join(s.dir, "debriefs"))[0]), "utf8")).not.toContain("## Honours");
	});

	test("names on: the chronicle carries the name, the deployed entry keeps it and the return says it", async () => {
		const s = await open();
		const name = await named(s, "battle-brother");
		s.handlers.before_subagent_spawn[0]({ agent: "battle-brother", spawnKey: name }, s.ctx);
		task(s, "battle-brother", name, "running");
		expect(texts(s)).toContain(`† ${name} deployed`);
		expect(cockpitFile(s).deployed[0][1].name).toBe(name);
		task(s, "battle-brother", name, "completed");
		expect(texts(s)).toContain(`✓ ${name} returned`);
		task(s, "veteran", "S1-v", "running");
		expect(texts(s).at(-1)).toBe("‡ escalated to VETERAN"); // no name matches this id: today's text
	});

	test("names on: an eval spawn with a named spawnKey is deployed by name", async () => {
		const s = await open();
		const i = (await s.call({ action: "name", agent: "inquisitor" })).slice(5);
		s.handlers.before_subagent_spawn.forEach(h => h({ invocationKind: "eval", agent: "inquisitor", spawnKey: i }, s.ctx));
		expect(texts(s)).toContain(`${i} deployed`);
		expect(cockpitFile(s).deployed.find(([id]) => id === i)![1].name).toBe(i);
	});

	test("names on: a veteran escalation and an unsquadded agent are named", async () => {
		const s = await open();
		const b = await named(s, "battle-brother");
		s.handlers.before_subagent_spawn[0]({ agent: "battle-brother", spawnKey: b }, s.ctx);
		const v = await named(s, "veteran");
		s.handlers.before_subagent_spawn[0]({ agent: "veteran", spawnKey: v }, s.ctx);
		task(s, "veteran", v, "running");
		expect(texts(s)).toContain(`‡ ${v} escalated to VETERAN`);
		const i = (await s.call({ action: "name", agent: "inquisitor" })).slice(5);
		s.handlers.before_subagent_spawn[0]({ agent: "inquisitor", spawnKey: i }, s.ctx);
		s.handlers.tool_result.forEach(h => h({ toolName: "task", input: { tasks: [{ agent: "inquisitor", name: i, task: "judge" }] }, details: { progress: [{ index: 0, id: `${i}-2`, status: "running" }] }, isError: false }, s.ctx));
		expect(texts(s)).toContain(`${i} deployed`);
	});

	test("names on: the squad row shows the badges, and one roster load serves the whole run", async () => {
		const s = await open({ brothers: { Lorenzo: LORENZO } });
		const name = await named(s, "battle-brother");
		expect(name).toBe("BrotherLorenzo");
		expect(await peek(s)).toContain("BrotherLorenzo ✠4");
		rmSync(join(s.dir, "roster.json"));
		expect(await peek(s)).toContain("BrotherLorenzo ✠4");
	});

	test("an unreadable roster.json shows record unknown in the detail and never throws", async () => {
		const s = await open({ raw: "{nope" });
		await named(s, "battle-brother");
		expect(await detail(s)).toContain("record: unknown (roster unreadable)");
	});

	test("a saved cockpit with a non-string name loads without the field", async () => {
		const s = await open();
		task(s, "scout", "scout-1", "running");
		const file = join(s.dir, "runs", "sess-0001.cockpit");
		const saved = JSON.parse(readFileSync(file, "utf8"));
		saved.deployed[0][1].name = 5;
		writeFileSync(file, JSON.stringify(saved));
		const again = setup("sess-0001", s.dir);
		await again.start();
		task(again as Opened, "scout", "scout-1", "completed");
		expect(cockpitFile(again as Opened).deployed[0][1]).not.toHaveProperty("name");
	});

	test("end with names on prints the HONOURS line before ROSTER, and the debrief lists the Honours table", async () => {
		const s = await open({ brothers: { Lorenzo: LORENZO } });
		const name = await named(s, "battle-brother");
		s.handlers.before_subagent_spawn[0]({ agent: "battle-brother", spawnKey: name }, s.ctx);
		task(s, "battle-brother", name, "completed");
		const out = await s.call({ action: "end" });
		expect(out).toMatch(/\nHONOURS Lorenzo earns a Purity Seal[^\n]*\nROSTER 1 squad\(s\) recorded$/);
		expect(readFileSync(join(s.dir, "debriefs", readdirSync(join(s.dir, "debriefs"))[0]), "utf8")).toMatch(/## Honours[\s\S]*Lorenzo/);
	});

	test("a roster that cannot be written still prints HONOURS and the debrief says it was not saved, with no joins", async () => {
		const s = await open();
		const name = await named(s, "battle-brother");
		s.handlers.before_subagent_spawn[0]({ agent: "battle-brother", spawnKey: name }, s.ctx);
		task(s, "battle-brother", name, "completed");
		mkdirSync(join(s.dir, "roster.lock")); // a lock nobody can take over
		const out = await s.call({ action: "end" });
		expect(out).toContain("WARN ROSTER not written: roster busy");
		expect(out).toContain("earns a Purity Seal");
		expect(out).not.toContain("joins the roster");
		expect(readFileSync(join(s.dir, "debriefs", readdirSync(join(s.dir, "debriefs"))[0]), "utf8")).toContain("this record was not saved");
	}, 30000);

	test("a roster written after the run opened still decorates a builder named later", async () => {
		const random = spyOn(Math, "random").mockReturnValue(0.99); // S1 and S2 draw from the end of the pool, so neither can take Lorenzo
		const s = await open().finally(() => random.mockRestore());
		await peek(s); // the roster is read now, while it is missing
		writeFileSync(join(s.dir, "roster.json"), JSON.stringify({ version: 1, brothers: { Lorenzo: LORENZO } }));
		expect(await named(s, "battle-brother", "S3")).toBe("BrotherLorenzo"); // S1 and S2 took their names at `slices`, S3 is the sequential squad
		expect(await peek(s)).toContain("BrotherLorenzo ✠4");
		expect(await detail(s, "S3")).toContain("passed 4");
	});

	test("an unreadable roster read is never cached: the next draw shows the record", async () => {
		const s = await open({ raw: "{nope" });
		const surname = (await named(s, "battle-brother")).replace(/^Brother/, "");
		expect(await detail(s)).toContain("record: unknown (roster unreadable)");
		writeFileSync(join(s.dir, "roster.json"), JSON.stringify({ version: 1, brothers: { [surname]: LORENZO } }));
		expect(await detail(s)).toContain("passed 4");
	});

	test("a corrupted brother named while the roster was unreadable shows corrupted: kept in reserve once it reads", async () => {
		const s = await open({ raw: "{nope" });
		const surname = (await named(s, "battle-brother")).replace(/^Brother/, "");
		writeFileSync(join(s.dir, "roster.json"), JSON.stringify({ version: 1, brothers: { [surname]: { ...LORENZO, falls: 3 } } }));
		expect(await detail(s)).toContain("corrupted: kept in reserve");
	});

	test("end then begin of another key in the same session reads the roster again", async () => {
		const s = await open({ brothers: { Lorenzo: LORENZO } });
		expect(await peek(s)).toContain("BrotherLorenzo ✠4"); // S1 got him at `slices`
		await s.call({ action: "end" });
		writeFileSync(join(s.dir, "roster.json"), JSON.stringify({ version: 1, brothers: { Lorenzo: { ...LORENZO, passed: 5, purity: 5, squads: 5 } } }));
		await s.call({ action: "begin", key: "K-2" });
		await s.call({ action: "repo", repo: s.dir });
		await s.call({ action: "slices", slices: SQ });
		const phases = [{ name: "Skirmish", tasks: [{ content: "[battle-brother] Squads", status: "in_progress" }] }];
		s.handlers.tool_result.forEach(h => h({ toolName: "todo", isError: false, details: { phases } }, s.ctx));
		expect(await peek(s)).toContain("BrotherLorenzoUnbroken ✠5"); // the epithet: his bare name was issued by K-1
	});

	const debriefText = (s: Opened) => readFileSync(join(s.dir, "debriefs", readdirSync(join(s.dir, "debriefs"))[0]), "utf8");
	const finish = async (s: Opened) => {
		const name = await named(s, "battle-brother");
		s.handlers.before_subagent_spawn[0]({ agent: "battle-brother", spawnKey: name }, s.ctx);
		task(s, "battle-brother", name, "completed");
		return name.replace(/^Brother/, "");
	};

	test("end: a brother passing for the tenth time earns the Crux in HONOURS and the debrief", async () => {
		const s = await open({ brothers: { Lorenzo: { ...LORENZO, passed: 9, purity: 9, squads: 9 } } });
		await finish(s);
		const out = await s.call({ action: "end" });
		expect(out).toContain("Lorenzo earns the Crux Terminatus");
		expect(debriefText(s)).toContain("Crux Terminatus");
	});

	test("end: a new brother joins the roster, in HONOURS and in the debrief's Honours section", async () => {
		const s = await open();
		const surname = await finish(s);
		const out = await s.call({ action: "end" });
		expect(out).toContain(`${surname} joins the roster`);
		expect(debriefText(s)).toContain(`${surname} joins the roster`);
	});

	test("end: a write that fails after the roster was read gives no joins or Crux, and says it was not saved", async () => {
		const s = await open({ brothers: { Lorenzo: { ...LORENZO, passed: 9, purity: 9, squads: 9 } } });
		await finish(s);
		mkdirSync(join(s.dir, `roster.json.${process.pid}.tmp`)); // the temp file cannot be created
		const out = await s.call({ action: "end" });
		expect(out).toContain("WARN ROSTER not written");
		expect(out).toContain("earns a Purity Seal");
		expect(out).not.toContain("Crux");
		expect(out).not.toContain("joins the roster");
		expect(debriefText(s)).toContain("this record was not saved");
		expect(debriefText(s)).not.toContain("Crux");
	});

	test("names turned off mid-run: the return line is today's text", async () => {
		const s = await open();
		const name = await named(s, "battle-brother");
		s.handlers.before_subagent_spawn[0]({ agent: "battle-brother", spawnKey: name }, s.ctx);
		task(s, "battle-brother", name, "running");
		await s.sub("config", "names off");
		task(s, "battle-brother", name, "completed");
		expect(texts(s)).toContain("✓ returned");
		expect(texts(s)).not.toContain(`✓ ${name} returned`);
	});
});

describe("reuse a proven builder (#143)", () => {
	type S = ReturnType<typeof setup>;
	type Verdict = { block?: true; reason?: string; model?: string; note?: string } | undefined;
	const DEFAULT = { light: "@smol:medium", standard: "@task:medium", heavy: "@slow:high" };
	const SQUADS = [
		{ id: "T", parallel: false, files: ["pkg/t.ts"], tier: "light" },
		{ id: "A", parallel: false, files: ["pkg/t.ts", "x/q.ts"] },
		{ id: "A2", parallel: false, files: ["pkg/t.ts"] },
		{ id: "A3", parallel: false, files: ["pkg/t.ts"] },
		{ id: "C", parallel: false, files: ["pkg/c.ts"] },
		{ id: "D", parallel: false, files: ["lib/d.ts"] },
		{ id: "E", parallel: false, files: ["top.ts"] },
	];
	const open = async (names = false, repo = true, squads: object[] = SQUADS) => {
		if (names) process.env.STRATEGIUM_NAMES = "1";
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		if (repo) await s.call({ action: "repo", repo: s.dir });
		await s.call({ action: "slices", slices: squads });
		return s;
	};
	const rate = (s: S, agent: string, rating = "proven") => s.call({ action: "rate", agent, rating, evidence: ["I-1"], model: "@task", effort: "medium" });
	// Names off: an async builder shows in the task result by its id, then its job ends in a message.
	const launch = (s: S, ids: string[]) =>
		s.handlers.tool_result.forEach(h =>
			h({ toolName: "task", input: { tasks: ids.map(id => ({ agent: "battle-brother", name: id, task: `build squad ${id}` })) }, details: { progress: ids.map((id, index) => ({ index, id, status: "running" })) }, isError: false }, s.ctx),
		);
	const finish = (s: S, ids: string[]) =>
		s.handlers.context[0]({ type: "context", messages: [{ role: "custom", details: { jobs: ids.map(label => ({ jobId: `j-${label}`, type: "task", status: "completed", label })) } }] }, s.ctx);
	const built = async (s: S, ids: string[], rating = "proven") => {
		launch(s, ids);
		finish(s, ids);
		for (const id of ids) await rate(s, id, rating);
	};
	const usage = (s: S, id: string, tokens: Record<string, number>) => {
		mkdirSync(join(s.dir, "runs", "sess-0001.live"), { recursive: true });
		writeFileSync(join(s.dir, "runs", "sess-0001.live", `${id}.json`), JSON.stringify({ since: 4e12, at: 4e12, busy: 0, ...tokens }));
	};
	const spawn = (s: S, agent: string, spawnKey?: string) => s.handlers.before_subagent_spawn[0]({ agent, spawnKey }, s.ctx) as Verdict;
	const task = (s: S, items: object[], context?: string) => s.handlers.tool_call[0]({ toolName: "task", input: { tasks: items, ...(context ? { context } : {}) } }, s.ctx) as Verdict;
	const item = (task: string, extra: object = {}) => ({ agent: "battle-brother", name: "T", isolated: true, task, ...extra });
	const nameOf = async (s: S, params: Record<string, unknown>) => {
		const out = await s.call({ action: "name", ...params });
		expect(out).toMatch(/^NAME \S+$/);
		return out.slice(5);
	};
	const runFile = (s: S) => JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8")) as { names?: { name: string; squad?: string }[] };

	describe("the reuse action", () => {
		test("each refusal", async () => {
			expect(await setup().call({ action: "reuse", squad: "T" })).toBe("ERROR no active run in this session");
			const s = await open();
			expect(await s.call({ action: "reuse" })).toBe("ERROR reuse needs squad");
			expect(await s.call({ action: "reuse", squad: "Z" })).toBe("ERROR squad Z is not declared: call strategium action slices first");
		});

		test("shared files beat same area, nothing shared is not offered; the SEED line follows", async () => {
			const s = await open();
			await built(s, ["A", "C", "D", "E"]);
			usage(s, "A", { tokens_in: 300, tokens_out: 100, cache_read: 50, cache_write: 50 });
			expect(await s.call({ action: "reuse", squad: "T" })).toBe(
				[
					"REUSE squad T: A (squad A, shared files, 500 tokens); C (squad C, same area, usage unknown)",
					"SEED brief line \"Reuse: A\", the line \"build squad T\", the squad's lessons and open finding IDs, its commit(s) to git show, agent://A (final report) and history://A:-60; spawn the agent the ladder calls for (battle-brother for a penance, veteran for the escalation)",
				].join("\n"),
			);
		});

		test("within an affinity the fewest tokens come first, unknown usage last", async () => {
			const s = await open();
			await built(s, ["A", "A2", "A3"]);
			usage(s, "A", { tokens_in: 900 });
			usage(s, "A2", { tokens_in: 100 });
			const [line] = (await s.call({ action: "reuse", squad: "T" })).split("\n");
			expect(line).toBe("REUSE squad T: A2 (squad A2, shared files, 100 tokens); A (squad A, shared files, 900 tokens); A3 (squad A3, shared files, usage unknown)");
		});

		test("a squad may reuse its own proven builder", async () => {
			const s = await open();
			await built(s, ["T"]);
			expect((await s.call({ action: "reuse", squad: "T" })).split("\n")[0]).toBe("REUSE squad T: T (squad T, shared files, usage unknown)");
		});

		test("only the three best are listed", async () => {
			const s = await open();
			await built(s, ["A", "A2", "A3", "C", "T"]);
			expect((await s.call({ action: "reuse", squad: "T" })).split("\n")[0].split("; ")).toHaveLength(3);
		});

		test("corrupted, proven-regression, unrated, running and squadless agents are never offered; a proven control is", async () => {
			const s = await open();
			// A, A2 and A3 share pkg/t.ts with T: only their rating keeps them out.
			await built(s, ["A"], "corrupted");
			await built(s, ["A2"], "proven-regression");
			launch(s, ["A3"]);
			finish(s, ["A3"]); // ended but never rated
			await built(s, ["C"]); // the control: proven, same area
			launch(s, ["T"]);
			await rate(s, "T"); // proven but still running
			s.handlers.before_subagent_spawn[0]({ invocationKind: "eval", agent: "battle-brother", spawnKey: "Ghost" }, s.ctx);
			await rate(s, "Ghost"); // proven, no squad on record
			expect((await s.call({ action: "reuse", squad: "T" })).split("\n")[0]).toBe("REUSE squad T: C (squad C, same area, usage unknown)");
			expect(await s.call({ action: "reuse", squad: "E" })).toBe("REUSE squad E: none (no proven builder of this run that has ended shares its files or area); spawn a fresh builder");
		});

		test("shared files beat same area even with more tokens; a squad whose builder ended and left the declared list still counts", async () => {
			const s = await open();
			await built(s, ["A", "C"]);
			usage(s, "A", { tokens_in: 900 });
			usage(s, "C", { tokens_in: 10 });
			expect((await s.call({ action: "reuse", squad: "T" })).split("\n")[0]).toBe("REUSE squad T: A (squad A, shared files, 900 tokens); C (squad C, same area, 10 tokens)");
			// Declared again without A: A lives only in the stopped list.
			await s.call({ action: "slices", slices: SQUADS.filter(q => q.id !== "A") });
			expect((await s.call({ action: "reuse", squad: "T" })).split("\n")[0]).toStartWith("REUSE squad T: A (squad A, shared files");
		});

		test("top-level files never make two squads neighbours", async () => {
			const s = await open(false, true, [
				{ id: "E", parallel: false, files: ["top.ts"] },
				{ id: "F", parallel: false, files: ["top2.ts"] },
			]);
			await built(s, ["E"]);
			expect(await s.call({ action: "reuse", squad: "F" })).toBe("REUSE squad F: none (no proven builder of this run that has ended shares its files or area); spawn a fresh builder");
		});

		test("the SEED line also tells the Captain to brief the squad and carry its lessons and open findings", async () => {
			const s = await open();
			await built(s, ["A"]);
			const seed = (await s.call({ action: "reuse", squad: "T" })).split("\n")[1];
			expect(seed).toContain('"build squad T"');
			expect(seed).toContain("the squad's lessons and open finding IDs");
		});

		test("names on: spawned builders of this run, by name, and the SEED line points at the name action", async () => {
			const s = await open(true);
			const a = await nameOf(s, { agent: "battle-brother", squad: "A" });
			spawn(s, "battle-brother", a);
			await rate(s, a);
			const out = (await s.call({ action: "reuse", squad: "T" })).split("\n");
			expect(out[0]).toBe(`REUSE squad T: ${a} (squad A, shared files, usage unknown)`);
			expect(out[1]).toEndWith(`; with names on, strategium action name with source: ${a}`);
		});
	});

	describe("the Reuse: guard on a task call", () => {
		test("a corrupted source blocks the whole call, in a task item or in the shared context, any key case", async () => {
			const s = await open();
			await built(s, ["A"], "corrupted");
			for (const [t, context] of [["build squad T\nReuse: A", undefined], ["build squad T\nreuse: A.", undefined], ["build squad T", "REUSE: A"]] as const) {
				const v = task(s, [item(t)], context);
				expect(v?.block).toBe(true);
				expect(v?.reason).toBe(
					"Strategium: a task item names A as its reuse source (Reuse: A), and A is rated corrupted: a corrupted agent is never reused. Pick another source with strategium action reuse, or brief a fresh builder without the Reuse line.",
				);
			}
		});

		test("a proven-regression source passes: only corrupted is vetoed", async () => {
			const s = await open();
			await built(s, ["A"], "proven-regression");
			expect(task(s, [item("build squad T\nReuse: A")])).toBeUndefined();
		});

		describe("every form of the line is read, on its own line only", () => {
			const blocked = async (brief: string, context?: string) => {
				const s = await open();
				await built(s, ["A"], "corrupted");
				return task(s, [item(brief)], context)?.block === true;
			};
			for (const line of ["- Reuse: A", "* Reuse: A", "> Reuse: A", "**Reuse:** A", "__Reuse:__ A", "Reuse : A", "Reuse: `A`", "Reuse: <A>", "Reuse: agent://A", "Reuse: **A**", "  - reuse: A.", "Reuse: A\r"])
				test(`blocks ${JSON.stringify(line)}`, async () => {
					expect(await blocked(`build squad T\n${line}\nmore`)).toBe(true);
				});
			test("a Reuse: that is not on a line of its own, or whose id is on the next line, does not read", async () => {
				expect(await blocked("build squad T\nReuse:\nA")).toBe(false);
				expect(await blocked("build squad T\nPlease Reuse: A")).toBe(false);
			});
			test("40k blank lines and a long id run read in linear time", async () => {
				const s = await open();
				await built(s, ["A"], "corrupted");
				const t0 = performance.now();
				task(s, [item(`build squad T${"\n".repeat(40_000)}`)], `Reuse: A${".".repeat(40_000)}x`);
				task(s, [item(`${" ".repeat(40_000)}x`)]);
				task(s, [item(`Reuse:${" ".repeat(40_000)}`)]);
				expect(performance.now() - t0).toBeLessThan(500);
			});
		});

		test("a proven source, an unrated one and a brief without the line pass", async () => {
			const s = await open();
			await built(s, ["C"]);
			expect(task(s, [item("build squad T\nReuse: C")])).toBeUndefined();
			expect(task(s, [item("build squad T\nReuse: Nobody")])).toBeUndefined();
			expect(task(s, [item("build squad T")])).toBeUndefined();
		});

		test("names on: a rating stored under Name-2 blocks Reuse: Name, and the other way round", async () => {
			const s = await open(true);
			const a = await nameOf(s, { agent: "battle-brother", squad: "A" });
			spawn(s, "battle-brother", a);
			const t = await nameOf(s, { agent: "battle-brother", squad: "T" });
			// omp shows a reused name as Name-2; a rating stored under it still names the same agent.
			const file = join(s.dir, "runs", "sess-0001.json");
			writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ratings: { [`${a}-2`]: { rating: "corrupted", evidence: ["I-1"], model: "@task", effort: "medium" } } }));
			expect(task(s, [item(`build squad T\nReuse: ${a}`, { name: t })])?.block).toBe(true);
			expect(task(s, [item(`build squad T\nReuse: ${a}-2`, { name: t })])?.block).toBe(true);
		});

		test("names off: S1-2 is another agent than S1; names on: the -N suffix folds", async () => {
			const off = await open();
			await built(off, ["A"], "corrupted");
			expect(task(off, [item("build squad T\nReuse: A-2")])).toBeUndefined();
			const on = await open(true);
			const a = await nameOf(on, { agent: "battle-brother", squad: "A" });
			spawn(on, "battle-brother", a);
			await rate(on, a, "corrupted");
			const t = await nameOf(on, { agent: "battle-brother", squad: "T" });
			expect(task(on, [item(`build squad T\nReuse: ${a}-2`, { name: t })])?.block).toBe(true);
			expect(task(on, [item(`build squad T\nReuse: ${a}`, { name: t })])?.block).toBe(true);
		});

		test("it holds without a repo", async () => {
			const s = await open(false, false);
			await built(s, ["A"], "corrupted");
			expect(task(s, [item("build squad T\nReuse: A")])?.block).toBe(true);
		});
	});

	describe("name with source", () => {
		test("the reused brother keeps his surname with the squad's title; a veteran too; the next builder has the squad's own", async () => {
			const s = await open(true);
			const l = await nameOf(s, { agent: "battle-brother", squad: "A" });
			spawn(s, "battle-brother", l);
			const g = await nameOf(s, { agent: "battle-brother", squad: "T" });
			spawn(s, "battle-brother", g);
			const surname = (n: string) => n.replace(/^[A-Z][a-z]+(?=[A-Z])/, "");
			const p = await nameOf(s, { agent: "battle-brother", squad: "T", source: l });
			expect(p).toBe(`Penitent${surname(l)}`);
			spawn(s, "battle-brother", p);
			const v = await nameOf(s, { agent: "veteran", squad: "T", source: l });
			expect(v).toBe(`Veteran${surname(l)}`);
			spawn(s, "veteran", v);
			const next = await nameOf(s, { agent: "battle-brother", squad: "T" });
			expect(surname(next)).toBe(surname(g));
			expect(runFile(s).names?.find(n => n.name === p)?.squad).toBe("T");
		});

		test("an epithet keeps the surname when that name is taken", async () => {
			const s = await open(true);
			const l = await nameOf(s, { agent: "battle-brother", squad: "A" });
			spawn(s, "battle-brother", l);
			spawn(s, "battle-brother", await nameOf(s, { agent: "battle-brother", squad: "T" }));
			spawn(s, "battle-brother", await nameOf(s, { agent: "battle-brother", squad: "T", source: l }));
			expect(await nameOf(s, { agent: "battle-brother", squad: "T", source: l })).toEndWith("Unbroken");
		});

		test("a source retired by a redraft or that is not a builder is refused", async () => {
			const s = await open(true);
			const l = await nameOf(s, { agent: "battle-brother", squad: "A" });
			spawn(s, "battle-brother", l);
			const sc = await nameOf(s, { agent: "scout" });
			spawn(s, "scout", sc);
			expect(await s.call({ action: "name", agent: "battle-brother", squad: "T", source: sc })).toBe(`ERROR ${sc} is not a builder of this run that has spawned`);
			await s.call({ action: "redraft" });
			await s.call({ action: "slices", slices: SQUADS });
			expect(await s.call({ action: "name", agent: "battle-brother", squad: "T", source: l })).toBe(`ERROR ${l} is not a builder of this run that has spawned`);
		});

		test("refusals: another agent, a name that never spawned, a corrupted source", async () => {
			const s = await open(true);
			const l = await nameOf(s, { agent: "battle-brother", squad: "A" });
			expect(await s.call({ action: "name", agent: "scout", source: l })).toBe("ERROR source is only for battle-brother and veteran");
			expect(await s.call({ action: "name", agent: "battle-brother", squad: "T", source: l })).toBe(`ERROR ${l} is not a builder of this run that has spawned`);
			expect(await s.call({ action: "name", agent: "battle-brother", squad: "T", source: "Ghost" })).toBe("ERROR Ghost is not a builder of this run that has spawned");
			spawn(s, "battle-brother", l);
			await rate(s, l, "corrupted");
			expect(await s.call({ action: "name", agent: "battle-brother", squad: "T", source: l })).toBe(`ERROR ${l} is corrupted: a corrupted agent is never reused`);
			expect(runFile(s).names?.filter(n => n.squad === "T")).toEqual([]);
		});
	});

	describe("the tier after a corrupted round", () => {
		const reused = async (agent: string, planned = "light") => {
			process.env.STRATEGIUM_NAMES = "1";
			const s = setup();
			await s.call({ action: "begin", key: "K-1" });
			await s.call({ action: "repo", repo: s.dir });
			await s.call({ action: "slices", slices: SQUADS.map(q => (q.id === "T" ? { ...q, tier: planned } : q)) });
			const l = await nameOf(s, { agent: "battle-brother", squad: "A" });
			spawn(s, "battle-brother", l);
			await rate(s, l);
			const g = await nameOf(s, { agent: "battle-brother", squad: "T" });
			expect(spawn(s, "battle-brother", g)?.model).toBe(DEFAULT[planned as keyof typeof DEFAULT]);
			await rate(s, g, "corrupted");
			const r = await nameOf(s, { agent: agent === "veteran" ? "veteran" : "battle-brother", squad: "T", source: l });
			return { s, l, g, r, spawned: spawn(s, agent, r) };
		};

		test("a reuse battle-brother of the squad runs one tier up", async () => {
			const { spawned } = await reused("battle-brother");
			expect(spawned).toEqual({ model: DEFAULT.standard, note: "Strategium tier standard" });
		});

		test("a reuse veteran runs heavy", async () => {
			const { spawned } = await reused("veteran");
			expect(spawned).toEqual({ model: DEFAULT.heavy, note: "Strategium tier heavy" });
		});

		test("the FALL line names the squad's first brother, not the reused one, and the roster credit agrees", async () => {
			const { s, g, r } = await reused("battle-brother");
			const surname = (n: string) => n.replace(/^[A-Z][a-z]+(?=[A-Z])/, "");
			const out = await rate(s, r, "corrupted");
			expect(out).toContain(`FALL ${surname(g)} squad T falls at end`);
			expect(out).not.toContain(`FALL ${surname(r)} `);
			// The roster credits the squad's first builder: the same surname the FALL line shows.
			const file = JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8"));
			expect(runOutcomes(file)).toEqual([{ brother: surname(g), squad: "T", kind: "fell", penances: expect.any(Number) }]);
		});

		test("a corrupted rating before a redraft does not step the re-planned squad up", async () => {
			const { s } = await reused("battle-brother");
			await s.call({ action: "redraft" });
			await s.call({ action: "slices", slices: SQUADS });
			const g = await nameOf(s, { agent: "battle-brother", squad: "T" });
			expect(spawn(s, "battle-brother", g)?.model).toBe(DEFAULT.light);
		});
	});

	describe("penance 2", () => {
		const surname = (n: string) => n.replace(/^[A-Z][a-z]+(?=[A-Z])/, "");

		test("a proven builder retired by a redraft is not offered (names on)", async () => {
			const s = await open(true);
			const a = await nameOf(s, { agent: "battle-brother", squad: "A" });
			spawn(s, "battle-brother", a);
			launch(s, [a]); // an async builder reaches the cockpit registry, which a redraft does not clear
			finish(s, [a]);
			await rate(s, a);
			expect((await s.call({ action: "reuse", squad: "T" })).split("\n")[0]).toStartWith(`REUSE squad T: ${a} `);
			await s.call({ action: "redraft" });
			await s.call({ action: "slices", slices: SQUADS });
			expect((await s.call({ action: "reuse", squad: "T" })).split("\n")[0]).toStartWith("REUSE squad T: none");
		});

		test("names on: a candidate rated corrupted under Name-2, or running as Name-2, is dropped", async () => {
			const s = await open(true);
			const a = await nameOf(s, { agent: "battle-brother", squad: "A" });
			spawn(s, "battle-brother", a);
			await rate(s, a);
			const file = join(s.dir, "runs", "sess-0001.json");
			const was = JSON.parse(readFileSync(file, "utf8"));
			const edit = (patch: object) => writeFileSync(file, JSON.stringify({ ...was, ...patch }));
			edit({ ratings: { ...was.ratings, [`${a}-2`]: { rating: "corrupted", evidence: ["I-1"], model: "@task", effort: "medium" } } });
			expect((await s.call({ action: "reuse", squad: "T" })).split("\n")[0]).toStartWith("REUSE squad T: none");
			edit({ agents: { [`${a}-2`]: { id: "A", parallel: false, files: ["pkg/t.ts"] } } });
			expect((await s.call({ action: "reuse", squad: "T" })).split("\n")[0]).toStartWith("REUSE squad T: none");
		});

		test("the FALL line after a redraft names the new live brother", async () => {
			const s = await open(true);
			const old = await nameOf(s, { agent: "battle-brother", squad: "T" });
			spawn(s, "battle-brother", old);
			await s.call({ action: "redraft" });
			await s.call({ action: "slices", slices: SQUADS });
			const fresh = await nameOf(s, { agent: "battle-brother", squad: "T" });
			spawn(s, "battle-brother", fresh);
			const out = await rate(s, fresh, "corrupted");
			expect(out).toContain(`FALL ${surname(fresh)} squad T falls at end`);
			if (surname(old) !== surname(fresh)) expect(out).not.toContain(`FALL ${surname(old)} `);
		});

		test("names off: a reuse brief that mentions the source's squad is counted for the squad after `build`", async () => {
			const s = await open(false, true, [
				{ id: "A", parallel: false, files: ["a/a.ts"], tier: "heavy" },
				{ id: "T", parallel: false, files: ["t/t.ts"], tier: "light" },
			]);
			expect(task(s, [{ agent: "battle-brother", name: "X", isolated: true, task: "Reuse: A\nbuild squad T\nA built squad A before" }])).toBeUndefined();
			expect(spawn(s, "battle-brother", "X")?.model).toBe(DEFAULT.light);
		});

		describe("the guard reads more forms", () => {
			const blocked = async (brief: string) => {
				const s = await open();
				await built(s, ["A"], "corrupted");
				return task(s, [item(`build squad T\n${brief}`)])?.block === true;
			};
			for (const line of ["1. Reuse: A", "2) Reuse: A", "# Reuse: A", "## Reuse: A", "(Reuse: A)", '"Reuse: A"', "'Reuse: A'", 'Reuse: "A"', "Reuse: [A](x)", "- 3. Reuse: A"])
				test(`blocks ${JSON.stringify(line)}`, async () => {
					expect(await blocked(line)).toBe(true);
				});
			test("an id that continues as a path is not the agent", async () => {
				expect(await blocked("Reuse: A/names.ts")).toBe(false);
				expect(await blocked("Reuse: Ax")).toBe(false);
			});
			test("hostile prefixes stay linear", async () => {
				const s = await open();
				await built(s, ["A"], "corrupted");
				const t0 = performance.now();
				for (const t of [`${"1.".repeat(20_000)}x`, `${"- ".repeat(20_000)}x`, `${"# ".repeat(20_000)}Reuse`, `Reuse:${'" '.repeat(20_000)}`, `Reuse:${"_".repeat(40_000)}/`]) task(s, [item(t)]);
				expect(performance.now() - t0).toBeLessThan(500);
			});
		});
	});
});

// The tally (#144): `end` folds the builders' ratings into <state dir>/tally.json, `report` shows it.
describe("tally wiring (#144)", () => {
	type S = ReturnType<typeof setup>;
	const SQ = [
		{ id: "S1", parallel: true, files: ["docs/a.md"] },
		{ id: "S2", parallel: true, files: ["b.ts"] },
	];
	const rate = (s: S, agent: string, rating: string, p: object = {}) => s.call({ action: "rate", agent, rating, evidence: ["I-3"], model: "@task", effort: "medium", ...p });
	const tallyOf = (dir: string) => JSON.parse(readFileSync(join(dir, "tally.json"), "utf8")).rows as { model: string; effort: string; kind: string; proven: number; regression: number; corrupted: number }[];
	const begin = async (names: boolean) => {
		if (names) process.env.STRATEGIUM_NAMES = "1";
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "repo", repo: s.dir });
		await s.call({ action: "slices", slices: SQ });
		return s;
	};
	// An async builder: spawned, then running in the cockpit registry (names off).
	const asyncBuilder = (s: S, id: string, agent = "battle-brother") => {
		s.handlers.before_subagent_spawn[0]({ agent, spawnKey: id }, s.ctx);
		const event = { toolName: "task", input: { tasks: [{ agent, name: id, task: `build squad ${id}` }] }, details: { progress: [{ index: 0, id, status: "running" }] }, isError: false };
		for (const h of s.handlers.tool_result) h(event, s.ctx);
	};

	test("names off: rated builders of a docs squad and a code squad are tallied at end", async () => {
		const s = await begin(false);
		asyncBuilder(s, "S1");
		asyncBuilder(s, "S2");
		await rate(s, "S1", "corrupted");
		await rate(s, "S2", "proven");
		const out = await s.call({ action: "end" });
		expect(out).toStartWith("ENDED K-1");
		expect(out).toEndWith("TALLY recorded 2 rating(s)");
		expect(tallyOf(s.dir)).toEqual([
			{ model: "@task", effort: "medium", kind: "code", proven: 1, regression: 0, corrupted: 0 },
			{ model: "@task", effort: "medium", kind: "docs", proven: 0, regression: 0, corrupted: 1 },
		]);
	});

	test("names on: a builder of a blocking task, known only by its name, is counted", async () => {
		const s = await begin(true);
		const out = await s.call({ action: "name", agent: "battle-brother", squad: "S1" });
		const name = out.split("\n").at(-1)!.slice(5);
		s.handlers.before_subagent_spawn[0]({ agent: "battle-brother", spawnKey: name }, s.ctx);
		await rate(s, name, "proven-regression");
		const end = await s.call({ action: "end" });
		expect(end).toEndWith("TALLY recorded 1 rating(s)");
		expect(tallyOf(s.dir)).toEqual([{ model: "@task", effort: "medium", kind: "docs", proven: 0, regression: 1, corrupted: 0 }]);
	});

	test("only a non-builder rated: no TALLY line and no tally.json", async () => {
		const s = await begin(false);
		asyncBuilder(s, "Scout1", "scout");
		expect(await rate(s, "Scout1", "proven")).toStartWith("RATED");
		const out = await s.call({ action: "end" });
		expect(out).toStartWith("ENDED K-1");
		expect(out).not.toContain("TALLY");
		expect(existsSync(join(s.dir, "tally.json"))).toBe(false);
	});

	test("an unreadable tally.json: end still answers ENDED, warns, and leaves the bytes alone", async () => {
		const s = await begin(false);
		writeFileSync(join(s.dir, "tally.json"), "not json");
		asyncBuilder(s, "S2");
		await rate(s, "S2", "proven");
		const out = await s.call({ action: "end" });
		expect(out).toStartWith("ENDED K-1");
		expect(out).toEndWith("WARN TALLY not written: tally unreadable (not valid JSON)");
		expect(readFileSync(join(s.dir, "tally.json"), "utf8")).toBe("not json");
	});

	// Rewrites the run file the way a crash, a redraft or a hostile edit would leave it.
	const rewrite = (s: S, change: (run: { slices?: Record<string, unknown>[]; agents?: Record<string, Record<string, unknown>>; names?: Record<string, unknown>[] }) => void) => {
		const file = join(s.dir, "runs", "sess-0001.json");
		const run = JSON.parse(readFileSync(file, "utf8"));
		change(run);
		writeFileSync(file, JSON.stringify(run));
	};

	test("CB2/N3: a slice without a files array: end still answers ENDED, warns, and releases the claim", async () => {
		const s = await begin(false);
		asyncBuilder(s, "S1");
		await rate(s, "S1", "proven");
		rewrite(s, run => {
			for (const sl of [...(run.slices ?? []), ...Object.values(run.agents ?? {})]) delete sl.files;
		});
		const out = await s.call({ action: "end" });
		expect(out).toStartWith("ENDED K-1");
		expect(out).toMatch(/\nWARN TALLY not written: .+$/);
		expect(existsSync(lockPath(s.dir, "K-1"))).toBe(false);
		expect(existsSync(join(s.dir, "tally.json"))).toBe(false);
	});

	test("CN2: a redraft that reuses an id keeps the squad kind the agent was built under", async () => {
		const s = await begin(false);
		asyncBuilder(s, "S1");
		await rate(s, "S1", "proven");
		rewrite(s, run => {
			for (const sl of run.slices ?? []) if (sl.id === "S1") sl.files = ["src/new.ts"];
		});
		await s.call({ action: "end" });
		expect(tallyOf(s.dir).map(r => r.kind)).toEqual(["docs"]);
	});

	test("N3/CN5: the agent's own copy under its id wins over another agent that shares the squad id", async () => {
		const s = await begin(false);
		asyncBuilder(s, "S1");
		await rate(s, "S1", "proven");
		rewrite(s, run => {
			run.agents = { X: { id: "S1", parallel: true, files: ["src/other.ts"] }, S1: { id: "S1", parallel: true, files: ["docs/a.md"] } };
		});
		await s.call({ action: "end" });
		expect(tallyOf(s.dir).map(r => r.kind)).toEqual(["docs"]);
	});

	test("N1/CN2: only unresolved builders rated: the skipped line, and no tally.json", async () => {
		const s = await begin(false);
		asyncBuilder(s, "S1");
		await rate(s, "S1", "proven");
		rewrite(s, run => {
			run.slices = [];
			run.agents = {};
		});
		expect(await s.call({ action: "end" })).toEndWith("TALLY recorded 0 rating(s) (1 skipped)");
		expect(existsSync(join(s.dir, "tally.json"))).toBe(false);
	});

	test("N2/CN3 (slow): names on, the lock held by a live pid: end waits 12 s + 2 s, then warns for the roster and the tally", async () => {
		const s = await begin(true);
		const name = (await s.call({ action: "name", agent: "battle-brother", squad: "S1" })).split("\n").at(-1)!.slice(5);
		s.handlers.before_subagent_spawn[0]({ agent: "battle-brother", spawnKey: name }, s.ctx);
		const done = { toolName: "task", input: { tasks: [{ agent: "battle-brother", name, task: "build squad S1" }] }, details: { progress: [{ index: 0, id: name, status: "completed" }] }, isError: false };
		for (const h of s.handlers.tool_result) h(done, s.ctx);
		await rate(s, name, "proven");
		// A live holder: a child keeps touching the lock, because end blocks this process and a lock older than 10 s is taken as stale.
		const lock = join(s.dir, "roster.lock");
		writeFileSync(lock, `${process.pid}-held`);
		const holder = Bun.spawn([process.execPath, "-e", `const fs=require("fs");const t=setInterval(()=>{try{fs.utimesSync(${JSON.stringify(lock)},new Date(),new Date())}catch{}},200);setTimeout(()=>clearInterval(t),30000)`], { stdio: ["ignore", "ignore", "ignore"] });
		try {
			const t0 = Date.now();
			var out = await s.call({ action: "end" });
			expect(Date.now() - t0).toBeLessThan(20_000);
		} finally {
			holder.kill();
		}
		expect(out).toStartWith("ENDED K-1");
		expect(out).toContain("WARN ROSTER not written: roster busy");
		expect(out).toEndWith("WARN TALLY not written: tally busy");
		expect(existsSync(lockPath(s.dir, "K-1"))).toBe(false);
	}, 40_000);

	test("CN2: a builder whose squad is gone is reported as skipped, the others are counted", async () => {
		const s = await begin(false);
		asyncBuilder(s, "S1");
		asyncBuilder(s, "S2");
		await rate(s, "S1", "proven");
		await rate(s, "S2", "proven");
		rewrite(s, run => {
			run.slices = (run.slices ?? []).filter(sl => sl.id !== "S2");
			run.agents = Object.fromEntries(Object.entries(run.agents ?? {}).filter(([, sl]) => sl.id !== "S2"));
		});
		expect(await s.call({ action: "end" })).toEndWith("TALLY recorded 1 rating(s) (1 skipped)");
		expect(tallyOf(s.dir)).toEqual([{ model: "@task", effort: "medium", kind: "docs", proven: 1, regression: 0, corrupted: 0 }]);
	});

	test("CN4: names on: a rating of an agent that is not a builder is not counted, even when its name entry has a squad", async () => {
		const s = await begin(true);
		const name = (await s.call({ action: "name", agent: "scout" })).split("\n").at(-1)!.slice(5);
		s.handlers.before_subagent_spawn[0]({ agent: "scout", spawnKey: name }, s.ctx);
		rewrite(s, run => {
			for (const n of run.names ?? []) n.squad = "S1";
		});
		expect(await rate(s, name, "proven")).toStartWith("RATED");
		const out = await s.call({ action: "end" });
		expect(out).not.toContain("TALLY");
		expect(existsSync(join(s.dir, "tally.json"))).toBe(false);
	});

	test("CN4: names on: the -N suffix omp adds to a spawn id is looked through", async () => {
		const s = await begin(true);
		const name = (await s.call({ action: "name", agent: "battle-brother", squad: "S1" })).split("\n").at(-1)!.slice(5);
		asyncBuilder(s, `${name}-2`);
		expect(await rate(s, `${name}-2`, "proven")).toStartWith("RATED");
		expect(await s.call({ action: "end" })).toEndWith("TALLY recorded 1 rating(s)");
		expect(tallyOf(s.dir)).toEqual([{ model: "@task", effort: "medium", kind: "docs", proven: 1, regression: 0, corrupted: 0 }]);
	});

	describe("report", () => {
		const seeded = (rows: object[]) => {
			const s = setup();
			writeFileSync(join(s.dir, "tally.json"), JSON.stringify({ version: 1, rows }));
			return s;
		};
		const day = async (s: S) => {
			await s.call({ action: "begin", key: "K-1" });
			await s.call({ action: "stop" });
		};

		test("ends with the TALLY lines and the PROPOSE line of a failing tier", async () => {
			const s = seeded([{ model: "@smol", effort: "medium", kind: "code", proven: 1, regression: 0, corrupted: 2 }]);
			await day(s);
			const out = (await s.call({ action: "report" })).split("\n");
			expect(out.slice(-2)).toEqual(["TALLY @smol medium code: proven 1, proven-regression 0, corrupted 2", "PROPOSE code squads: default tier standard (now light: @smol medium corrupted 2 of 3)"]);
		});

		test("an unreadable tally.json gives a WARN line, not an error", async () => {
			const s = setup();
			writeFileSync(join(s.dir, "tally.json"), "{");
			await day(s);
			expect((await s.call({ action: "report" })).split("\n").at(-1)).toBe(`WARN TALLY ${join(s.dir, "tally.json")} unreadable (not valid JSON): fix or delete it`);
		});

		test("a report with a date shows no tally", async () => {
			const s = seeded([{ model: "@smol", effort: "medium", kind: "code", proven: 1, regression: 0, corrupted: 2 }]);
			await day(s);
			expect(await s.call({ action: "report", date: "2026-11-16" })).not.toContain("TALLY");
		});

		test("N1: no day file at all: IDLE, then the TALLY and PROPOSE lines", async () => {
			const s = seeded([{ model: "@smol", effort: "medium", kind: "code", proven: 1, regression: 0, corrupted: 2 }]);
			expect((await s.call({ action: "report" })).split("\n")).toEqual([
				"IDLE",
				"TALLY @smol medium code: proven 1, proven-regression 0, corrupted 2",
				"PROPOSE code squads: default tier standard (now light: @smol medium corrupted 2 of 3)",
			]);
		});

		test("CN4: a custom STRATEGIUM_TIERS selector maps the row to its tier", async () => {
			const s = seeded([{ model: "@mine", effort: "low", kind: "code", proven: 0, regression: 0, corrupted: 3 }]);
			process.env.STRATEGIUM_TIERS = "light=@mine:low";
			try {
				await day(s);
				expect((await s.call({ action: "report" })).split("\n").at(-1)).toBe("PROPOSE code squads: default tier standard (now light: @mine low corrupted 3 of 3)");
			} finally {
				delete process.env.STRATEGIUM_TIERS;
			}
		});

		test("a fresh state dir still answers exactly IDLE", async () => {
			expect(await setup().call({ action: "report" })).toBe("IDLE");
		});
	});

	test("the tool description says report shows the tally and end updates it", async () => {
		const s = setup();
		expect(s.tool.description).toContain("report (date?) also ends with the TALLY and PROPOSE lines");
		expect(s.tool.description).toContain("end also adds the run's rated builders to <state dir>/tally.json");
	});
});

// The plugin's own events in the vault's daily note (#151): off by default, one line per event, never a duplicate.
describe("vault records (#151)", () => {
	type S = ReturnType<typeof setup>;
	const CONTRACT = { daily: "Daily/{date}.md", heading: "## 📝 Log", line: "- {time} - Strategium {key}: {text}", createDaily: true };
	const vaultDir = (contract: unknown = CONTRACT) => {
		const v = mkdtempSync(join(tmpdir(), "st-vault-"));
		dirs.push(v);
		if (contract !== null) writeFileSync(join(v, ".strategium.json"), typeof contract === "string" ? contract : JSON.stringify(contract));
		return v;
	};
	const dailyFile = (v: string) => join(v, "Daily", "2026-11-16.md");
	const dailyLines = (v: string) => (existsSync(dailyFile(v)) ? readFileSync(dailyFile(v), "utf8").split("\n").filter(l => l.startsWith("- ")) : []);
	const at = (h: number, m: number) => setSystemTime(new Date(2026, 10, 16, h, m, 0));
	const sealTodo = (status: string) => [{ name: "Scriptorium", tasks: [{ content: "[seal] Plan", status }] }];
	const todo = (s: S, status: string) => s.handlers.tool_result.forEach(h => h({ toolName: "todo", isError: false, details: { phases: sealTodo(status) } }, s.ctx));
	const bash = (s: S, command: string, extra: object = {}, ctx: object = s.ctx, text = "https://github.com/o/r/pull/7") =>
		s.handlers.tool_result.forEach(h => h({ toolName: "bash", input: { command }, isError: false, details: {}, content: [{ type: "text", text }], ...extra }, ctx));
	const runOf = (s: S, sid = "sess-0001") => JSON.parse(readFileSync(join(s.dir, "runs", `${sid}.json`), "utf8")) as { recorded?: unknown; merged?: unknown };
	// The clock is frozen at the day's 09:00: the daily's name and the lines' times are then known.
	const withVault = (v: string) => {
		process.env.STRATEGIUM_VAULT = v;
		at(9, 0);
		return setup();
	};
	// begin, a seal, the first PR, end: the calls a run makes, with the state dir masked. A frozen clock never ends a lock wait: `clock` false leaves the real one running.
	const script = async (s: S, clock = true) => {
		const out: string[] = [];
		if (clock) at(9, 0);
		out.push(await s.call({ action: "begin", key: "K-1" }));
		todo(s, "in_progress");
		todo(s, "completed");
		bash(s, "gh pr create --fill");
		if (clock) at(9, 30);
		out.push(await s.call({ action: "end" }));
		return out.map(o => o.replaceAll(s.dir, "<dir>").replace(/T\d\d-\d\d-\d\d/, "T<time>"));
	};

	test("A1: begin, a granted seal, the first PR and end each add one line at the local time", async () => {
		const v = vaultDir();
		const s = withVault(v);
		at(9, 5);
		await s.call({ action: "begin", key: "K-1" });
		at(9, 20);
		todo(s, "in_progress");
		todo(s, "completed");
		at(9, 30);
		bash(s, "gh pr create --fill");
		at(10, 0);
		expect(await s.call({ action: "end" })).toStartWith("ENDED K-1");
		const lines = dailyLines(v);
		expect(lines).toHaveLength(4);
		expect(lines.slice(0, 3)).toEqual(["- 09:05 - Strategium K-1: run begun", "- 09:20 - Strategium K-1: seal Plan granted", "- 09:30 - Strategium K-1: PR opened https://github.com/o/r/pull/7"]);
		expect(lines[3]).toMatch(/^- 10:00 - Strategium K-1: run ended \(\d+ min active, \d+ min paused\)$/);
		expect(readFileSync(dailyFile(v), "utf8").split("\n")[0]).toBe("## 📝 Log");
	});

	test("B1: a switch writes the old key's end line and the new key's begin line", async () => {
		const v = vaultDir();
		const s = withVault(v);
		at(9, 5);
		await s.call({ action: "begin", key: "K-1" });
		at(9, 30);
		await s.call({ action: "switch", key: "K-2" });
		expect(dailyLines(v).map(l => l.replace(/^- \d\d:\d\d - Strategium /, ""))).toEqual(["K-1: run begun", "K-1: run ended (25 min active, 0 min paused)", "K-2: run begun"]);
	});

	test("A2: restart, same-key begin, takeover, replayed todo and a second gh pr create add no line", async () => {
		const v = vaultDir();
		const s = withVault(v);
		at(9, 5);
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "begin", key: "K-1" });
		todo(s, "in_progress");
		todo(s, "completed");
		todo(s, "completed");
		bash(s, "gh pr create --fill");
		bash(s, "gh pr create --fill");
		expect(dailyLines(v)).toHaveLength(3);
		expect(runOf(s).recorded).toEqual(["begin", "seal:Plan", "pr"]);
		const again = setup("sess-0001", s.dir);
		await again.start();
		await again.call({ action: "begin", key: "K-1" });
		expect(dailyLines(v)).toHaveLength(3);
		const b = setup("sess-0002", s.dir);
		await b.call({ action: "begin", key: "K-1", takeover: "sess-0001" });
		expect(dailyLines(v)).toHaveLength(3);
		expect(runOf(b, "sess-0002").recorded).toEqual(["begin", "seal:Plan", "pr"]);
	});

	test("a hand-edited recorded list is sanitized on read: junk dropped, ids kept", async () => {
		const v = vaultDir();
		const s = withVault(v);
		await s.call({ action: "begin", key: "K-1" });
		const file = join(s.dir, "runs", "sess-0001.json");
		const edit = (recorded: unknown) => writeFileSync(file, JSON.stringify({ ...runOf(s), recorded }));
		edit(["pr", "pr", 5, "x".repeat(221)]);
		bash(s, "gh pr create --fill");
		todo(s, "in_progress");
		todo(s, "completed");
		expect(runOf(s).recorded).toEqual(["pr", "seal:Plan"]);
		expect(dailyLines(v).map(l => l.split(": ")[1])).toEqual(["run begun", "seal Plan granted"]);
		edit("oops");
		bash(s, "gh pr create --fill");
		expect(runOf(s).recorded).toEqual(["pr"]);
	});

	test("A3: vault off writes nothing, adds no recorded field and changes no output", async () => {
		const v = vaultDir();
		delete process.env.STRATEGIUM_VAULT;
		const base = await script(setup());
		const off = withVault(v); // STRATEGIUM_VAULT set again here, so only the saved `off` can keep it quiet
		await off.sub("config", "vault off");
		off.notes.length = 0;
		// The same script as base, on the off run: its outputs must equal the unset-variable run's.
		expect(await script(off)).toEqual(base);
		expect(existsSync(join(v, "Daily"))).toBe(false);
		expect(off.notes.filter(n => n.includes("vault"))).toEqual([]);
		await off.call({ action: "begin", key: "K-0" });
		todo(off, "in_progress");
		todo(off, "completed");
		bash(off, "gh pr create --fill");
		expect("recorded" in runOf(off)).toBe(false);
	});

	describe("A3: an unusable vault costs one notice and changes no output", () => {
		const reasons: [string, () => string, RegExp][] = [
			["folder missing", () => join(vaultDir(), "nope"), /unreachable \(\w+\)/],
			["no contract", () => vaultDir(null), /no contract \(\.strategium\.json\)/],
			["invalid contract", () => vaultDir("{nope"), /contract invalid: not JSON/],
			["held vault.lock", () => vaultDir(), /daily busy/],
		];
		for (const [label, make, why] of reasons) {
			test(label, async () => {
				const clock = label !== "held vault.lock";
				const base = await script(setup(), clock);
				const v = make();
				const s = withVault(v);
				if (!clock) setSystemTime();
				if (label === "held vault.lock") writeFileSync(join(s.dir, "vault.lock"), `${process.pid}-held`);
				expect(await script(s, clock)).toEqual(base);
				const notices = s.notes.filter(n => n.startsWith("Strategium: vault "));
				expect(notices).toHaveLength(1);
				expect(notices[0]).toMatch(why);
				expect(notices[0]).toEndWith("; the run goes on and this event is not in the vault");
				expect(existsSync(join(v, "Daily"))).toBe(false);
			}, 15000);
		}
	});

	describe("the setting", () => {
		const listed = (s: S) => s.notes.at(-1)!.split("\n").find(l => l.startsWith("vault: "));

		test("the listing starts at vault: off (default)", async () => {
			const s = setup();
			await s.sub("config");
			expect(listed(s)).toBe("vault: off (default)");
		});

		test("vault <abs> saves the folder (quotes stripped) and applies at once", async () => {
			const v = vaultDir();
			const s = setup();
			await s.sub("config", `vault "${v}"`);
			expect(readFileSync(join(s.dir, "vault"), "utf8")).toBe(v);
			expect(listed(s)).toBe(`vault: ${v} (/strategium-config) · contract ok`);
			at(9, 5);
			await s.call({ action: "begin", key: "K-1" });
			expect(dailyLines(v)).toEqual(["- 09:05 - Strategium K-1: run begun"]);
		});

		test("a missing folder is accepted and reported in the listing", async () => {
			const v = join(vaultDir(), "nope");
			const s = setup();
			await s.sub("config", `vault ${v}`);
			expect(listed(s)).toMatch(new RegExp(`^vault: .*nope \\(/strategium-config\\) · unreachable \\(\\w+\\)$`));
		});

		test("a relative path or a bare vault is refused and writes no file", async () => {
			const s = setup();
			await s.sub("config", "vault some/where");
			expect(s.notes.at(-1)).toContain("vault takes an absolute folder path, off or default");
			await s.sub("config", "vault");
			expect(s.notes.at(-1)).toContain("config takes");
			expect(existsSync(join(s.dir, "vault"))).toBe(false);
		});

		test("STRATEGIUM_VAULT picks it, vault off beats it, vault default falls back to it", async () => {
			const v = vaultDir();
			const s = withVault(v);
			await s.sub("config");
			expect(listed(s)).toBe(`vault: ${v} (STRATEGIUM_VAULT) · contract ok`);
			await s.sub("config", "vault off");
			expect(readFileSync(join(s.dir, "vault"), "utf8")).toBe("off");
			expect(listed(s)).toBe("vault: off (/strategium-config)");
			await s.call({ action: "begin", key: "K-1" });
			expect(existsSync(join(v, "Daily"))).toBe(false);
			await s.sub("config", "vault default");
			expect(existsSync(join(s.dir, "vault"))).toBe(false);
			expect(listed(s)).toBe(`vault: ${v} (STRATEGIUM_VAULT) · contract ok`);
		});

		test("a relative STRATEGIUM_VAULT is ignored", async () => {
			process.env.STRATEGIUM_VAULT = "some/where";
			const s = setup();
			await s.sub("config");
			expect(listed(s)).toBe("vault: off (default)");
		});

		test("the listing names a bad contract", async () => {
			const s = withVault(vaultDir("[]"));
			await s.sub("config");
			expect(listed(s)).toEndWith("(STRATEGIUM_VAULT) · contract invalid: not an object");
		});
	});

	describe("first PR detection", () => {
		const DELIVERY = `gh pr create -R github.com/o/r -d -B main -H feat/151-x -t "$title" -F - -a @me -l "bug" <<'GH_x7'\nCloses #151; done & dusted | really\n- ok; fine && more\nGH_x7`;
		const yes = [
			"gh pr create --fill",
			"glab mr create --fill",
			"cd x && glab mr create",
			"cd a && cd b && gh pr create --title x",
			"gh pr create 2>&1",
			"gh pr create && echo done",
			DELIVERY,
			`cd C:/p && ${DELIVERY}`,
			`gh pr create --title "fix; a & b | c -w --web" --fill`,
			`gh pr create -t 'x; y & z' --fill`,
			`gh pr create -t "say \\"-w\\"; ok" --fill`,
		];
		const CREATE = `gh pr create -R github.com/o/r -d -B main -H feat/151-x -t "$title" -F - -a @me <<'GH_b'\nCloses #151; a & b | c\nGH_b`;
		const TITLE = `title=$(cat <<'GH_t'\nTitle; R&D\nGH_t\n)`;
		yes.push(`${TITLE}\n${CREATE}`, `${TITLE}\n${CREATE}\n`, `title="x; y"\ncd C:/p && ${CREATE}`, "gh pr create --title a\\|b --fill", "gh pr create --fill\n\n");
		const no = [
			"gh pr create --web", "gh pr create -w", "gh pr create --dry-run", "gh pr create -h", "gh pr create --help", "gh pr create | tee x", "gh pr create; echo hi", "echo gh pr create", "gh pr view 7", "gh pr merge 7", "git log && gh pr create", "gh pr create &", "gh pr create || true",
			`${CREATE}\necho done`, "gh pr create --fill\necho done", "gh pr create --fill\ngit push", `echo hi\n${CREATE}`, `${TITLE}\nrm -rf x\n${CREATE}`, `${TITLE}\ngit push; ${CREATE}`,
			"gh pr create -dw", "gh pr create -fw", "gh pr create -hd", "gh pr create --web=true", "gh pr create --dry-run=x", "gh pr create --help=all",
			'gh pr create -t "unclosed', "gh pr create -t 'unclosed", "gh pr create \\-w", "gh pr create --\\web",
		];

		test("a Captain's gh pr create or glab mr create adds one line, with or without a URL", async () => {
			for (const command of yes) {
				const v = vaultDir();
				const s = withVault(v);
				await s.call({ action: "begin", key: "K-1" });
				bash(s, command, {}, s.ctx, command.startsWith("glab") ? "https://gitlab.com/o/r/-/merge_requests/3" : "created");
				const lines = dailyLines(v).map(l => l.split(": ").slice(1).join(": "));
				expect(lines, command).toEqual(["run begun", command.startsWith("glab") ? "PR opened https://gitlab.com/o/r/-/merge_requests/3" : "PR opened"]);
			}
		}, 20000);

		test("anything else, an error, an exit code, a background run or a subagent adds none", async () => {
			const v = vaultDir();
			const s = withVault(v);
			await s.call({ action: "begin", key: "K-1" });
			for (const command of no) bash(s, command);
			bash(s, "gh pr create --fill", { isError: true });
			bash(s, "gh pr create --fill", { details: { exitCode: 1 } });
			bash(s, "gh pr create --fill", { details: { async: { state: "running", jobId: "bg_1" } } });
			bash(s, "gh pr create --fill", { input: { command: "gh pr create --fill", async: true } });
			bash(s, "gh pr create --fill", {}, { ...s.ctx, agent: { kind: "sub" } });
			expect(dailyLines(v)).toHaveLength(1);
			expect(runOf(s).recorded).toEqual(["begin"]);
		}, 20000);
	});

	test("a merge with names off and the vault on puts ', PR merged' in the end line", async () => {
		const v = vaultDir();
		const s = withVault(v);
		await s.call({ action: "begin", key: "K-1" });
		bash(s, "gh pr merge 7 --merge --delete-branch");
		expect(runOf(s).merged).toBe(true);
		await s.call({ action: "end" });
		expect(dailyLines(v).at(-1)).toMatch(/: run ended, PR merged \(\d+ min active, \d+ min paused\)$/);
	});

	test("a merge with names and the vault off still leaves no merged flag", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		bash(s, "gh pr merge 7");
		expect("merged" in runOf(s)).toBe(false);
	});

	test("N7: a null item in the tool result's content does not throw and the URL is still found", async () => {
		const v = vaultDir();
		const s = withVault(v);
		await s.call({ action: "begin", key: "K-1" });
		expect(() => bash(s, "gh pr create --fill", { content: [null, undefined, { type: "text", text: "https://github.com/o/r/pull/9" }] })).not.toThrow();
		expect(dailyLines(v).at(-1)).toEndWith(": PR opened https://github.com/o/r/pull/9");
	});

	test("N3: two seals granted in one todo result are both recorded", async () => {
		const v = vaultDir();
		const s = withVault(v);
		await s.call({ action: "begin", key: "K-1" });
		const seals = (a: string, b: string) => [{ name: "Scriptorium", tasks: [{ content: "[seal] Plan", status: a }, { content: "[seal] UI", status: b }] }];
		const send = (phases: unknown) => s.handlers.tool_result.forEach(h => h({ toolName: "todo", isError: false, details: { phases } }, s.ctx));
		send(seals("in_progress", "pending"));
		send(seals("completed", "completed"));
		expect(runOf(s).recorded).toEqual(["begin", "seal:Plan", "seal:UI"]);
		expect(dailyLines(v).map(l => l.split(": ")[1])).toEqual(["run begun", "seal Plan granted", "seal UI granted"]);
	});

	describe("a daily that is missing (the vault does not create it unless the contract says createDaily)", () => {
		const { createDaily: _, ...NO_CREATE } = { ...CONTRACT, createDaily: true };
		const notices = (s: S) => s.notes.filter(n => n.startsWith("Strategium: vault "));

		test("CN4: default skips every line and warns once with daily missing", async () => {
			const v = vaultDir(NO_CREATE);
			const s = withVault(v);
			await script(s);
			expect(existsSync(join(v, "Daily"))).toBe(false);
			expect(notices(s)).toHaveLength(1);
			expect(notices(s)[0]).toContain("daily missing");
		});

		test("CN4: an existing daily is written without createDaily", async () => {
			const v = vaultDir(NO_CREATE);
			mkdirSync(join(v, "Daily"));
			writeFileSync(dailyFile(v), "# Day\n\n## 📝 Log\n");
			const s = withVault(v);
			await s.call({ action: "begin", key: "K-1" });
			expect(dailyLines(v)).toEqual(["- 09:00 - Strategium K-1: run begun"]);
			expect(notices(s)).toEqual([]);
		});

		test("CN4: createDaily true creates the daily and its folder", async () => {
			const v = vaultDir({ ...NO_CREATE, createDaily: true });
			const s = withVault(v);
			await s.call({ action: "begin", key: "K-1" });
			expect(dailyLines(v)).toEqual(["- 09:00 - Strategium K-1: run begun"]);
		});
	});

	describe("end by another session", () => {
		const two = async () => {
			const v = vaultDir();
			const s = withVault(v);
			await s.call({ action: "begin", key: "K-1" });
			return { v, s, b: setup("sess-0002", s.dir) };
		};

		test("N4: a refused end writes nothing", async () => {
			const { v, b } = await two();
			expect(await b.call({ action: "end", key: "K-1" })).toStartWith("ERROR K-1 belongs to session");
			expect(dailyLines(v)).toEqual(["- 09:00 - Strategium K-1: run begun"]);
		});

		test("CN5: an end by takeover writes the line with the other run's key and merged flag", async () => {
			const { v, s, b } = await two();
			bash(s, "gh pr merge 7 --merge --delete-branch");
			expect(await b.call({ action: "end", key: "K-1", takeover: "sess-0001" })).toStartWith("ENDED K-1");
			expect(dailyLines(v)).toHaveLength(2);
			expect(dailyLines(v)[1]).toMatch(/^- 09:00 - Strategium K-1: run ended, PR merged( \(.*\))?$/);
		});
	});
});

// The Captain's own entries in the vault (#152): one `record` call, the plugin does the writing.
describe("vault record (#152)", () => {
	type S = ReturnType<typeof setup>;
	const CONTRACT = { daily: "Daily/{date}.md", heading: "## 📝 Log", line: "- {time} - Strategium {key}: {text}", createDaily: true, notes: ["Projects/*.md"] };
	const vaultDir = (contract: unknown = CONTRACT) => {
		const v = mkdtempSync(join(tmpdir(), "st-vault-"));
		dirs.push(v);
		if (contract !== null) writeFileSync(join(v, ".strategium.json"), typeof contract === "string" ? contract : JSON.stringify(contract));
		return v;
	};
	const dailyFile = (v: string) => join(v, "Daily", "2026-11-16.md");
	const noteFile = (v: string, rel = "Projects/K.md") => join(v, ...rel.split("/"));
	const at = (h: number, m: number) => setSystemTime(new Date(2026, 10, 16, h, m, 0));
	const withNote = (contract: unknown = CONTRACT, body: string | Buffer = "# K\n") => {
		const v = vaultDir(contract);
		mkdirSync(join(v, "Projects"));
		writeFileSync(noteFile(v), body);
		return v;
	};
	// A run with a vault: begin at 09:00 (one "run begun" line in the daily), then the clock moves to 09:12.
	const begun = async (v: string) => {
		process.env.STRATEGIUM_VAULT = v;
		at(9, 0);
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		at(9, 12);
		return s;
	};
	const bytes = (v: string) => ({ daily: readFileSync(dailyFile(v)), note: existsSync(noteFile(v)) ? readFileSync(noteFile(v)) : undefined });
	const runOf = (s: S) => JSON.parse(readFileSync(join(s.dir, "runs", "sess-0001.json"), "utf8")) as { recorded?: unknown };
	// Built at run time so the file holds no token-shaped literal.
	const GH = `ghp_${"a1B2".repeat(6)}`;

	// The test host stubs zod, so the schema itself cannot be read here; the description is what the model sees.
	test("the tool description names record, text and note", async () => {
		const s = setup();
		expect(s.tool.description).toContain("record (text, note?; Captain only)");
	});

	test("R1: record adds the line under the heading in the daily, and in an allowed note", async () => {
		const v = withNote();
		const s = await begun(v);
		expect(await s.call({ action: "record", text: "chose X over Y" })).toBe("RECORDED daily");
		expect(readFileSync(dailyFile(v), "utf8").split("\n").filter(l => l.startsWith("- "))).toEqual(["- 09:00 - Strategium K-1: run begun", "- 09:12 - Strategium K-1: chose X over Y"]);
		expect(readFileSync(noteFile(v), "utf8")).toBe("# K\n");
		at(9, 13);
		expect(await s.call({ action: "record", text: "installed svc", note: "Projects/K.md" })).toBe("RECORDED daily\nRECORDED note Projects/K.md");
		expect(readFileSync(noteFile(v), "utf8")).toBe("# K\n- 09:13 - Strategium K-1: installed svc\n");
		expect(readFileSync(dailyFile(v), "utf8").trimEnd().split("\n").at(-1)).toBe("- 09:13 - Strategium K-1: installed svc");
	});

	test("R2: a refused note writes nothing, not even the daily", async () => {
		const noNotes = { ...CONTRACT, notes: undefined };
		for (const [label, contract, note, why] of [
			["outside notes", CONTRACT, "Other/x.md", "not allowed by the contract's notes"],
			["no notes in the contract", noNotes, "Projects/K.md", "the contract lists no notes"],
			["parent segment", CONTRACT, "../x.md", "not a relative .md path inside the vault"],
			["the daily itself", { ...CONTRACT, notes: ["Daily/*.md"] }, "Daily/2026-11-16.md", "is today's daily"],
			["missing", CONTRACT, "Projects/Nope.md", "missing"],
		] as const) {
			const v = withNote(contract);
			const s = await begun(v);
			const before = bytes(v);
			expect(await s.call({ action: "record", text: "x", note }), label).toBe(`ERROR record refused: note ${note}: ${why}; nothing was written`);
			expect(bytes(v), label).toEqual(before);
		}
	});

	test("R2: a note that is a folder is refused and nothing is written", async () => {
		const v = withNote();
		mkdirSync(join(v, "Projects", "Dir.md"));
		const s = await begun(v);
		const before = bytes(v);
		expect(await s.call({ action: "record", text: "x", note: "Projects/Dir.md" })).toBe("ERROR record refused: note Projects/Dir.md: not a regular file; nothing was written");
		expect(bytes(v)).toEqual(before);
	});

	test("record refuses text over 200 characters and writes nothing", async () => {
		const v = withNote();
		const s = await begun(v);
		const before = bytes(v);
		expect(await s.call({ action: "record", text: "a ".repeat(101) })).toBe("ERROR record needs text of at most 200 characters");
		expect(bytes(v)).toEqual(before);
		expect(await s.call({ action: "record", text: "a ".repeat(100) })).toBe("RECORDED daily");
	});

	test("R3: a secret text is refused with its kind, before the vault and the note are looked at", async () => {
		const v = withNote();
		const s = await begun(v);
		const before = bytes(v);
		for (const [text, kind] of [[`token ${GH}`, "token"], ["API_KEY=x", "NAME=value"]] as const) {
			for (const note of [undefined, "Projects/K.md", "Other/x.md"]) {
				const out = await s.call({ action: "record", text, note });
				expect(out).toBe(`ERROR the text looks like a secret (${kind}); nothing was written; rephrase without the value`);
				expect(out).not.toContain(GH);
			}
		}
		expect(bytes(v)).toEqual(before);
	});

	test("R4: a subagent gets the main-session refusal and nothing is written", async () => {
		const v = withNote();
		const s = await begun(v);
		const before = bytes(v);
		s.ctx.agent = { kind: "sub" };
		expect(await s.call({ action: "record", text: "x", note: "Projects/K.md" })).toBe("ERROR strategium tool is for the main session only");
		expect(bytes(v)).toEqual(before);
	});

	test("R5: no run, vault off, invalid contract and blank text each get their line", async () => {
		process.env.STRATEGIUM_VAULT = withNote();
		expect(await setup().call({ action: "record", text: "x" })).toBe("ERROR no active run in this session");

		const off = await begun(withNote());
		await off.sub("config", "vault off");
		expect(await off.call({ action: "record", text: "x" })).toBe("ERROR no vault set (/strategium-config vault <absolute folder>)");

		const bad = vaultDir({ ...CONTRACT, notes: [] });
		const s = await begun(bad);
		const out = await s.call({ action: "record", text: "x" });
		expect(out).toBe(`ERROR vault ${bad}: contract invalid: notes must be a list of 1 to 32 relative .md globs (* within a segment, ** as a whole segment)`);

		const ok = await begun(withNote());
		for (const text of [undefined, "", "  \t "]) expect(await ok.call({ action: "record", text })).toBe("ERROR record needs text");
	});

	test("R6: two identical calls add two lines, no run.recorded entry and no notice", async () => {
		const v = withNote();
		const s = await begun(v);
		const recorded = runOf(s).recorded;
		const notes = s.notes.length;
		await s.call({ action: "record", text: "same" });
		await s.call({ action: "record", text: "same" });
		expect(readFileSync(dailyFile(v), "utf8").split("\n").filter(l => l.endsWith(": same"))).toHaveLength(2);
		expect(runOf(s).recorded).toEqual(recorded);
		expect(s.notes).toHaveLength(notes);
	});

	test("R7: a note that fails at write time leaves the daily line and says so", async () => {
		const bin = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
		const v = withNote(CONTRACT, bin);
		const s = await begun(v);
		expect(await s.call({ action: "record", text: "x", note: "Projects/K.md" })).toBe("RECORDED daily\nERROR note Projects/K.md: note not UTF-8; the daily line stays");
		expect(readFileSync(noteFile(v)).equals(bin)).toBe(true);
		expect(readFileSync(dailyFile(v), "utf8")).toContain("- 09:12 - Strategium K-1: x");
	});

	test("a daily failure writes no note line and reports the vault reason", async () => {
		const v = withNote({ ...CONTRACT, createDaily: undefined });
		const s = await begun(v);
		const out = await s.call({ action: "record", text: "x", note: "Projects/K.md" });
		expect(out).toStartWith(`ERROR vault ${v}: daily `);
		expect(readFileSync(noteFile(v), "utf8")).toBe("# K\n");
	});
});

// switch (#155): end this session's run and begin another key in one call.
describe("switch (#155)", () => {
	const runFile = (dir: string, sid = "sess-0001") => join(dir, "runs", `${sid}.json`);
	const debriefs = (dir: string) => (existsSync(join(dir, "debriefs")) ? readdirSync(join(dir, "debriefs")) : []);

	test("the tool description lists switch with its parameters", () => {
		const s = setup();
		expect(s.tool.description).toContain("switch (key, booked?, via?, takeover?)");
	});

	test("ends K-1 then begins K-2, keeping theatre and repo, and frees K-1", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1", theatre: "github", booked: 120 });
		await s.call({ action: "repo", repo: s.dir });
		const out = await s.call({ action: "switch", key: "K-2" });
		expect(out).toStartWith("ENDED K-1");
		expect(out).toContain("DEBRIEF");
		expect(out).toContain("K-2 0 min (no booking) running");
		const status = await s.call({ action: "status" });
		expect(status).toContain(`RUN K-2 theatre=github repo=${s.dir}`);
		expect(status).not.toContain("RUN K-1");
		expect(await setup("sess-0002", s.dir).call({ action: "begin", key: "K-1" })).not.toContain("ERROR");
	});

	test("booked is the new key's own, never carried over", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1", booked: 120 });
		expect(await s.call({ action: "switch", key: "K-2" })).toContain("K-2 0 min (no booking)");
		expect(await s.call({ action: "switch", key: "K-3", booked: 60 })).toContain("K-3 0/60 min");
	});

	test("the run's own state is not carried to the new run", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1", archmagos: true });
		await s.call({ action: "slices", slices: [{ id: "S1", parallel: true, files: ["a.ts"] }] });
		s.handlers.tool_result.forEach(h => h({ toolName: "todo", isError: false, details: { phases: [{ name: "Muster", tasks: [{ content: "captain: Objective", status: "pending" }] }] } }, s.ctx));
		expect(JSON.parse(readFileSync(runFile(s.dir), "utf8"))).toHaveProperty("phases");
		await s.call({ action: "switch", key: "K-2" });
		const run = JSON.parse(readFileSync(runFile(s.dir), "utf8"));
		expect(run.key).toBe("K-2");
		for (const f of ["slices", "archmagos", "names", "ratings", "phases"]) expect(run).not.toHaveProperty(f);
	});

	test("refusals return one ERROR line and change nothing", async () => {
		const s = setup();
		expect(await s.call({ action: "switch", key: "K-2" })).toStartWith("ERROR no run to switch from");
		expect(existsSync(runFile(s.dir))).toBe(false);
		await s.call({ action: "begin", key: "K-1" });
		const before = readFileSync(runFile(s.dir), "utf8");
		expect(await s.call({ action: "switch" })).toBe("ERROR switch needs key");
		expect(await s.call({ action: "switch", key: "K-1" })).toBe("ERROR K-1 is already this session's run");
		const other = setup("sess-0002", s.dir);
		await other.call({ action: "begin", key: "K-2" });
		expect(await setup("sess-0001", s.dir).call({ action: "switch", key: "K-2" })).toStartWith("ERROR K-2 is held by omp session");
		expect(readFileSync(runFile(s.dir), "utf8")).toBe(before);
		expect(debriefs(s.dir)).toEqual([]);
		expect(readFileSync(lockPath(s.dir, "K-2"), "utf8")).toBe("sess-0002");
		expect(readFileSync(lockPath(s.dir, "K-1"), "utf8")).toBe("sess-0001");
	});

	test("takeover names the holder of the new key and the switching session's repo wins", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		await s.call({ action: "repo", repo: s.dir });
		const other = setup("sess-0002", s.dir);
		await other.call({ action: "begin", key: "K-2" });
		await other.call({ action: "repo", repo: join(s.dir, "elsewhere") });
		const out = await setup("sess-0001", s.dir).call({ action: "switch", key: "K-2", takeover: "sess-0002" });
		expect(out).toStartWith("ENDED K-1");
		expect(existsSync(runFile(s.dir, "sess-0002"))).toBe(false);
		expect(await s.call({ action: "status" })).toContain(`RUN K-2 theatre=none repo=${s.dir}`);
	});

	test("a takeover switch with no own repo leaves K-2 without a repo, never the holder's", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		const other = setup("sess-0002", s.dir);
		await other.call({ action: "begin", key: "K-2" });
		await other.call({ action: "repo", repo: join(s.dir, "elsewhere") });
		await setup("sess-0001", s.dir).call({ action: "switch", key: "K-2", takeover: "sess-0002" });
		expect(JSON.parse(readFileSync(runFile(s.dir), "utf8"))).not.toHaveProperty("repo");
	});

	test("running agents refuse the switch and change nothing", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		const run = JSON.parse(readFileSync(runFile(s.dir), "utf8"));
		run.agents = { A: { id: "S1", parallel: true, files: ["a.ts"] } };
		writeFileSync(runFile(s.dir), JSON.stringify(run));
		const before = readFileSync(runFile(s.dir), "utf8");
		expect(await s.call({ action: "switch", key: "K-2" })).toBe("ERROR K-1 still has builders (battle-brothers, veterans) running: wait for them or end the run first");
		expect(readFileSync(runFile(s.dir), "utf8")).toBe(before);
		expect(existsSync(lockPath(s.dir, "K-2"))).toBe(false);
		expect(debriefs(s.dir)).toEqual([]);
	});

	test("a failed end releases the new key's claim and begins nothing", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1" });
		// The day file becomes a directory: the end cannot stop K-1.
		const day = readdirSync(s.dir).find(f => f.endsWith(".jsonl"))!;
		rmSync(join(s.dir, day));
		mkdirSync(join(s.dir, day));
		const out = await s.call({ action: "switch", key: "K-2" });
		expect(out).toStartWith("ERROR");
		expect(out).not.toContain("ended but");
		expect(existsSync(lockPath(s.dir, "K-2"))).toBe(false);
	});

	test("an end that throws after the run ended says K-2 did not begin and releases its claim", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1", theatre: "github" });
		failAlarm();
		s.ctx.ui.notify = () => {
			throw new Error("notify broke");
		};
		const out = await s.call({ action: "switch", key: "K-2", booked: 30 });
		expect(out).toBe("ERROR K-1 ended but K-2 did not begin: notify broke; call strategium begin key K-2 theatre github booked 30");
		expect(existsSync(lockPath(s.dir, "K-2"))).toBe(false);
		expect(existsSync(runFile(s.dir))).toBe(false);
	});

	test("a begin that fails after the end says so and the retry begin succeeds", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1", theatre: "github" });
		await s.call({ action: "repo", repo: s.dir });
		// A directory where the run file's temp goes: the new run cannot be written.
		const tmp = `${runFile(s.dir)}.${process.pid}.tmp`;
		mkdirSync(tmp);
		const out = await s.call({ action: "switch", key: "K-2", booked: 90 });
		expect(out).toStartWith("ENDED K-1");
		expect(out).toContain("ERROR begin K-2 failed after K-1 ended");
		expect(out).toContain(`call strategium begin key K-2 theatre github booked 90, then repo ${s.dir}`);
		expect(readFileSync(lockPath(s.dir, "K-2"), "utf8")).toBe("sess-0001");
		rmSync(tmp, { recursive: true });
		expect(await s.call({ action: "begin", key: "K-2", theatre: "github" })).toContain("K-2");
	});
});

// `via`: the booking a key counts against when it is not its own (the theatre's lookup), shared by the keys of one parent.
describe("via on begin and switch", () => {
	const T = (h: number, m: number, day = 16) => new Date(2026, 10, day, h, m, 0);
	const day = (dir: string, d = 16) => join(dir, `2026-11-${d}.jsonl`);
	const starts = (dir: string, d = 16) => load(day(dir, d)).filter(e => e.event === "start");
	const pb = { key: "P", reason: "parent booking" } as const;

	test("begin with booked and via shows it in status and report, and the TOTAL line keeps its form", async () => {
		const s = setup();
		setSystemTime(T(9, 0));
		const begun = await s.call({ action: "begin", key: "K-1", booked: 60, via: pb });
		expect(begun).toContain("K-1 0/60 min (0%) running via P (parent booking)");
		expect(await s.call({ action: "status" })).toContain("via P (parent booking) · shared P 0/60 min (0%)");
		setSystemTime(T(9, 30));
		const report = await s.call({ action: "report" });
		expect(report).toContain("VIA K-1 P (parent booking)");
		expect(report).toContain("TOTAL K-1 measured 30 min, worked 30 min with prior and adjustments (~30 min)");
		expect(starts(s.dir)[0].via).toEqual(pb);
	});

	test("a stopped key restarted the same day with booked and no via drops the via", async () => {
		const s = setup();
		setSystemTime(T(9, 0));
		await s.call({ action: "begin", key: "K-1", booked: 60, via: pb });
		setSystemTime(T(9, 5));
		await s.call({ action: "end" });
		setSystemTime(T(9, 10));
		await s.call({ action: "begin", key: "K-1", booked: 30 });
		expect(starts(s.dir).at(-1)!.via).toBeUndefined();
		expect(await s.call({ action: "status" })).not.toContain("via P");
	});

	test("an estimate via is shown but never shared", async () => {
		const s = setup();
		setSystemTime(T(9, 0));
		await s.call({ action: "begin", key: "K-1", booked: 60, via: { key: "K-1", reason: "estimate", extra: 1 } });
		const status = await s.call({ action: "status" });
		expect(status).toContain("via K-1 (estimate)");
		expect(status).not.toContain("shared");
		expect(starts(s.dir)[0].via).toEqual({ key: "K-1", reason: "estimate" });
	});

	test("via without booked answers an ERROR and changes nothing", async () => {
		const s = setup();
		setSystemTime(T(9, 0));
		expect(await s.call({ action: "begin", key: "K-1", via: pb })).toContain("ERROR via needs booked");
		expect(await s.call({ action: "status" })).toStartWith("IDLE\nARCHMAGOS");
		expect(existsSync(day(s.dir))).toBe(false);
		expect(existsSync(lockPath(s.dir, "K-1"))).toBe(false);
	});

	test.each([
		{ key: "", reason: "estimate" },
		{ key: "x".repeat(65), reason: "estimate" },
		{ key: "a\nb", reason: "estimate" },
		{ key: " A", reason: "estimate" },
		{ key: "A", reason: "guess" },
		"P",
		null,
	])("a bad via %p answers an ERROR and changes nothing", async via => {
		const s = setup();
		setSystemTime(T(9, 0));
		expect(await s.call({ action: "begin", key: "K-1", booked: 60, via })).toContain("ERROR bad via");
		expect(await s.call({ action: "status" })).toStartWith("IDLE\nARCHMAGOS");
		expect(existsSync(day(s.dir))).toBe(false);
		expect(existsSync(join(s.dir, "runs"))).toBe(false);
		expect(existsSync(lockPath(s.dir, "K-1"))).toBe(false);
	});

	test("switch with booked and via records the via on the new key", async () => {
		const s = setup();
		setSystemTime(T(9, 0));
		await s.call({ action: "begin", key: "K-1", booked: 60 });
		const out = await s.call({ action: "switch", key: "K-2", booked: 30, via: pb });
		expect(out).toContain("K-2 0/30 min (0%) running via P (parent booking)");
		expect(starts(s.dir).find(e => e.key === "K-2")!.via).toEqual(pb);
	});

	test("switch with a bad via answers an ERROR: the old run runs on and no claim is taken", async () => {
		const s = setup();
		setSystemTime(T(9, 0));
		await s.call({ action: "begin", key: "K-1", booked: 60 });
		const before = load(day(s.dir)).length;
		expect(await s.call({ action: "switch", key: "K-2", booked: 30, via: { key: "A", reason: "guess" } })).toContain("ERROR bad via");
		expect(await s.call({ action: "switch", key: "K-2", via: pb })).toContain("ERROR via needs booked");
		expect(await s.call({ action: "status" })).toContain("RUN K-1");
		expect(load(day(s.dir)).length).toBe(before);
		expect(existsSync(lockPath(s.dir, "K-1"))).toBe(true);
		expect(existsSync(lockPath(s.dir, "K-2"))).toBe(false);
	});

	test("a resume the same day carries the via; a changed via, or a booking without via, writes a new start", async () => {
		const s = setup();
		setSystemTime(T(9, 0));
		await s.call({ action: "begin", key: "K-1", booked: 60, via: pb });
		await s.call({ action: "stop" });
		await s.call({ action: "start" });
		expect(starts(s.dir).map(e => e.via)).toEqual([pb, pb]);
		await s.call({ action: "begin", key: "K-1", booked: 60, via: pb });
		expect(starts(s.dir)).toHaveLength(2);
		const other = { key: "Q", reason: "parent booking" } as const;
		await s.call({ action: "begin", key: "K-1", booked: 60, via: other });
		expect(starts(s.dir).at(-1)!.via).toEqual(other);
		await s.call({ action: "begin", key: "K-1", booked: 60 });
		expect(starts(s.dir).at(-1)).toMatchObject({ key: "K-1", booked: 60 });
		expect(starts(s.dir).at(-1)!.via).toBeUndefined();
		expect(await s.call({ action: "status" })).not.toContain("via");
	});

	test("two keys booked through one parent alert once for the group across two sessions", async () => {
		const a = setup("sess-0001");
		const b = setup("sess-0002", a.dir);
		setSystemTime(T(9, 0));
		await a.call({ action: "begin", key: "K-1", booked: 4, via: pb });
		await b.call({ action: "begin", key: "K-2", booked: 4, via: pb });
		setSystemTime(T(9, 2));
		a.start();
		expect(a.calls.map(c => (c[0] as { content: string }).content)).toEqual(["TIMER 50% K-1 2/4 min via P (shared K-1+K-2)"]);
		expect(a.notes).toEqual(["Strategium: 50% of the booking for K-1 (shared via P: K-1+K-2)"]);
		expect(alertEvents(a.dir)).toEqual([expect.objectContaining({ key: "K-1", p: 50, pool: "P" })]);
		b.start();
		expect(b.calls).toHaveLength(0);
		expect(alertEvents(a.dir)).toHaveLength(1);
		setSystemTime(T(9, 4));
		b.start();
		a.start();
		expect(b.calls.map(c => (c[0] as { content: string }).content)).toEqual(["TIMER 100% K-2 4/4 min via P (shared K-1+K-2)"]);
		expect(a.calls).toHaveLength(1);
		expect(alertEvents(a.dir).map(e => e.p)).toEqual([50, 100]);
		expect(b.shown()).toContain("4/4 min");
	});

	test("a sub-task starting after a stopped sibling shows the group's minutes in footer, TIMER and clock", async () => {
		const s = setup();
		setSystemTime(T(9, 0));
		await s.call({ action: "begin", key: "K-1", booked: 4, via: pb });
		setSystemTime(T(9, 2));
		await s.call({ action: "switch", key: "K-2", booked: 4, via: pb });
		setSystemTime(T(9, 3));
		s.start();
		expect(s.shown()).toContain("3/4 min");
		expect(s.shown()).not.toContain("1/4 min");
		expect(s.calls.map(c => (c[0] as { content: string }).content)).toEqual(["TIMER 50% K-2 3/4 min via P (shared K-1+K-2)"]);
	});

	test("a switch whose end fails carries via in the retry hint", async () => {
		const s = setup();
		await s.call({ action: "begin", key: "K-1", theatre: "github" });
		failAlarm();
		s.ctx.ui.notify = () => {
			throw new Error("notify broke");
		};
		const out = await s.call({ action: "switch", key: "K-2", booked: 30, via: pb });
		expect(out).toBe("ERROR K-1 ended but K-2 did not begin: notify broke; call strategium begin key K-2 theatre github booked 30 via key P reason parent booking");
	});

	test("changing only the via reason on an open key writes a new start", async () => {
		const s = setup();
		setSystemTime(T(9, 0));
		await s.call({ action: "begin", key: "K-1", booked: 60, via: { key: "P", reason: "parent booking" } });
		await s.call({ action: "begin", key: "K-1", booked: 60, via: { key: "P", reason: "estimate" } });
		expect(starts(s.dir).map(e => e.via?.reason)).toEqual(["parent booking", "estimate"]);
	});

	test("a key without via alerts exactly as before", async () => {
		const s = setup();
		setSystemTime(T(9, 0));
		await s.call({ action: "begin", key: "K-1", booked: 4 });
		setSystemTime(T(9, 2));
		s.start();
		expect(s.calls.map(c => (c[0] as { content: string }).content)).toEqual(["TIMER 50% K-1 2/4 min"]);
		expect(alertEvents(s.dir)[0].pool).toBeUndefined();
	});

	test("a new day drops the via: a new shift with booked starts without it", async () => {
		const s = setup();
		setSystemTime(T(17, 0, 15));
		await s.call({ action: "begin", key: "K-1", booked: 60, via: pb });
		await s.call({ action: "stop" });
		setSystemTime(T(9, 0));
		await s.call({ action: "start", booked: 60 });
		expect(starts(s.dir)).toEqual([{ ts: expect.any(String), event: "start", key: "K-1", booked: 60 }]);
		expect(await s.call({ action: "status" })).not.toContain("via");
		expect(await s.call({ action: "report" })).not.toContain("VIA");
	});

	test("a run left running over midnight starts the new day without via", async () => {
		const s = setup();
		setSystemTime(T(23, 30));
		await s.call({ action: "begin", key: "K-1", booked: 120, via: pb });
		await s.start();
		for (let m = 31; m < 60; m += 2) {
			setSystemTime(T(23, m));
			await s.sub("status");
		}
		setSystemTime(T(0, 1, 17));
		await s.sub("status");
		expect(starts(s.dir, 17)).toEqual([{ ts: nowIso(T(0, 0, 17)), event: "start", key: "K-1" }]);
		expect(await s.call({ action: "status" })).not.toContain("via");
	});
});
