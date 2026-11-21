import { describe, expect, test } from "bun:test";
import {
	activePhase,
	closes,
	clean,
	cockpitView,
	colorDepth,
	grantedSeals,
	waitingSeal,
	jobEnds,
	palette,
	pushEntry,
	renderCockpit,
	sealsFrom,
	type Deployed,
	type Entry,
	type Live,
	type Phase,
	type ViewInput,
} from "./cockpit";
import { AGENTS } from "../../skills/strategium/todo";
import { DEFAULT_THEME, THEMES, type Theme } from "./themes";

// The rendering tests pin the cogitator theme: its colours are the ones the GOLD, PURPLE and RED sequences name.
const TRUE = palette("truecolor", THEMES.cogitator);
const GOLD = "\x1b[38;2;201;162;39m";
const PURPLE = "38;2;123;44;191";
const RED = "38;2;164;22;26";
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const phases = (...tasks: [string, string][]): Phase[] => [{ name: "Plan", tasks: tasks.map(([content, status]) => ({ content, status })) }];
const input = (over: Partial<ViewInput> = {}): ViewInput => ({ key: "K-1", notes: {}, chronicle: [], ...over });
const text = (over: Partial<ViewInput> = {}, width = 100) => plain(renderCockpit(cockpitView(input(over)), width, 0, TRUE).join("\n"));

// The 8 stations of SKILL.md with the agent tags each one uses, and the boxes each must show.
const STATIONS: [string, string[], string[]][] = [
	["Muster", ["captain"], ["CAPTAIN"]],
	["Auspex", ["scout"], ["SCOUTS"]],
	["Scriptorium", ["librarian", "archmagos", "seal"], ["LIBRARIANS"]],
	["Deployment", ["captain"], ["CAPTAIN"]],
	["Skirmish", ["battle-brother", "veteran", "apothecary", "seal"], ["BATTLE-BROTHERS", "APOTHECARIES"]],
	["Inquisition", ["inquisitor", "security-reviewer", "sonic", "task", "seal"], ["INQUISITOR", "SECURITY-REVIEWER", "SONIC", "ADEPTS"]],
	["Extraction", ["captain", "seal"], ["CAPTAIN"]],
	["Debrief", ["captain"], ["CAPTAIN"]],
];
/** The run at station `at`: earlier phases completed, its first task in_progress. */
const run = (at: number): Phase[] =>
	STATIONS.map(([name, tags], i) => ({ name, tasks: tags.map((tag, j) => ({ content: `[${tag}] ${tag} job`, status: i < at ? "completed" : i === at && j === 0 ? "in_progress" : "pending" })) }));
// Box titles are the `┌─ TITLE ─` / `╔═ …` tops; a plain icon before the name is dropped.
const titles = (t: string) => [...t.matchAll(/[┌╔]─ (.+?) ─/g)].map(m => m[1].replace(/^\S+ (?=[A-Z-]+$)/, ""));
const dep = (over: Partial<Deployed>): Deployed => ({ who: "X", role: "scout", station: "Plan", state: "active", ...over });

describe("seals", () => {
	test("sealsFrom reads bracket and glyph tags with their three states", () => {
		const seals = sealsFrom(phases(["[seal] Plan", "completed"], ["\u{f047a} seal · Demo", "in_progress"], ["[seal] Ship", "pending"], ["[builder] x", "pending"]));
		expect(seals).toEqual([
			{ id: "Plan", state: "granted" },
			{ id: "Demo", state: "waiting" },
			{ id: "Ship", state: "pending" },
		]);
	});

	test("a seal's name is the whole text after the tag: Demo (2) stays distinct from Demo", () => {
		const seals = sealsFrom(phases(["[seal] Demo", "pending"], ["[seal] Demo (2)", "pending"], ["\u{f047a} seal · Plan the squads", "pending"]));
		expect(seals.map(s => s.id)).toEqual(["Demo", "Demo (2)", "Plan the squads"]);
	});

	test("waitingSeal is the seal of the first in_progress task of the first phase that has one", () => {
		expect(waitingSeal(phases(["[seal] Plan", "completed"], ["[seal] Demo (2)", "in_progress"]))?.id).toBe("Demo (2)");
		expect(waitingSeal(phases(["[seal] Plan", "pending"]))).toBeUndefined();
		expect(waitingSeal(phases(["[captain] x", "in_progress"], ["[seal] Plan", "in_progress"]))).toBeUndefined();
		expect(waitingSeal([])).toBeUndefined();
		const two: Phase[] = [{ name: "A", tasks: [{ content: "[seal] First", status: "in_progress" }] }, { name: "B", tasks: [{ content: "[seal] Second", status: "in_progress" }] }];
		expect(waitingSeal(two)?.id).toBe("First");
	});

	test.each([
		["no before", undefined, phases(["[seal] Plan", "completed"]), []],
		["pending to completed", phases(["[seal] Plan", "pending"]), phases(["[seal] Plan", "completed"]), ["Plan"]],
		["waiting to completed", phases(["[seal] Plan", "in_progress"]), phases(["[seal] Plan", "completed"]), ["Plan"]],
		["completed to completed", phases(["[seal] Plan", "completed"]), phases(["[seal] Plan", "completed"]), []],
		["first seen completed", phases(["[builder] x", "pending"]), phases(["[builder] x", "pending"], ["[seal] Plan", "completed"]), []],
	])("grantedSeals: %s", (_n, before, after, names) => {
		expect(grantedSeals(before, after).map(s => s.id)).toEqual(names);
	});

	test("the Muster Orders captain task is no seal", () => {
		const orders = (status: string) => phases(["[captain] Orders", status], ["\u{f18bc} captain · Orders", status]);
		expect(sealsFrom(orders("in_progress"))).toEqual([]);
		expect(grantedSeals(orders("in_progress"), orders("completed"))).toEqual([]);
		expect(grantedSeals(orders("pending"), orders("completed"))).toEqual([]);
	});
});

