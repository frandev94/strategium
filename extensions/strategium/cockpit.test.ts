import { describe, expect, test } from "bun:test";
import {
	activePhase,
	closes,
	clean,
	transcriptLines,
	briefRow,
	cockpitView,
	cockpitKey,
	detailKey,
	wrap,
	colorDepth,
	grantedSeals,
	waitingSeal,
	jobEnds,
	navKey,
	navigate,
	palette,
	pushEntry,
	renderCockpit,
	sealsFrom,
	type Deployed,
	type Entry,
	type Live,
	type Nav,
	type NavKey,
	type Phase,
	type View,
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
		expect(out[at + 1]).toContain("10m · $? · 2/5 · ~15m · Write tests");
	});

	test("no ETA while nothing is done, nor when everything is", () => {
		expect(rows(squad(live({ done: 0, total: 5, current: "x" }))).join("\n")).toContain("10m · $? · 0/5 · x");
		expect(rows(squad(live({ done: 0, total: 5 }))).join("\n")).not.toContain("~");
		expect(rows(squad(live({ done: 5, total: 5 }))).join("\n")).not.toContain("~");
	});

	test("the ETA rounds up and reads hours past 60 minutes", () => {
		expect(rows(scout(live({ done: 1, total: 2 }), {}, 61)).join("\n")).toContain("1h01m · $? · 1/2 · ~1h01m");
		expect(rows(scout(live({ done: 1, total: 3 }), {}, 1)).join("\n")).toContain("1m · $? · 1/3 · ~2m");
	});

	test("without a todo: elapsed and the intent, else the tool name", () => {
		expect(rows(scout(live({ intent: "Reading the cockpit", tool: "read" }))).join("\n")).toContain("10m · $? · Reading the cockpit");
		expect(rows(scout(live({ tool: "read" }))).join("\n")).toContain("10m · $? · read");
		expect(rows(scout(live())).join("\n")).toMatch(/\n.*│ {3}10m · \$\? {1,}│/);
	});

	test("a todo with total 0 is no todo", () => {
		expect(rows(scout(live({ done: 0, total: 0, intent: "Idle" }))).join("\n")).toContain("10m · $? · Idle");
	});

	test("elapsed reads <1m under a minute and 1h05m past an hour", () => {
		expect(rows(scout(live(), {}, 0.5)).join("\n")).toContain("<1m");
		expect(rows(scout(live(), {}, 65)).join("\n")).toContain("1h05m");
	});

	test("with no live entry: elapsed only; with no deploy time and no live: no detail", () => {
		expect(rows(scout(undefined)).join("\n")).toMatch(/\n.*│ {3}10m · \$\? {1,}│/);
		const bare = input({ phases: phases(["[scout] look", "in_progress"]), deployed: new Map([["A", dep({})]]), now: NOW });
		expect(rows(bare).join("\n")).not.toMatch(/\dm\b|<1m/);
		expect(rows(bare).join("\n")).toContain("▶ A");
	});

	test("with no deploy time the live file's since gives the elapsed", () => {
		expect(rows(scout(live({ since: NOW - 3 * MIN, intent: "Go" }), { at: undefined })).join("\n")).toContain("3m · $? · Go");
	});

	test("done agents show no detail", () => {
		expect(rows(scout(live({ intent: "Reading" }), { state: "done" })).join("\n")).not.toContain("Reading");
	});

	describe("agent cost", () => {
		test("the cost follows the elapsed span on the row", () => {
			const out = rows(squad(live({ done: 2, total: 5, current: "Write tests", cost: 0.42 })));
			expect(out[out.findIndex(l => l.includes("squad a forging")) + 1]).toContain("10m · $0.42 · 2/5 · ~15m · Write tests");
		});

		test("$? with a live row that has no cost, and with no live row", () => {
			expect(rows(scout(live({ intent: "Go" }))).join("\n")).toContain("10m · $? · Go");
			expect(rows(scout(undefined)).join("\n")).toMatch(/\n.*│ {3}10m · \$\? {1,}│/);
		});

		test("a cost of 0 is a real cost: $0.00", () => {
			expect(rows(scout(live({ cost: 0 }))).join("\n")).toContain("10m · $0.00");
		});

		test("a done agent gets no detail row, so no cost", () => {
			expect(rows(scout(live({ cost: 0.42 }), { state: "done" })).join("\n")).not.toMatch(/\$/);
		});

		test("an unknown cost never prints $0.00", () => {
			for (const l of [undefined, live(), live({ cost: undefined }), live({ cost: Number.NaN }), live({ cost: -1 }), live({ cost: Infinity })]) {
				const out = rows(scout(l)).join("\n");
				expect(out).not.toContain("$0.00");
				expect(out).toContain("$?");
			}
		});

		test("the cost survives truncation at 100 columns with a 300-character current", () => {
			const out = rows(squad(live({ done: 1, total: 2, current: "w".repeat(300), cost: 1.07 })), 100);
			const row = out.find(l => l.includes("$1.07")) ?? "";
			expect(row).toContain("10m · $1.07 · 1/2");
			expect(row).toContain("…");
			for (const r of out) expect(Bun.stringWidth(r)).toBeLessThanOrEqual(100);
		});

		test("properties: the cost part is $? iff cost is not a finite number >= 0", () => {
			const picks = [undefined, null, "0.4", NaN, Infinity, -Infinity, -0.01, -1, 0, 0.004, 0.005, 1.005, 42, 1e6];
			for (const cost of picks) {
				const row = rows(scout(live({ cost: cost as number })), 140).find(l => /\b10m · /.test(l)) ?? "";
				const ok = typeof cost === "number" && Number.isFinite(cost) && cost >= 0;
				expect(row).toContain(ok ? `10m · $${cost.toFixed(2)}` : "10m · $?");
				if (!ok) expect(row).not.toMatch(/\$\d/);
			}
		});
	});

	test("a stalled agent draws mark, text and detail in gold, with the minutes", () => {
		const l = live({ at: NOW - 6 * MIN, intent: "Reading" });
		const raw = draw(scout(l, { stalled: l.at })).join("\n");
		expect(rows(scout(l, { stalled: l.at })).join("\n")).toContain("stalled 6m · 10m · $? · Reading");
		expect(raw).toContain(`${GOLD}▶\x1b[39m ${GOLD}A\x1b[39m`);
		expect(raw).toContain(`${GOLD}stalled 6m`);
	});

	test("a stall mark for an older tool call no longer applies", () => {
		const l = live({ at: NOW - 1 * MIN });
		const out = rows(scout(l, { stalled: NOW - 8 * MIN })).join("\n");
		expect(out).not.toContain("stalled");
		expect(draw(scout(l, { stalled: NOW - 8 * MIN })).join("\n")).not.toContain(`${GOLD}▶`);
	});

	test("an agent with no live entry is not gold even when marked stalled", () => {
		const at = NOW - 10 * MIN;
		expect(rows(scout(undefined, { stalled: at })).join("\n")).not.toContain("stalled");
		expect(draw(scout(undefined, { stalled: at })).join("\n")).not.toContain(`${GOLD}▶`);
	});

	test("an agent with no live entry and no stall mark draws elapsed only, not gold", () => {
		const out = rows(scout(undefined)).join("\n");
		expect(out).not.toContain("stalled");
		expect(draw(scout(undefined)).join("\n")).not.toContain(`${GOLD}▶`);
		expect(rows(scout(undefined, { stalled: NOW - 3 * MIN })).join("\n")).not.toContain("stalled");
	});

	test("a signalled line, eta and todo render in the documented order", () => {
		const out = rows(squad(live({ done: 2, total: 5, current: "x", line: "GREEN parser", eta_min: 4 })));
		expect(out[out.findIndex(l => l.includes("squad a forging")) + 1]).toContain("10m · $? · 2/5 · ~4m · GREEN parser");
	});

	test("pct replaces done/total", () => {
		const out = rows(squad(live({ done: 2, total: 5, pct: 60, current: "x" }))).join("\n");
		expect(out).toContain("10m · $? · 60% · ~15m · x");
		expect(out).not.toContain("2/5");
		expect(rows(scout(live({ pct: 0 }))).join("\n")).toContain("10m · $? · 0%");
	});

	test("eta_min shows with no todo; 0 reads ~<1m", () => {
		expect(rows(scout(live({ eta_min: 4 }))).join("\n")).toContain("10m · $? · ~4m");
		expect(rows(scout(live({ eta_min: 0 }))).join("\n")).toContain("10m · $? · ~<1m");
	});

	test("an empty line falls back to current, then intent", () => {
		expect(rows(squad(live({ done: 1, total: 2, current: "Write tests", line: "  " }))).join("\n")).toContain("Write tests");
		expect(rows(scout(live({ intent: "Reading", line: "" }))).join("\n")).toContain("10m · $? · Reading");
	});

	test("a blocked row says so first and draws gold", () => {
		const raw = draw(scout(live({ blocked: true, line: "need the API shape" }))).join("\n");
		expect(plain(raw)).toContain("blocked · 10m · $? · need the API shape");
		expect(raw).toContain(`${GOLD}blocked · 10m`);
		expect(raw).toContain(`${GOLD}▶\x1b[39m ${GOLD}A\x1b[39m`);
	});

	test("blocked and stalled together read blocked · stalled Nm · …", () => {
		const l = live({ at: NOW - 6 * MIN, blocked: true, line: "why" });
		expect(rows(scout(l, { stalled: l.at })).join("\n")).toContain("blocked · stalled 6m · 10m · $? · why");
	});

	test("a hostile line renders as one clean row", () => {
		const hostile = "\x1b[31mred\x1b[0m \x1b]8;;http://evil\x07link\x1b]8;;\x07\x00\x07\u202eevil\u2066\u2028next\r\nend";
		const out = rows(scout(live({ line: hostile })));
		const row = out.find(l => l.includes("10m · ")) ?? "";
		expect(row).toContain("10m · $? · red link evil next end");
		for (const r of out) expect(r).not.toMatch(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/u);
	});

	test("a 300-character line is cut with … inside the box at 100 and 140 columns", () => {
		for (const w of [100, 140]) {
			const out = rows(scout(live({ line: "w".repeat(300) })), w);
			const row = out.find(l => l.includes("10m · $? · w")) ?? "";
			expect(row).toContain("…");
			for (const r of out) expect(Bun.stringWidth(r)).toBeLessThanOrEqual(w);
		}
	});

	test("properties: hostile fields keep rows clean and inside the box; ~ iff eta_min or a part-done todo", () => {
		let seed = 115;
		const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
		const pieces = ["a", "界", "\x1b[31m", "\x1b]8;;u\x07", "\x00", "\u202e", "\u2028", "\n", " ", "…", "x".repeat(80), "\ud83d\ude00"];
		const txt = () => Array.from({ length: rnd(12) }, () => pieces[rnd(pieces.length)]).join("");
		for (let i = 0; i < 300; i++) {
			const total = rnd(4) === 0 ? undefined : rnd(6);
			const done = total === undefined ? undefined : rnd(total + 1);
			const eta_min = rnd(2) ? rnd(100) : undefined;
			const l = live({ done, total, eta_min, pct: rnd(2) ? rnd(101) : undefined, line: txt(), current: txt(), intent: txt(), blocked: rnd(2) ? true : undefined });
			const width = 40 + rnd(120);
			const out = draw(scout(l), width);
			for (const r of out) {
				expect(r.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/u);
				expect(Bun.stringWidth(r)).toBeLessThanOrEqual(width);
			}
			// the detail is the second row under the agent line; ~ can only come from eta_min or the computed ETA
			const text = (done !== undefined && total !== undefined && total > 0 && eta_min === undefined && done > 0 && done < total) || eta_min !== undefined;
			const detail = out.map(plain).find(r => /\b10m\b/.test(r)) ?? "";
			const head = detail.split("│")[1]?.trim().split(" · ").slice(0, l.blocked ? 5 : 4).join(" · ") ?? "";
			if (width >= 100 && !/…/.test(head)) expect(/(^| )~/.test(head)).toBe(text);
		}
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

	test("an even number of rows drawn still leaves one for +N more, and no pair is split", () => {
		const many = Array.from({ length: 6 }, (_, i) => [`A${i}`, dep({ at: NOW - 10 * MIN })] as const);
		const i = input({ phases: phases(["[captain] x", "in_progress"]), deployed: new Map(many), live: new Map(many.map(([id]) => [id, live({ intent: `intent ${id}` })])), now: NOW });
		const out = rows(i);
		const box = out.slice(out.findIndex(l => l.includes("┌")) + 1, out.findIndex(l => l.includes("└")));
		expect(box).toHaveLength(7); // 3 whole pairs (6 rows), the next pair would reach 8 = cap, so +N more takes the last row
		expect(box.filter(r => /▶ A\d/.test(r))).toHaveLength(3);
		expect(box.at(-1)).toContain("+3 more");
	});

	test("a squad whose brother failed and whose veteran is active shows the veteran's row", () => {
		const i = input({
			phases: [{ name: "Skirmish", tasks: [{ content: "[battle-brother] build", status: "in_progress" }] }],
			slices: [{ id: "a" }],
			agents: { Veteran: { id: "a" } },
			notes: { a: { veteran: true, failed: true } },
			deployed: new Map([
				["B", dep({ role: "battle-brother", squad: "a", station: "Skirmish", state: "failed", at: NOW - 20 * MIN })],
				["V", dep({ role: "veteran", squad: "a", station: "Skirmish", at: NOW - 10 * MIN })],
			]),
			live: new Map([["V", live({ done: 1, total: 2, current: "Veteran work" })]]),
			now: NOW,
		});
		const out = rows(i);
		const at = out.findIndex(l => l.includes("squad a forging"));
		expect(at).toBeGreaterThan(-1);
		expect(out[at + 1]).toContain("10m · $? · 1/2 · ~10m · Veteran work");
	});

	test("a rendered row is 2 cells in for a detail, in iron when not stalled", () => {
		const raw = draw(scout(live({ intent: "Reading" }))).find(l => l.includes("Reading"))!;
		expect(raw).toContain(`  ${TRUE.iron}10m · $? · Reading`);
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

// ---- navigable cockpit (#123): navKey, the cursor model, stations, windows and the selected line ----

const ALL_KEYS = [
	// VT and SS3
	["\x1b[A", "up"], ["\x1b[B", "down"], ["\x1b[C", "right"], ["\x1b[D", "left"], ["\x1b[H", "home"],
	["\x1bOA", "up"], ["\x1bOB", "down"], ["\x1bOC", "right"], ["\x1bOD", "left"], ["\x1bOH", "home"],
	["\x1b[1~", "home"], ["\x1b[7~", "home"],
	// xterm/kitty modified form: plain, lock bits, press and repeat events
	["\x1b[1;1A", "up"], ["\x1b[1;1B", "down"], ["\x1b[1;1C", "right"], ["\x1b[1;1D", "left"], ["\x1b[1;1H", "home"],
	["\x1b[1;65A", "up"], ["\x1b[1;129B", "down"], ["\x1b[1;193C", "right"], ["\x1b[1;129D", "left"],
	["\x1b[1;1:1A", "up"], ["\x1b[1;1:2B", "down"], ["\x1b[1;129:1H", "home"], ["\x1b[1;65:2D", "left"],
	// Tab
	["\t", "tab"],
	// kitty CSI-u: tab and the keypad keys
	["\x1b[9u", "tab"], ["\x1b[9;1u", "tab"],
	["\x1b[57417u", "left"], ["\x1b[57418u", "right"], ["\x1b[57419u", "up"], ["\x1b[57420u", "down"], ["\x1b[57423u", "home"],
	["\x1b[57420;1:2u", "down"], ["\x1b[57420;129u", "down"], ["\x1b[57417;65:1u", "left"],
	// win32-input-mode key down (the replay's records), lock bits allowed
	["\x1b[38;72;0;1;256;1_", "up"], ["\x1b[40;80;0;1;256;1_", "down"], ["\x1b[37;75;0;1;256;1_", "left"], ["\x1b[39;77;0;1;256;1_", "right"],
	["\x1b[36;71;0;1;256;1_", "home"], ["\x1b[9;15;9;1;0;1_", "tab"], ["\x1b[40;80;0;1;288;1_", "down"],
] as const;
const NOT_KEYS = [
	"", "\x1b", "q", "a", "\x1b[27u", "\x1b[Z", "\x1b\x1b[A", "\x1b\x1b[1;1A", "\x1b[AB", "x\x1b[A", "\x1b[A\x1b[A", "\x1bOB\x1bOB", "\t\t", " \t",
	// releases, Alt/Ctrl/Shift chords, a zero modifier
	"\x1b[1;1:3A", "\x1b[1;129:3B", "\x1b[1;3A", "\x1b[1;5A", "\x1b[1;2A", "\x1b[1;2H", "\x1b[1;0A", "\x1b[1;1;1A",
	"\x1b[57420;1:3u", "\x1b[57420;5u", "\x1b[57420;3u", "\x1b[9;2u", "\x1b[57421u", "\x1b[57352u",
	"\x1b[38;72;0;0;256;1_", "\x1b[38;72;0;1;258;1_", "\x1b[38;72;0;1;4;1_", "\x1b[38;72;0;1;16;1_", "\x1b[41;80;0;1;256;1_", "\x1b[38;72;0;1;256;1", "\x1b[38;72;0;1;4294967296;1_",
	// a number too long for a modifier must not wrap around into "no modifier"
	`\x1b[1;${"9".repeat(400)}A`, `\x1b[38;72;0;1;${"9".repeat(400)};1_`,
	// a malformed or 4+-digit modifier must not backtrack into "no modifier"
	"\x1b[57420;1000u", "\x1b[57420;5::u", "\x1b[9;2::u",
];

describe("navKey", () => {
	test.each(ALL_KEYS)("navKey(%j) is %p", (data, key) => {
		expect(navKey(data)).toBe(key);
	});
	test.each(NOT_KEYS)("navKey(%j) is undefined", data => {
		expect(navKey(data)).toBeUndefined();
	});
	test("an arrow, Home or Tab is never a close: closes() is false for every encoding, and Esc and q stay closes", () => {
		for (const [data] of ALL_KEYS) expect(closes(data)).toBe(false);
		expect(closes("\x1b")).toBe(true);
		expect(closes("q")).toBe(true);
		expect(closes("\x1b[27u")).toBe(true);
		expect(closes("\x1b[A")).toBe(false);
	});
	test("a hostile string costs linear time and never throws", () => {
		const n = 100_000;
		const hostile = [`\x1b[${"9".repeat(n)}`, `\x1b[${":".repeat(n)}u`, `\x1b[9${":1".repeat(n)}x`, `\x1b[1;1${":".repeat(n)}A`, `\x1b[9;${"1;".repeat(n)}u`, `\x1b[${"1;".repeat(n)}_`, "\x1b".repeat(n), "\t".repeat(n)];
		const t0 = performance.now();
		for (const h of hostile) expect(navKey(h)).toBeUndefined();
		expect(performance.now() - t0).toBeLessThan(1000);
	});
	// properties: no property-test library in the repo, so a seeded random walk over the escape alphabet stands in for fast-check.
	test("property: navKey(x) defined implies closes(x) is false, for random strings over the escape alphabet", () => {
		let s = 0x9e3779b9;
		const rnd = (n: number) => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0), (s >>> 0) % n);
		const atoms = ["\x1b", "[", "O", ";", ":", "1", "2", "3", "9", "27", "65", "129", "A", "B", "H", "u", "_", "~", "q", "\t", "57420", "38", "256", "0"];
		let keys = 0;
		for (let i = 0; i < 20_000; i++) {
			const x = Array.from({ length: 1 + rnd(9) }, () => atoms[rnd(atoms.length)]).join("");
			if (navKey(x) !== undefined) {
				keys++;
				expect(closes(x)).toBe(false);
			}
		}
		expect(keys).toBeGreaterThan(0);
	});
});

// A station with a CAPTAIN box (2 lines), a BATTLE-BROTHERS box (1 line) and a chronicle of 2 entries: 5 items, 3 groups.
const NAVRUN = (over: Partial<ViewInput> = {}): ViewInput =>
	input({
		phases: [{ name: "Skirmish", tasks: [{ content: "[captain] a", status: "in_progress" }, { content: "[captain] b", status: "pending" }, { content: "[battle-brother] c", status: "pending" }] }],
		chronicle: [{ at: "10:00", who: "CAPTAIN", text: "first" }, { at: "10:01", who: "CAPTAIN", text: "second" }],
		...over,
	});
/** Press `keys` in order from nothing selected, each against the view the previous one produced; the final view. */
const press = (base: ViewInput, ...keys: NavKey[]): View => {
	let nav: Nav = {};
	for (const k of keys) nav = navigate(cockpitView({ ...base, nav }), k);
	return cockpitView({ ...base, nav });
};
const curAt = (v: View) => v.nav.cursor?.at;
const draw = (v: View, width = 100, height?: number) => renderCockpit(v, width, 0, TRUE, height).map(plain);

describe("cursor model", () => {
	test("the cockpit opens with no cursor and the first arrow or Tab selects the first item", () => {
		expect(cockpitView(NAVRUN()).nav).toEqual({});
		for (const k of ["up", "down", "tab"] as const) expect(curAt(press(NAVRUN(), k))).toBe(0);
	});
	test("the flat order is box lines in drawn order, then the chronicle newest first", () => {
		expect(cockpitView(NAVRUN()).items.map(i => i.group.replace(/^\S+ (?=[A-Z-]+$)/, ""))).toEqual(["CAPTAIN", "CAPTAIN", "BATTLE-BROTHERS", "chronicle", "chronicle"]);
		expect(cockpitView(NAVRUN()).items.slice(3).map(i => i.id)).toEqual(["log:10:01|CAPTAIN|second#0", "log:10:00|CAPTAIN|first#0"]);
	});
	test("up and down move one item, clamp at both ends and cross from a box into the chronicle", () => {
		expect([1, 2, 3, 4].map(n => curAt(press(NAVRUN(), ...Array<NavKey>(n).fill("down"))))).toEqual([0, 1, 2, 3]);
		expect(curAt(press(NAVRUN(), ...Array<NavKey>(20).fill("down")))).toBe(4);
		expect(curAt(press(NAVRUN(), ...Array<NavKey>(20).fill("down"), ...Array<NavKey>(20).fill("up")))).toBe(0);
		const v = press(NAVRUN(), "down", "down", "down", "down");
		expect(v.items[v.nav.cursor!.at].group).toBe("chronicle");
		expect(curAt(press(NAVRUN(), "down", "down", "down", "down", "up"))).toBe(2);
	});
	test("tab jumps to the first item of the next group and wraps to the first group", () => {
		expect([1, 2, 3, 4, 5].map(n => curAt(press(NAVRUN(), ...Array<NavKey>(n).fill("tab"))))).toEqual([0, 2, 3, 0, 2]);
		expect(curAt(press(NAVRUN(), "down", "tab"))).toBe(2); // from inside a group too
	});
	test("with no items the cursor stays off and moves return the nav as it is", () => {
		const empty = input();
		for (const k of ["up", "down", "tab", "left", "right", "home"] as const) expect(cockpitView({ ...empty, nav: navigate(cockpitView(empty), k) }).nav).toEqual({});
	});
	test("the seal panel lines come first, one item per line, and the default line is one item", () => {
		const p: Phase[] = [{ name: "Muster", tasks: [{ content: "[seal] Plan", status: "in_progress" }, { content: "[captain] a", status: "pending" }] }];
		const lines = cockpitView(NAVRUN({ phases: p, seal: { id: "Plan", lines: ["l1", "l2"] } })).items.map(i => i.id);
		expect(lines.slice(0, 3)).toEqual(["seal:Plan:0", "seal:Plan:1", "task:1:[captain] a"]);
		expect(cockpitView(NAVRUN({ phases: p })).items.filter(i => i.group === "seal")).toHaveLength(1);
	});
	// "no cursor exactly when there are no items" holds once a line was selected: Left, Right and Home keep an unset cursor unset.
	test("property: after any key sequence the cursor id is in items, and absent exactly when nothing was selected yet or there are no items", () => {
		let s = 12345;
		const rnd = (n: number) => ((s = (Math.imul(s, 1103515245) + 12345) | 0), ((s >>> 8) >>> 0) % n);
		const keys = ["up", "down", "left", "right", "home", "tab"] as const;
		const bases = [input(), NAVRUN(), NAVRUN({ phases: run(4), chronicle: many(30) }), input({ chronicle: many(3) })];
		for (const base of bases)
			for (let round = 0; round < 40; round++) {
				let nav: Nav = {};
				let moved = false;
				for (let i = 0; i < 30; i++) {
					const k = keys[rnd(keys.length)];
					moved ||= k === "up" || k === "down" || k === "tab";
					nav = navigate(cockpitView({ ...base, nav }), k);
					const w = cockpitView({ ...base, nav });
					expect(w.nav.cursor === undefined).toBe(!moved || w.items.length === 0);
					if (w.nav.cursor) expect(w.items[w.nav.cursor.at].id).toBe(w.nav.cursor.id);
				}
			}
	});
});

describe("window memory", () => {
	const base = input({ phases: [{ name: "Skirmish", tasks: Array.from({ length: 20 }, (_, i) => ({ content: `[captain] t${i}`, status: "pending" })) }] });
	/** Press `keys`, drawing between presses as the cockpit does (the render keeps each box's window start); the final drawn lines. */
	const pressDrawing = (...keys: NavKey[]) => {
		let nav: Nav = {};
		for (const k of keys) {
			const v = cockpitView({ ...base, nav });
			draw(v);
			nav = navigate(v, k);
		}
		const v = cockpitView({ ...base, nav });
		return draw(v);
	};
	/** The marker's row inside the box, from its first line (7 lines fit), and the text of the first line shown. */
	const marker = (lines: string[]) => {
		const top = lines.findIndex(l => l.includes("┌"));
		return { at: lines.findIndex(l => l.includes("▸")) - top - 1, first: lines[top + 1].match(/t\d+/)![0] };
	};
	const down = (n: number) => Array<NavKey>(n).fill("down");
	const up = (n: number) => Array<NavKey>(n).fill("up");

	test("going up from the end moves the marker up the window until it reaches the top, then the window scrolls", () => {
		expect(marker(pressDrawing(...down(20)))).toEqual({ at: 6, first: "t13" });
		expect(marker(pressDrawing(...down(20), ...up(3)))).toEqual({ at: 3, first: "t13" });
		expect(marker(pressDrawing(...down(20), ...up(6)))).toEqual({ at: 0, first: "t13" });
		expect(marker(pressDrawing(...down(20), ...up(8)))).toEqual({ at: 0, first: "t11" });
	});
	test("going down inside the window moves the marker without scrolling", () => {
		expect(marker(pressDrawing(...down(4)))).toEqual({ at: 3, first: "t0" });
	});
	test("a window start for a box that is gone is dropped", () => {
		const v = cockpitView({ ...base, nav: { tops: { "no such box": 3 } } });
		expect(v.nav.tops).toBeUndefined();
	});
});

describe("cursor identity", () => {
	const sel = (id: string, pos: number): Nav => ({ cursor: { id, at: pos } });
	const two = (a: string, b: string) => input({ phases: [{ name: "Skirmish", tasks: [{ content: "[captain] a", status: a }, { content: "[captain] b", status: b }] }] });
	test("a task that changes state re-sorts and the cursor follows it", () => {
		const before = cockpitView({ ...two("in_progress", "pending"), nav: sel("task:0:[captain] a", 0) });
		expect(before.nav.cursor).toEqual({ id: "task:0:[captain] a", at: 0 });
		const after = cockpitView({ ...two("completed", "in_progress"), nav: before.nav });
		expect(after.items[0].id).toBe("task:1:[captain] b"); // b runs first now
		expect(after.nav.cursor).toEqual({ id: "task:0:[captain] a", at: 1 });
	});
	test("a new chronicle entry keeps the selected entry", () => {
		const log = [{ at: "10:00", who: "A", text: "x" }, { at: "10:01", who: "A", text: "y" }];
		const v = cockpitView({ ...input({ chronicle: log }), nav: sel("log:10:00|A|x#0", 1) });
		const w = cockpitView({ ...input({ chronicle: pushEntry(log, { at: "10:02", who: "A", text: "z" }) }), nav: v.nav });
		expect(w.nav.cursor).toEqual({ id: "log:10:00|A|x#0", at: 2 });
	});
	test("the trim at the 200 cap keeps the selected entry while it lasts", () => {
		let log: Entry[] = [];
		for (let i = 0; i < 200; i++) log = pushEntry(log, { at: "10:00", who: "A", text: `e${i}` });
		const v = cockpitView({ ...input({ chronicle: log }), nav: sel("log:10:00|A|e100#0", 99) });
		expect(v.nav.cursor).toEqual({ id: "log:10:00|A|e100#0", at: 99 });
		const w = cockpitView({ ...input({ chronicle: pushEntry(log, { at: "10:00", who: "A", text: "e200" }) }), nav: v.nav });
		expect(w.chronicle).toHaveLength(200);
		expect(w.nav.cursor).toEqual({ id: "log:10:00|A|e100#0", at: 100 });
	});
	test("identical entries get distinct ids counted from the oldest", () => {
		const e = { at: "10:00", who: "A", text: "same" };
		expect(cockpitView(input({ chronicle: [e, e, e] })).chronicle.map(x => x.id)).toEqual(["log:10:00|A|same#2", "log:10:00|A|same#1", "log:10:00|A|same#0"]);
	});
	test("a removed line falls to the nearest position, and past the end to the last item", () => {
		const v = cockpitView({ ...two("pending", "pending"), nav: sel("task:1:[captain] b", 1) });
		const w = cockpitView({ ...input({ phases: [{ name: "Skirmish", tasks: [{ content: "[captain] a", status: "pending" }, { content: "[captain] c", status: "pending" }] }] }), nav: v.nav });
		expect(w.nav.cursor).toEqual({ id: "task:1:[captain] c", at: 1 });
		const gone = cockpitView({ ...input({ phases: [{ name: "Skirmish", tasks: [{ content: "[captain] a", status: "pending" }] }] }), nav: v.nav });
		expect(gone.nav.cursor).toEqual({ id: "task:0:[captain] a", at: 0 });
	});
	test("squad and agent lines are keyed by squad id and agent id", () => {
		const v = cockpitView(input({ phases: run(4), slices: [{ id: "a" }], deployed: new Map([["eval-x-1", dep({ role: "battle-brother", station: "Skirmish" })]]) }));
		const ids = v.items.map(i => i.id);
		expect(ids).toContain("squad:a");
		expect(ids).toContain("agent:eval-x-1");
	});
});

describe("stations", () => {
	const R = () => input({ phases: run(4) }); // Skirmish (index 4) is the active station
	const title = (v: View) => draw(v).find(l => l.startsWith("╟─"))!;
	test("the title names the active station by default, with no viewing note", () => {
		const v = cockpitView(R());
		expect(v.stations).toEqual({ shown: 4, active: 4, count: 8 });
		expect(title(v)).toContain("▶ Skirmish");
		expect(title(v)).not.toContain("viewing");
	});
	test("left shows the previous station and the title names both, marking the shown one", () => {
		const v = press(R(), "left");
		expect(v.nav.shown).toEqual({ phase: 3, from: 4 });
		expect(title(v)).toContain("✓ Deployment · viewing · active: Skirmish");
		expect(titles(draw(v).join("\n"))).toEqual(["CAPTAIN"]); // Deployment's boxes, not Skirmish's
		expect(title(press(R(), "left", "left"))).toContain("✓ Scriptorium · viewing · active: Skirmish");
		expect(title(press(R(), "right"))).toContain("○ Inquisition · viewing · active: Skirmish");
	});
	test("right back onto the active station and home clear the browse; both clamp at the ends", () => {
		expect(press(R(), "left", "right").nav.shown).toBeUndefined();
		expect(press(R(), "left", "left", "home").nav.shown).toBeUndefined();
		expect(title(press(R(), "left", "left", "home"))).toContain("▶ Skirmish");
		expect(press(R(), ...Array<NavKey>(20).fill("left")).stations.shown).toBe(0);
		expect(press(R(), ...Array<NavKey>(20).fill("right")).stations.shown).toBe(7);
	});
	test("a station change of the run drops the browse; so does an out-of-range phase", () => {
		const browsing: Nav = { shown: { phase: 3, from: 4 } };
		expect(cockpitView({ ...R(), nav: browsing }).nav.shown).toEqual({ phase: 3, from: 4 });
		const moved = cockpitView({ ...input({ phases: run(5) }), nav: browsing });
		expect(moved.nav.shown).toBeUndefined();
		expect(title(moved)).toContain("▶ Inquisition");
		expect(cockpitView({ ...R(), nav: { shown: { phase: 99, from: 4 } } }).nav.shown).toBeUndefined();
		expect(cockpitView({ ...R(), nav: { shown: { phase: -1, from: 4 } } }).nav.shown).toBeUndefined();
		expect(cockpitView({ ...R(), nav: { shown: { phase: 1.5, from: 4 } } }).nav.shown).toBeUndefined();
	});
	test("the waiting-seal note stays on the active station; the seal panel and chronicle show on every station", () => {
		const p: Phase[] = [{ name: "Muster", tasks: [{ content: "[captain] a", status: "completed" }] }, { name: "Scriptorium", tasks: [{ content: "[seal] Plan", status: "in_progress" }] }];
		const base = input({ phases: p, seal: { id: "Plan", lines: ["the details"] }, chronicle: [{ at: "10:00", who: "A", text: "hello" }] });
		const here = draw(cockpitView(base)).join("\n");
		expect(here).toContain("seal Plan awaits you");
		const there = draw(press(base, "left")).join("\n");
		expect(there).toContain("Muster · viewing · active: Scriptorium");
		expect(there).not.toContain("seal Plan awaits you");
		expect(there).toContain("the details");
		expect(there).toContain("hello");
	});
	test("the narrow station line names the shown station too", () => {
		expect(draw(press(R(), "left"), 50).join("\n")).toContain("✓ Deployment · viewing · active: Skirmish");
	});
});

describe("hidden lines and the selected line", () => {
	const jobs = (n: number): ViewInput => input({ phases: [{ name: "Skirmish", tasks: Array.from({ length: n }, (_, i) => ({ content: `[battle-brother] job ${i}`, status: "pending" })) }] });
	const downs = (n: number) => Array<NavKey>(n).fill("down");
	test("a selected hidden line is drawn, the window moves only as far as needed and +k more counts the rest", () => {
		const none = draw(cockpitView(jobs(12))).join("\n");
		expect(none).not.toContain("job 10");
		expect(none).toContain("+5 more (5 idle)");
		const rows = draw(press(jobs(12), ...downs(11))); // the 11th item: job 10
		expect(rows.find(l => l.includes("job 10"))).toContain("▸");
		expect(rows.some(l => l.includes("job 3"))).toBe(false); // the window starts at 4: 4..10 are the 7 rows of cap - 1
		expect(rows.some(l => l.includes("job 4"))).toBe(true);
		expect(rows.filter(l => l.includes("job ")).length).toBe(7);
		expect(rows.join("\n")).toContain("+5 more (5 idle)");
	});
	test("a visible selected line does not move the window", () => {
		const rows = draw(press(jobs(12), ...downs(3))).join("\n");
		expect(rows).toContain("job 0");
		expect(rows).toContain("job 6");
		expect(rows).not.toContain("job 7");
	});
	test("the line and its detail stay whole; only the line is marked", () => {
		const d = new Map(Array.from({ length: 6 }, (_, i) => [`agent-${i}`, dep({ role: "battle-brother", station: "Skirmish", at: 60_000 })] as const));
		const base = input({ phases: [{ name: "Skirmish", tasks: [] }], deployed: d, now: 120_000, live: new Map() });
		const rows = draw(press(base, ...downs(6)));
		const i = rows.findIndex(l => l.includes("agent-5"));
		expect(i).toBeGreaterThan(0);
		expect(rows[i]).toContain("▸");
		expect(rows[i + 1]).not.toContain("▸");
		expect(rows[i + 1]).toMatch(/\$\?/); // its detail row is right under it
	});
	test("a selected seal panel line past SEAL_CAP is drawn, with its own +k more", () => {
		const p: Phase[] = [{ name: "Muster", tasks: [{ content: "[seal] Plan", status: "in_progress" }] }];
		const base = input({ phases: p, seal: { id: "Plan", lines: Array.from({ length: 20 }, (_, i) => `line ${i}`) } });
		const none = draw(cockpitView(base)).join("\n");
		expect(none).not.toContain("line 15");
		expect(none).toContain("+9 more");
		const rows = draw(press(base, ...downs(16)));
		expect(rows.find(l => l.includes("line 15"))).toContain("▸");
		expect(rows.join("\n")).toContain("+9 more");
	});
	test("the chronicle scrolls to the selected entry at a fixed height", () => {
		const base = input({ chronicle: many(30) });
		const unselected = draw(cockpitView(base), 100, 20);
		expect(unselected).toHaveLength(20);
		expect(unselected.some(l => /event 1\b/.test(l))).toBe(false);
		const v = press(base, ...downs(30)); // the oldest entry, event 1
		const rows = draw(v, 100, 20);
		expect(rows).toHaveLength(20);
		expect(rows.find(l => /event 1\b/.test(l))).toContain("▸");
		expect(rows.some(l => l.includes("event 30"))).toBe(false);
		expect(draw(v, 50, 20).find(l => /event 1\b/.test(l))).toContain("▸");
	});
});

describe("the selected line renders inside the frame", () => {
	const FULL = (): ViewInput =>
		input({
			clock: { running: true, el: 42, bk: 120 },
			phases: [{ name: "Skirmish", tasks: [{ content: "[seal] Demo", status: "in_progress" }, { content: "[captain] a", status: "pending" }, { content: "[battle-brother] Build squad a", status: "pending" }] }],
			seal: { id: "Demo", lines: ["one", "two"] },
			slices: [{ id: "a" }],
			chronicle: many(6),
		});
	const nItems = cockpitView(FULL()).items.length;
	const downs = (n: number) => Array<NavKey>(n).fill("down");
	test("the marker sits in the blank cell: every framed row keeps ║ at col 0 and col W-1, and the footer starts at the left", () => {
		for (const width of [50, 72, 100, 140]) {
			for (let k = 0; k <= nItems; k++) {
				const rows = draw(press(FULL(), ...downs(k)), width);
				expect(rows.some(l => l.includes("▸"))).toBe(k > 0);
				if (width >= 72) {
					for (const l of rows) {
						expect(Bun.stringWidth(l)).toBe(width);
						if (l.startsWith("║")) expect(l.at(-1)).toBe("║");
					}
					expect(rows.at(-1)!.startsWith("╚═ esc/q close")).toBe(true);
					expect(rows.at(-1)!.endsWith("╝")).toBe(true);
				} else {
					for (const l of rows) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width);
					expect(rows.at(-1)).toBe("esc/q close");
				}
			}
		}
	});
	test("the selected text is inverse video and the marker is gold, with no change to the plain text", () => {
		const raw = renderCockpit(press(FULL(), ...downs(4)), 100, 0, TRUE).join("\n");
		expect(raw).toContain("\x1b[7m");
		expect(raw).toContain(`${GOLD}▸`);
		const bare = renderCockpit(cockpitView(FULL()), 100, 0, TRUE).join("\n");
		expect(bare).not.toContain("▸");
		expect(bare).not.toContain("\x1b[7m");
	});
	test("the footer lists the keys on every wide width, still starting with esc/q close", () => {
		const last = (w: number) => draw(cockpitView(FULL()), w).at(-1)!;
		for (const w of [100, 140]) expect(last(w)).toMatch(/^╚═ esc\/q close · ↑↓ line · ←→ station · tab box · home active · enter open ═+╝$/);
		expect(last(72)).toMatch(/^╚═ esc\/q close · ↑↓ line · ←→ station · tab box · home active ═+╝$/);
		expect(last(76)).toMatch(/^╚═ esc\/q close · ↑↓ line · ←→ station · tab box · home active ═+╝$/); // the widest the old hint stays, still with a rule cell
		expect(last(77)).toMatch(/^╚═ esc\/q close · ↑↓ line · ←→ station · tab box · home active · enter open ═+╝$/); // the first width where `enter open` leaves a rule cell
		expect(draw(cockpitView(FULL()), 50).at(-1)).toBe("esc/q close");
	});
	test("property: every line is at most the width and exactly the width from 72 columns, with or without a selection", () => {
		for (let width = 20; width <= 160; width++)
			for (const k of [0, 1, 5, nItems]) {
				for (const l of draw(press(FULL(), ...downs(k)), width)) {
					if (width >= 72) expect(Bun.stringWidth(l)).toBe(width);
					else expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width);
				}
			}
	});
	test("property: at a fixed height the output is exactly that many lines with the selected line visible", () => {
		for (const height of [14, 20, 30])
			for (const width of [50, 100]) {
				const rows = draw(press(FULL(), ...downs(nItems)), width, height); // the oldest chronicle entry
				expect(rows).toHaveLength(height);
				expect(rows.some(l => l.includes("▸"))).toBe(true);
			}
	});
});

