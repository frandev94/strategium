import { describe, expect, test } from "bun:test";
import {
	closes,
	cockpitView,
	colorDepth,
	grantedSeals,
	jobEnds,
	palette,
	pushEntry,
	renderCockpit,
	renderWidget,
	sealsFrom,
	type Entry,
	type Phase,
	type ViewInput,
} from "./cockpit";

const TRUE = palette("truecolor");
const GOLD = "\x1b[38;2;201;162;39m";
const PURPLE = "38;2;123;44;191";
const RED = "38;2;164;22;26";
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const phases = (...tasks: [string, string][]): Phase[] => [{ name: "Plan", tasks: tasks.map(([content, status]) => ({ content, status })) }];
const input = (over: Partial<ViewInput> = {}): ViewInput => ({ key: "K-1", notes: {}, chronicle: [], ...over });
const text = (over: Partial<ViewInput> = {}, width = 100) => plain(renderCockpit(cockpitView(input(over)), width, 0, TRUE).join("\n"));

describe("seals", () => {
	test("sealsFrom reads bracket and glyph tags with their three states", () => {
		const seals = sealsFrom(phases(["[seal] Plan", "completed"], ["\u{f047a} seal · UI", "in_progress"], ["[seal] Ship", "pending"], ["[builder] x", "pending"]));
		expect(seals).toEqual([
			{ id: "Plan", name: "Plan", state: "granted" },
			{ id: "UI", name: "UI", state: "waiting" },
			{ id: "Ship", name: "Ship", state: "pending" },
		]);
	});

	test("UI (2) stays distinct from UI and its name is the first word", () => {
		const seals = sealsFrom(phases(["[seal] UI", "pending"], ["[seal] UI (2)", "pending"]));
		expect(seals.map(s => s.id)).toEqual(["UI", "UI (2)"]);
		expect(seals[1].name).toBe("UI");
	});

	test.each([
		["no before", undefined, phases(["[seal] Plan", "completed"]), []],
		["pending to completed", phases(["[seal] Plan", "pending"]), phases(["[seal] Plan", "completed"]), ["Plan"]],
		["waiting to completed", phases(["[seal] Plan", "in_progress"]), phases(["[seal] Plan", "completed"]), ["Plan"]],
		["completed to completed", phases(["[seal] Plan", "completed"]), phases(["[seal] Plan", "completed"]), []],
		["first seen completed", phases(["[builder] x", "pending"]), phases(["[builder] x", "pending"], ["[seal] Plan", "completed"]), []],
	])("grantedSeals: %s", (_n, before, after, names) => {
		expect(grantedSeals(before, after).map(s => s.name)).toEqual(names);
	});
});