describe("view", () => {
	test("an agent deployed in Skirmish still shows in Skirmish after a todo with phases in another order", () => {
		const deployed = new Map([["a1", dep({ role: "apothecary", station: "Skirmish" })]]);
		const ph = (name: string, status: string): Phase => ({ name, tasks: [{ content: "[captain] x", status }] });
		expect(text({ phases: [ph("Muster", "completed"), ph("Skirmish", "in_progress")], deployed })).toContain("▶ a1");
		const reordered = text({ phases: [ph("Skirmish", "in_progress"), ph("Muster", "completed")], deployed });
		expect(reordered).toContain("▶ a1");
		expect(reordered).toContain("APOTHECARIES");
		expect(text({ phases: [ph("Skirmish", "completed"), ph("Muster", "in_progress")], deployed })).not.toContain("a1");
	});

	test("activePhase is the first in_progress phase, by index", () => {
		const two = (a: string, b: string): Phase[] => [{ name: "Same", tasks: [{ content: "[captain] x", status: a }] }, { name: "Same", tasks: [{ content: "[captain] y", status: b }] }];
		expect(activePhase(two("completed", "in_progress"))).toBe(1);
		expect(activePhase(two("in_progress", "in_progress"))).toBe(0);
	});

	test("activePhase falls back to the first pending phase, then the last, then -1", () => {
		const at = (...s: string[]): Phase[] => s.map((status, i) => ({ name: `P${i}`, tasks: [{ content: "[captain] x", status }] }));
		expect(activePhase(at("completed", "pending", "pending"))).toBe(1);
		expect(activePhase(at("completed", "completed"))).toBe(1);
		expect(activePhase([])).toBe(-1);
	});

	test.each(STATIONS.map((s, i) => [s[0], s[2], i] as const))("station %s shows %j", (_name, boxes, at) => {
		expect(titles(text({ phases: run(at) }))).toEqual(boxes);
	});

	test("the station title is a rule exactly width cells wide, marked ▶", () => {
		const line = plain(renderCockpit(cockpitView(input({ phases: run(4) })), 100, 0, TRUE).find(l => plain(l).startsWith("╟─ ▶ Skirmish"))!);
		expect(Bun.stringWidth(line)).toBe(100);
		expect(line.endsWith("─╢")).toBe(true);
	});

	test("a long station title is cut and the rule still ends at the border", () => {
		const phs: Phase[] = [{ name: "S".repeat(200), tasks: [{ content: "[captain] x", status: "in_progress" }] }];
		const line = renderCockpit(cockpitView(input({ phases: phs })), 72, 0, TRUE).map(plain).find(l => l.startsWith("╟─ ▶ SSS"))!;
		expect(Bun.stringWidth(line)).toBe(72);
		expect(line).toContain("…");
		expect(line).toMatch(/… ─+╢$/);
	});

	test("a return shows ↶ on the station that was returned to", () => {
		const phs: Phase[] = [{ name: "Forge", tasks: [{ content: "[captain] redo", status: "in_progress" }] }, { name: "Later", tasks: [{ content: "[captain] x", status: "completed" }] }];
		expect(text({ phases: phs })).toMatch(/╟─ ↶ Forge /);
	});

	test("a running task beside a completed sibling is ▶, not a return, while no later phase is completed", () => {
		const phs: Phase[] = [{ name: "Forge", tasks: [{ content: "[captain] done", status: "completed" }, { content: "[captain] now", status: "in_progress" }] }, { name: "Later", tasks: [{ content: "[captain] x", status: "pending" }] }];
		const t = text({ phases: phs });
		expect(t).toMatch(/╟─ ▶ Forge /);
		expect(t).not.toContain("↶");
	});

	test("a waiting seal puts its name after the station", () => {
		expect(text({ phases: phases(["[seal] Plan", "in_progress"]) })).toContain("▶ Plan · ◷ seal Plan awaits you");
	});

	test("with no task running the first pending phase is the station", () => {
		const phs: Phase[] = [{ name: "Muster", tasks: [{ content: "[captain] x", status: "completed" }] }, { name: "Auspex", tasks: [{ content: "[scout] map", status: "pending" }] }];
		const t = text({ phases: phs });
		expect(t).toMatch(/╟─ ○ Auspex /);
		expect(titles(t)).toEqual(["SCOUTS"]);
	});

	test("no phases: no station yet and no box", () => {
		const t = text();
		expect(t).toMatch(/╟─ ○ no station yet /);
		expect(titles(t)).toEqual([]);
	});

	test("no phases: an agent with no station opens no box", () => {
		expect(titles(text({ deployed: new Map([["a1", dep({ station: undefined })]]) }))).toEqual([]);
	});

	test("the old fixed boxes are gone", () => {
		const t = text({ phases: run(4) });
		for (const w of ["STRATEGOS", "LIBRARIAN", "INQUISITOR", "standing by", "awaiting judgement", "\u25cc"]) expect(t).not.toContain(w);
	});

	test("each line is a task with its state mark and loses its tag", () => {
		const t = text({ phases: phases(["[scout] first", "completed"], ["[scout] second", "in_progress"], ["[scout] third", "pending"], ["[scout] fourth", "failed"]) });
		for (const l of ["✓ first", "▶ second", "○ third", "✗ fourth"]) expect(t).toContain(l);
		expect(t).not.toContain("[scout]");
	});

	test("glyph-form tags are found and lose their tag", () => {
		expect(titles(text({ phases: phases(["\u{f0e0b} inquisitor · judging", "in_progress"]) }))).toEqual(["INQUISITOR"]);
		expect(text({ phases: phases(["\u{f0e0b} inquisitor · judging", "in_progress"]) })).toContain("▶ judging");
	});

	test("the Archmagos planner shows in LIBRARIANS", () => {
		const t = text({ phases: phases(["[archmagos] merging the plan", "in_progress"]) });
		expect(titles(t)).toEqual(["LIBRARIANS"]);
		expect(t).toContain("▶ merging the plan");
	});

	test("squad lines follow the tasks, in declared order with their states", () => {
		const t = text({
			phases: phases(["[battle-brother] Build squad a", "in_progress"]),
			slices: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
			stopped: [{ id: "c" }],
			agents: { x1: { id: "a" } },
			notes: { b: { failed: true }, d: { veteran: true } },
		});
		for (const l of ["▶ † squad a forging", "✗ † squad b failed", "✓ † squad c returned", "○ ‡ squad d awaiting deployment"]) expect(t).toContain(l);
		expect(t.indexOf("squad a")).toBeLessThan(t.indexOf("squad d"));
		expect(t.indexOf("Build squad a")).toBeLessThan(t.indexOf("squad a forging"));
	});

	test("squad precedence: an agent beats failed, failed beats stopped", () => {
		const row = (over: Partial<ViewInput>) => text({ phases: phases(["[battle-brother] x", "pending"]), slices: [{ id: "a" }], ...over });
		const forging = row({ agents: { x: { id: "a" } }, notes: { a: { failed: true } } });
		expect(forging).toContain("▶ † squad a forging");
		expect(forging).not.toContain("✗");
		const failed = row({ stopped: [{ id: "a" }], notes: { a: { failed: true } } });
		expect(failed).toContain("✗ † squad a failed");
		expect(failed).not.toContain("returned");
	});

	test("squads show only in the BATTLE-BROTHERS box, so not outside Skirmish", () => {
		expect(text({ phases: phases(["[captain] x", "in_progress"]), slices: [{ id: "a" }] })).not.toContain("squad a");
	});

	test("a veteran task and a brother task carry † and ‡ in plain mode, and the Nerd glyphs in Nerd mode, never a skull", () => {
		const phs = phases(["[battle-brother] Build squad alpha", "in_progress"], ["[veteran] Rebuild squad gamma", "in_progress"]);
		const plainText = text({ phases: phs });
		expect(plainText).toContain("▶ † Build squad alpha");
		expect(plainText).toContain("▶ ‡ Rebuild squad gamma");
		const nerd = text({ phases: phs, glyphs: true });
		expect(nerd).toContain("▶ \u{f18be}  Build squad alpha");
		expect(nerd).toContain("▶ \u{f0787}  Rebuild squad gamma");
		expect(plainText + nerd).not.toContain("\u2620");
	});

	test("a Nerd box title is its glyph, exactly two spaces, then the name", () => {
		expect(text({ phases: phases(["[librarian] x", "in_progress"]), glyphs: true })).toContain(`${AGENTS.librarian}  LIBRARIANS`);
	});

	test("three boxes at width 83 take two columns, not three", () => {
		const phs = phases(["[captain] a", "in_progress"], ["[scout] b", "in_progress"], ["[apothecary] c", "in_progress"]);
		const tops = renderCockpit(cockpitView(input({ phases: phs })), 83, 0, TRUE).map(plain).filter(l => l.includes("┌"));
		expect(tops).toHaveLength(2);
		expect(tops[0].split("┌")).toHaveLength(3);
	});

	test("a registry agent seen in this station shows with its id and state", () => {
		const t = text({ phases: run(1), deployed: new Map([["a1", dep({ station: "Auspex" })], ["a2", dep({ station: "Auspex", state: "done" })], ["a3", dep({ station: "Auspex", state: "failed" })]]) });
		for (const l of ["▶ a1", "✓ a2", "✗ a3"]) expect(t).toContain(l);
	});

	test("a registry agent seen in another station does not show", () => {
		const t = text({ phases: run(1), deployed: new Map([["a1", dep({ role: "battle-brother", station: "Muster" })]]) });
		expect(titles(t)).toEqual(["SCOUTS"]);
		expect(t).not.toContain("a1");
	});

	test("a registry agent can open its box on its own, and a squad agent shows only through its squad line", () => {
		const t = text({
			phases: phases(["[captain] x", "in_progress"]),
			deployed: new Map([["eval-apothecary-1", dep({ role: "apothecary" })], ["b9", dep({ role: "battle-brother", squad: "a" })]]),
			slices: [{ id: "a" }],
		});
		expect(titles(t)).toEqual(["CAPTAIN", "BATTLE-BROTHERS", "APOTHECARIES"]);
		expect(t).toContain("▶ eval-apothecary-1");
		expect(t).toContain("† squad a awaiting");
		expect(t).not.toContain("b9");
	});

	test("box tones: red on a failed line, purple INQUISITOR, gold CAPTAIN, iron when all pending", () => {
		const top = (phs: Phase[], title: string) => renderCockpit(cockpitView(input({ phases: phs })), 100, 0, TRUE).find(l => l.includes(title))!;
		expect(top(phases(["[apothecary] x", "failed"]), "APOTHECARIES")).toContain(RED);
		expect(top(phases(["[inquisitor] x", "in_progress"]), "INQUISITOR")).toContain(PURPLE);
		expect(top(phases(["[captain] x", "in_progress"]), "CAPTAIN")).toContain(GOLD);
		expect(top(phases(["[scout] x", "pending"]), "SCOUTS")).toContain("\x1b[38;2;90;90;90m");
		expect(top(phases(["[scout] x", "completed"]), "SCOUTS")).toContain("\x1b[38;2;76;255;122m");
	});

	test("clock: untimed has no bar", () => {
		const t = text({ untimed: true, clock: { running: true, el: 42 } });
		expect(t).toContain("⧗ 42 min");
		expect(t).not.toContain("▰");
	});

	test("clock: timed 42 of 120 gives 4 filled, 10 empty and 35%", () => {
		const t = text({ clock: { running: true, el: 42, bk: 120 } });
		expect(t).toContain("⧗ 42/120 min");
		expect(t).toContain("▰▰▰▰▱▱▱▱▱▱▱▱▱▱");
		expect(t).toContain("35%");
	});

	test("clock bar is gold at 85% and blood red at 100%", () => {
		const bar = (el: number) => renderCockpit(cockpitView(input({ clock: { running: true, el, bk: 100 } })), 100, 0, TRUE).find(l => l.includes("▰"))!;
		expect(bar(85)).toContain(`${GOLD}▰`);
		expect(bar(100)).toContain(`\x1b[${RED}m▰`);
		expect(bar(10)).toContain("\x1b[38;2;76;255;122m▰");
	});

	test("clock: no booking today, and paused", () => {
		expect(text({ clock: { running: true, el: 5 } })).toContain("awaiting today's booking");
		expect(text({ clock: { running: false, el: 5, bk: 60 } })).toContain("paused");
	});
});

