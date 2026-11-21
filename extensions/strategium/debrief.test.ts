import { describe, expect, test } from "bun:test";
import { type DebriefInput, debrief, splitMinutes, stationTimes } from "./debrief";
import { type Ev, lockPath, nowIso, safeName } from "./timer";

const base = new Date(2026, 10, 16, 9, 0, 0);
const t = (min: number) => nowIso(new Date(base.getTime() + min * 60_000));
const at = (min: number) => new Date(base.getTime() + min * 60_000);
const MIN = 60_000;

const start = (m: number, extra: Partial<Ev> = {}): Ev => ({ ts: t(m), event: "start", key: "K", ...extra });
const stop = (m: number): Ev => ({ ts: t(m), event: "stop", key: "K" });
const station = (m: number, name: string): Ev => ({ ts: t(m), event: "station", key: "K", station: name });
const seal = (m: number, id: string, state: "asked" | "granted"): Ev => ({ ts: t(m), event: "seal", key: "K", seal: id, state });
const spawn = (m: number, role: string, extra: Partial<Ev> = {}): Ev => ({ ts: t(m), event: "spawn", key: "K", role, ...extra });

const input = (evs: Ev[], extra: Partial<DebriefInput> = {}): DebriefInput => ({
	key: "K",
	theatre: "github",
	since: t(0),
	end: at(60),
	evs,
	squads: [],
	notes: {},
	...extra,
});

const section = (md: string, title: string) => md.split(`## ${title}\n`)[1]?.split("\n## ")[0] ?? "";

describe("safeName", () => {
	test("keeps the lock name", () => {
		expect(lockPath("/d", "A/B").endsWith(`${safeName("A/B")}.lock`)).toBe(true);
		expect(safeName("A/B")).toMatch(/^A_B-[0-9a-f]{8}$/);
		expect(safeName("A/B")).not.toBe(safeName("A_B"));
	});
});

describe("splitMinutes", () => {
	test("largest remainder sums to the rounded total", () => {
		expect(splitMinutes([20_000, 20_000, 20_000])).toEqual([1, 0, 0]);
		expect(splitMinutes([])).toEqual([]);
		expect(splitMinutes([0, 0])).toEqual([0, 0]);
		expect(splitMinutes([10_000, 50_000])).toEqual([0, 1]);
	});
});

describe("stationTimes", () => {
	test("a paused span lands in the station it fell in", () => {
		const evs = [start(0), station(0, "Muster"), stop(10), start(20), station(30, "Auspex"), stop(40)];
		const rows = stationTimes(evs, "K", at(60));
		expect(rows).toEqual([
			{ station: "Muster", activeMs: 20 * MIN, pausedMs: 10 * MIN },
			{ station: "Auspex", activeMs: 10 * MIN, pausedMs: 20 * MIN },
		]);
	});

	test("time before the first station goes to its own row, and a return adds to the same row", () => {
		const evs = [start(0), station(5, "A"), station(10, "B"), station(15, "A"), stop(20)];
		const rows = stationTimes(evs, "K", at(60));
		expect(rows.map(r => [r.station, r.activeMs / MIN, r.pausedMs / MIN])).toEqual([
			["(before the todo)", 5, 0],
			["A", 10, 40],
			["B", 5, 0],
		]);
	});

	test("an open span runs to the end; no stations is all before the todo; other keys ignored", () => {
		const other: Ev = { ts: t(1), event: "station", key: "Z", station: "X" };
		expect(stationTimes([start(0), other], "K", at(30))).toEqual([{ station: "(before the todo)", activeMs: 30 * MIN, pausedMs: 0 }]);
		expect(stationTimes([], "K", at(30))).toEqual([]);
	});
});