describe("view", () => {
	test("role boxes: active, done and idle", () => {
		const active = text({ phases: phases(["[librarian] mapping the repo", "in_progress"]) });
		expect(active).toContain("▶ mapping the repo");
		const done = text({ phases: phases(["[apothecary] first", "completed"], ["[apothecary] last one", "completed"]) });
		expect(done).toContain("✓ last one");
		const idle = text();
		expect(idle).toContain("○ standing by");
		expect(idle).toContain("○ awaiting judgement");
	});

	test("role tasks in glyph form are found and lose their tag", () => {
		expect(text({ phases: phases(["\u{f0e0b} inquisitor · judging", "in_progress"]) })).toContain("▶ judging");
	});

	test.each([
		["seal", { station: "Plan", seal: "Plan" }, "◷ seal Plan awaits you"],
		["return", { station: "Forge", back: true as const, task: "redo" }, "↶ Forge › redo"],
		["station", { station: "Forge", task: "build" }, "▶ Forge › build"],
		["none", undefined, "○ awaiting orders"],
	])("strategos: %s", (_n, where, expected) => {
		expect(text({ where })).toContain(expected);
	});

	test("squad boxes in declared order with their states", () => {
		const t = text({
			slices: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
			stopped: [{ id: "c" }],
			agents: { x1: { id: "a" } },
			notes: { b: { failed: true }, d: { veteran: true } },
		});
		expect(t).toContain("SQUAD a");
		expect(t).toContain("▶ forging");
		expect(t).toContain("✗ failed");
		expect(t).toContain("✓ returned");
		expect(t).toContain("◌ awaiting deployment");
		expect(t).toContain("‡ VETERAN");
		expect(t.indexOf("SQUAD a")).toBeLessThan(t.indexOf("SQUAD d"));
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
	test("pushEntry keeps the newest 20, newest last", () => {
		let list: Entry[] = [];
		for (let i = 0; i < 25; i++) list = pushEntry(list, { at: "10:00", who: "X", text: String(i) });
		expect(list).toHaveLength(20);
		expect(list[0].text).toBe("5");
		expect(list[19].text).toBe("24");
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
});

describe("keys", () => {
	test.each([["\x1b", true], ["\x1b[27u", true], ["q", true], ["a", false]])("closes(%j) is %p", (data, expected) => {
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
		expect(palette("truecolor").gold).toBe(GOLD);
		expect(palette("256").gold.startsWith("\x1b[38;5;")).toBe(true);
		expect(palette("256").gold).not.toContain("38;2;");
	});
});

const busy = (): ViewInput =>
	input({
		clock: { running: true, el: 42, bk: 120 },
		where: { station: "Forge", task: "build" },
		phases: phases(["[seal] Plan", "completed"], ["[seal] UI", "pending"], ["[inquisitor] judging", "in_progress"]),
		slices: [{ id: "a" }, { id: "b" }],
		notes: { b: { failed: true } },
		agents: { x: { id: "a" } },
		chronicle: [1, 2, 3, 4, 5].map(i => ({ at: `10:0${i}`, who: "SQUAD a", text: `event ${i}` })),
	});

describe("rendering", () => {
	test.each([30, 60, 120])("widget at %i is at most 6 lines, newest 3 entries first, each within the width", width => {
		const lines = renderWidget(cockpitView(busy()), width, TRUE);
		expect(lines.length).toBeLessThanOrEqual(6);
		for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width);
		if (width === 120) {
			const t = plain(lines.join("\n"));
			expect(t).toContain("K-1");
			expect(t.indexOf("event 5")).toBeLessThan(t.indexOf("event 4"));
			expect(t.indexOf("event 4")).toBeLessThan(t.indexOf("event 3"));
			expect(t).not.toContain("event 2");
		}
	});

	test("widget leaves the squad line out while no squad is declared", () => {
		expect(renderWidget(cockpitView(input()), 80, TRUE).length).toBe(2);
	});

	test("overlay at 100 draws every box and the truecolor palette", () => {
		const view = cockpitView(busy());
		const out = renderCockpit(view, 100, 0, TRUE);
		const t = plain(out.join("\n"));
		for (const w of ["STRATEGOS", "LIBRARIAN", "APOTHECARY", "INQUISITOR", "SQUAD a", "SQUAD b", "SEALS", "CHRONICLE", "COGITATOR"]) expect(t).toContain(w);
		expect(out.join("\n")).toContain(GOLD);
		expect(out.find(l => l.includes("INQUISITOR"))).toContain(PURPLE);
		expect(out.find(l => l.includes("SQUAD b"))).toContain(RED);
		expect(out.filter(l => l.includes("event")).length).toBeLessThanOrEqual(8);
	});

	test("the 256 palette has no truecolor sequence but has gold's index", () => {
		const out = renderCockpit(cockpitView(busy()), 100, 0, palette("256")).join("\n");
		expect(out).not.toContain("38;2;");
		expect(out).toContain(palette("256").gold);
	});

	test("width 50 is stacked: one line per box, no frame", () => {
		const t = plain(renderCockpit(cockpitView(busy()), 50, 0, TRUE).join("\n"));
		expect(t).not.toContain("╔");
		expect(t).toMatch(/^STRATEGOS ▶ Forge › build$/m);
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

describe("overlay close hint, cut box titles, widget station", () => {
	test("the overlay says how to close it, framed or stacked, and never overflows", () => {
		expect(text({}, 100)).toContain("esc/q close");
		expect(text({}, 50)).toContain("esc/q close");
		for (const width of [30, 50, 72, 120])
			for (const l of renderCockpit(cockpitView(input()), width, 0, TRUE)) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width);
	});

	test("a cut box title keeps the border coloured to its corner", () => {
		const slices = ["a", "b", "c"].map(c => ({ id: c.repeat(30) }));
		const tops = renderCockpit(cockpitView(input({ slices })), 100, 0, TRUE).join("\n").match(/┌[^┐]*┐/g)!;
		expect(tops.some(t => t.includes("SQUAD aaa") && !t.includes("a".repeat(30)))).toBe(true);
		for (const t of tops) expect(t).not.toContain("\x1b[39m");
	});

	test("the widget's strategos with a station and no task is just the station", () => {
		expect(plain(renderWidget(cockpitView(input({ where: { station: "Forge" } })), 80, TRUE)[1])).toBe("☩ Forge");
	});
});

describe("jobEnds, squads, bar, seals, layout and chronicle edge cases", () => {
	test("jobEnds skips task jobs whose label is not a string", () => {
		const jobs = [{ type: "task", status: "completed" }, { type: "task", label: 7, status: "failed" }, { type: "task", label: "ok", status: "failed" }];
		expect(jobEnds([{ details: { jobs } }])).toEqual([{ id: "ok", status: "failed" }]);
	});

	test("strategos with a station and no task shows just the station", () => {
		const t = text({ where: { station: "Forge" } });
		expect(t).toContain("▶ Forge");
		expect(t).not.toContain("undefined");
		expect(t).not.toContain("Forge ›");
	});

	test("squad precedence: an agent beats failed, failed beats stopped", () => {
		const row = (over: Partial<ViewInput>) => text({ slices: [{ id: "a" }], ...over });
		const forging = row({ agents: { x: { id: "a" } }, notes: { a: { failed: true } } });
		expect(forging).toContain("▶ forging");
		expect(forging).not.toContain("✗ failed");
		const failed = row({ stopped: [{ id: "a" }], notes: { a: { failed: true } } });
		expect(failed).toContain("✗ failed");
		expect(failed).not.toContain("✓ returned");
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

	test("no seals shows a dash in the overlay and the widget", () => {
		const view = cockpitView(input());
		expect(renderWidget(view, 80, TRUE)[0]).toContain(`${IRON}—`);
		expect(text()).toMatch(/SEALS —/);
	});

	test("seal symbols and tones: granted gold ✠, waiting gold ○, pending iron ○", () => {
		const p = phases(["[seal] A", "completed"], ["[seal] B", "in_progress"], ["[seal] C", "pending"]);
		const head = renderWidget(cockpitView(input({ phases: p })), 80, TRUE)[0];
		expect(head).toContain(`${GOLD}✠\x1b[39m${GOLD}○\x1b[39m${IRON}○\x1b[39m`);
		expect(text({ phases: p })).toContain("✠ A  ○ B  ○ C");
	});

	test.each([
		["station", { station: "Forge", task: "build" }, "☩ Forge › build"],
		["return", { station: "Forge", back: true as const, task: "redo" }, "☩ ↶ Forge › redo"],
		["seal", { station: "Plan", seal: "Plan" }, "☩ ◷ seal Plan"],
		["none", undefined, "☩ ○ awaiting orders"],
	])("widget strategos line: %s", (_n, where, expected) => {
		expect(plain(renderWidget(cockpitView(input({ where })), 80, TRUE)[1])).toBe(expected);
	});

	test("width 71 is stacked, 72 is framed", () => {
		expect(text({}, 71)).not.toContain("╔");
		expect(text({}, 72)).toContain("╔");
	});

	test("stacked chronicle shows exactly the 8 newest, newest first", () => {
		const lines = eventLines(renderCockpit(cockpitView(input({ chronicle: many(10) })), 50, 0, TRUE));
		expect(lines).toHaveLength(8);
		expect(lines[0]).toContain("event 10");
		expect(lines[7]).toContain("event 3");
	});

	test("wide chronicle shows exactly the 8 newest, newest first", () => {
		const lines = eventLines(renderCockpit(cockpitView(input({ chronicle: many(10) })), 100, 0, TRUE));
		expect(lines).toHaveLength(8);
		expect(lines[0]).toContain("event 10");
		expect(lines[7]).toContain("event 3");
	});

	test("widget with a full fixture is exactly 6 lines and shows 3 entries", () => {
		const lines = renderWidget(cockpitView({ ...busy(), chronicle: many(10) }), 120, TRUE);
		expect(lines).toHaveLength(6);
		expect(eventLines(lines)).toHaveLength(3);
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

describe("glyphs", () => {
	const states: [string, Partial<ViewInput>][] = [
		["veteran", { slices: [{ id: "a" }], notes: { a: { veteran: true } } }],
		["failed", { slices: [{ id: "a" }], notes: { a: { failed: true } } }],
		["seal waiting", { where: { station: "Plan", seal: "Plan" }, phases: phases(["[seal] Plan", "in_progress"]) }],
		["return", { where: { station: "Forge", back: true, task: "redo" } }],
		["timed", { clock: { running: true, el: 42, bk: 120 } }],
		["untimed", { untimed: true, clock: { running: true, el: 42 } }],
	];
	// ▶ is Extended_Pictographic but has text presentation without U+FE0F: the user's terminal draws it one cell wide.
	const emoji = (s: string) => s.replaceAll("▶", "").match(/\p{Extended_Pictographic}/gu) ?? [];

	test.each(states.flatMap(([n, o]) => [50, 100].flatMap(w => [false, true].map(g => [n, o, w, g] as const))))(
		"%s at width %i (nerd %p) has no emoji and fits",
		(_n, over, width, glyphs) => {
			const view = cockpitView(input({ ...over, glyphs }));
			for (const l of [...renderWidget(view, width, TRUE), ...renderCockpit(view, width, 0, TRUE), ...renderCockpit(view, width, 1, TRUE)]) {
				expect(emoji(l)).toEqual([]);
				expect(Bun.stringWidth(l)).toBeLessThanOrEqual(width);
			}
		},
	);

	test("plain mode uses † ‡ ◷", () => {
		expect(text({ slices: [{ id: "a" }, { id: "b" }], notes: { b: { veteran: true } } })).toMatch(/† brother[\s\S]*‡ VETERAN/);
		expect(plain(renderWidget(cockpitView(input({ where: { station: "Plan", seal: "Plan" } })), 80, TRUE)[1])).toBe("☩ ◷ seal Plan");
	});

	test("nerd mode uses the todo.ts role glyphs, each followed by an extra space", () => {
		const t = plain(renderCockpit(cockpitView(input({ glyphs: true, slices: [{ id: "a" }, { id: "b" }], notes: { b: { veteran: true } }, where: { station: "Plan", seal: "Plan" } })), 100, 0, TRUE).join("\n"));
		for (const g of ["\u{f18bc}", "\u{f18be}", "\u{f0787}", "\u{f05da}", "\u{f06ef}", "\u{f029b}", "\u{f051f}"]) expect(t).toContain(`${g}  `);
		expect(t).not.toMatch(/[☩†‡◷]/);
	});
});