describe("chronicle and jobs", () => {
	test("pushEntry keeps the newest 200, newest last", () => {
		let list: Entry[] = [];
		for (let i = 0; i < 205; i++) list = pushEntry(list, { at: "10:00", who: "X", text: String(i) });
		expect(list).toHaveLength(200);
		expect(list[0].text).toBe("5");
		expect(list[199].text).toBe("204");
	});

	test("jobEnds returns ids and statuses of task jobs that stopped running", () => {
		const messages = [
			{ details: { jobs: [{ type: "task", label: "a1", status: "completed" }, { type: "task", label: "a2", status: "running" }, { type: "bash", label: "b", status: "failed" }] } },
			{ details: { jobs: [{ type: "task", label: "a3", status: "failed" }] } },
			"junk",
			null,
		];
		expect(jobEnds(messages)).toEqual([{ id: "a1", status: "completed" }, { id: "a3", status: "failed" }]);
		expect(jobEnds(undefined)).toEqual([]);
	});

	test("jobEnds reads eval cells: completed, failed and aborted agent events end their id; running and pending do not", () => {
		const ev = (id: unknown, status: string) => ({ op: "agent", id, status });
		const messages = [{ role: "toolResult", toolName: "eval", details: { cells: [{ statusEvents: [ev("A1", "completed"), ev("A2", "running"), ev("A3", "failed"), ev("A4", "aborted"), ev("A5", "pending"), { op: "read", path: "x" }, { op: "read", id: "A9", status: "completed" }, ev(7, "completed")] }, null, { statusEvents: "junk" }] } }];
		expect(jobEnds(messages)).toEqual([{ id: "A1", status: "completed" }, { id: "A3", status: "failed" }, { id: "A4", status: "aborted" }]);
		expect(jobEnds([{ details: { cells: "x" } }])).toEqual([]);
	});
});

describe("keys", () => {
	// Esc as terminals send it: legacy, kitty CSI-u with explicit modifier 1, event press/repeat, and Num/Caps Lock bits (omp's matchesKey ignores locks).
	test.each([
		["\x1b", true], ["\x1b[27u", true], ["\x1b[27;1u", true], ["\x1b[27;1:1u", true], ["\x1b[27;1:2u", true],
		["\x1b[27;129u", true], ["\x1b[27;65u", true], ["\x1b[27;193:1u", true], ["\x1b[27:27;1u", true],
		["\x1b[27;1:3u", false], ["\x1b[27;2u", false], ["\x1b[27;3u", false], ["\x1b[27;5u", false], ["\x1b[27;129:3u", false],
		["\x1b[27::27u", true], ["\x1b[27:27:27;1u", true], ["\x1b[27;1;27u", true], ["\x1b[27;1:1;27:27u", true], ["\x1b[27;1;u", true],
		["\x1b[27;2;27u", false], ["\x1b[27;1:3;27u", false],
		["a\x1b[27u", false], ["x\x1b[27;1u", false],
		["q", true], ["a", false],
	])("closes(%j) is %p", (data, expected) => {
		expect(closes(data)).toBe(expected);
	});
});

describe("colour depth", () => {
	test.each([
		[{ COLORTERM: "truecolor" }, "truecolor"],
		[{ COLORTERM: "24BIT" }, "truecolor"],
		[{ WT_SESSION: "x" }, "truecolor"],
		[{}, "256"],
		[{ COLORTERM: "xterm" }, "256"],
	] as const)("colorDepth(%j) is %s", (env, depth) => {
		expect(colorDepth(env)).toBe(depth);
	});

	test("palette uses Bun.color at the chosen depth", () => {
		expect(palette("truecolor", THEMES.cogitator).gold).toBe(GOLD);
		expect(palette("256").gold.startsWith("\x1b[38;5;")).toBe(true);
		expect(palette("256").gold).not.toContain("38;2;");
	});

	test("the default palette is blood-angels, with its background as a 48; sequence", () => {
		expect(DEFAULT_THEME).toBe("blood-angels");
		expect(palette("truecolor").bg).toBe("\x1b[48;2;24;13;16m");
		expect(palette("256").bg).toMatch(/^\x1b\[48;5;\d+m$/);
		expect(palette("truecolor", THEMES.cogitator).bg).toBeUndefined();
	});

	// WCAG relative luminance and contrast ratio.
	const luminance = (hex: string) => {
		const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const contrast = (a: string, b: string) => {
		const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return (hi + 0.05) / (lo + 0.05);
	};
	test.each(Object.entries(THEMES))("theme %s: every colour is a #RRGGBB Bun.color reads, every text tone ≥ 4.5:1 on its background", (_name, theme: Theme) => {
		const { bg, ...tones } = theme;
		for (const hex of Object.values(theme)) {
			expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
			expect(Bun.color(hex, "ansi-16m")).toBeString();
		}
		if (bg) for (const [tone, hex] of Object.entries(tones)) expect([tone, contrast(hex, bg) >= 4.5]).toEqual([tone, true]);
	});
});

const busy = (): ViewInput =>
	input({
		clock: { running: true, el: 42, bk: 120 },
		phases: [
			{ name: "Muster", tasks: [{ content: "[seal] Plan", status: "completed" }] },
			{ name: "Skirmish", tasks: [{ content: "[battle-brother] Build squad a", status: "in_progress" }, { content: "[apothecary] Test squad b", status: "pending" }, { content: "[seal] Demo", status: "pending" }] },
		],
		slices: [{ id: "a" }, { id: "b" }],
		notes: { b: { failed: true } },
		agents: { x: { id: "a" } },
		chronicle: [1, 2, 3, 4, 5].map(i => ({ at: `10:0${i}`, who: "SQUAD a", text: `event ${i}` })),
	});

describe("rendering", () => {
	test("overlay at 100 draws the station boxes and the truecolor palette", () => {
		const view = cockpitView(busy());
		const out = renderCockpit(view, 100, 0, TRUE);
		const t = plain(out.join("\n"));
		for (const w of ["BATTLE-BROTHERS", "APOTHECARIES", "SEALS", "CHRONICLE", "COGITATOR", "▶ Skirmish"]) expect(t).toContain(w);
		expect(t).not.toMatch(/SEAL ─/);
		for (const w of ["STRATEGOS", "LIBRARIAN", "INQUISITOR", "VETERAN"]) expect(t).not.toContain(w);
		expect(out.join("\n")).toContain(GOLD);
		expect(out.find(l => l.includes("BATTLE-BROTHERS"))).toContain(RED);
		expect(out.filter(l => l.includes("event")).length).toBeLessThanOrEqual(8);
	});

	test.each([100, 50])("a theme with a background paints every line at width %i edge to edge and closes it", width => {
		const pal = palette("truecolor", THEMES["blood-angels"]);
		const out = renderCockpit(cockpitView(busy()), width, 0, pal, 20);
		expect(out).toHaveLength(20);
		for (const l of out) {
			expect(l.startsWith(pal.bg!)).toBe(true);
			expect(l.endsWith("\x1b[49m")).toBe(true);
			expect(Bun.stringWidth(plain(l))).toBe(width);
		}
	});

	test("the 256 palette has no truecolor sequence but has gold's index", () => {
		const out = renderCockpit(cockpitView(busy()), 100, 0, palette("256")).join("\n");
		expect(out).not.toContain("38;2;");
		expect(out).toContain(palette("256").gold);
	});

	test("width 50 is stacked: the station, then a line per box title, no frame", () => {
		const t = plain(renderCockpit(cockpitView(busy()), 50, 0, TRUE).join("\n"));
		expect(t).not.toContain("╔");
		expect(t).toMatch(/^▶ Skirmish$/m);
		expect(t).toMatch(/^† BATTLE-BROTHERS$/m);
		expect(t).toMatch(/^ {2}▶ † Build squad a$/m);
	});

	test.each([30, 50, 72, 120])("every overlay line fits in %i", width => {
		for (const frame of [0, 1]) for (const l of renderCockpit(cockpitView(busy()), width, frame, TRUE)) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width);
	});

	test.each([30, 50, 100])("frames 0 and 1 differ only on active-mark lines at %i", width => {
		const view = cockpitView(busy());
		const a = renderCockpit(view, width, 0, TRUE);
		const b = renderCockpit(view, width, 1, TRUE);
		expect(a.length).toBe(b.length);
		let differ = 0;
		a.forEach((l, i) => {
			if (l === b[i]) return;
			differ++;
			expect(plain(l) + plain(b[i])).toMatch(/[▶▷]/);
		});
		expect(differ).toBeGreaterThan(0);
	});

	test("with no active box frames are identical", () => {
		const view = cockpitView(input());
		expect(renderCockpit(view, 100, 0, TRUE)).toEqual(renderCockpit(view, 100, 1, TRUE));
	});
});

const IRON = "\x1b[38;2;90;90;90m";
const GREEN = "\x1b[38;2;76;255;122m";
const many = (n: number): Entry[] => Array.from({ length: n }, (_, i) => ({ at: "10:00", who: "SQUAD a", text: `event ${i + 1}` }));
const eventLines = (lines: string[]) => lines.map(plain).filter(l => /event \d+/.test(l));

describe("overlay close hint, cut box titles", () => {
	test("the overlay says how to close it, framed or stacked, and never overflows", () => {
		expect(text({}, 100)).toContain("esc/q close");
		expect(text({}, 50)).toContain("esc/q close");
		for (const width of [30, 50, 72, 120])
			for (const l of renderCockpit(cockpitView(input()), width, 0, TRUE)) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width);
	});

	test("a line longer than its box is cut with … and the box keeps its border", () => {
		const long = "x".repeat(200);
		const rows = renderCockpit(cockpitView(input({ phases: phases([`[scout] ${long}`, "in_progress"]) })), 100, 0, TRUE).map(plain);
		const cut = rows.find(l => l.includes("▶ xxx"))!;
		expect(cut).toContain("…");
		expect(cut).not.toContain(long);
		expect(Bun.stringWidth(cut)).toBe(100);
		expect(cut.endsWith(" │ ║")).toBe(true);
	});
});