describe("properties (seeded)", () => {
	const rng = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

	test("stations sum to the span time, active+paused is the wall time, splitMinutes is exact", () => {
		for (let seed = 1; seed <= 300; seed++) {
			const r = rng(seed);
			const names = ["A", "B", "C"];
			const evs: Ev[] = [];
			let m = Math.floor(r() * 5);
			const n = 1 + Math.floor(r() * 12);
			for (let i = 0; i < n; i++) {
				const k = r();
				evs.push(k < 0.35 ? start(m) : k < 0.6 ? stop(m) : station(m, names[Math.floor(r() * 3)]));
				m += Math.floor(r() * 15);
			}
			const endMin = m + Math.floor(r() * 10);
			const end = at(endMin);
			const rows = stationTimes(evs, "K", end);
			const first = Math.min(...evs.map(e => new Date(e.ts).getTime()));
			// oracle: walk minute by minute
			let open = false;
			let oracle = 0;
			let firstMin = (first - base.getTime()) / MIN;
			let wall = 0;
			for (let x = firstMin; x < endMin; x++) {
				for (const e of evs) {
					if ((new Date(e.ts).getTime() - base.getTime()) / MIN !== x) continue;
					if (e.event === "start") open = true;
					if (e.event === "stop") open = false;
				}
				if (open) oracle += MIN;
				wall += MIN;
			}
			const active = rows.reduce((s, x) => s + x.activeMs, 0);
			expect(active).toBe(oracle);
			expect(rows.reduce((s, x) => s + x.activeMs + x.pausedMs, 0)).toBe(wall);
			for (const row of rows) expect(row.activeMs + row.pausedMs).toBeGreaterThanOrEqual(0);
			const ms = rows.map(x => x.activeMs + (r() < 0.5 ? Math.floor(r() * MIN) : 0));
			const parts = splitMinutes(ms);
			expect(parts.reduce((a, b) => a + b, 0)).toBe(Math.round(ms.reduce((a, b) => a + b, 0) / MIN));
			parts.forEach((p, i) => expect(Math.abs(p - ms[i] / MIN)).toBeLessThanOrEqual(1));
		}
	});

	test("each station's active+paused equals its wall interval", () => {
		const evs = [start(0), station(2, "A"), stop(5), start(9), station(12, "B"), station(20, "A"), stop(21)];
		const rows = stationTimes(evs, "K", at(30));
		expect(rows.map(r => [r.station, (r.activeMs + r.pausedMs) / MIN])).toEqual([
			["(before the todo)", 2],
			["A", 10 + 10],
			["B", 8],
		]);
	});
});