describe("selected rows are one even inverse block", () => {
	const long: Entry[] = [{ at: "10:00", who: "SQUAD a", text: "x".repeat(300), tone: "ok" }];
	test.each([100, 60])("a 300-char selected chronicle entry at %i columns has a single inverse span, closed before the frame", width => {
		const raw = renderCockpit(press(input({ chronicle: long }), "down"), width, 0, TRUE);
		const row = raw.find(l => l.includes("\x1b[7m"))!;
		expect(row.split("\x1b[7m")).toHaveLength(2);
		expect(row.lastIndexOf("\x1b[27m")).toBeGreaterThan(row.lastIndexOf("\x1b[7m"));
		if (width >= 72) expect(row.lastIndexOf("║")).toBeGreaterThan(row.lastIndexOf("\x1b[27m"));
		expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
		expect(Bun.stripANSI(row)).toContain("…");
	});
	test("a selected box line too long for its box is also one closed inverse span", () => {
		const long2 = "[scout] " + "y".repeat(200);
		for (const width of [100, 60]) {
			const raw = renderCockpit(press(input({ phases: [{ name: "Auspex", tasks: [{ content: long2, status: "in_progress" }] }] }), "down"), width, 0, TRUE);
			const row = raw.find(l => l.includes("\x1b[7m"))!;
			expect(row.split("\x1b[7m")).toHaveLength(2);
			expect(row.lastIndexOf("\x1b[27m")).toBeGreaterThan(row.lastIndexOf("\x1b[7m"));
		}
	});
	test("at the minimum height a selected line with a detail row keeps its marker (cap 2 and cap 1)", () => {
		const d = new Map(Array.from({ length: 6 }, (_, i) => [`agent-${i}`, dep({ role: "battle-brother", station: "Skirmish", at: 60_000 })] as const));
		const base = input({ phases: [{ name: "Skirmish", tasks: [] }], deployed: d, now: 120_000, live: new Map() });
		for (const height of [6, 8, 10, 12, 14, 16, 18]) {
			const rows = renderCockpit(press(base, ...Array<NavKey>(6).fill("down")), 100, 0, TRUE, height).map(plain);
			const hit = rows.find(l => l.includes("agent-5"));
			if (hit) expect(hit).toContain("▸");
		}
		const rows = renderCockpit(press(base, ...Array<NavKey>(6).fill("down")), 100, 0, TRUE, 12).map(plain);
		expect(rows.find(l => l.includes("agent-5"))).toContain("▸");
	});
});