describe("jobEnds, squads, bar, seals, layout and chronicle edge cases", () => {
	test("jobEnds skips task jobs whose label is not a string", () => {
		const jobs = [{ type: "task", status: "completed" }, { type: "task", label: 7, status: "failed" }, { type: "task", label: "ok", status: "failed" }];
		expect(jobEnds([{ details: { jobs } }])).toEqual([{ id: "ok", status: "failed" }]);
	});

	test("bar is clamped to 14 cells over 100%", () => {
		const bar = plain(renderCockpit(cockpitView(input({ clock: { running: true, el: 150, bk: 100 } })), 100, 0, TRUE).find(l => l.includes("▰"))!);
		expect(bar).toContain("▰".repeat(14));
		expect(bar).not.toContain("▱");
		expect(bar).toContain("150%");
	});

	test("bar colour: 79% green, 80% gold", () => {
		const bar = (el: number) => renderCockpit(cockpitView(input({ clock: { running: true, el, bk: 100 } })), 100, 0, TRUE).find(l => l.includes("▰"))!;
		expect(bar(79)).toContain(`${GREEN}▰`);
		expect(bar(80)).toContain(`${GOLD}▰`);
	});

	test("no seals: no SEALS row, framed or stacked", () => {
		for (const w of [100, 50]) expect(text({}, w)).not.toContain("SEALS");
	});

	test("seal symbols and tones: granted gold ✠, waiting gold ○, pending iron ○", () => {
		const p = phases(["[seal] A", "completed"], ["[seal] B", "in_progress"], ["[seal] C", "pending"]);
		const out = renderCockpit(cockpitView(input({ phases: p })), 100, 0, TRUE).join("\n");
		expect(out).toContain(`${GOLD}✠`);
		expect(out).toContain(`${GOLD}○`);
		expect(out).toContain(`${IRON}○`);
		expect(text({ phases: p })).toContain("✠ A → ○ B → ○ C");
	});

	test("nerd seals: U+F047A granted, U+F051F waiting, pending stays iron ○, nothing touches or overflows", () => {
		const p = phases(["[seal] A", "completed"], ["[seal] B", "in_progress"], ["[seal] C", "pending"]);
		const view = cockpitView(input({ phases: p, glyphs: true }));
		const out = renderCockpit(view, 100, 0, TRUE).join("\n");
		expect(out).toContain(`${GOLD}\u{f047a} \x1b[39m`);
		expect(out).toContain(`${GOLD}\u{f051f} \x1b[39m`);
		expect(out).toContain(`${IRON}○\x1b[39m`);
		expect(text({ phases: p, glyphs: true })).toContain("\u{f047a}  A → \u{f051f}  B → ○ C");
		for (const w of [72, 100]) for (const l of renderCockpit(view, w, 0, TRUE)) expect(Bun.stringWidth(l)).toBe(w);
		for (const w of [40, 60]) for (const l of renderCockpit(view, w, 0, TRUE)) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(w);
	});

	test.each([
		["station", phases(["[captain] build", "in_progress"]), /^▶ Plan$/m],
		["return", [{ name: "Forge", tasks: [{ content: "[captain] redo", status: "in_progress" }] }, { name: "Later", tasks: [{ content: "[captain] x", status: "completed" }] }], /^↶ Forge$/m],
		["seal", phases(["[seal] Plan", "in_progress"]), /^▶ Plan · ◷ seal Plan awaits you$/m],
		["none", undefined, /^○ no station yet$/m],
	])("stacked station line: %s", (_n, phs, expected) => {
		expect(text({ phases: phs }, 50)).toMatch(expected);
	});

	test("width 71 is stacked, 72 is framed", () => {
		expect(text({}, 71)).not.toContain("╔");
		expect(text({}, 72)).toContain("╔");
	});

	test.each([72, 100, 120])("every framed overlay line is exactly %i cells wide", width => {
		for (const l of renderCockpit(cockpitView(busy()), width, 0, TRUE)) expect(Bun.stringWidth(l)).toBe(width);
	});

	test.each([100, 101])("boxes of rows with 1, 2 and 3 boxes all end at the same column at width %i", width => {
		for (const n of [1, 2, 3]) {
			const phs = phases(...["inquisitor", "security-reviewer", "sonic"].slice(0, n).map(t => [`[${t}] x`, "pending"] as [string, string]));
			const rows = renderCockpit(cockpitView(input({ phases: phs })), width, 0, TRUE).map(plain).filter(l => /^║ [┌╔│║└╚]/.test(l));
			expect(rows.length).toBeGreaterThan(0);
			for (const l of rows) {
				// the row's last box starts after the final "border space start" boundary; its own right edge must sit at width - 3
				const start = [...l.slice(0, width - 2).matchAll(/[┐╗│║┘╝] ([┌╔│║└╚])/g)].at(-1)![1];
				expect(l[width - 3]).toBe({ "┌": "┐", "╔": "╗", "│": "│", "║": "║", "└": "┘", "╚": "╝" }[start]!);
				expect(l.length).toBe(width);
			}
		}
	});

	test.each([
		[100, [31, 31, 32]],
		[101, [31, 31, 33]],
	])("the leftover width goes to the last box of a row at width %i", (width, widths) => {
		const phs = phases(["[inquisitor] x", "pending"], ["[security-reviewer] x", "pending"], ["[sonic] x", "pending"]);
		const top = renderCockpit(cockpitView(input({ phases: phs })), width, 0, TRUE).map(plain).find(l => l.includes("INQUISITOR"))!;
		expect(top.match(/┌[^┐]*┐/g)!.map(b => b.length)).toEqual(widths);
	});

	// Rows the layout needs with an empty chronicle: everything but the entries.
	const fixedRows = (width: number) => renderCockpit(cockpitView(input({ chronicle: [] })), width, 0, TRUE).length;

	test.each([50, 100])("chronicle with a height shows the H - fixed newest entries, newest first, at width %i", width => {
		const H = 30;
		const spare = H - fixedRows(width);
		const lines = eventLines(renderCockpit(cockpitView(input({ chronicle: many(40) })), width, 0, TRUE, H));
		expect(lines).toHaveLength(spare);
		expect(lines[0]).toContain("event 40");
		expect(lines.at(-1)).toContain(`event ${40 - spare + 1}`);
	});

	test.each([50, 100])("chronicle without a height shows every entry at width %i", width => {
		const lines = eventLines(renderCockpit(cockpitView(input({ chronicle: many(10) })), width, 0, TRUE));
		expect(lines).toHaveLength(10);
		expect(lines[0]).toContain("event 10");
		expect(lines[9]).toContain("event 1");
	});

	test.each([72, 100, 140])("framed overlay at height 45 and width %i fills the window", width => {
		const out = renderCockpit(cockpitView(busy()), width, 0, TRUE, 45).map(plain);
		expect(out).toHaveLength(45);
		for (const l of out) expect(Bun.stringWidth(l)).toBe(width);
		expect(out[0].startsWith("╔")).toBe(true);
		expect(out[44].startsWith("╚═ esc/q close")).toBe(true);
		for (const l of out.slice(1, 44)) {
			expect(l.startsWith("║") || l.startsWith("╟")).toBe(true);
			expect(l.endsWith("║") || l.endsWith("╢")).toBe(true);
		}
	});

	test("spare rows after the chronicle are blank framed rows", () => {
		const out = renderCockpit(cockpitView(input({ chronicle: many(2) })), 100, 0, TRUE, 45).map(plain);
		const spare = out.slice(out.findLastIndex(l => l.includes("event")) + 1, 44);
		expect(spare.length).toBeGreaterThan(0);
		for (const l of spare) expect(l).toBe(`║${" ".repeat(98)}║`);
	});

	test("a short height cuts the body and keeps the header and the close border", () => {
		const out = renderCockpit(cockpitView(busy()), 100, 0, TRUE, 6).map(plain);
		expect(out).toHaveLength(6);
		expect(out[0].startsWith("╔")).toBe(true);
		expect(out[5].startsWith("╚═ esc/q close")).toBe(true);
	});

	test("height 1 returns only the close hint", () => {
		const framed = renderCockpit(cockpitView(busy()), 100, 0, TRUE, 1).map(plain);
		expect(framed).toHaveLength(1);
		expect(framed[0].startsWith("╚═ esc/q close")).toBe(true);
		expect(renderCockpit(cockpitView(busy()), 50, 0, TRUE, 1).map(plain)).toEqual(["esc/q close"]);
	});

	test("stacked layout with a height fills it, chronicle on the spare rows, close hint last", () => {
		const out = renderCockpit(cockpitView(input({ chronicle: many(40) })), 50, 0, TRUE, 30).map(plain);
		expect(out).toHaveLength(30);
		for (const l of out) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(50);
		expect(out[29]).toBe("esc/q close");
		const sparse = renderCockpit(cockpitView(input({ chronicle: many(1) })), 50, 0, TRUE, 30).map(plain);
		expect(sparse).toHaveLength(30);
		expect(sparse.at(-2)).toBe("");
		expect(sparse.at(-1)).toBe("esc/q close");
	});

	test("stacked layout at height 4 is cut and still ends with the close hint", () => {
		const out = renderCockpit(cockpitView(busy()), 50, 0, TRUE, 4).map(plain);
		expect(out).toHaveLength(4);
		expect(out[3]).toBe("esc/q close");
		expect(out[0]).toContain("STRATEGIUM");
	});

	test("frames 0 and 1 have the same length at a height", () => {
		expect(renderCockpit(cockpitView(busy()), 100, 0, TRUE, 45)).toHaveLength(renderCockpit(cockpitView(busy()), 100, 1, TRUE, 45).length);
	});

	test("active marks: frame 0 is ▶, frame 1 is ▷", () => {
		const view = cockpitView(busy());
		const f0 = renderCockpit(view, 100, 0, TRUE).map(plain).join("\n");
		const f1 = renderCockpit(view, 100, 1, TRUE).map(plain).join("\n");
		expect(f0).toContain("▶");
		expect(f0).not.toContain("▷");
		expect(f1).toContain("▷");
		expect(f1).not.toContain("▶");
	});
});