describe("debrief markdown", () => {
	const evs = [
		start(0, { prior: 30 }),
		station(0, "Muster"),
		station(10, "Scriptorium"),
		seal(15, "plan", "asked"),
		seal(20, "plan", "asked"),
		seal(26, "plan", "granted"),
		stop(30),
		start(40),
		spawn(41, "scout", { model: "default" }),
		spawn(42, "battle-brother", { tier: "light", squad: "A", model: "@smol:medium" }),
		spawn(43, "battle-brother", { tier: "light", squad: "A", model: "@smol:medium" }),
		spawn(44, "veteran", { squad: "A", model: "@slow:high" }),
		{ ts: t(45), event: "adjust", key: "K", prior: 5 } as Ev,
	];
	const out = debrief(
		input(evs, {
			squads: [
				{ id: "A", tier: "light", state: "stopped" },
				{ id: "B", state: "not built" },
			],
			notes: { A: { failed: true } },
			end: at(50),
		}),
	);

	test("whole document", () => {
		expect(out.markdown).toBe(
			[
				"# Debrief K",
				"",
				"Theatre github · 11-16 09:00 → 11-16 09:50 · plugin numbers are exact except the Model requested column; (reported) sections come from the agents.",
				"",
				"## Time per station",
				"",
				"| Station | Active (min) | Paused (min) |",
				"|---|---|---|",
				"| Muster | 10 | 0 |",
				"| Scriptorium | 30 | 10 |",
				"| Total | 40 | 10 |",
				"",
				"Prior estimate 30 min, added by hand 5 min: worked 75 min.",
				"",
				"## Seals",
				"",
				"| Seal | Asked | Granted | Wait (min) |",
				"|---|---|---|---|",
				"| plan | 11-16 09:20 | 11-16 09:26 | 6 |",
				"",
				"## Squads",
				"",
				"| Squad | Tier | Builder runs | Penances | Veteran runs | Last result | State |",
				"|---|---|---|---|---|---|---|",
				"| A | light | 2 | 1 | 1 | failed | stopped |",
				"| B | — | 0 | 0 | 0 | — | not built |",
				"",
				"## Agents spawned",
				"",
				"| Role | Spawns |",
				"|---|---|",
				"| battle-brother | 2 |",
				"| scout | 1 |",
				"| veteran | 1 |",
				"| Total | 4 |",
				"",
				"| Model requested | Spawns |",
				"|---|---|",
				"| @smol:medium | 2 |",
				"| @slow:high | 1 |",
				"| default | 1 |",
				"| Total | 4 |",
				"",
				"Model requested: the selector Strategium asked of the host; the host may run another.",
				"",
				"## Apothecary (reported)",
				"",
				"Not reported.",
				"",
				"## Review (reported)",
				"",
				"Not reported.",
				"",
			].join("\n"),
		);
	});

	test("summary lines", () => {
		expect(out.summary).toEqual([
			"TIME 40 min active, 10 min paused: Muster 10, Scriptorium 30",
			"SEALS plan 6m",
			"SPAWNS 4: battle-brother 2, scout 1, veteran 1",
		]);
	});

	test("reported numbers render only in the reported sections, missing fields as a dash", () => {
		const r = debrief(
			input([start(0)], {
				reported: { apothecary: { killed: 7, survived: 2 }, review: { pass: 3, fail: 1, opened: 4, fixed: 4, not_reproduced: 0 } },
			}),
		);
		expect(section(r.markdown, "Apothecary (reported)")).toBe("\n| Mutants killed | Survivors | Fuzz crashes |\n|---|---|---|\n| 7 | 2 | — |\n");
		expect(section(r.markdown, "Review (reported)")).toContain("| 3 | 1 | 4 | 4 | 0 |");
		expect(r.markdown.replace(section(r.markdown, "Apothecary (reported)"), "").replace(section(r.markdown, "Review (reported)"), "")).not.toContain("| 7 |");
	});

	test("no since and no seals or squads", () => {
		const r = debrief(input([start(0)], { since: undefined }));
		expect(r.markdown).toContain("Theatre github · today (start not recorded) → 11-16 10:00 ·");
		expect(section(r.markdown, "Seals")).toBe("\nNone.\n");
		expect(section(r.markdown, "Squads")).toBe("\nNone.\n");
		expect(r.summary[1]).toBe("SEALS none");
	});

	test("a seal with no asked event shows a dash", () => {
		const r = debrief(input([start(0), seal(5, "mr", "granted")]));
		expect(section(r.markdown, "Seals")).toContain("| mr | — | 11-16 09:05 | — |");
	});

	test("untrusted names cannot break a table", () => {
		const evil = "a|b\nc\u001b[31mred\u001b[0m\r| x ";
		const r = debrief(
			input([start(0), station(0, evil), seal(1, evil, "granted"), spawn(2, evil, { model: evil })], {
				key: "K",
				squads: [{ id: evil, tier: evil, state: "running" }],
			}),
		);
		const cells = (l: string) => l.replace(/\\\|/g, "").split("|").length;
		expect(r.markdown).not.toContain("\u001b");
		expect(r.markdown).toContain("a\\|b cred");
		const lines = r.markdown.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (!lines[i + 1]?.startsWith("|---")) continue;
			const width = cells(lines[i]);
			for (let j = i; lines[j]?.startsWith("|"); j++) expect(cells(lines[j])).toBe(width);
		}
		expect(r.summary.every(l => !l.includes("\n"))).toBe(true);
	});

	test("a backslash before a pipe cannot unescape it", () => {
		const r = debrief(input([start(0), station(0, "a\\|b")]));
		expect(r.markdown).toContain("| a\\\\\\|b |");
	});

	test("a station row with 0 active and 0 paused minutes is skipped, in the table and the summary", () => {
		const r = debrief(input([start(0), station(0, "Empty"), station(0, "Work"), stop(10)], { end: at(10) }));
		expect(r.markdown).not.toContain("Empty");
		expect(r.markdown).toContain("| Work | 10 | 0 |");
		expect(r.markdown).toContain("| Total | 10 | 0 |");
		expect(r.summary[0]).toBe("TIME 10 min active, 0 min paused: Work 10");
	});

	test("asked, granted, asked again pairs the grant with the ask before it", () => {
		const r = debrief(input([start(0), seal(5, "mr", "asked"), seal(8, "mr", "granted"), seal(20, "mr", "asked")]));
		expect(section(r.markdown, "Seals")).toContain("| mr | 11-16 09:05 | 11-16 09:08 | 3 |");
	});

	test("Squads shows the tiers actually used, in order, and the planned tier when none was recorded", () => {
		const r = debrief(
			input(
				[
					start(0),
					spawn(1, "battle-brother", { tier: "light", squad: "A" }),
					spawn(2, "battle-brother", { tier: "standard", squad: "A" }),
					spawn(3, "veteran", { tier: "heavy", squad: "A" }),
				],
				{ squads: [{ id: "A", tier: "light", state: "stopped" }, { id: "B", tier: "standard", state: "not built" }] },
			),
		);
		expect(r.markdown).toContain("| A | light→standard→heavy | 2 | 1 | 1 |");
		expect(r.markdown).toContain("| B | standard | 0 | 0 | 0 |");
	});

	test("builder spawns with no squad render as an (unmatched) row", () => {
		const r = debrief(
			input([start(0), spawn(1, "battle-brother"), spawn(2, "battle-brother"), spawn(3, "veteran"), spawn(4, "scout")], {
				squads: [{ id: "A", state: "running" }],
			}),
		);
		expect(r.markdown).toContain("| (unmatched) | — | 2 | 1 | 1 | — | — |");
		const none = debrief(input([start(0), spawn(1, "scout")]));
		expect(none.markdown).not.toContain("(unmatched)");
	});

	test("long names are cut at 60 characters", () => {
		const r = debrief(input([start(0), station(0, "x".repeat(200))]));
		expect(r.markdown).toContain(`| ${"x".repeat(60)} |`);
		expect(r.markdown).not.toContain("x".repeat(61));
	});
});