describe("detailKey", () => {
	const win32 = (vk: number, down: number, cs: number) => `\x1b[${vk};1;0;${down};${cs};1_`;
	test("every Enter and Back encoding maps to its key", () => {
		for (const d of ["\r", "\n", "\x1b[13u", "\x1b[13;1u", "\x1b[13;65u", "\x1b[13;129u", "\x1b[13;1:1u", "\x1b[13;1:2u", "\x1b[57414u", "\x1b[13;1;13u", win32(13, 1, 0)]) expect(detailKey(d)).toBe("enter");
		for (const d of ["\x7f", "\b", "\x1b[127u", "\x1b[127;1:1u", "\x1b[127;65u", "\x1b[127;5u", "\x1b[127;5:1u", "\x1b[127;69u", "\x1b[127;133u", "\x1b[127;197u", win32(8, 1, 0), win32(8, 1, 4), win32(8, 1, 8), win32(8, 1, 12), win32(8, 1, 0x88), win32(8, 1, 0x2c)]) expect(detailKey(d)).toBe("back");
	});
	test("a release, a modifier, Esc, q, arrows and everything else is undefined", () => {
		const none = ["", "\x1b[13;1:3u", "\x1b[127;1:3u", "\x1b[127;5:3u", "\x1b[13;3u", "\x1b[13;5u", "\x1b[13;2u", "\x1b[127;3u", "\x1b[127;2u", "\x1b[127;4u", "\x1b[127;6u", "\x1b[127;7u", win32(13, 0, 0), win32(13, 1, 2), win32(13, 1, 8), win32(8, 0, 0), win32(8, 0, 8), win32(8, 1, 2), win32(8, 1, 1), win32(8, 1, 16), win32(8, 1, 0x1c), win32(8, 1, 10), "\x1b", "q", "\x1b[A", "\t", "\r\r", "x", "\x1b[27u", "\x1b[13", "\x1b[14u"];
		for (const d of none) expect(detailKey(d)).toBeUndefined();
	});
	test("a hostile string costs linear time and never throws", () => {
		const n = 100_000;
		const hostile = [`\x1b[13${":".repeat(n)}x`, `\x1b[127;${"1;".repeat(n)}u`, `\x1b[${"9".repeat(n)}`, `\x1b[13;1${":".repeat(n)}u`, `\x1b[${"1;".repeat(n)}_`, "\r".repeat(n)];
		const t0 = performance.now();
		for (const h of hostile) expect(detailKey(h)).toBeUndefined();
		expect(performance.now() - t0).toBeLessThan(1000);
	});
	// properties: no property-test library in the repo, so a seeded random walk over the escape alphabet stands in for fast-check.
	test("property: detailKey(x) defined implies closes(x) false and navKey(x) undefined; q closes at both levels", () => {
		let s = 0x1234567;
		const rnd = (n: number) => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0), (s >>> 0) % n);
		const atoms = ["\x1b", "[", ";", ":", "1", "2", "3", "8", "13", "127", "65", "129", "u", "_", "~", "q", "\r", "\n", "\b", "\x7f", "57414", "27", "0", "A", "9", "\t"];
		let keys = 0;
		for (let i = 0; i < 30_000; i++) {
			const x = Array.from({ length: 1 + rnd(9) }, () => atoms[rnd(atoms.length)]).join("");
			if (detailKey(x) !== undefined) {
				keys++;
				expect(closes(x)).toBe(false);
				expect(navKey(x)).toBeUndefined();
			}
		}
		expect(keys).toBeGreaterThan(0);
		expect(cockpitKey("q", true)).toBe("close");
		expect(cockpitKey("q", false)).toBe("close");
	});
});

describe("cockpitKey", () => {
	test("q closes at every level; Esc backs out of a detail and closes at the top", () => {
		for (const inDetail of [true, false]) expect(cockpitKey("q", inDetail)).toBe("close");
		for (const esc of ["\x1b", "\x1b[27u"]) {
			expect(cockpitKey(esc, false)).toBe("close");
			expect(cockpitKey(esc, true)).toBe("back");
		}
	});
	test("Enter, Back and the cursor keys map through; anything else is ignored", () => {
		for (const inDetail of [true, false]) {
			expect(cockpitKey("\r", inDetail)).toBe("enter");
			expect(cockpitKey("\x7f", inDetail)).toBe("back");
			expect(cockpitKey("\b", inDetail)).toBe("back");
			expect(cockpitKey("\x1b[B", inDetail)).toBe("down");
			expect(cockpitKey("\t", inDetail)).toBe("tab");
			expect(cockpitKey("x", inDetail)).toBeUndefined();
		}
	});
});

describe("detail navigation", () => {
	const base = () => NAVRUN();
	const at = (n: number, ...more: NavKey[]) => press(base(), ...Array<NavKey>(n + 1).fill("down"), ...more);
	test("enter with no cursor does nothing", () => {
		expect(navigate(cockpitView(base()), "enter")).toEqual({});
	});
	test("enter opens the detail of the cursor line, one level only", () => {
		const v = at(1, "enter");
		expect(v.nav.detail).toEqual({ id: v.nav.cursor!.id });
		expect(navigate(v, "enter")).toEqual(v.nav);
	});
	test("back drops the detail and its scroll, and the cursor is where it was", () => {
		const before = at(2);
		const open = press(base(), "down", "down", "down", "enter");
		const scrolled = cockpitView({ ...base(), nav: navigate(open, "down") });
		expect(scrolled.nav.tops?.detail).toBe(1);
		const raw = navigate(scrolled, "back"); // cockpitView would filter a stale top away, so check navigate's own result
		expect(raw.detail).toBeUndefined();
		expect(raw.tops?.detail).toBeUndefined();
		const back = cockpitView({ ...base(), nav: raw });
		expect(back.nav.detail).toBeUndefined();
		expect(back.nav.tops).toBeUndefined();
		expect(back.nav.cursor).toEqual(before.nav.cursor);
	});
	test("back at the top level changes nothing", () => {
		const v = at(1);
		expect(navigate(v, "back")).toEqual(v.nav);
	});
	test("in a detail up and down scroll, never below 0; tab, left, right and home change nothing", () => {
		let v = at(0, "enter");
		expect(navigate(v, "up").tops).toBeUndefined();
		for (let i = 0; i < 3; i++) v = cockpitView({ ...base(), nav: navigate(v, "down") });
		expect(v.nav.tops?.detail).toBe(3);
		v = cockpitView({ ...base(), nav: navigate(v, "up") });
		expect(v.nav.tops?.detail).toBe(2);
		for (const k of ["tab", "left", "right", "home"] as const) expect(navigate(v, k)).toEqual(v.nav);
	});
});