describe("agent status line", () => {
	const lines = (status: ViewInput["status"], width: number, frame = 0) => renderCockpit(cockpitView(input({ status })), width, frame, TRUE).map(plain);

	test.each([100, 50])("working shows ▶ AGENT AT WORK, flipping to ▷ on odd frames, at width %i", width => {
		expect(lines("working", width).some(l => l.includes("▶ AGENT AT WORK"))).toBe(true);
		expect(lines("working", width, 1).some(l => l.includes("▷ AGENT AT WORK"))).toBe(true);
	});

	test.each([100, 50])("awaiting shows ○ VOX OPEN · esc to give orders in gold at width %i", width => {
		expect(lines("awaiting", width).some(l => l.includes("○ VOX OPEN · esc to give orders"))).toBe(true);
		expect(renderCockpit(cockpitView(input({ status: "awaiting" })), width, 0, TRUE).some(l => l.includes(`${GOLD}○ VOX OPEN · esc to give orders`))).toBe(true);
	});

	test("no status draws no status line and the layout keeps its rows", () => {
		expect(text()).not.toMatch(/AGENT AT WORK|VOX OPEN/);
		for (const w of [100, 50]) expect(lines("working", w)).toHaveLength(lines(undefined, w).length + 1);
	});

	test("the status row keeps the exact width of the framed layout", () => {
		for (const l of lines("awaiting", 100)) expect(Bun.stringWidth(l)).toBe(100);
		for (const l of lines("awaiting", 50)) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(50);
	});
});

describe("glyphs", () => {
	const states: [string, Partial<ViewInput>][] = [
		["skirmish with a veteran", { phases: phases(["[battle-brother] Build squad a", "in_progress"], ["[veteran] Rebuild squad b", "in_progress"]), slices: [{ id: "a" }, { id: "b" }], notes: { b: { veteran: true } } }],
		["failed squad", { phases: phases(["[battle-brother] x", "in_progress"]), slices: [{ id: "a" }], notes: { a: { failed: true } } }],
		["seal waiting", { phases: phases(["[seal] Plan", "in_progress"]) }],
		["return", { phases: [{ name: "Forge", tasks: [{ content: "[captain] redo", status: "in_progress" }] }, { name: "Later", tasks: [{ content: "[captain] x", status: "completed" }] }] }],
		["timed", { clock: { running: true, el: 42, bk: 120 } }],
		["untimed", { untimed: true, clock: { running: true, el: 42 } }],
		["agent at work", { status: "working" }],
		["agent awaiting", { status: "awaiting" }],
	];
	// ▶ is Extended_Pictographic but has text presentation without U+FE0F: the user's terminal draws it one cell wide.
	const emoji = (s: string) => s.replaceAll("▶", "").match(/\p{Extended_Pictographic}/gu) ?? [];

	test.each(states.flatMap(([n, o]) => [50, 100].flatMap(w => [false, true].map(g => [n, o, w, g] as const))))(
		"%s at width %i (nerd %p) has no emoji and fits",
		(_n, over, width, glyphs) => {
			const view = cockpitView(input({ ...over, glyphs }));
			for (const l of [...renderCockpit(view, width, 0, TRUE), ...renderCockpit(view, width, 1, TRUE)]) {
				expect(emoji(l)).toEqual([]);
				expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width);
			}
		},
	);

	test("plain mode uses † ‡ ◷", () => {
		expect(text({ phases: phases(["[battle-brother] x", "pending"]), slices: [{ id: "a" }, { id: "b" }], notes: { b: { veteran: true } } })).toMatch(/† squad a[\s\S]*‡ squad b/);
		expect(text({ phases: phases(["[seal] Plan", "in_progress"]) })).toContain("◷ seal Plan awaits you");
	});

	test("nerd mode uses the todo.ts agent glyphs on every box title, each followed by two spaces", () => {
		const tags = STATIONS.flatMap(s => s[1]).filter((t, i, a) => a.indexOf(t) === i);
		const all: Phase[] = [{ name: "All", tasks: tags.map((tag, i) => ({ content: `[${tag}] ${tag} job`, status: i ? "pending" : "in_progress" })) }];
		const t = plain(renderCockpit(cockpitView(input({ glyphs: true, phases: all })), 120, 0, TRUE).join("\n"));
		for (const g of ["\u{f18bc}", "\u{f0437}", "\u{f05da}", "\u{f18be}", "\u{f06ef}", "\u{f029b}", "\u{f0d9a}", "\u{f068c}", "\u{f0474}"]) expect(t).toContain(`${g}  `);
		expect(titles(t)).toHaveLength(9);
		expect(t).not.toMatch(/[☩†‡◷]/);
	});
});

