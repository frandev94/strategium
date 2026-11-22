import { describe, expect, test } from "bun:test";
import { usd } from "./cockpit";
import { type AgentCost, type DebriefInput, debrief, splitMinutes, stationTimes } from "./debrief";
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
				"## Cost",
				"",
				"Costs are omp's list-price estimates: each agent's own spend as omp prices it (its cost minus its nested subagents', computed as omp's agent view computes it). Tokens include nested subagents'; cost does not. Agents only: the Captain's own session is not included. A subscription plan pays differently. ?: no usage recorded, or a model without a price in omp.",
				"",
				"None.",
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
			"COST none",
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

describe("cost", () => {
	const ag = (id: string, role: string, extra: Partial<AgentCost> = {}): AgentCost => ({ id, role, ...extra });
	const cost = (agents: AgentCost[], evs: Ev[] = [start(0)]) => debrief(input(evs, { agents }));
	const lines = (md: string) => section(md, "Cost").split("\n");
	const rolesTable = (md: string) => lines(md).slice(lines(md).findIndex(l => l.startsWith("| Role | Agents")) + 2);

	test("the note says list-price estimates, subscription and ?", () => {
		const md = cost([ag("A", "scout", { cost: 1 })]).markdown;
		expect(section(md, "Cost")).toContain("Costs are omp's list-price estimates");
		expect(section(md, "Cost")).toContain("A subscription plan pays differently.");
		expect(section(md, "Cost")).toContain("?: no usage recorded, or a model without a price in omp.");
		expect(md.indexOf("## Cost")).toBeGreaterThan(md.indexOf("## Agents spawned"));
		expect(md.indexOf("## Cost")).toBeLessThan(md.indexOf("## Apothecary (reported)"));
	});

	test("per-agent rows carry tokens and cache, and an unknown agent shows ? cells", () => {
		const md = cost([
			ag("Alpha", "battle-brother", { squad: "a", cost: 0.42, tokens_in: 120000, tokens_out: 9000, cache_read: 800000, cache_write: 5 }),
			ag("Scout1", "scout", { cost: 0.07, tokens_in: 30000, tokens_out: 2000, cache_write: 7 }),
			ag("Insp", "inquisitor"),
		]).markdown;
		expect(md).toContain("| Agent | Role | Squad | Tokens in | Tokens out | Cache | Cost |");
		expect(md).toContain("| Alpha | battle-brother | a | 120000 | 9000 | 800005 | $0.42 |");
		expect(md).toContain("| Scout1 | scout | — | 30000 | 2000 | 7 | $0.07 |");
		expect(md).toContain("| Insp | inquisitor | — | ? | ? | ? | ? |");
	});

	test("per-role totals add the raw floats and round once: three at 0.004 is $0.01", () => {
		const md = cost([ag("A", "scout", { cost: 0.004 }), ag("B", "scout", { cost: 0.004 }), ag("C", "scout", { cost: 0.004 })]).markdown;
		expect(md).toContain("| scout | 3 | $0.01 | ██████████ |");
		expect(md).toContain("| Total (agents) | 3 | $0.01 | — |");
	});

	test("a role of unknown agents prints ?, a mixed role prints $x + ?", () => {
		const md = cost([ag("A", "scout"), ag("B", "scout", { cost: Number.NaN }), ag("C", "inquisitor", { cost: 1 }), ag("D", "inquisitor"), ag("E", "veteran", { cost: 2 })]).markdown;
		expect(md).toContain("| scout | 2 | ? |  |");
		expect(md).toContain("| inquisitor | 2 | $1.00 + ? | █████ |");
		expect(md).toContain("| veteran | 1 | $2.00 | ██████████ |");
		expect(md).toContain("| Total (agents) | 5 | $3.00 + ? | — |");
		expect(md).not.toContain("$0.00");
	});

	test("every agent unknown: the total is ?", () => {
		const md = cost([ag("A", "scout")]).markdown;
		expect(md).toContain("| Total (agents) | 1 | ? | — |");
		expect(md).not.toContain("$");
	});

	test("bars: 10 cells for the top role, rounded for the rest, sorted by cost then name", () => {
		const md = cost([ag("A", "b", { cost: 4 }), ag("B", "a", { cost: 1 }), ag("C", "c", { cost: 4 }), ag("D", "d", { cost: 0.2 })]).markdown;
		const rows = rolesTable(md);
		expect(rows.slice(0, 4)).toEqual(["| b | 1 | $4.00 | ██████████ |", "| c | 1 | $4.00 | ██████████ |", "| a | 1 | $1.00 | ███ |", "| d | 1 | $0.20 | █ |"]);
	});

	test("no agents: None. and COST none", () => {
		const r = cost([]);
		expect(section(r.markdown, "Cost")).toContain("None.");
		expect(r.summary.at(-1)).toBe("COST none");
		expect(debrief(input([start(0)])).summary.at(-1)).toBe("COST none");
	});

	test("the COST summary line: total, then each role", () => {
		const r = cost([ag("A", "scout", { cost: 0.5 }), ag("B", "inquisitor", { cost: 1.25 }), ag("C", "scout")]);
		expect(r.summary.at(-1)).toBe("COST (agents, list price) $1.75 + ? · inquisitor $1.25, scout $0.50 + ?");
	});

	test("cost per booked hour sums each day's booking: 60 + 60 min is B = 120", () => {
		const evs = [start(0, { booked: 60 }), stop(30), start(1440, { booked: 60 }), stop(1470)];
		const r = debrief({ ...input(evs, { agents: [ag("A", "scout", { cost: 3 })] }), end: at(1500) });
		expect(r.markdown).toContain("Cost per booked hour: $1.50 (agents only; total $3.00 over 120 booked min)");
		expect(r.summary.at(-1)).toBe("COST (agents, list price) $3.00 · scout $3.00 · $1.50/booked h");
	});

	test("with an unknown agent the rate says known agents only", () => {
		const r = cost([ag("A", "scout", { cost: 3 }), ag("B", "scout")], [start(0, { booked: 120 })]);
		expect(r.markdown).toContain("Cost per booked hour: $1.50 (agents only; total $3.00 + ? over 120 booked min; known agents only)");
	});

	test("an untimed run has no rate line; neither has one with nothing known", () => {
		expect(cost([ag("A", "scout", { cost: 3 })]).markdown).not.toContain("Cost per booked hour");
		expect(cost([ag("A", "scout")], [start(0, { booked: 60 })]).markdown).not.toContain("Cost per booked hour");
		expect(cost([ag("A", "scout", { cost: 3 })]).summary.at(-1)).not.toContain("booked h");
	});

	test("huge finite costs are unknown, not a thrown report", () => {
		const r = cost([ag("A", "scout", { cost: 1e308 }), ag("B", "scout", { cost: 1 }), ag("C", "veteran", { cost: 1e6 + 1 })]);
		expect(r.markdown).toContain("| A | scout | — | ? | ? | ? | ? |");
		expect(r.markdown).toContain("| scout | 2 | $1.00 + ? |");
		expect(cost([ag("A", "scout", { cost: 1e6 }), ag("B", "scout", { cost: 1e6 })]).markdown).toContain("| scout | 2 | $2000000.00 |");
	});

	test("per-agent costs under a cent keep a third decimal so the rows add up", () => {
		const md = cost([ag("A", "scout", { cost: 0.004 }), ag("B", "scout", { cost: 0.0001 }), ag("C", "scout", { cost: 0 })]).markdown;
		expect(md).toContain("| A | scout | — | ? | ? | ? | $0.004 |");
		expect(md).toContain("| B | scout | — | ? | ? | ? | <$0.001 |");
		expect(md).toContain("| C | scout | — | ? | ? | ? | $0.00 |");
	});

	test("a role with a known cost above zero gets at least one bar block", () => {
		const md = cost([ag("A", "big", { cost: 100 }), ag("B", "tiny", { cost: 0.5 }), ag("C", "zero", { cost: 0 })]).markdown;
		expect(md).toContain("| tiny | 1 | $0.50 | █ |");
		expect(md).toContain("| zero | 1 | $0.00 |  |");
	});

	test("the COST summary names the roles as the table does, capped at 60", () => {
		const long = "r".repeat(80);
		const s = cost([ag("A", "Total", { cost: 1 }), ag("B", long, { cost: 2 })]).summary.at(-1)!;
		expect(s).toContain("Total (role) $1.00");
		expect(s).toContain(`${"r".repeat(60)} $2.00`);
		expect(s).not.toContain("r".repeat(61));
	});

	test("the rate line has one parenthesis", () => {
		const r = cost([ag("A", "scout", { cost: 3 }), ag("B", "scout")], [start(0, { booked: 120 })]);
		expect(r.markdown).toContain("Cost per booked hour: $1.50 (agents only; total $3.00 + ? over 120 booked min; known agents only)");
	});

	test("the note uses one apostrophe style", () => {
		expect(section(cost([ag("A", "scout", { cost: 1 })]).markdown, "Cost")).not.toContain("’");
	});

	test("a caster row names the caster in the note and is a role of its own; without one the note says agents only", () => {
		const none = cost([ag("A", "scout", { cost: 1 })]).markdown;
		expect(section(none, "Cost")).toContain("Agents only: the Captain's own session is not included.");
		expect(section(none, "Cost")).not.toContain("caster");
		const r = cost([ag("A", "scout", { cost: 1 }), ag("caster", "caster", { cost: 0.5, tokens_in: 300, tokens_out: 40 })]);
		expect(section(r.markdown, "Cost")).toContain("Agents and the cockpit caster only: the Captain's own session is not included.");
		expect(section(r.markdown, "Cost")).not.toContain("Agents only");
		expect(section(r.markdown, "Cost")).toContain("| caster | caster | — | 300 | 40 | ? | $0.50 |");
		expect(r.summary.find(l => l.startsWith("COST"))).toContain("caster $0.50");
	});

	test("with a caster row the Total, rate and COST labels say agents and caster; without one they say agents", () => {
		const withCaster = cost([ag("A", "scout", { cost: 1 }), ag("caster", "caster", { cost: 0.5 })], [start(0, { booked: 60 })]);
		expect(withCaster.markdown).toContain("| Total (agents and caster) | 2 | $1.50 | — |");
		expect(withCaster.markdown).toContain("Cost per booked hour: $1.50 (agents and caster only; total $1.50 over 60 booked min)");
		expect(withCaster.summary.find(l => l.startsWith("COST"))).toStartWith("COST (agents and caster, list price) $1.50");
		const none = cost([ag("A", "scout", { cost: 1 })], [start(0, { booked: 60 })]);
		expect(none.markdown).toContain("| Total (agents) | 1 | $1.00 | — |");
		expect(none.markdown).toContain("(agents only; total $1.00 over 60 booked min)");
		expect(none.summary.find(l => l.startsWith("COST"))).toStartWith("COST (agents, list price) $1.00");
	});

	test("a role named Total is not the totals row", () => {
		const rows = lines(cost([ag("A", "Total", { cost: 1 }), ag("B", "Total (agents)", { cost: 2 })]).markdown);
		expect(rows).toContain("| Total (role) | 1 | $1.00 | █████ |");
		expect(rows).toContain("| Total (agents) (role) | 1 | $2.00 | ██████████ |");
		expect(rows.filter(l => l.startsWith("| Total (agents) |"))).toEqual(["| Total (agents) | 2 | $3.00 | — |"]);
	});

	test("an id or role with |, ANSI or a newline is one escaped cell", () => {
		const md = cost([ag("a|b\nc\x1b[31mred", "r|x\\", { squad: "s\x00q", cost: 1 })]).markdown;
		const row = lines(md).find(l => l.includes("a\\|b"))!;
		expect(row).toBe("| a\\|b cred | r\\|x\\\\ | s q | ? | ? | ? | $1.00 |");
		expect(md).not.toContain("\x1b");
	});

	test("properties (seeded): totals add raw then round once, ? iff unknown, rows keep the column count, cells stay clean", () => {
		let seed = 25;
		const rnd = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff), seed % n);
		const pieces = ["a", "b", "界", "|", "\\", "\x1b[31m", "\x1b]8;;u\x07", "\x00", "\n", " ", "x".repeat(70), "\ud83d\ude00"];
		const txt = () => Array.from({ length: 1 + rnd(5) }, () => pieces[rnd(pieces.length)]).join("");
		const costs = [undefined, undefined, 0.004, 0.005, 0.1, 0.2, 0.3, 1.005, 2.675, 10, 0, Number.NaN, -1, Infinity];
		const split = (l: string) => l.split(/(?<!\\)\|/).slice(1, -1);
		for (let i = 0; i < 300; i++) {
			const roles = ["r1", "r2", txt()];
			const agents = Array.from({ length: rnd(8) }, (_, n) => ag(`${n}${txt()}`, roles[rnd(3)], { cost: costs[rnd(costs.length)], tokens_in: rnd(2) ? rnd(1000) : undefined }));
			const md = cost(agents).markdown;
			const sec = lines(md);
			for (const l of sec) expect(l).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
			const tables = sec.filter(l => l.startsWith("|"));
			const known = (a: AgentCost[]) => a.filter(x => typeof x.cost === "number" && Number.isFinite(x.cost) && x.cost >= 0);
			const text = (a: AgentCost[]) => {
				const k = known(a);
				const s = k.reduce((n, x) => n + x.cost!, 0);
				return !k.length ? "?" : k.length < a.length ? `${usd(s)} + ?` : usd(s);
			};
			if (!agents.length) continue;
			const head = tables.findIndex(l => l.startsWith("| Agent |"));
			const rhead = tables.findIndex(l => l.startsWith("| Role |"));
			expect(rhead - head).toBe(agents.length + 2);
			tables.forEach((l, n) => expect(split(l).length).toBe(n < rhead ? 7 : 4));
			const total = split(tables.find(l => l.startsWith("| Total (agents) |"))!)[2].trim();
			expect(total).toBe(text(agents));
			for (const r of new Set(agents.map(a => a.role))) {
				const mine = agents.filter(a => a.role === r);
				const cells = tables.slice(rhead + 2).map(split).filter(c => c[0] !== " Total (agents) " && c[1].trim() === String(mine.length));
				expect(cells.map(c => c[2].trim())).toContain(text(mine));
			}
			expect(total.includes("$0.00") && !known(agents).some(x => x.cost! > 0 || x.cost === 0)).toBe(false);
		}
	});
});