// A Skirmish with a seal of 14 lines, squad alpha (a brother, a penance and a veteran), a returned squad beta and a lone apothecary.
const LONG = `${"word ".repeat(120)}END-OF-ENTRY`;
const DETAIL = (over: Partial<ViewInput> = {}): ViewInput =>
	input({
		clock: { running: true, el: 42, bk: 120 },
		phases: [{ name: "Skirmish", tasks: [{ content: "[seal] Demo", status: "in_progress" }, { content: "[battle-brother] Build squad alpha", status: "pending" }, { content: "[captain] note", status: "pending" }] }],
		seal: { id: "Demo", lines: Array.from({ length: 14 }, (_, i) => `line ${i + 1}`) },
		slices: [{ id: "alpha", parallel: true, files: ["extensions/a.ts", "extensions/b.ts"], tier: "heavy" }],
		stopped: [{ id: "beta", files: ["c.ts"] }],
		agents: { AlphaBrother: { id: "alpha" } },
		notes: { alpha: { veteran: true } },
		now: 600_000,
		deployed: new Map<string, Deployed>([
			["AlphaBrother", dep({ role: "battle-brother", station: "Skirmish", squad: "alpha", at: 60_000, stalled: 500_000 })],
			["AlphaPenance", dep({ role: "battle-brother", station: "Skirmish", squad: "alpha", state: "done", at: 60_000, ended: 180_000 })],
			["AlphaVet", dep({ role: "veteran", station: "Skirmish", squad: "alpha", state: "failed", at: 60_000, ended: 90_000 })],
			["ApothecaryBeta", dep({ role: "apothecary", station: "Skirmish", at: 120_000 })],
		]),
		live: new Map<string, Live>([
			["AlphaBrother", { since: 60_000, at: 500_000, tool: "read", intent: "scan\n\x1b[31mred\u202e", done: 2, total: 5, pct: 40, eta_min: 7, current: "cur", line: "sig line", blocked: true, cost: 0.42, tokens_in: 1234, tokens_out: 56, cache_read: 7, cache_write: 8 }],
		]),
		chronicle: [{ at: "10:00", who: "CAPTAIN", text: LONG }, ...many(3)],
		...over,
	});
const open = (id: string, over: Partial<ViewInput> = {}, extra: Nav = {}): View => cockpitView({ ...DETAIL(over), nav: { cursor: { id, at: 0 }, detail: { id }, ...extra } });
const longId = () => cockpitView(DETAIL()).chronicle.find(e => e.text === LONG)!.id;

describe("view.detail per kind", () => {
	test("no detail open, no view.detail", () => {
		expect(cockpitView(DETAIL()).detail).toBeUndefined();
	});
	test("squad: files, parallel, tier, the veteran note and every agent that ran it, penance included", () => {
		const d = open("squad:alpha").detail!;
		expect(d.title).toBe("SQUAD alpha · forging");
		const t = d.lines.join("\n");
		expect(d.lines.slice(0, 7)).toEqual(["files:", "  extensions/a.ts", "  extensions/b.ts", "parallel: yes", "tier: heavy", "escalated to veteran", "agents (3):"]);
		expect(t).toContain("battle-brother AlphaBrother · running");
		expect(t).toContain("penance AlphaPenance · returned");
		expect(t).toContain("veteran AlphaVet · failed");
		expect(t).toContain("ran 2m"); // ended - at
		expect(t).toContain("ran <1m"); // the veteran: 30s
		expect(t.indexOf("AlphaBrother")).toBeLessThan(t.indexOf("AlphaPenance"));
	});
	test("squad: an unknown slice says so, a squad with no agent says none deployed, parallel false is no", () => {
		const none = open("squad:beta", { slices: [], stopped: [{ id: "beta", files: ["c.ts"], parallel: false }], deployed: new Map() }).detail!;
		expect(none.title).toBe("SQUAD beta · returned");
		expect(none.lines).toEqual(["files:", "  c.ts", "parallel: no", "no agent deployed yet"]);
		const unknown = open("squad:alpha", { slices: [], stopped: [], agents: {}, deployed: new Map() }, {});
		expect(unknown.detail).toBeUndefined(); // the line is gone with its slice
	});
	test("agent: role, id, station, elapsed, state, every live field, cost and tokens", () => {
		const lines = open("squad:alpha").detail!.lines;
		const brother = lines.slice(lines.indexOf("agents (3):") + 1, lines.indexOf("")).map(l => l.replace(/^  /, "")); // each agent indented under agents (n):
		expect(brother).toEqual([
			"battle-brother AlphaBrother · running",
			"station: Skirmish",
			"squad: alpha",
			"ran 9m",
			"progress: 40% · 2/5",
			"eta: ~7m",
			"current: cur",
			"intent: scan red",
			"tool: read",
			"signalled: sig line",
			"blocked",
			"stalled 1m",
			"cost: $0.42",
			"tokens: 1,234 in · 56 out · cache 7 read · 8 write",
		]);
	});
	test("agent detail of an apothecary with no usage says cost unknown and has no tokens line", () => {
		const d = open("agent:ApothecaryBeta").detail!;
		expect(d.title).toBe("APOTHECARY ApothecaryBeta");
		expect(d.lines).toEqual(["apothecary ApothecaryBeta · running", "station: Skirmish", "ran 8m", "cost: unknown"]);
	});
	test("seal: the title of the panel and all 14 lines", () => {
		const v = open("seal:Demo:3");
		expect(v.detail!.title).toContain("SEAL DEMO");
		expect(v.detail!.lines).toHaveLength(14);
		expect(v.detail!.lines.at(-1)).toBe("line 14");
	});
	test("chronicle: the full text of a 600-char entry, uncut", () => {
		const d = open(longId()).detail!;
		expect(d.title).toBe("CHRONICLE · 10:00 · CAPTAIN");
		expect(d.lines).toEqual([LONG]);
		expect(LONG.length).toBeGreaterThan(600);
	});
	test("task: its text, status and station", () => {
		const id = cockpitView(DETAIL()).items.find(i => i.id.startsWith("task:"))!.id;
		const d = open(id).detail!;
		expect(d.title).toBe("CAPTAIN TASK");
		expect(d.lines).toEqual(["note", "status: pending", "station: Skirmish"]);
	});
	test("untrusted text comes out cleaned: no ESC, bidi override or newline in any title or line", () => {
		const evil = "a\x1b[31mb\u202ec\nd\re";
		const squad = open("squad:alpha", { slices: [{ id: "alpha", files: [evil], tier: evil }] }).detail!;
		const chronicle = [{ at: "10:00", who: evil, text: evil }];
		const entry = open(cockpitView(DETAIL({ chronicle })).chronicle[0].id, { chronicle }).detail!;
		const agent = open("agent:ApothecaryBeta", { live: new Map([["ApothecaryBeta", { since: 1, at: 1, intent: evil, line: evil, current: evil, tool: evil }]]) }).detail!;
		for (const d of [squad, entry, agent]) for (const l of [d.title, ...d.lines]) expect(l).not.toMatch(/[\x00-\x1f\x7f\u202a-\u202e]/);
	});
});

describe("detail normalisation", () => {
	test("the detail is dropped with its line: seal granted, entry trimmed at the cap", () => {
		expect(open("seal:Demo:2").nav.detail).toEqual({ id: "seal:Demo:2" });
		const granted = open("seal:Demo:2", { phases: [{ name: "Skirmish", tasks: [{ content: "[seal] Demo", status: "completed" }, { content: "[captain] note", status: "pending" }] }] });
		expect(granted.nav.detail).toBeUndefined();
		expect(granted.detail).toBeUndefined();
		expect(granted.nav.cursor).toBeDefined(); // falls to the nearest line
		expect(granted.items.some(i => i.id === granted.nav.cursor!.id)).toBe(true);
		const old = cockpitView(DETAIL({ chronicle: many(200) })).chronicle.at(-1)!.id;
		const full = [...many(200)];
		expect(open(old, { chronicle: full }).nav.detail).toEqual({ id: old });
		expect(open(old, { chronicle: pushEntry(full, { at: "11:00", who: "X", text: "new" }) }).nav.detail).toBeUndefined();
	});
	test("the detail and its scroll survive a redraw with new data; the scroll key goes with the detail", () => {
		const v = open("seal:Demo:2", {}, { tops: { detail: 2 } });
		const again = cockpitView({ ...DETAIL({ chronicle: [{ at: "10:05", who: "X", text: "fresh" }, ...DETAIL().chronicle] }), nav: v.nav });
		expect(again.nav.detail).toEqual({ id: "seal:Demo:2" });
		expect(again.nav.tops?.detail).toBe(2);
		expect(cockpitView({ ...DETAIL(), nav: { cursor: v.nav.cursor, tops: { detail: 2 } } }).nav.tops).toBeUndefined();
	});
});

describe("wrap", () => {
	test("hanging indent: every row keeps the leading spaces of the first, capped so 2 cells remain", () => {
		const path = "    extensions/strategium/a-very-long-file-name.ts";
		const rows = wrap(path, 20);
		expect(rows.length).toBeGreaterThan(2);
		for (const row of rows) {
			expect(row.startsWith("    ")).toBe(true);
			expect(Bun.stringWidth(row)).toBeLessThanOrEqual(20);
		}
		expect(rows.map(x => x.trim()).join("")).toBe(path.trim());
		expect(wrap("        abcdef", 6)).toEqual(["    ab", "    cd", "    ef"]);
	});
	test("breaks on spaces, splits a word longer than the width, keeps the indent on every row", () => {
		expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
		expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
		expect(wrap("  indented text here", 10)).toEqual(["  indented", "  text", "  here"]);
		expect(wrap("", 10)).toEqual([""]);
	});
	test("wide graphemes never overflow", () => {
		for (const s of ["漢字漢字漢字漢字", "👍🏽👍🏽👍🏽 ❤️❤️❤️❤️", "a漢b漢c漢d"]) for (let w = 2; w < 12; w++) for (const r of wrap(s, w)) expect(Bun.stringWidth(r)).toBeLessThanOrEqual(w);
	});
	test("a 100000-char word is split in linear time", () => {
		const t0 = performance.now();
		const rows = wrap("x".repeat(100_000), 50);
		expect(rows).toHaveLength(2000);
		expect(performance.now() - t0).toBeLessThan(1000);
	});
	test("a long run of trailing whitespace is wrapped in linear time", () => {
		for (const s of ["a" + " ".repeat(1e5), "a" + "\t ".repeat(5e4)]) {
			const t0 = performance.now();
			expect(wrap(s, 50)).toEqual(["a"]);
			expect(performance.now() - t0).toBeLessThan(1000);
		}
	});
	// properties: seeded walk standing in for fast-check.
	test("property: every row fits the width and no character is lost", () => {
		let s = 99;
		const rnd = (n: number) => ((s = (Math.imul(s, 1103515245) + 12345) | 0), ((s >>> 8) >>> 0) % n);
		const atoms = ["a", "bb", "ccc", "  ", " ", "漢字", "👍🏽", "❤️", "x".repeat(30), "\t", "é", "e\u0301"];
		for (let i = 0; i < 3000; i++) {
			const str = Array.from({ length: rnd(14) }, () => atoms[rnd(atoms.length)]).join(rnd(2) ? " " : "");
			const w = 2 + rnd(30);
			const rows = wrap(str, w);
			for (const r of rows) expect(Bun.stringWidth(r)).toBeLessThanOrEqual(w);
			expect(rows.join("").replace(/\s/g, "")).toBe(str.replace(/\s/g, ""));
		}
	});
});

describe("never trap: Esc closes from any state", () => {
	test("property: from any nav, at most three Esc presses reach close (transcript, detail, top)", () => {
		let s = 4242;
		const rnd = (n: number) => ((s = (Math.imul(s, 1103515245) + 12345) | 0), ((s >>> 8) >>> 0) % n);
		const keys: NavKey[] = ["up", "down", "left", "right", "home", "tab", "enter", "back"];
		for (const base of [input(), NAVRUN(), DETAIL()])
			for (let round = 0; round < 40; round++) {
				let nav: Nav = {};
				for (let i = 0; i < 25; i++) nav = navigate(cockpitView({ ...base, nav }), keys[rnd(keys.length)]);
				let closed = false;
				for (let press2 = 0; press2 < 3 && !closed; press2++) {
					const k = cockpitKey("\x1b", !!cockpitView({ ...base, nav }).nav.detail);
					if (k === "close") closed = true;
					else if (k) nav = navigate(cockpitView({ ...base, nav }), k);
				}
				expect(closed).toBe(true);
			}
	});
});

describe("detail rendering", () => {
	const ids = (): string[] => ["seal:Demo:0", "squad:alpha", "agent:ApothecaryBeta", longId()];
	test("every width and height: no line wider than the width, framed rows closed, title names the detail, no chronicle rule, back footer", () => {
		for (const width of [50, 72, 100, 140])
			for (const height of [undefined, 12, 40])
				for (const id of ids()) {
					const v = open(id);
					const rows = draw(v, width, height);
					if (height) expect(rows).toHaveLength(height);
					const title = v.detail!.title;
					for (const l of rows) {
						if (width >= 72) {
							expect(Bun.stringWidth(l)).toBe(width);
							if (l.startsWith("║")) expect(l.at(-1)).toBe("║");
						} else expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width);
					}
					if (width >= 72) {
						expect(rows.some(l => l.startsWith("╟─ ") && l.includes(title.slice(0, 12)))).toBe(true);
						expect(rows.some(l => /^╟─ CHRONICLE ─/.test(l))).toBe(false);
						expect(rows.at(-1)).toMatch(v.detail!.target === undefined ? /^╚═ esc\/bksp back · q close · ↑↓ scroll ═+╝$/ : /^╚═ esc\/bksp back · q close · ↑↓ scroll · enter transcript ═+╝$/); // an agent or squad detail also hints the transcript
					} else {
						expect(rows.some(l => l.includes(title.slice(0, 12)))).toBe(true);
						expect(rows.includes("CHRONICLE")).toBe(false);
						expect(rows.at(-1)).toBe(v.detail!.target === undefined ? "esc back · q close" : "esc back · q close · enter transcript");
					}
				}
	});
	test("words of width-1 and width cells drop nothing and cut nothing, wide and narrow", () => {
		for (const width of [100, 50]) {
			const inner = width - 2;
			// Words of width-1 and width cells: wrapping at the full width would leave rows the frame then cuts with `…`.
			const chronicle = [{ at: "10:00", who: "CAPTAIN", text: `${"Q".repeat(width - 1)} ${"Z".repeat(width)} END-OF-ENTRY` }];
			const t = draw(open(cockpitView(DETAIL({ chronicle })).chronicle[0].id, { chronicle }), width).join("\n");
			expect(t).not.toContain("…");
			expect(t.match(/Q/g)).toHaveLength(width - 1);
			expect(t.match(/Z/g)).toHaveLength(width);
			expect(t).toContain("END-OF-ENTRY");
		}
	});
	test("a long detail title is cut, not its scroll position", () => {
		const id = `A${"x".repeat(150)}`;
		const deployed = new Map<string, Deployed>([[id, dep({ role: "apothecary", station: "Skirmish", at: 120_000 })]]);
		for (const width of [100, 50]) {
			const title = draw(open(`agent:${id}`, { deployed }), width, 9).find(l => l.includes("APOTHECARY"))!;
			expect(title).toMatch(/…\s?· \d+–\d+\/\d+ *(─+╢)?$/);
		}
	});
	test("the scroll position stays gold after a cut title, wide and narrow", () => {
		const id = `A${"x".repeat(150)}`;
		const deployed = new Map<string, Deployed>([[id, dep({ role: "apothecary", station: "Skirmish", at: 120_000 })]]);
		for (const width of [100, 50]) {
			const row = renderCockpit(open(`agent:${id}`, { deployed }), width, 0, TRUE, 9).find(l => plain(l).includes("APOTHECARY"))!;
			const sgr = (s: string) => s.match(/\x1b\[[0-9;]*m/g)!;
			const at = row.search(/· \d+–\d+\/\d+/);
			expect(at).toBeGreaterThan(0);
			expect(sgr(row.slice(0, at)).at(-1)).toBe(sgr(row.slice(0, row.indexOf("APOTHECARY")))!.at(-1)); // the gold that opened the title
		}
	});
	test("with no height every row is drawn, uncut, without a range suffix", () => {
		for (const width of [50, 100]) {
			const rows = draw(open(longId()), width).join(" ");
			expect(rows).toContain("END-OF-ENTRY");
			expect(rows).not.toMatch(/\d+–\d+\/\d+/);
		}
		expect(draw(open("seal:Demo:0"), 100).join("\n")).toContain("line 14");
	});
	test("a long detail at a fixed height shows a–b/n, scrolls with tops.detail and clamps at the bottom", () => {
		const top = draw(open("seal:Demo:0"), 100, 12);
		const t0 = top.find(l => l.startsWith("╟─ SEAL") || /╟─.*SEAL/.test(l))!;
		expect(t0).toMatch(/· 1–\d+\/14/);
		expect(top.join("\n")).toContain("line 1 ");
		expect(top.join("\n")).not.toContain("line 14");
		const v = open("seal:Demo:0", {}, { tops: { detail: 99 } });
		const bottom = draw(v, 100, 12);
		expect(bottom.join("\n")).toContain("line 14");
		expect(bottom.find(l => /╟─.*SEAL/.test(l))).toMatch(/· \d+–14\/14/);
		expect(v.nav.tops!.detail).toBeLessThan(99);
		const mid = draw(open("seal:Demo:0", {}, { tops: { detail: 3 } }), 100, 12).join("\n");
		expect(mid).toContain("line 4 ");
		expect(mid).not.toContain("line 1 ");
	});
	test("a detail that fits the height has no suffix and clears a zero scroll", () => {
		const v = open("agent:ApothecaryBeta");
		expect(draw(v, 100, 40).join("\n")).not.toMatch(/\d+–\d+\/\d+/);
		expect(v.nav.tops).toBeUndefined();
	});
});