describe("box line cap", () => {
	const tasks = (spec: [string, string, number][]): Phase[] => [
		{ name: "Auspex", tasks: spec.flatMap(([prefix, status, n]) => Array.from({ length: n }, (_, i) => ({ content: `[scout] ${prefix}${i + 1}`, status }))) },
	];
	// 4 active, 3 failed, 3 idle, 2 done: 12 lines in one box
	const twelve = () => tasks([["d", "completed", 2], ["i", "pending", 3], ["a", "in_progress", 4], ["f", "failed", 3]]);
	const draw = (p: Phase[], width = 100, height?: number, chronicle: Entry[] = []) => renderCockpit(cockpitView(input({ phases: p, chronicle })), width, 0, TRUE, height).map(plain);

	test("box lines run active, failed, idle, then done", () => {
		const out = draw(tasks([["d", "completed", 1], ["i", "pending", 1], ["f", "failed", 1], ["a", "in_progress", 1]])).join("\n");
		const at = (s: string) => out.indexOf(s);
		expect(at("▶ a1")).toBeGreaterThan(-1);
		expect(at("▶ a1")).toBeLessThan(at("✗ f1"));
		expect(at("✗ f1")).toBeLessThan(at("○ i1"));
		expect(at("○ i1")).toBeLessThan(at("✓ d1"));
	});

	test("a box shows at most 8 lines, the last one +N more naming what it hides", () => {
		const out = draw(twelve());
		const rows = out.slice(out.findIndex(l => l.includes("┌")) + 1, out.findIndex(l => l.includes("└")));
		expect(rows).toHaveLength(8);
		const text = rows.join("\n");
		for (const id of ["a1", "a2", "a3", "a4", "f1", "f2", "f3"]) expect(text).toContain(id);
		expect(rows[7]).toContain("+5 more (2 done, 3 idle)");
		expect(text).not.toContain("✓ d");
	});

	test.each([50, 100])("active and failed lines are never hidden while a done line shows at width %i", width => {
		const p = tasks([["d", "completed", 4], ["i", "pending", 3], ["a", "in_progress", 4], ["f", "failed", 3]]);
		for (let h = 8; h <= 45; h++) {
			const text = draw(p, width, h).join("\n");
			if (/✓ d/.test(text)) for (const id of ["a1", "a2", "a3", "a4", "f1", "f2", "f3"]) expect(text).toContain(id);
		}
	});

	test("a station with 20 tasks at 140x45 still shows at least 5 chronicle rows", () => {
		const states = ["in_progress", "failed", "pending", "completed"];
		const p: Phase[] = [{ name: "Skirmish", tasks: Array.from({ length: 20 }, (_, i) => ({ content: `[battle-brother] Build squad s${i + 1}`, status: states[i % 4] })) }];
		const slices = Array.from({ length: 20 }, (_, i) => ({ id: `s${i + 1}` }));
		const out = renderCockpit(cockpitView(input({ phases: p, slices, chronicle: many(10) })), 140, 0, TRUE, 45);
		expect(out).toHaveLength(45);
		expect(eventLines(out).length).toBeGreaterThanOrEqual(5);
	});

	test.each([50, 100])("a short window gives the boxes fewer lines so the chronicle keeps 5 rows at width %i", width => {
		const p = tasks([["t", "pending", 20]]);
		const out = draw(p, width, 18, many(10));
		expect(out).toHaveLength(18);
		expect(eventLines(out)).toHaveLength(5);
		expect(out.join("\n")).toContain(width === 50 ? "+14 more" : "+15 more"); // stacked: no SEALS row without seals, so one more line fits
	});
});

describe("seal chain and seal panel", () => {
	const PARCHMENT = TRUE.parchment;
	const DEFAULT = "the details are in the Captain's message";
	const waiting = (id = "Plan") => phases(["[captain] Orders", "completed"], [`[seal] ${id}`, "in_progress"], ["[seal] Demo", "pending"]);
	const draw = (over: Partial<ViewInput>, width = 140) => renderCockpit(cockpitView(input(over)), width, 0, TRUE);
	const lines = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
	const edges = (l: string) => ({ left: l.indexOf("┌"), right: l.lastIndexOf("┐") });

	test("no SEAL box at 140 with seal tasks in the active phase", () => {
		const t = text({ phases: run(4).map((p, i) => (i === 4 ? { ...p, tasks: [...p.tasks, { content: "[seal] Demo", status: "in_progress" }] } : p)) }, 140);
		expect(t).not.toMatch(/SEAL ─/);
		expect(t).not.toMatch(/┌─ \S* ?SEAL ─/);
	});

	test("the chain reads ✠ Plan → ○ Demo with a gold ✠ and an iron ○, Demo (2) whole", () => {
		const p = phases(["[seal] Plan", "completed"], ["[seal] Demo", "pending"]);
		expect(text({ phases: p })).toContain("SEALS ✠ Plan → ○ Demo");
		const out = draw({ phases: p }).join("\n");
		expect(out).toContain(`${GOLD}✠`);
		expect(out).toContain(`${IRON}○`);
		expect(text({ phases: phases(["[seal] Demo (2)", "in_progress"]) })).toContain("○ Demo (2)");
		expect(text({ phases: phases(["[seal] Demo (2)", "in_progress"]) }, 50)).toContain("○ Demo (2)");
	});

	test("the title and the panel name a seal whole: Demo (2)", () => {
		const t = text({ phases: phases(["[seal] Demo (2)", "in_progress"]) });
		expect(t).toContain("seal Demo (2) awaits you");
		expect(t).toContain("SEAL DEMO (2) · awaits you");
	});

	test("the panel is one gold box as wide as the box grid, between the station row and the boxes", () => {
		const raw = draw({ phases: waiting() });
		const out = raw.map(plain);
		const at = out.findIndex(l => l.includes("SEAL PLAN · awaits you"));
		const station = out.findIndex(l => l.startsWith("╟─ ▶ Plan"));
		const boxTop = out.findIndex(l => l.includes("CAPTAIN"));
		expect(station).toBeGreaterThan(-1);
		expect(at).toBe(station + 1);
		expect(boxTop).toBeGreaterThan(at);
		expect(edges(out[at])).toEqual({ left: 2, right: 140 - 3 });
		expect(edges(out[boxTop]).left).toBe(2);
		expect(raw[at]).toContain(`${GOLD}┌─ ○ SEAL PLAN · awaits you`);
	});

	test("without prepared lines the panel shows its one default line in iron", () => {
		const raw = draw({ phases: waiting() });
		const row = raw.find(l => l.includes(DEFAULT))!;
		expect(row).toContain(`${IRON}${DEFAULT}`);
		expect(cockpitView(input({ phases: waiting() })).panel).toEqual({ title: "○ SEAL PLAN · awaits you", lines: [DEFAULT], prepared: false });
	});

	test("prepared lines show in parchment when the id matches, the default line when it does not", () => {
		const mine = draw({ phases: waiting(), seal: { id: "Plan", lines: ["Squads: a, b"] } });
		expect(mine.find(l => l.includes("Squads: a, b"))).toContain(`${PARCHMENT}Squads: a, b`);
		expect(plain(mine.join("\n"))).not.toContain(DEFAULT);
		const other = text({ phases: waiting(), seal: { id: "Demo", lines: ["Squads: a, b"] } });
		expect(other).toContain(DEFAULT);
		expect(other).not.toContain("Squads: a, b");
		expect(text({ phases: waiting(), seal: { id: "Plan", lines: [] } })).toContain(DEFAULT);
	});

	test("a long prepared line ends in … inside the frame", () => {
		const out = draw({ phases: waiting(), seal: { id: "Plan", lines: ["x".repeat(300)] } }).map(plain);
		const row = out.find(l => l.includes("xxxx"))!;
		expect(row).toMatch(/x…\s*│\s*║$/);
		expect(Bun.stringWidth(row)).toBe(140);
	});

	test("12 lines all show; 14 lines show the first 11 and +3 more", () => {
		const twelve = text({ phases: waiting(), seal: { id: "Plan", lines: lines(12) } });
		expect(twelve).toContain("line 12");
		expect(twelve).not.toContain("more");
		const fourteen = text({ phases: waiting(), seal: { id: "Plan", lines: lines(14) } });
		expect(fourteen).toContain("line 11");
		expect(fourteen).not.toContain("line 12");
		expect(fourteen).toContain("+3 more");
		expect(draw({ phases: waiting(), seal: { id: "Plan", lines: lines(14) } }).find(l => l.includes("+3 more"))).toContain(`${IRON}+3 more`);
	});

	test("no panel when nothing waits, even with a seal stored", () => {
		const p = phases(["[seal] Plan", "pending"]);
		expect(cockpitView(input({ phases: p, seal: { id: "Plan", lines: ["x"] } })).panel).toBeUndefined();
		expect(text({ phases: p, seal: { id: "Plan", lines: ["x"] } })).not.toContain("awaits you");
	});

	test("the stacked panel at 50: a gold title then each line indented two spaces, after the station line", () => {
		const raw = draw({ phases: waiting(), seal: { id: "Plan", lines: ["Squads: a", "Bar: b"] } }, 50);
		const out = raw.map(plain);
		const station = out.findIndex(l => l.startsWith("▶ Plan"));
		expect(out.slice(station + 1, station + 4)).toEqual(["○ SEAL PLAN · awaits you", "  Squads: a", "  Bar: b"]);
		expect(raw[station + 1]).toContain(`${GOLD}○ SEAL PLAN`);
	});

	const bodies: [string, Phase[]][] = [
		["nothing", []],
		["a seal waits", waiting()],
		["a seal is pending", phases(["[seal] Plan", "pending"])],
		["a seal is granted", phases(["[seal] Plan", "completed"])],
		["a non-seal runs", phases(["[captain] x", "in_progress"])],
	];
	describe.each(bodies.flatMap(([n, p]) => [50, 71, 72, 100, 140].flatMap(w => [0, 1, 14].map(k => [n, p, w, k] as const))))("%s at %i columns with %i lines", (_n, p, width, k) => {
		const view = cockpitView(input({ phases: p, glyphs: false, seal: { id: "Plan", lines: lines(k) } }));
		test("every line is exactly width cells when framed, at most width when stacked", () => {
			for (const l of renderCockpit(view, width, 0, TRUE)) {
				if (width >= 72) expect(Bun.stringWidth(l)).toBe(width);
				else expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width);
			}
		});
		test("the panel exists iff a seal waits", () => {
			expect(view.panel !== undefined).toBe(waitingSeal(p) !== undefined);
		});
		test("a SEALS row exists iff there are seals", () => {
			expect(plain(renderCockpit(view, width, 0, TRUE).join("\n")).includes("SEALS")).toBe(sealsFrom(p).length > 0);
		});
	});
});