describe("top-level footer", () => {
	test("enter open at 100 and 140, the old hint at 72, always starting esc/q close", () => {
		for (const w of [72, 100, 140]) {
			const f = draw(cockpitView(NAVRUN()), w).at(-1)!;
			expect(f.startsWith("╚═ esc/q close")).toBe(true);
			expect(f.endsWith("╝")).toBe(true);
			expect(f.includes("enter open")).toBe(w >= 100);
		}
		expect(draw(cockpitView(NAVRUN()), 50).at(-1)).toBe("esc/q close");
	});
});

describe("review fixes", () => {
	const agent = (state: Deployed["state"], over: Partial<Deployed> = {}) =>
		cockpitView({ ...DETAIL({ deployed: new Map([["Z", dep({ role: "scout", station: "Skirmish", state, at: 60_000, ...over })]]), live: new Map([["Z", { since: 60_000, at: 500_000, done: 1, total: 4, eta_min: 7, blocked: true }]]), now: 600_000 }), nav: { cursor: { id: "agent:Z", at: 0 }, detail: { id: "agent:Z" } } }).detail!.lines;
	test("a returned or failed agent shows no eta, no blocked and no stalled line, even if its row had them", () => {
		for (const state of ["done", "failed"] as const) {
			const t = agent(state, { ended: 120_000, stalled: 500_000 }).join("\n");
			expect(t).toContain("progress: 1/4");
			expect(t).not.toMatch(/eta|stalled|blocked/);
		}
		expect(agent("active", { stalled: 500_000 }).join("\n")).toMatch(/eta: ~7m[\s\S]*blocked[\s\S]*stalled 1m/);
	});
	test("a finished agent with no `ended` says elapsed unknown, never an ever-growing ran", () => {
		for (const state of ["done", "failed"] as const) {
			const t = agent(state);
			expect(t).toContain("elapsed unknown");
			expect(t.join("\n")).not.toContain("ran ");
		}
		expect(agent("active")).toContain("ran 9m");
	});
	test("squad detail indents each agent's facts by two spaces under agents (n):", () => {
		const lines = open("squad:alpha").detail!.lines;
		const at = lines.indexOf("agents (3):");
		const body = lines.slice(at + 1);
		expect(body[0]).toBe("  battle-brother AlphaBrother · running");
		for (const l of body) expect(l === "" || l.startsWith("  ")).toBe(true);
		expect(body.filter(l => l === "")).toHaveLength(2);
	});
	describe("nav through a detail", () => {
		const R = () => input({ phases: run(4) });
		const detailed = (): View => {
			let nav: Nav = {};
			for (const k of ["left", "down", "enter"] as const) nav = navigate(cockpitView({ ...R(), nav }), k);
			return cockpitView({ ...R(), nav });
		};
		test("opening a detail from a browsed station keeps the shown station through enter, scroll and back", () => {
			let v = detailed();
			expect(v.nav.shown).toEqual({ phase: 3, from: 4 });
			expect(v.nav.detail).toBeDefined();
			for (const k of ["down", "down", "up"] as const) {
				v = cockpitView({ ...R(), nav: navigate(v, k) });
				expect(v.nav.shown).toEqual({ phase: 3, from: 4 });
			}
			v = cockpitView({ ...R(), nav: navigate(v, "back") });
			expect(v.nav.detail).toBeUndefined();
			expect(v.nav.shown).toEqual({ phase: 3, from: 4 });
		});
		test("enter inside a detail leaves nav unchanged, scrolled detail and viewed station included", () => {
			const v = cockpitView({ ...R(), nav: { ...detailed().nav, tops: { detail: 3 } } });
			expect(v.nav.tops).toEqual({ detail: 3 });
			expect(navigate(v, "enter")).toEqual(v.nav);
		});
	});
	test("a detail of exactly the rows that fit has no a–b/n suffix, one more has it", () => {
		const fit = (n: number) => {
			const v = open("seal:Demo:0", { seal: { id: "Demo", lines: Array.from({ length: n }, (_, i) => `line ${i + 1}`) } });
			return draw(v, 100, 20).find(l => /╟─.*SEAL/.test(l))!;
		};
		// find the room: the largest n with no suffix
		let n = 1;
		while (!/\d+–\d+\/\d+/.test(fit(n + 1))) n++;
		expect(fit(n)).not.toMatch(/\d+–\d+\/\d+/);
		expect(fit(n + 1)).toMatch(new RegExp(`· 1–${n}/${n + 1}`));
		expect(n).toBeGreaterThan(3);
	});
	describe("wrap", () => {
		test("interior runs of spaces survive when the line fits", () => {
			expect(wrap("name    cost   tier", 30)).toEqual(["name    cost   tier"]);
			expect(wrap("  a  b", 30)).toEqual(["  a  b"]);
		});
		test("a run at a break collapses and no row starts or ends with the dropped run", () => {
			expect(wrap("aaa      bbb", 5)).toEqual(["aaa", "bbb"]);
			expect(wrap("aa  bb    cc", 7)).toEqual(["aa  bb", "cc"]);
		});
		test("a word wider than the row hard-splits after an indent, and a wide grapheme in a one-cell row still moves on", () => {
			expect(wrap("  abcdefghij", 6)).toEqual(["  abcd", "  efgh", "  ij"]);
			expect(wrap("漢字", 1)).toEqual(["漢", "字"]);
		});
	});
});

// --- transcript view (#125) ---
const jl = (...o: unknown[]) => o.map(x => JSON.stringify(x)).join("\n");
const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({ type: "message", message: { role, content, ...extra } });
const CTRL = /[\p{Cc}\u202a-\u202e\u2066-\u2069\u2028\u2029\u200e\u200f\u061c]/u;
const rnd0 = (seed: number) => {
	let s = seed;
	return (n: number) => ((s = (Math.imul(s, 1103515245) + 12345) | 0), ((s >>> 8) >>> 0) % n);
};