describe("seal panel hardening", () => {
	const waiting = (id = "Plan") => phases(["[captain] Orders", "completed"], [`[seal] ${id}`, "in_progress"], ["[seal] Demo", "pending"]);
	const out = (over: Partial<ViewInput>, width = 140, height?: number) => renderCockpit(cockpitView(input(over)), width, 0, TRUE, height);
	const noControls = (s: string) => /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029]/.test(plain(s));
	const wide = ["❤️".repeat(60), "👨‍👩‍👧".repeat(30), "字".repeat(80), "x".repeat(300), `a${"❤️".repeat(5)}${"字".repeat(40)}`];

	test.each([140, 50])("prepared lines never carry an escape or bidi control to the terminal (width %i)", width => {
		const raw = out({ phases: waiting(), seal: { id: "Plan", lines: ["a\x1b]0;PWN\x07tail", "b\u202eevil\u2066x\u2069\u2028y\u2029z"] } }, width).join("\n");
		expect(noControls(raw)).toBe(false);
		expect(plain(raw)).toContain("a ]0;PWN tail");
		expect(plain(raw)).toContain("b evil x  y z");
	});

	test("clean turns LRM, RLM and ALM into spaces", () => {
		expect(clean("a\u200eb\u200fc\u061cd")).toBe("a b c d");
	});

	test("a waiting seal's name is cleaned in the chain, the station note and the panel title", () => {
		const id = "Plan\x1b]0;pwn\x07";
		const view = cockpitView(input({ phases: waiting(id) }));
		for (const width of [140, 50]) expect(noControls(renderCockpit(view, width, 0, TRUE).join("\n"))).toBe(false);
		expect(view.panel!.title).toContain("PLAN ]0;PWN ");
		expect(view.station.note).toContain("seal Plan ]0;pwn ");
		expect(view.seals.map(s => s.id)).toContain("Plan ]0;pwn ");
	});

	test("prepared lines that are all blank after cleaning count as none: the default line shows", () => {
		const t = plain(out({ phases: waiting(), seal: { id: "Plan", lines: ["", "  ", "\x1b\t\u202e"] } }).join("\n"));
		expect(t).toContain("the details are in the Captain's message");
		expect(cockpitView(input({ phases: waiting(), seal: { id: "Plan", lines: [" "] } })).panel!.prepared).toBe(false);
	});

	test("stacked at height 30 with seals, a 14-line panel and capped boxes: at most height lines and the right +k more", () => {
		const p = phases(["[captain] Orders", "completed"], ["[seal] Plan", "in_progress"], ["[seal] Demo", "pending"], ...Array.from({ length: 20 }, (_, i) => [`[scout] t${i}`, "pending"] as [string, string]));
		const lines = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`);
		const t = out({ phases: p, seal: { id: "Plan", lines }, chronicle: many(20) }, 50, 30);
		expect(t.length).toBeLessThanOrEqual(30);
		const txt = t.map(plain);
		expect(txt).toContain("  +3 more");
		expect(txt.filter(l => /\+\d+ more/.test(l)).length).toBeGreaterThanOrEqual(2); // panel and the capped box
		expect(eventLines(t).length).toBeGreaterThanOrEqual(5);
	});

	// At height 30 the floor() hides the seals row; at 29 it costs a chronicle row, so the term in boxCap is pinned here.
	test("stacked at height 29 with seals: the seals row is budgeted, the chronicle gets exactly 6 rows", () => {
		const p = phases(["[captain] Orders", "completed"], ["[seal] Plan", "in_progress"], ["[seal] Demo", "pending"], ...Array.from({ length: 20 }, (_, i) => [`[scout] t${i}`, "pending"] as [string, string]));
		const t = out({ phases: p, seal: { id: "Plan", lines: Array.from({ length: 14 }, (_, i) => `line ${i + 1}`) }, chronicle: many(20) }, 50, 29);
		expect(t).toHaveLength(29);
		expect(eventLines(t)).toHaveLength(6);
	});

	test("framed at 140x30 with a 12-line panel and a 20-task box: at most height lines, the chronicle keeps 5 rows", () => {
		const p = phases(["[seal] Plan", "in_progress"], ...Array.from({ length: 20 }, (_, i) => [`[scout] t${i}`, "pending"] as [string, string]));
		const t = out({ phases: p, seal: { id: "Plan", lines: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`) }, chronicle: many(20) }, 140, 30);
		expect(t).toHaveLength(30);
		expect(eventLines(t).length).toBeGreaterThanOrEqual(5);
		expect(plain(t.join("\n"))).toMatch(/\+\d+ more/);
	});

	test("the weak no-SEAL-box check also holds where a seal waits: the panel is there", () => {
		const t = plain(out({ phases: waiting() }).join("\n"));
		expect(t).toMatch(/┌─ \S* ?SEAL PLAN · awaits you/);
		expect(plain(out({ phases: phases(["[seal] Plan", "pending"]) }).join("\n"))).not.toMatch(/SEAL PLAN · awaits/);
	});

	describe("widths count terminal cells per grapheme", () => {
		test.each(wide)("%#: every line fits, framed lines are exactly width", glyphs => {
			const ph = waiting(glyphs);
			for (const width of [30, 50, 71, 72, 100, 140])
				for (const over of [{ chronicle: [{ at: "10:00", who: glyphs, text: glyphs }] }, { seal: { id: glyphs, lines: [glyphs] } }])
					for (const l of renderCockpit(cockpitView(input({ key: glyphs, phases: ph, ...over })), width, 0, TRUE)) {
						if (width >= 72) expect(Bun.stringWidth(plain(l))).toBe(width);
						else expect(Bun.stringWidth(plain(l))).toBeLessThanOrEqual(width);
					}
		});
	});
});

describe("live agent lines", () => {
	const MIN = 60_000;
	const NOW = 1_700_000_000_000;
	const live = (over: Partial<Live> = {}): Live => ({ since: NOW - 10 * MIN, at: NOW, ...over });
	// One scout deployed `ago` minutes before NOW, with `l` as its live file.
	const scout = (l: Live | undefined, d: Partial<Deployed> = {}, ago = 10) =>
		input({ phases: phases(["[scout] look", "in_progress"]), deployed: new Map([["A", dep({ at: NOW - ago * MIN, ...d })]]), live: l && new Map([["A", l]]), now: NOW });
	const draw = (i: ViewInput, width = 100) => renderCockpit(cockpitView(i), width, 0, TRUE);
	const rows = (i: ViewInput, width = 100) => draw(i, width).map(plain);
	const squad = (l: Live | undefined) =>
		input({
			phases: [{ name: "Skirmish", tasks: [{ content: "[battle-brother] build", status: "in_progress" }] }],
			slices: [{ id: "a" }],
			agents: { Brother: { id: "a" } },
			deployed: new Map([["A", dep({ role: "battle-brother", squad: "a", station: "Skirmish", at: NOW - 10 * MIN })]]),
			live: l && new Map([["A", l]]),
			now: NOW,
		});

	test("a squad shows elapsed, done/total, the ETA and the current task under its line", () => {
		const out = rows(squad(live({ done: 2, total: 5, current: "Write tests" })));
		const at = out.findIndex(l => l.includes("squad a forging"));
		expect(at).toBeGreaterThan(-1);
		expect(out[at + 1]).toContain("10m · 2/5 · ~15m · Write tests");
	});

	test("no ETA while nothing is done, nor when everything is", () => {
		expect(rows(squad(live({ done: 0, total: 5, current: "x" }))).join("\n")).toContain("10m · 0/5 · x");
		expect(rows(squad(live({ done: 0, total: 5 }))).join("\n")).not.toContain("~");
		expect(rows(squad(live({ done: 5, total: 5 }))).join("\n")).not.toContain("~");
	});

	test("the ETA rounds up and reads hours past 60 minutes", () => {
		expect(rows(scout(live({ done: 1, total: 2 }), {}, 61)).join("\n")).toContain("1h01m · 1/2 · ~1h01m");
		expect(rows(scout(live({ done: 1, total: 3 }), {}, 1)).join("\n")).toContain("1m · 1/3 · ~2m");
	});

	test("without a todo: elapsed and the intent, else the tool name", () => {
		expect(rows(scout(live({ intent: "Reading the cockpit", tool: "read" }))).join("\n")).toContain("10m · Reading the cockpit");
		expect(rows(scout(live({ tool: "read" }))).join("\n")).toContain("10m · read");
		expect(rows(scout(live())).join("\n")).toMatch(/\n.*│ {3}10m {1,}│/);
	});

	test("a todo with total 0 is no todo", () => {
		expect(rows(scout(live({ done: 0, total: 0, intent: "Idle" }))).join("\n")).toContain("10m · Idle");
	});

	test("elapsed reads <1m under a minute and 1h05m past an hour", () => {
		expect(rows(scout(live(), {}, 0.5)).join("\n")).toContain("<1m");
		expect(rows(scout(live(), {}, 65)).join("\n")).toContain("1h05m");
	});

	test("with no live entry: elapsed only; with no deploy time and no live: no detail", () => {
		expect(rows(scout(undefined)).join("\n")).toMatch(/\n.*│ {3}10m {1,}│/);
		const bare = input({ phases: phases(["[scout] look", "in_progress"]), deployed: new Map([["A", dep({})]]), now: NOW });
		expect(rows(bare).join("\n")).not.toMatch(/\dm\b|<1m/);
		expect(rows(bare).join("\n")).toContain("▶ A");
	});

	test("with no deploy time the live file's since gives the elapsed", () => {
		expect(rows(scout(live({ since: NOW - 3 * MIN, intent: "Go" }), { at: undefined })).join("\n")).toContain("3m · Go");
	});

	test("done agents show no detail", () => {
		expect(rows(scout(live({ intent: "Reading" }), { state: "done" })).join("\n")).not.toContain("Reading");
	});

	test("a stalled agent draws mark, text and detail in gold, with the minutes", () => {
		const l = live({ at: NOW - 6 * MIN, intent: "Reading" });
		const raw = draw(scout(l, { stalled: l.at })).join("\n");
		expect(rows(scout(l, { stalled: l.at })).join("\n")).toContain("stalled 6m · 10m · Reading");
		expect(raw).toContain(`${GOLD}▶\x1b[39m ${GOLD}A\x1b[39m`);
		expect(raw).toContain(`${GOLD}stalled 6m`);
	});

	test("a stall mark for an older tool call no longer applies", () => {
		const l = live({ at: NOW - 1 * MIN });
		const out = rows(scout(l, { stalled: NOW - 8 * MIN })).join("\n");
		expect(out).not.toContain("stalled");
		expect(draw(scout(l, { stalled: NOW - 8 * MIN })).join("\n")).not.toContain(`${GOLD}▶`);
	});

	test("an agent with no live entry marked stalled at its deploy draws gold with minutes and elapsed", () => {
		const at = NOW - 10 * MIN;
		expect(rows(scout(undefined, { stalled: at })).join("\n")).toContain("stalled 10m · 10m");
		const raw = draw(scout(undefined, { stalled: at })).join("\n");
		expect(raw).toContain(`${GOLD}▶\x1b[39m ${GOLD}A\x1b[39m`);
		expect(raw).toContain(`${GOLD}stalled 10m`);
	});

	test("an agent with no live entry and no stall mark draws elapsed only, not gold", () => {
		const out = rows(scout(undefined)).join("\n");
		expect(out).not.toContain("stalled");
		expect(draw(scout(undefined)).join("\n")).not.toContain(`${GOLD}▶`);
		expect(rows(scout(undefined, { stalled: NOW - 3 * MIN })).join("\n")).not.toContain("stalled");
	});

	test("a warn chronicle entry is gold", () => {
		const raw = draw(input({ chronicle: [{ at: "10:00", who: "A", text: "stalled 6m", tone: "warn" }] })).join("\n");
		expect(raw).toContain(`${GOLD}stalled 6m`);
	});

	test("ANSI, OSC links, control, bidi and U+2028 are removed from current, intent and tool, on one row", () => {
		const hostile = "\x1b[31mred\x1b[0m \x1b]8;;http://evil.test\x07link\x1b]8;;\x07\ttab\r\nnl \u202eRTL\u2066\u2028x\u0085\x00\x7f end";
		for (const i of [squad(live({ done: 1, total: 2, current: hostile })), scout(live({ intent: hostile })), scout(live({ tool: hostile }))]) {
			const out = draw(i, 140);
			expect(out.join("\n").replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/[\x1b\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029]/);
			expect(out.join("\n")).toContain("red link tab nl RTL x end");
		}
	});

	test.each([100, 140])("a 300-character intent is cut with … inside the box width at %i columns", width => {
		const out = rows(scout(live({ intent: "w".repeat(300) })), width);
		const row = out.find(l => l.includes("wwww"))!;
		expect(row).toContain("…");
		expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
		for (const l of out.slice(0, -1)) expect(Bun.stringWidth(l)).toBe(width);
	});

	test("the row cap never separates a line from its detail", () => {
		const many = Array.from({ length: 6 }, (_, i) => [`A${i}`, dep({ at: NOW - 10 * MIN })] as const);
		const i = input({ phases: phases(["[scout] look", "in_progress"]), deployed: new Map(many), live: new Map(many.map(([id]) => [id, live({ intent: `intent ${id}` })])), now: NOW });
		const out = rows(i);
		const box = out.slice(out.findIndex(l => l.includes("┌")) + 1, out.findIndex(l => l.includes("└")));
		expect(box).toHaveLength(8); // the task line, 3 whole line+detail pairs, then the +N more row
		for (const [n, r] of box.entries()) if (/intent A\d/.test(r)) expect(box[n - 1]).toMatch(/▶ A\d/);
		expect(box.at(-1)).toMatch(/\+\d+ more/);
		// The pair that would cross the cap goes whole into the +N more count.
		const shown = box.filter(r => /▶ A\d/.test(r)).length;
		expect(box.filter(r => /intent A\d/.test(r))).toHaveLength(shown);
		expect(shown).toBe(3);
		expect(box.at(-1)).toContain(`+${6 - shown} more`);
	});

	test("a rendered row is 2 cells in for a detail, in iron when not stalled", () => {
		const raw = draw(scout(live({ intent: "Reading" }))).find(l => l.includes("Reading"))!;
		expect(raw).toContain(`  ${TRUE.iron}10m · Reading`);
	});

	// properties: no property-test library in the repo, so each invariant runs over a fixed adversarial corpus.
	const CORPUS = ["", " ", "plain", "\x1b[31mred", "\x1b]8;;u\x07l\x1b]8;;\x07", "\x1b", "\x1b]8;;http://x", "a\tb\r\nc", "\u202e\u2066\u2028\u2029\u200e\u061c", "\x00\x07\x7f\x9b", "日本語".repeat(40), "e\u0301".repeat(150), "👨‍👩‍👧".repeat(60), "x".repeat(5000), "\x1b[".repeat(100)];
	const NUMS: [number | undefined, number | undefined][] = [[0, 5], [1, 5], [4, 5], [5, 5], [6, 5], [0, 0], [undefined, 3], [2, undefined], [-1, 4], [1.5, 4], [Number.NaN, 4], [3, Number.POSITIVE_INFINITY]];

	test("property 1: a row has no escape but the palette's, nor a control or bidi character from agent text", () => {
		const sgr = /\x1b\[[0-9;]*m/g;
		for (const s of CORPUS)
			for (const width of [40, 100, 140]) {
				const out = [squad(live({ done: 1, total: 2, current: s, intent: s, tool: s })), scout(live({ intent: s, tool: s }))].flatMap(i => draw(i, width));
				for (const l of out) expect(l.replace(sgr, "")).not.toMatch(/[\x00-\x09\x0b-\x1a\x1c-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029\u200e\u200f\u061c]|\x1b/);
			}
	});

	test("property 2: every drawn row is exactly the width, so no box row is wider than the box", () => {
		for (const s of CORPUS)
			for (const width of [40, 71, 72, 100, 140]) {
				const out = rows(squad(live({ done: 1, total: 2, current: s })), width).concat(rows(scout(live({ intent: s })), width));
				for (const l of out) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width);
			}
	});

	test("property 3: the ETA is there iff 0 < done < total", () => {
		for (const [done, total] of NUMS) {
			const detail = rows(squad(live({ done, total, current: "t" })), 140).join("\n");
			const valid = Number.isInteger(done) && Number.isInteger(total) && done! > 0 && done! < total!;
			expect(detail.includes("~")).toBe(valid);
		}
	});
});