describe("transcriptLines", () => {
	test("maps every row kind of a message in file order; thinking and other entries are skipped", () => {
		const tail = jl(
			{ type: "session_init", systemPrompt: "SECRET-PROMPT" },
			msg("user", "do it"),
			msg("assistant", [
				{ type: "thinking", thinking: "SECRET-THINKING" },
				{ type: "text", text: "hello\nworld" },
				{ type: "toolCall", name: "read", intent: "scan files", arguments: { path: "a", i: "ignored" } },
				{ type: "toolCall", name: "bash", arguments: { n: 3, i: "list dir", cmd: "ls" } },
				{ type: "toolCall", name: "find", arguments: { n: 3, pat: "*.ts" } },
			]),
			msg("toolResult", [{ type: "text", text: "first\nsecond" }], { toolName: "read" }),
			msg("toolResult", [{ type: "text", text: "boom\nmore" }], { toolName: "bash", isError: true }),
			{ type: "custom", customType: "x", data: 1 },
			{ type: "model_change", model: "m" },
		);
		expect(transcriptLines(tail, false)).toEqual(["user: do it", "hello", "world", "→ read scan files", "→ bash list dir", "→ find *.ts", "← read ok: first", "← bash error: boom"]);
	});
	test("a finished agent shows its final answer, or says there is no file; an unfinished one shows neither", () => {
		const tail = jl(msg("user", "go"));
		expect(transcriptLines(tail, false, "line a\nline b")).toEqual(["user: go", "final answer:", "line a", "line b"]);
		expect(transcriptLines(tail, false, null)).toEqual(["user: go", "no final answer file"]);
		expect(transcriptLines(tail, false)).toEqual(["user: go"]);
		expect(transcriptLines("", false, "only the answer")).toEqual(["final answer:", "only the answer"]);
	});
	test("a cut tail drops its first partial line and leads with the notice", () => {
		const tail = `ial"}}\n${jl(msg("user", "kept"))}`;
		expect(transcriptLines(tail, true)).toEqual(["… earlier entries not shown", "user: kept"]);
		expect(transcriptLines(jl(msg("user", "first"), msg("user", "second")), false)).toEqual(["user: first", "user: second"]);
		expect(transcriptLines("x".repeat(1000), true)).toEqual(["… earlier entries not shown"]);
	});
	test("a text block is capped at 40 lines and each row at 400 chars", () => {
		const rows = transcriptLines(jl(msg("assistant", [{ type: "text", text: Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n") }])), false);
		expect(rows).toHaveLength(41);
		expect(rows[39]).toBe("l39");
		expect(rows[40]).toBe("… 10 more lines");
		const [long] = transcriptLines(jl(msg("user", "é".repeat(900))), false);
		expect(long.length).toBeLessThanOrEqual(400);
		expect(long.endsWith("…")).toBe(true);
	});
	test("only the newest 1000 rows stay, behind the notice", () => {
		const rows = transcriptLines(jl(...Array.from({ length: 1500 }, (_, i) => msg("user", `m${i}`))), false);
		expect(rows).toHaveLength(1001);
		expect(rows[0]).toBe("… earlier entries not shown");
		expect(rows[1]).toBe("user: m500");
		expect(rows.at(-1)).toBe("user: m1499");
	});
	test("no message at all is one reason line", () => {
		for (const t of ["", "\n\n", "garbage", jl({ type: "custom" }), "[1,2]\nnull\n7\n\"s\""]) expect(transcriptLines(t, false)).toEqual(["no messages yet"]);
	});
	test("a hostile tail: no throw, no control character, capped, linear", () => {
		const hostile = [
			"x".repeat(512 * 1024),
			jl(msg("user", `a\x1b[2Jb\u202ec\u2028d\x00e\x9bf`)),
			"[".repeat(100_000),
			`{"type":"message","message":{"role":"user","content":${"[".repeat(100_000)}}}`,
			`{"type":"message"`,
			`{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"\x1b[31mx\u202e","arguments":{"a":"\x1b]0;t\x07zz"}}]}}`,
			jl(msg("toolResult", "plain string content", { toolName: 5 }), msg("assistant", "str"), msg("assistant", [null, 3, "s", { type: "text", text: 9 }, { type: "toolCall" }])),
		];
		for (const h of hostile) {
			const t0 = performance.now();
			const rows = transcriptLines(h, false, h);
			expect(performance.now() - t0).toBeLessThan(1000);
			expect(rows.length).toBeLessThanOrEqual(1001);
			for (const r of rows) {
				expect(r).not.toMatch(CTRL);
				expect(r.length).toBeLessThanOrEqual(400);
			}
		}
		expect(transcriptLines(hostile[1], false)[0]).toBe("user: ab c d e"); // \x1b[2J and the C1 CSI \x9bf are stripped, the rest become spaces
	});
	test("512 KiB of messages parse in under 200 ms", () => {
		const line = jl(msg("assistant", [{ type: "text", text: "word ".repeat(20) }, { type: "toolCall", name: "read", arguments: { i: "x" } }]));
		const tail = Array(Math.ceil((512 * 1024) / (line.length + 1))).fill(line).join("\n");
		const t0 = performance.now();
		const rows = transcriptLines(tail, true);
		const ms = performance.now() - t0;
		console.log(`transcriptLines(512 KiB): ${ms.toFixed(1)} ms`);
		expect(ms).toBeLessThan(200);
		expect(rows).toHaveLength(1001);
	});
	// properties: no property-test library in the repo, so a seeded walk over hostile atoms stands in for fast-check.
	test("property: never throws; rows are clean, ≤ 400 chars, and at most 1001", () => {
		const r = rnd0(77);
		const atoms = ['{"type":"message","message":{"role":"user","content":"', '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"', '"}}', "\n", "\x1b[31m", "\x1b", "\u202e", "\u2028", "\x00", "\x9b", "[[[[", '{"type":"toolCall"', "漢字", "é", "x".repeat(500), "\ud800", "\\u202e", '","name":"n","arguments":{"i":"q"}}]}}', "\r\n", "null", "{", "}"];
		for (let i = 0; i < 1500; i++) {
			const mk = () => Array.from({ length: r(30) }, () => atoms[r(atoms.length)]).join("");
			const rows = transcriptLines(mk(), r(2) === 1, r(3) === 0 ? null : r(3) === 1 ? undefined : mk());
			expect(rows.length).toBeLessThanOrEqual(1001);
			for (const row of rows) {
				expect(row).not.toMatch(CTRL);
				expect(row.length).toBeLessThanOrEqual(400);
			}
		}
	});
});

const TR_ROWS = Array.from({ length: 60 }, (_, i) => `row ${i + 1}`);
const TR_BASE = () => DETAIL({ transcript: { id: "ApothecaryBeta", lines: TR_ROWS } });
const trNav = (id: string, extra: Nav = {}, transcript?: string): Nav => ({ cursor: { id, at: 0 }, detail: { id, ...(transcript ? { transcript } : {}) }, ...extra });
const trView = (nav: Nav, over: Partial<ViewInput> = {}): View => cockpitView({ ...TR_BASE(), ...over, nav });
const BIGBG = palette("truecolor", THEMES.ultramarines); // a themed background pads every row to the full width

describe("transcript navigation", () => {
	test("enter from an agent detail opens its transcript; back, back returns the exact nav", () => {
		const v0 = trView(trNav("agent:ApothecaryBeta", { tops: { detail: 2 } }));
		expect(v0.detail!.target).toBe("ApothecaryBeta");
		const n1 = navigate(v0, "enter");
		expect(n1.detail).toEqual({ id: "agent:ApothecaryBeta", transcript: "ApothecaryBeta" });
		const v1 = trView(n1);
		expect(v1.detail!.title).toBe("TRANSCRIPT ApothecaryBeta");
		expect(v1.nav).toEqual(n1);
		const v2 = trView(navigate(v1, "back"));
		expect(v2.nav).toEqual(v0.nav);
		expect(v2.nav.tops).toEqual({ detail: 2 });
		const top = navigate(v2, "back");
		expect(top.detail).toBeUndefined();
		expect(top.cursor).toEqual(v0.nav.cursor);
	});
	test("enter from a squad detail opens the transcript of its newest agent", () => {
		const v = trView(navigate(trView(trNav("squad:alpha")), "enter"), { transcript: { id: "AlphaVet", lines: ["a", "b"] } });
		expect(v.nav.detail).toEqual({ id: "squad:alpha", transcript: "AlphaVet" });
		expect(v.detail!.title).toBe("TRANSCRIPT AlphaVet");
		expect(v.detail!.lines).toEqual(["a", "b"]);
	});
	test("enter does nothing on a squad with no agent, and on seal, task and chronicle details", () => {
		const ids = ["squad:beta", "seal:Demo:0", longId(), ...cockpitView(DETAIL()).items.map(i => i.id).filter(id => id.startsWith("task:"))];
		for (const id of ids) {
			const v = trView(trNav(id));
			expect(v.detail).toBeDefined();
			expect(v.detail!.target).toBeUndefined();
			expect(navigate(v, "enter")).toEqual(v.nav);
		}
	});
	test("a transcript opened with enter inside a transcript changes nothing", () => {
		const v = trView(trNav("agent:ApothecaryBeta", {}, "ApothecaryBeta"));
		expect(navigate(v, "enter")).toEqual(v.nav);
		for (const k of ["tab", "left", "right", "home"] as const) expect(navigate(v, k)).toEqual(v.nav);
	});
	test("the transcript is dropped when its agent leaves deployed, or belongs to another squad", () => {
		const gone = trView(trNav("agent:ApothecaryBeta", { tops: { transcript: 4 } }, "ApothecaryBeta"), { deployed: new Map(), live: undefined });
		expect(gone.detail).toBeUndefined();
		expect(gone.nav.detail).toBeUndefined();
		expect(gone.nav.tops).toBeUndefined();
		const other = new Map(DETAIL().deployed!).set("AlphaVet", dep({ role: "veteran", station: "Skirmish", squad: "beta" }));
		const v = trView(trNav("squad:alpha", { tops: { transcript: 4, detail: 1 } }, "AlphaVet"), { deployed: other });
		expect(v.nav.detail).toEqual({ id: "squad:alpha" });
		expect(v.nav.tops).toEqual({ detail: 1 });
		expect(v.detail!.title).toContain("SQUAD alpha");
	});
	test("a transcript opened from a squad stays when a penance deploys in it", () => {
		const newer = new Map(DETAIL().deployed!).set("AlphaNew", dep({ role: "battle-brother", station: "Skirmish", squad: "alpha" }));
		const v = trView(trNav("squad:alpha", { tops: { transcript: 4 } }, "AlphaVet"), { deployed: newer, transcript: { id: "AlphaVet", lines: ["kept"] } });
		expect(v.nav.detail).toEqual({ id: "squad:alpha", transcript: "AlphaVet" });
		expect(v.nav.tops).toEqual({ transcript: 4 });
		expect(v.detail!.title).toContain("TRANSCRIPT AlphaVet");
	});
	test("opens at the bottom; up moves away from it, down returns and never goes below 0", () => {
		let v = trView(trNav("agent:ApothecaryBeta", {}, "ApothecaryBeta"));
		expect(v.nav.tops).toBeUndefined();
		expect(navigate(v, "down").tops).toBeUndefined();
		for (let i = 0; i < 3; i++) v = trView(navigate(v, "up"));
		expect(v.nav.tops).toEqual({ transcript: 3 });
		v = trView(navigate(v, "down"));
		expect(v.nav.tops).toEqual({ transcript: 2 });
		const rows = draw(trView(trNav("agent:ApothecaryBeta", { tops: { transcript: 3 } }, "ApothecaryBeta")), 100, 20);
		expect(rows.join("\n")).toContain("row 57");
		expect(rows.join("\n")).not.toContain("row 58 ");
		const bottom = draw(trView(trNav("agent:ApothecaryBeta", {}, "ApothecaryBeta")), 100, 20);
		expect(bottom.join("\n")).toContain("row 60 ");
		expect(bottom.find(l => l.startsWith("╟─ TRANSCRIPT"))).toMatch(/· \d+–60\/60/);
	});
	test("the transcript scroll is clamped to the first row once written back", () => {
		const v = trView(trNav("agent:ApothecaryBeta", { tops: { transcript: 9999 } }, "ApothecaryBeta"));
		const rows = draw(v, 100, 20);
		expect(rows.find(l => l.startsWith("╟─ TRANSCRIPT"))).toMatch(/· 1–\d+\/60/);
		expect(v.nav.tops!.transcript).toBeLessThan(9999);
		expect(rows.join("\n")).toContain("row 1 ");
	});
	// properties: seeded walk standing in for fast-check.
	test("property: enter then back returns the nav, from any detail with a target", () => {
		const r = rnd0(31337);
		const keys: NavKey[] = ["up", "down", "left", "right", "home", "tab", "enter", "back"];
		let hits = 0;
		for (let round = 0; round < 300; round++) {
			const starts: Nav[] = [{}, trNav("agent:ApothecaryBeta"), trNav("squad:alpha", { tops: { detail: 2 } }), trNav("squad:beta"), trNav("seal:Demo:0")];
			let nav: Nav = starts[r(starts.length)];
			for (let i = 0; i < r(8); i++) nav = navigate(trView(nav), keys[r(keys.length)]);
			const v = trView(nav);
			if (v.detail?.target === undefined || v.nav.detail?.transcript) continue;
			hits++;
			const v2 = trView(navigate(v, "enter"));
			expect(v2.nav.detail?.transcript).toBe(v.detail.target);
			expect(trView(navigate(v2, "back")).nav).toEqual(v.nav);
			expect(navigate(v2, "back")).toEqual(v.nav);
		}
		expect(hits).toBeGreaterThan(20);
	});
});

describe("transcript rendering", () => {
	const big = Array.from({ length: 1000 }, (_, i) => `user: message ${i} ${"漢字 wide ".repeat(i % 7)}${"Q".repeat(i % 5 === 0 ? 300 : 3)}`);
	test("every row is exactly width cells at 60 and 120 cols, any height, with a 1000-row transcript", () => {
		for (const width of [60, 120])
			for (const height of [undefined, 12, 40])
				for (const tops of [{}, { transcript: 7 }, { transcript: 5000 }] as Record<string, number>[]) {
					const v = trView(trNav("agent:ApothecaryBeta", { tops }, "ApothecaryBeta"), { transcript: { id: "ApothecaryBeta", lines: big } });
					const rows = renderCockpit(v, width, 0, BIGBG, height).map(plain);
					if (height) expect(rows).toHaveLength(height);
					for (const l of rows) expect(Bun.stringWidth(l)).toBe(width);
				}
	});
	test("hostile rows from the reader are cleaned before they are drawn", () => {
		const v = trView(trNav("agent:ApothecaryBeta", {}, "ApothecaryBeta"), { transcript: { id: "ApothecaryBeta", lines: ["a\x1b[2Jb\u202ec", "z".repeat(5000)] } });
		for (const l of v.detail!.lines) {
			expect(l).not.toMatch(CTRL);
			expect(l.length).toBeLessThanOrEqual(400);
		}
	});
	test("rows from another agent's read are not shown", () => {
		const v = trView(trNav("agent:ApothecaryBeta", {}, "ApothecaryBeta"), { transcript: { id: "Other", lines: ["WRONG"] } });
		expect(v.detail!.lines).toEqual([]);
	});
	test("footers: agent and squad details with a target hint enter transcript; the transcript and other details do not", () => {
		const wide = (id: string, t?: string) => draw(trView(trNav(id, {}, t)), 120).at(-1)!;
		const narrow = (id: string, t?: string) => draw(trView(trNav(id, {}, t)), 50).at(-1)!;
		expect(wide("agent:ApothecaryBeta")).toMatch(/^╚═ esc\/bksp back · q close · ↑↓ scroll · enter transcript ═+╝$/);
		expect(wide("squad:alpha")).toMatch(/· enter transcript ═+╝$/);
		expect(wide("squad:beta")).toMatch(/^╚═ esc\/bksp back · q close · ↑↓ scroll ═+╝$/);
		expect(wide("seal:Demo:0")).toMatch(/^╚═ esc\/bksp back · q close · ↑↓ scroll ═+╝$/);
		expect(wide("agent:ApothecaryBeta", "ApothecaryBeta")).toMatch(/^╚═ esc\/bksp back · q close · ↑↓ scroll ═+╝$/);
		expect(narrow("agent:ApothecaryBeta")).toBe("esc back · q close · enter transcript");
		expect(narrow("squad:beta")).toBe("esc back · q close");
		expect(narrow("agent:ApothecaryBeta", "ApothecaryBeta")).toBe("esc back · q close");
	});
	test("the title names the agent and carries a–b/n only when rows are hidden", () => {
		const short = trView(trNav("agent:ApothecaryBeta", {}, "ApothecaryBeta"), { transcript: { id: "ApothecaryBeta", lines: ["one"] } });
		const t = draw(short, 120, 30).find(l => l.startsWith("╟─ TRANSCRIPT"))!;
		expect(t).toMatch(/^╟─ TRANSCRIPT ApothecaryBeta ─+╢$/);
		const long = draw(trView(trNav("agent:ApothecaryBeta", {}, "ApothecaryBeta")), 120, 14).find(l => l.startsWith("╟─ TRANSCRIPT"))!;
		expect(long).toMatch(/^╟─ TRANSCRIPT ApothecaryBeta · \d+–60\/60 ─+╢$/);
	});
	test("the narrow layout is bottom-anchored too", () => {
		const rows = draw(trView(trNav("agent:ApothecaryBeta", {}, "ApothecaryBeta")), 50, 14);
		expect(rows.join("\n")).toContain("row 60");
		expect(rows.some(l => l.startsWith("TRANSCRIPT ApothecaryBeta"))).toBe(true);
	});
});

describe("transcript boundaries (#125 penance)", () => {
	const rowsOf = (...ms: unknown[]) => transcriptLines(jl(...ms), false);
	test("a text block of exactly 40 lines has no `more lines` row", () => {
		const rows = rowsOf(msg("assistant", [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n") }]));
		expect(rows).toHaveLength(40);
		expect(rows.at(-1)).toBe("l39");
	});
	test("a row of exactly 400 chars is kept whole; 401 is cut with an ellipsis", () => {
		expect(rowsOf(msg("user", "a".repeat(394)))).toEqual([`user: ${"a".repeat(394)}`]);
		const [cut] = rowsOf(msg("user", "a".repeat(395)));
		expect(cut).toHaveLength(400);
		expect(cut.endsWith("…")).toBe(true);
	});
	test("exactly 1000 rows with no cut carry no notice; 1001 do", () => {
		const many = (n: number) => transcriptLines(jl(...Array.from({ length: n }, (_, i) => msg("user", `m${i}`))), false);
		expect(many(1000)).toHaveLength(1000);
		expect(many(1000)[0]).toBe("user: m0");
		expect(many(1001)[0]).toBe("… earlier entries not shown");
	});
	test("an entry that is not a message is skipped even when it carries a message role", () => {
		expect(rowsOf({ type: "custom", message: { role: "user", content: "LEAK" } })).toEqual(["no messages yet"]);
	});
	test("a toolResult with no tool name says `?`; a long one stays within 400 chars", () => {
		expect(rowsOf(msg("toolResult", "x"))).toEqual(["← ? ok: x"]);
		const [row] = rowsOf(msg("toolResult", "a".repeat(300), { toolName: "t".repeat(300) }));
		expect(row.length).toBeLessThanOrEqual(400);
	});
	test("a toolResult row is never cut inside a surrogate pair", () => {
		const [row] = rowsOf(msg("toolResult", `${"a".repeat(391)}😀`, { toolName: "t" }));
		expect(row).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
		expect(row.length).toBeLessThanOrEqual(400);
	});
	test("a whitespace-only text block adds no row", () => {
		expect(rowsOf(msg("assistant", [{ type: "text", text: " \n  " }, { type: "text", text: "real" }]))).toEqual(["real"]);
	});
	test("a cut tail with no complete message says the head is not shown, not `no messages yet`", () => {
		expect(transcriptLines("x".repeat(1000), true)).toEqual(["… earlier entries not shown"]);
		expect(transcriptLines("", false)).toEqual(["no messages yet"]);
	});
	test("the view keeps the notice with 1001 rows (the notice and the newest 1000)", () => {
		const lines = ["… earlier entries not shown", ...Array.from({ length: 1000 }, (_, i) => `r${i}`)];
		const v = trView(trNav("agent:ApothecaryBeta", {}, "ApothecaryBeta"), { transcript: { id: "ApothecaryBeta", lines } });
		expect(v.detail!.lines).toHaveLength(1001);
		expect(v.detail!.lines[0]).toBe("… earlier entries not shown");
	});
	test("enter on a detail with no target returns the nav unchanged, with no transcript key", () => {
		const v = trView(trNav("squad:beta"));
		const n = navigate(v, "enter");
		expect(n).toStrictEqual(v.nav);
		expect(n).not.toHaveProperty("detail.transcript");
	});
	test("a failed agent shows its final answer, or says it has no answer file", () => {
		expect(transcriptLines(jl(msg("user", "go")), false, "bad news")).toEqual(["user: go", "final answer:", "bad news"]);
		expect(transcriptLines(jl(msg("user", "go")), false, null)).toEqual(["user: go", "no final answer file"]);
	});
	test("colour codes in a toolResult are stripped", () => {
		expect(rowsOf(msg("toolResult", "\x1b[31mred\x1b[0m", { toolName: "bash" }))).toEqual(["← bash ok: red"]);
	});
	test("an emoji straddling the 400-char cut leaves no lone surrogate", () => {
		const [row] = rowsOf(msg("toolResult", `${"a".repeat(390)}😀😀😀`, { toolName: "t" }));
		expect(row).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
		expect(row.length).toBeLessThanOrEqual(400);
		expect(row.endsWith("…")).toBe(true);
	});
	test("the view keeps the notice when given 1002 or more rows", () => {
		const lines = ["… earlier entries not shown", ...Array.from({ length: 1100 }, (_, i) => `r${i}`)];
		const v = trView(trNav("agent:ApothecaryBeta", {}, "ApothecaryBeta"), { transcript: { id: "ApothecaryBeta", lines } });
		expect(v.detail!.lines).toHaveLength(1001);
		expect(v.detail!.lines[0]).toBe("… earlier entries not shown");
		expect(v.detail!.lines.at(-1)).toBe("r1099");
	});
	test("the view keeps both header rows (brief and notice) with 1100 rows after them", () => {
		const lines = ["user: brief", "… earlier entries not shown", ...Array.from({ length: 1100 }, (_, i) => `r${i}`)];
		const v = trView(trNav("agent:ApothecaryBeta", {}, "ApothecaryBeta"), { transcript: { id: "ApothecaryBeta", lines } });
		expect(v.detail!.lines).toHaveLength(1002);
		expect(v.detail!.lines.slice(0, 2)).toEqual(["user: brief", "… earlier entries not shown"]);
		expect(v.detail!.lines.at(-1)).toBe("r1099");
	});
	test("the agent's brief leads a cut transcript, above the notice; an uncut one has no extra row", () => {
		const head = jl(msg("assistant", "x"), msg("user", `do\nthis ${"b".repeat(500)}`));
		const brief = briefRow(head)!;
		expect(brief.startsWith("user: do this bbb")).toBe(true);
		expect(brief.length).toBeLessThanOrEqual(400);
		expect(transcriptLines("partial\n" + jl(msg("user", "tail")), true, undefined, brief)).toEqual([brief, "… earlier entries not shown", "user: tail"]);
		expect(transcriptLines(jl(msg("user", "tail")), false, undefined, brief)).toEqual(["user: tail"]);
		expect(briefRow("garbage\n{\"type\":\"message\",\"message\":{\"role\":\"user\"")).toBeUndefined();
	});
	test("the narrow footer hints enter transcript at exactly its width, not one cell less", () => {
		const hint = "esc back · q close · enter transcript";
		const foot = (w: number) => draw(trView(trNav("agent:ApothecaryBeta")), w).at(-1)!;
		expect(foot(Bun.stringWidth(hint))).toBe(hint);
		expect(foot(Bun.stringWidth(hint) - 1)).toBe("esc back · q close");
	});
});

// The relic switch must leave today's renderer byte for byte alone. These digests were taken from the renderer of main 157274f before the relic code existed.
describe("relic off: byte-identical to main", () => {
	const FIX: Record<string, () => View> = {
		scriptorium: () =>
			cockpitView(
				input({
					clock: { running: true, el: 42, bk: 120 },
					phases: [
						{ name: "Muster", tasks: [{ content: "[captain] Orders", status: "completed" }] },
						{ name: "Scriptorium", tasks: [{ content: "[librarian] Draft the plan", status: "completed" }, { content: "[seal] Plan", status: "in_progress" }] },
						{ name: "Skirmish", tasks: [{ content: "[battle-brother] Build squad a", status: "pending" }] },
					],
					seal: { id: "Plan", lines: ["Squads: a, b", "Merge bar: tests green", "Review: confessor"] },
					chronicle: many(7),
				}),
			),
		skirmish: () => cockpitView(DETAIL({ chronicle: many(14) })),
		detail: () => open("agent:AlphaBrother", { chronicle: many(6) }),
	};
	const PALS = { truecolor: () => palette("truecolor", THEMES["blood-angels"]), 256: () => palette("256", THEMES.cogitator) };
	const DIGESTS: Record<string, string> = {
		"detail/100/256/-/0": "e10dfd918d8d79a23e00f9c1510838561eaca2552eef8882d13976c32a54eedc",
		"detail/100/256/-/1": "a852b9dc31d2488a763c4aeec9c3d9fa58eb051bef54abe1f4a8c3bcc3064727",
		"detail/100/256/30/0": "25cc5b0784f85bef16419be4839ce701e7b4aa42a96c26d9b269549a43a7556b",
		"detail/100/256/30/1": "267276ad39dbb94eaa2124fb6d4b2346fffaea788da627e2f3db5e6d5b85457f",
		"detail/100/truecolor/-/0": "3a72d4768698594a18b46ec65707c274841bf2db207a1474b5d156b954f730c1",
		"detail/100/truecolor/-/1": "438398b11d02d5899df3603cf4510d8c85120974177869373cf1f46a9cf6597e",
		"detail/100/truecolor/30/0": "ca985979a473f0313ad97dcba1e04b07ada3aeb6ebda9f844de85f6d11a12bbe",
		"detail/100/truecolor/30/1": "4a1222c3cb6cce3f4cde6e5324b8971261a75a0fee849a62683ab0cb2cae97a8",
		"detail/140/256/-/0": "9f7118775c82ddeb2cd33c2c6139c97685c8c3de93979eb19b57ed04e93d68a1",
		"detail/140/256/-/1": "98b8beb7fe730635b5a10794398777b89b8ce01a50351f92d15a334f8c92632b",
		"detail/140/256/30/0": "a5b42ef7ab60a81d8bc5af16517529220449604886b25c36de7fa20c49b439a3",
		"detail/140/256/30/1": "96a8d1a9296a155696549d0a82d938a37e7e012017e2a3cb20de9adfa1dd20c1",
		"detail/140/truecolor/-/0": "c1c33b4cf3ebd25a9ec5fbc90c0e77b3200c774be4b7e56e147670444a6f8764",
		"detail/140/truecolor/-/1": "197c8f6e9ec8f62fed77858bba4487c51ddad3826e9452c0b61d73defa04dc15",
		"detail/140/truecolor/30/0": "0e5549eb8db33449cfcfed5001156bc5c4c45e3dcff3472067d67d3aad02f2dd",
		"detail/140/truecolor/30/1": "b46c7e18e42fbb4aa338f2f84fd7c8ac89d4ac24ac89ca3e83d76e0ebac7f3c9",
		"detail/60/256/-/0": "ed8c561656c4f39414aabcab08c069fd3b3d3dd7ed0d0e6878964ca9a5151a7e",
		"detail/60/256/-/1": "49142af281231b7b114e7413855f8a0df80183ab78650bb06adc2c3fc5a97c7e",
		"detail/60/256/30/0": "aa85091b2222c97d4700ee5f52afdb100a355351865da3b0103c8ad71bf744c6",
		"detail/60/256/30/1": "5ef69dd478257bac6f8ecef4acebf9af3b735c9a76b29db1ae8ba0b4509d812b",
		"detail/60/truecolor/-/0": "4bfeccab366e2d581e6085acca672c13f98d282aa70dff3a9a6fab2715d2fe2c",
		"detail/60/truecolor/-/1": "219bb248b4dd37f453476860a08328c522978bcabe356d82e64a90d10276de2f",
		"detail/60/truecolor/30/0": "a582c088158eeac3e2ca084876a0a72e7f89825d675293e8488c46ce43359a89",
		"detail/60/truecolor/30/1": "d0162a27b01587bc7d5932421edb4e3ca671deddb8b0d19c5914cc93d8b4902e",
		"detail/72/256/-/0": "55ab7850d4694a887c7ea6a6d0de54b70c8bc01756255b8aa9d04d672daca83b",
		"detail/72/256/-/1": "981b3de70210239bb7ac3070dcc3a152c2ae2a4d1c81ce48cb7ba25fe95a7169",
		"detail/72/256/30/0": "460f90a2ea321224219c2c99119be20441665e91091e7cd793a5d9dc95436c57",
		"detail/72/256/30/1": "eece39708368b88cfd54b575ab5b1e2f94865a267c7728e0fcabbdb549729571",
		"detail/72/truecolor/-/0": "2feed0497fa3b5548bf2fbdbf4535873ff87d928a16d1ff18f8c5137948c841b",
		"detail/72/truecolor/-/1": "c365970d124b190b7bb34df3e9bf3cbebbde31550fc1fee5c21a924453c0afdb",
		"detail/72/truecolor/30/0": "8aa1b8ec59d94c899500adc6d4d92132028c16a7f0e839a93c2a6f2c9b83e561",
		"detail/72/truecolor/30/1": "4b7a93558a6406caf7e525085226b422060aa4d97294191eb4fac69020d44cd3",
		"scriptorium/100/256/-/0": "b920b3373502b71ff02dcf013af868092e6dbdc1ec39f50fc02c4726543d8aef",
		"scriptorium/100/256/-/1": "754672fc9175985cefec8dbb0fb6e03d61c4ade9e4744e14eee63c98fab301a2",
		"scriptorium/100/256/30/0": "cca5baf1d29ff4e5e3e5d8786aa8e079b362422fecb1a4bfad7d3ab01af1eda5",
		"scriptorium/100/256/30/1": "6b300a1caab704828f7a2a9221234b5ef2c20d8f384ac1be04448a385f3339c1",
		"scriptorium/100/truecolor/-/0": "c35f7cb46e2f16024184c9da2c686201b6810efeed575d64bc5c3f15721f1e5f",
		"scriptorium/100/truecolor/-/1": "7f2166bd87f1f3ac9f0baeabbc7c4676c5e4d30856014603830fc74d4d151631",
		"scriptorium/100/truecolor/30/0": "292d00395fdf514bf2bf383b419e02b7cf32a8241614fad81f843b9aa44260ac",
		"scriptorium/100/truecolor/30/1": "c6c04bc45efcf9638375e59776c6b7047c09c3e18598c96d3f8f113f70c1b526",
		"scriptorium/140/256/-/0": "8cb522251edfb183f1785e9ec409741fc14614819a0cb74fafb5175ee9dd11fe",
		"scriptorium/140/256/-/1": "43fd4536af843e3eea64d0fffa56a994a2866d4dc14f6e11bf4114d2ad3a1f95",
		"scriptorium/140/256/30/0": "081a528bcac7b9a74a08bc7f1e3bf7d8ccb95fc91921e690051b554ab1bf1bd2",
		"scriptorium/140/256/30/1": "d6a609c6f9a0782c8fa848375fc060c55d4c8811ee6d9e8deb404c59986b65d5",
		"scriptorium/140/truecolor/-/0": "59d6f5de5c122d9966ca4e9b14424c130aac32dbc49ea592a560ce97a01c073f",
		"scriptorium/140/truecolor/-/1": "f56f41d49e9cc834426be32f9d40fec4a5f6bbdd7a32d20cff6858fb4009d712",
		"scriptorium/140/truecolor/30/0": "3d1c8886c4969aef8b7e3d5077c03e8003cf9948211634ea080308421dadeb45",
		"scriptorium/140/truecolor/30/1": "e403fca76604179bb90b88f7b793c91780daa1f246cd032247583d682bd2e23d",
		"scriptorium/60/256/-/0": "b9ae139c5f2c8abda95edc82905d74479305d13ade5e82c5bfc34a3f25d6e408",
		"scriptorium/60/256/-/1": "dc6a34367578afad568c23d9f61760f3532cffd0d448d9d00565f402c611e63e",
		"scriptorium/60/256/30/0": "44464e0dba8c9a3dabf1651a93df54b04b2ff21bbd4a79b746ef0a3d77a647ce",
		"scriptorium/60/256/30/1": "5869f0a53dad112a191f61ceaefa265bf88072c6cb731e83ed8ed7d087d99bce",
		"scriptorium/60/truecolor/-/0": "2d1d0be828f7cdb7a7de7c61226af63521f83d79dcaf428bc04b06903750423f",
		"scriptorium/60/truecolor/-/1": "6efdeb721e55145b3a1f262d62f4ba01bb5d479dfeac976a3f3a5d64fa31cb37",
		"scriptorium/60/truecolor/30/0": "24263fda84545e20c357b0461c5a74106c62e2d2d1f5557ae9caae86e00fbbe9",
		"scriptorium/60/truecolor/30/1": "34eddd345fe94a7d8580b69bf988da066788e97f8322ff89f04454b95910e9f3",
		"scriptorium/72/256/-/0": "15173bcdc2b77c8a1f2e444842d152ee2b8b656ca7a56fde6712bee5672a4123",
		"scriptorium/72/256/-/1": "f9f9640e5edd465d1905b94737a478cdc8456c889208a2f8dabe6a372652c2e6",
		"scriptorium/72/256/30/0": "b8fcee0c9c9c82953cb38947f50f665af9670e16feba88fb6c765ffa5907df6e",
		"scriptorium/72/256/30/1": "8683cff5735e6396ddc64bda56c01db5e559e9549781a6defca22a92e4a1191d",
		"scriptorium/72/truecolor/-/0": "d80495b7abf1609f9197caacc6d9f29503d713a672f9be7a2733d02ad5fd4d97",
		"scriptorium/72/truecolor/-/1": "dff5cb51e265e0fc3d0628db23d95cd87e86c5da2ee45f43b23202df315bfe09",
		"scriptorium/72/truecolor/30/0": "105a3dba5d01e011ed9bc3ff1897874a029b117a212567bb0584ab808f4b3bcb",
		"scriptorium/72/truecolor/30/1": "530616c2993a8fbaa616c43a9d42ce2a9e86ba0c3b804c583a45d7121a1de11a",
		"skirmish/100/256/-/0": "e8ad609fd38e6633acf3aa782a1499c9244a852cdacc555d4ad83109e124904a",
		"skirmish/100/256/-/1": "3153eece72b05084967cd561e3e19743b05b4dd404889d059e575d3522f00db0",
		"skirmish/100/256/30/0": "bffae3e7a3b7378d6883e6e26806f8b6443310175d2165583d0406fa7e10c6d2",
		"skirmish/100/256/30/1": "d70f64a2910e606a04e38d69740217509e62871a4c26b992a17c15290c21cda7",
		"skirmish/100/truecolor/-/0": "a6f79dfa0d3d5b049b762bd1a625317d49c962b2df4c6222c04f1addc798f837",
		"skirmish/100/truecolor/-/1": "c9816a7e3f8f40de6d86f4afd397e5f5582193e859aa31f360cf4ab3bcc01831",
		"skirmish/100/truecolor/30/0": "e973b32b44308241128c71fd2af6005079b39e4ad46f10ae678411c0642180ee",
		"skirmish/100/truecolor/30/1": "b03f8201d6279112b54f0eca4a988f00db1aeb43652eb93a3770c594a3a358ba",
		"skirmish/140/256/-/0": "34ea423713ba5dd6716c1b89dfffeabee01fe496b9c163ce893aba7c2d1dee1c",
		"skirmish/140/256/-/1": "0207fe120aca24e0b2239e4a6d13042d78074f1014af7beb057b03276e172d8e",
		"skirmish/140/256/30/0": "20613b7d9ba447055dde36f5c4c1036ce9e2d3d317c5dde520eeacf121f4afbf",
		"skirmish/140/256/30/1": "2649b6658694cb0ec6c1d7ebe6fd0832365283a39468dd6d6eab78fb49196819",
		"skirmish/140/truecolor/-/0": "d7baaed5bf298f17b6806f3f18e6f2d53500e70ff6086861ae4f1c4a020de550",
		"skirmish/140/truecolor/-/1": "61326056103eff71c238f147a9df19402a75822b95009976d657b5fef6ce6ffd",
		"skirmish/140/truecolor/30/0": "f355681571c8c0574a206d34c14dfb0a4b139bcb1bfecd119d7013ca78542387",
		"skirmish/140/truecolor/30/1": "243f85b25526026ae38370d2569a99e9d28ac896bd75df7fd5730ff5f6f7a089",
		"skirmish/60/256/-/0": "910aeac412c7c4cfe60bb2b02cf4efa563dbed88673fc2d08e838c451ed90c6a",
		"skirmish/60/256/-/1": "6da767e6975fc152e6342a348e6f262c9113774a445cedab780934f4073317cf",
		"skirmish/60/256/30/0": "ca98829503ff373d51ea2712a5125e04ca676a4cda535d138558673ec29be1b8",
		"skirmish/60/256/30/1": "c6e3bb673548f4a8873e2e975699920c35e7a4f4294dd0be6dc8ed268b22c81b",
		"skirmish/60/truecolor/-/0": "a8cadf4ba87f49562e909d163df155f14237913f0f87b7b95e70f4faaa759f40",
		"skirmish/60/truecolor/-/1": "e0e9556a79fac7b9187cb88d2aa751ef25da59a85fbf306dd355b30d33809b0c",
		"skirmish/60/truecolor/30/0": "0368f99c20121574e6d85906449fcc794c73f747c04fba73e78f06e01f22abfb",
		"skirmish/60/truecolor/30/1": "847002308a923c59b3cc40ac11b8ab08a5b9a6b8b0e047244c28f308e5a0e656",
		"skirmish/72/256/-/0": "28bf586095d61875f325f010cdc510bda70e1ba70859d177e39d7472ce983f12",
		"skirmish/72/256/-/1": "104b999c5f41a2801c13735273700d133a6288758ae2eb338a6fd148a0d768f4",
		"skirmish/72/256/30/0": "dd2e46e0a9f9722e410d9dad2892d86ac01baec07ab282a6c046b041a37b941f",
		"skirmish/72/256/30/1": "7e73990c18531b27c474301c1d27dd9535729b23393e9490b5cdeb0e6a60b6bc",
		"skirmish/72/truecolor/-/0": "2f237e1d451697b7aac939ebd504cb966aef3ca7764b4b4a9e1388fb50c74532",
		"skirmish/72/truecolor/-/1": "2b7ee05844cc4871589796640663418605cf9867e2ac146693d18dd2c00195ee",
		"skirmish/72/truecolor/30/0": "d1062c1ddeef6ca930c49a339eabe004213338c7bec3adbca2038ae9a733cccc",
		"skirmish/72/truecolor/30/1": "8d0d238dbab9acd4615593bc5e499eb85d3f9fe0eda3b3b7104720e9c80d1b5e",
	};
	const cases = Object.keys(FIX).flatMap(v => [60, 72, 100, 140].flatMap(w => Object.keys(PALS).flatMap(p => [undefined, 30].flatMap(h => [0, 1].map(f => [`${v}/${w}/${p}/${h ?? "-"}/${f}`, v, w, p, h, f] as const)))));
	const digest = (v: string, w: number, p: string, h: number | undefined, f: number) =>
		new Bun.CryptoHasher("sha256").update(renderCockpit(FIX[v](), w, f, PALS[p as keyof typeof PALS](), h).join("\n")).digest("hex");

	test.each(cases)("%s", (name, v, w, p, h, f) => {
		if (process.env.DUMP_DIGESTS) console.log(`DIGEST ${name} ${digest(v, w, p, h, f)}`);
		expect(digest(v, w, p, h, f)).toBe(DIGESTS[name]);
	});
});

describe("relic", () => {
	const BLOOD = palette("truecolor", THEMES["blood-angels"]);
	const WORN: Record<string, string> = { "═": "╍┅•", "─": "╌┄" };
	const GLYPHS = [..."╍┅╌┄•╱╲·"];
	const render = (v: View, width: number, pal = BLOOD, relic = true, height?: number, frame = 0) => renderCockpit(v, width, frame, pal, height, relic);
	const POOL: string[] = [..."═─╍┅╌┄•╱╲·  abcXYZ019世界😀é", "\x1b[31m", "\t", "\u202e", "\n"];
	const word = (r: (n: number) => number, n: number) => Array.from({ length: r(n) }, () => POOL[r(POOL.length)]).join("");
	const randomView = (r: (n: number) => number, kind = 0): View => {
		const inp = DETAIL({
			key: [...word(r, 14)].filter(c => c >= " " && c !== "\u202e").join("") || "k",
			phases: [
				{ name: "Skirmish", tasks: [{ content: "[seal] Demo", status: "in_progress" }, ...Array.from({ length: r(5) }, () => ({ content: `[battle-brother] ${word(r, 30)}`, status: ["pending", "in_progress", "completed"][r(3)] }))] },
			],
			seal: { id: "Demo", lines: Array.from({ length: r(16) }, () => word(r, 60)) },
			chronicle: Array.from({ length: 1 + r(20) }, () => ({ at: "10:00", who: word(r, 12), text: word(r, 160) })),
			transcript: { id: "ApothecaryBeta", lines: Array.from({ length: r(60) }, () => word(r, 80)) },
		});
		if (kind === 1) return cockpitView({ ...inp, nav: { cursor: { id: cockpitView(inp).chronicle[0].id, at: 0 }, detail: { id: cockpitView(inp).chronicle[0].id } } }); // an entry's detail
		if (kind === 2) return cockpitView({ ...inp, nav: trNav("agent:ApothecaryBeta", {}, "ApothecaryBeta") }); // a transcript
		return cockpitView(inp);
	};
	const cells = (s: string) => [...plain(s)];

	test("(a) 300 random views, detail and transcript included: relic only wears fill runs and scratches blank cells with blank neighbours (never in a detail or transcript), never changes a line's width or the line count", () => {
		const r = rnd0(20260);
		let changed = 0;
		for (let n = 0; n < 300; n++) {
			const view = randomView(r, n % 3);
			expect(!!view.detail).toBe(n % 3 > 0);
			const width = 72 + r(129);
			const height = r(2) ? undefined : 20 + r(41);
			const pal = n % 2 ? palette("256", THEMES.cogitator) : BLOOD;
			const on = render(view, width, pal, true, height);
			const off = render(view, width, pal, false, height);
			expect(on).toHaveLength(off.length);
			on.forEach((l, i) => {
				expect(Bun.stringWidth(plain(l))).toBe(Bun.stringWidth(plain(off[i])));
				const a = cells(l);
				const b = cells(off[i]);
				expect(a).toHaveLength(b.length);
				a.forEach((c, j) => {
					if (c === b[j]) return;
					changed++;
					const worn = WORN[b[j]]?.includes(c);
					const scratch = !view.detail && b[j] === " " && b[j - 1] === " " && b[j + 1] === " " && "╱╲·".includes(c);
					expect([n, i, j, b[j], c, worn || scratch]).toEqual([n, i, j, b[j], c, true]);
				});
			});
		}
		expect(changed).toBeGreaterThan(300);
	});

	test.each([140, 100, 72])("(b) at %i every framed line is exactly the width and ends in ╗║╢╝, and the relic changes something", width => {
		for (const height of [undefined, 30]) {
			const view = cockpitView(DETAIL({ chronicle: many(14) }));
			const on = render(view, width, BLOOD, true, height).map(plain);
			const off = render(view, width, BLOOD, false, height).map(plain);
			for (const l of on) {
				expect(Bun.stringWidth(l)).toBe(width);
				expect("╗║╢╝").toContain(l.at(-1)!);
			}
			expect(on.filter((l, i) => l !== off[i]).length).toBeGreaterThan(0);
		}
	});

	test("(c) the same view renders identically twice, and the frame moves no decoration", () => {
		const view = cockpitView(DETAIL({ chronicle: many(14) }));
		expect(render(view, 140)).toEqual(render(view, 140));
		const norm = (ls: string[]) => ls.map(l => l.replaceAll("▷", "▶"));
		const on0 = render(view, 140, BLOOD, true, 30, 0);
		const on1 = render(view, 140, BLOOD, true, 30, 1);
		expect(on0).not.toEqual(on1);
		expect(norm(on0)).toEqual(norm(on1));
	});

	test("(d) other keys give another relic: alpha vs beta, and equal-length keys that appear nowhere else with the key text masked", () => {
		const at = (key: string) => render(cockpitView(DETAIL({ key, chronicle: many(14) })), 140, BLOOD, true, 30);
		expect(at("alpha")).not.toEqual(at("beta"));
		const masked = (key: string) => at(key).map(l => l.replaceAll(key, "KEY"));
		expect(masked("kkkkk")).not.toEqual(masked("mmmmm"));
	});

	test("(e) in 256 colours the relic adds no colour sequence", () => {
		const pal = palette("256", THEMES["blood-angels"]);
		const view = cockpitView(DETAIL({ chronicle: many(14) }));
		for (const height of [undefined, 30]) {
			const sgr = (ls: string[]) => new Set(ls.join("\n").match(/\x1b\[[0-9;]*m/g));
			const off = sgr(render(view, 140, pal, false, height));
			expect([...sgr(render(view, 140, pal, true, height))].filter(s => !off.has(s))).toEqual([]);
		}
	});

	const luminance = (rgb: number[]) => {
		const [r, g, b] = rgb.map(c => c / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const contrast = (a: number[], b: number[]) => {
		const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return (hi + 0.05) / (lo + 0.05);
	};
	const dimIron = (iron: string, bg?: string) => {
		const f = iron.match(/\d+/g)!.slice(2).map(Number);
		const b = bg?.match(/\d+/g)!.slice(2).map(Number);
		return `\x1b[38;2;${f.map((x, i) => (b ? Math.round((x + b[i]) / 2) : Math.round(x * 0.6))).join(";")}m`; // a themed background: halfway to it; none: 0.6 of the iron
	};
	test.each(Object.entries(THEMES))("(f) theme %s: truecolor relic adds tarnish shades that are no palette tone and keep 3:1 on the background", (_name, theme: Theme) => {
		const pal = palette("truecolor", theme);
		const view = cockpitView(DETAIL({ chronicle: many(14) }));
		const seqs = (ls: string[]) => new Set(ls.join("\n").match(/\x1b\[38;2;\d+;\d+;\d+m/g));
		const off = seqs(render(view, 140, pal, false, 30));
		const faint = dimIron(pal.iron, pal.bg); // the scratches: faint on purpose (no 3:1), and never the iron the real text is in
		const shades = [...seqs(render(view, 140, pal, true, 30))].filter(s => !off.has(s) && s !== faint);
		expect(shades).toHaveLength(8); // 4 shades and their dimmed twins on the odd scanlines
		expect(faint).not.toBe(pal.iron);
		const tones: string[] = Object.values(pal);
		for (const s of shades) {
			expect(tones).not.toContain(s);
			if (theme.bg) expect(contrast(s.slice(7, -1).split(";").map(Number), [1, 3, 5].map(i => parseInt(theme.bg!.slice(i, i + 2), 16)))).toBeGreaterThanOrEqual(3);
		}
	});

	test.each([71, 60, 40])("(g) at width %i relic on is byte-identical to off", width => {
		const view = cockpitView(DETAIL({ chronicle: many(14) }));
		for (const height of [undefined, 30]) expect(render(view, width, BLOOD, true, height)).toEqual(render(view, width, BLOOD, false, height));
	});

	test("(h) relic false gives the bytes of omitting the argument", () => {
		const view = cockpitView(DETAIL({ chronicle: many(14) }));
		for (const height of [undefined, 30]) expect(renderCockpit(view, 100, 0, BLOOD, height, false)).toEqual(renderCockpit(view, 100, 0, BLOOD, height));
	});

	test("(i) every decoration glyph is one cell wide and outside the Private Use Area", () => {
		for (const g of GLYPHS) {
			expect([g, Bun.stringWidth(g)]).toEqual([g, 1]);
			expect(g.codePointAt(0)!).toBeLessThan(0xe000);
		}
	});

	test("the selected line of a box is never scratched", () => {
		const id = cockpitView(DETAIL()).boxes[0].lines[0].id;
		const view = cockpitView({ ...DETAIL(), nav: { cursor: { id, at: 0 } } });
		for (const width of [72, 100, 140]) {
			const on = render(view, width).map(plain);
			const off = render(view, width, BLOOD, false).map(plain);
			const at = off.findIndex(l => l.includes("▸"));
			expect(at).toBeGreaterThan(-1);
			const from = off[at].indexOf("▸");
			const seg = (l: string) => l.slice(from, l.indexOf("│", from));
			expect(seg(on[at])).toBe(seg(off[at]));
		}
	});

	test("blank filler rows keep their scratches when a chronicle entry is added", () => {
		const at = (n: number, relic = true) => render(cockpitView(DETAIL({ chronicle: many(n), key: "stable" })), 140, BLOOD, relic, 40).map(plain);
		const [a, b, off] = [at(4), at(5), at(4, false)];
		const rows = [2, 3, 4, 5, 6, 7, 8, 9]; // from the bottom: the fillers just above the bottom frame
		for (const d of rows) expect(a.at(-d)).toBe(b.at(-d));
		expect(rows.filter(d => a.at(-d) !== off.at(-d)).length).toBeGreaterThan(0); // not vacuous: some of them are scratched
	});

	test("scratches are sparse: at most one per row, about 1 in 140 blank cells, clustered as · ╱ ╲ or ╱╲", () => {
		let blank = 0;
		let marks = 0;
		for (let k = 0; k < 40; k++) {
			const view = cockpitView(DETAIL({ key: `sparse-${k}`, chronicle: many(2) }));
			const on = render(view, 140, BLOOD, true, 50).map(plain);
			const off = render(view, 140, BLOOD, false, 50).map(plain);
			on.forEach((l, i) => {
				const diff = [...l].map((c, j) => (c !== [...off[i]][j] && [...off[i]][j] === " " ? j : -1)).filter(j => j >= 0);
				const clusters = diff.filter((j, n) => n === 0 || j - diff[n - 1] > 1); // a row of boxes has one scratch at most per box
				expect(diff.length).toBeLessThanOrEqual(2 * clusters.length);
				expect(clusters.length).toBeLessThanOrEqual(3);
				marks += clusters.length;
				blank += [...off[i]].filter(c => c === " ").length;
			});
		}
		expect(marks).toBeGreaterThan(0);
		expect(marks / blank).toBeLessThan(1 / 60);
	});

	test("the first and last cell of the top and bottom runs stay a plain ═, whatever the key", () => {
		for (let k = 0; k < 200; k++) {
			for (const width of [72, 140]) {
				const on = render(cockpitView(DETAIL({ key: `run-${k}`, chronicle: many(3) })), width).map(plain);
				expect(on[0]).toMatch(/COGITATOR ═/);
				expect(on[0]).toMatch(/═ run-\d+ ═╗$/);
				expect(on.at(-1)).toMatch(/home active(?: · enter open)? ═/);
				expect(on.at(-1)).toMatch(/═╝$/);
			}
		}
	});

	const bars = (ls: string[]) => ls.map(l => l.match(/\x1b\[[0-9;]*m║/g) ?? []); // each ║ with the tarnish shade before it
	const shot = (inp: ViewInput, nav?: Nav) => render(cockpitView(nav ? { ...inp, nav } : inp), 140, BLOOD, true, 40);

	test("the rules and the ║ tints stay put when the cursor moves between a box line and a chronicle entry", () => {
		const inp = DETAIL({ key: "stable", chronicle: many(4) });
		const v = cockpitView(inp);
		const [a, b] = [shot(inp, { cursor: { id: v.boxes[0].lines[0].id, at: 0 } }), shot(inp, { cursor: { id: v.chronicle[0].id, at: 0 } })];
		expect(a).toHaveLength(b.length);
		expect(a).not.toEqual(b); // the cursor does move
		expect(bars(a)).toEqual(bars(b));
		a.forEach((l, i) => {
			if (!l.includes("▸") && !b[i].includes("▸")) expect(l).toBe(b[i]);
		});
	});

	test("the rules, the ║ tints and the filler rows stay put when the chronicle grows by one entry", () => {
		const at = (n: number) => shot(DETAIL({ key: "stable", chronicle: many(n) }));
		const [a, b] = [at(4), at(5)];
		expect(a).toHaveLength(b.length);
		expect(bars(b)).toEqual(bars(a));
		a.forEach((l, i) => {
			if (/^[╔╟╚]/.test(plain(l))) expect(b[i]).toBe(l);
		});
		for (let d = 1; d <= 9; d++) expect(b.at(-d)).toBe(a.at(-d)); // the fillers and the bottom frame, by distance from the bottom
	});

	test("a box line whose text changes keeps its scratch column", () => {
		const lines = (text: string, key: string) => {
			const inp = DETAIL({ key, phases: [{ name: "Skirmish", tasks: [{ content: "[seal] Demo", status: "in_progress" }, { content: `[battle-brother] ${text}`, status: "pending" }] }], slices: [], stopped: [], agents: {}, deployed: new Map() });
			const on = render(cockpitView(inp), 140).map(plain);
			const off = render(cockpitView(inp), 140, BLOOD, false).map(plain);
			const row = off.findIndex(l => l.includes(text));
			return { on: [...on[row]], off: [...off[row]], row };
		};
		let kept = 0;
		for (let k = 0; k < 400; k++) {
			const [a, b] = [lines("zzq", `col-${k}`), lines("zzqzzq", `col-${k}`)];
			expect(a.row).toBeGreaterThan(0);
			a.on.forEach((c, j) => {
				if (c === a.off[j] || b.off.slice(j - 4, j + 2).join("") !== "      ") return;
				kept++;
				expect([k, j, b.on[j]]).toEqual([k, j, c]);
			});
		}
		expect(kept).toBeGreaterThan(0);
	});

	test("in a box a scratch has at least 3 blank cells between it and the text", () => {
		let seen = 0;
		for (let k = 0; k < 150; k++) {
			const view = cockpitView(DETAIL({ key: `gap-${k}`, chronicle: many(2) }));
			const on = render(view, 140, BLOOD, true, 40).map(plain);
			const off = render(view, 140, BLOOD, false, 40).map(plain);
			on.forEach((l, i) => {
				if (!off[i].includes("│")) return;
				[...l].forEach((c, j) => {
					if (c === [...off[i]][j]) return;
					seen++;
					expect([k, i, j, [...off[i]].slice(j - 3, j).join("")]).toEqual([k, i, j, "   "]);
				});
			});
		}
		expect(seen).toBeGreaterThan(0);
	});

	const rgbOf = (s: string) => s.match(/\d+/g)!.slice(2).map(Number);
	test("tarnish: shades lie between gold and brass, the first closer to gold, the odd lines carry their 0.85 twins", () => {
		const view = cockpitView(DETAIL({ chronicle: many(14) }));
		const seqs = (ls: string[]) => ls.join("\n").match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? [];
		const palette0 = new Set([...seqs(render(view, 140, BLOOD, false, 30)), dimIron(BLOOD.iron, BLOOD.bg)]);
		const lines = render(view, 140, BLOOD, true, 30);
		const [even, odd] = [0, 1].map(p => new Set(seqs(lines.filter((_, i) => i % 2 === p)).filter(s => !palette0.has(s))));
		expect([even.size, odd.size]).toEqual([4, 4]); // the scanline parity: the shades on the even lines, the twins on the odd ones
		for (const o of odd) {
			expect(even.has(o)).toBe(false);
			expect([...even].some(e => rgbOf(e).every((x, c) => Math.round(x * 0.85) === rgbOf(o)[c]))).toBe(true);
		}
		const [gold, brass] = [rgbOf(BLOOD.gold), [0x8c, 0x6a, 0x2a]];
		const dist = (a: number[], b: number[]) => Math.hypot(...a.map((x, c) => x - b[c]));
		const shades = [...even].map(rgbOf).sort((x, y) => dist(x, gold) - dist(y, gold));
		for (const s of shades) s.forEach((x, c) => expect(x).toBeWithin(Math.min(gold[c], brass[c]), Math.max(gold[c], brass[c]) + 1));
		expect(dist(shades[0], gold)).toBeLessThan(dist(shades[0], brass));
	});

	test("wear and scratch density: worn cells are a minority of the run cells, scratches between 1 in 200 and 1 in 80 blank cells", () => {
		let worn = 0;
		let run = 0;
		let blank = 0;
		let marks = 0;
		for (let k = 0; k < 60; k++) {
			const view = cockpitView(DETAIL({ key: `dens-${k}`, chronicle: many(2) }));
			const on = render(view, 140, BLOOD, true, 50).map(plain);
			const off = render(view, 140, BLOOD, false, 50).map(plain);
			on.forEach((l, i) => {
				const [a, b] = [[...l], [...off[i]]];
				a.forEach((c, j) => {
					if ("╍┅╌┄".includes(c)) worn++;
					if ("═─".includes(b[j]) && c !== "•") run++;
					if (b[j] === " ") blank++;
					if ("╱╲·".includes(c) && b[j] === " " && !"╱╲".includes(a[j - 1] ?? "")) marks++;
				});
			});
		}
		expect(worn / run).toBeGreaterThan(0.02);
		expect(worn / run).toBeLessThan(0.2);
		expect(marks / blank).toBeGreaterThan(1 / 200);
		expect(marks / blank).toBeLessThan(1 / 80);
	});
});
