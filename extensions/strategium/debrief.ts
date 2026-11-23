// The run report: a pure builder from a key's events, squads and notes to markdown. Does no fs itself, no ctx, no index.ts.
import { isCost, type Live, oneLine, type Rating, RATING_WORD, RATINGS, usd } from "./cockpit";
import type { Honour } from "./roster";
import { bookedMin, type Ev } from "./timer";

export type Reported = {
	apothecary?: { killed?: number; survived?: number; crashes?: number };
	review?: { pass?: number; fail?: number; opened?: number; fixed?: number; not_reproduced?: number };
};
export type DebriefInput = {
	key: string;
	theatre: string;
	since?: string;
	end: Date;
	evs: Ev[]; // this key's events, every day file from since to end, sorted (load order)
	squads: { id: string; tier?: string; state: "running" | "stopped" | "not built" }[];
	notes: Record<string, { failed?: true; veteran?: true }>;
	reported?: Reported;
	agents?: AgentCost[]; // every agent of the run with the usage its live file carried; ids and roles are untrusted
	honours?: { rows: Honour[]; unsaved?: string }; // names on only: the run's honours and falls; unsaved = why roster.json was not written
	ratings?: Record<string, Rating>; // untrusted: the Captain's rate action, already cleaned by the caller and cleaned again here
};
/** One agent's usage as its live file carried it: a missing or invalid field is unknown, never 0. */
export type AgentCost = { id: string; role: string; squad?: string; calls?: number; model?: string } & Pick<Live, "cost" | "tokens_in" | "tokens_out" | "cache_read" | "cache_write">;

const MIN = 60_000;
const BEFORE = "(before the todo)";
const time = (ts: string) => new Date(ts).getTime();

/** Per station (order of first entry): active time = the key's start→stop spans ∩ the station's intervals; paused = the rest of its wall time. */
export function stationTimes(evs: Ev[], key: string, end: Date): { station: string; activeMs: number; pausedMs: number }[] {
	const mine = evs
		.filter(e => e.key === key && (e.event === "start" || e.event === "stop" || e.event === "station") && Number.isFinite(time(e.ts)))
		.sort((a, b) => time(a.ts) - time(b.ts));
	if (!mine.length) return [];
	const endMs = end.getTime();
	const spans: [number, number][] = [];
	let open: number | undefined;
	for (const e of mine) {
		if (e.event === "start" && open === undefined) open = time(e.ts);
		else if (e.event === "stop" && open !== undefined) {
			spans.push([open, time(e.ts)]);
			open = undefined;
		}
	}
	if (open !== undefined) spans.push([open, endMs]);

	const stations = mine.filter(e => e.event === "station");
	const first = time(mine[0].ts);
	const cuts = [{ name: BEFORE, from: first }, ...stations.map(e => ({ name: e.station ?? "", from: time(e.ts) }))];
	const rows = new Map<string, { station: string; activeMs: number; pausedMs: number }>();
	cuts.forEach((c, i) => {
		const from = Math.min(c.from, endMs);
		const to = Math.min(i + 1 < cuts.length ? cuts[i + 1].from : endMs, endMs);
		if (to <= from && c.name === BEFORE) return;
		const active = spans.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
		const row = rows.get(c.name) ?? { station: c.name, activeMs: 0, pausedMs: 0 };
		row.activeMs += active;
		row.pausedMs += Math.max(0, to - from) - active;
		rows.set(c.name, row);
	});
	return [...rows.values()];
}

/** Whole minutes by largest remainder: the parts sum to round(Σms / 1 min) and each is within 1 of its exact value. */
export function splitMinutes(ms: number[]): number[] {
	const v = ms.map(x => Math.max(0, x));
	const parts = v.map(x => Math.floor(x / MIN));
	let extra = Math.round(v.reduce((a, b) => a + b, 0) / MIN) - parts.reduce((a, b) => a + b, 0);
	const order = v.map((x, i) => i).sort((a, b) => (v[b] % MIN) - (v[a] % MIN) || a - b);
	for (const i of order) {
		if (extra-- <= 0) break;
		parts[i]++;
	}
	return parts;
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const when = (ms: number | undefined) => (ms === undefined ? "—" : stamp(new Date(ms)));
/** One table cell from untrusted text: one printable line, cut at 60, pipes escaped. */
const cell = (s: unknown) => oneLine(s).slice(0, 60).replace(/[\\|]/g, "\\$&") || "—";
const row = (...c: (string | number)[]) => `| ${c.join(" | ")} |`;
const table = (head: string[], body: string[][]) => [row(...head), `|${head.map(() => "---").join("|")}|`, ...body.map(r => row(...r))];
const num = (n: number | undefined) => (n === undefined ? "—" : String(n));

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const tokens = (n: unknown) => (isCount(n) ? String(n) : "?");
const priced = (a: AgentCost) => isCost(a.cost);
/** An agent group's spend: the known costs added as raw floats and rounded once (`$x`), `$x + ?` when some agents are unknown, `?` when all are. */
const group = (a: AgentCost[]) => {
	const k = a.filter(priced);
	const sum = k.reduce((n, x) => n + x.cost!, 0);
	return { sum, some: k.length < a.length, text: !k.length ? "?" : k.length < a.length ? `${usd(sum)} + ?` : usd(sum), any: k.length > 0 };
};

/** One agent's cost: a third decimal under a cent so the rows can be added up. */
const agentUsd = (n: number) => (n > 0 && n < 0.01 ? (n < 0.0005 ? "<$0.001" : `$${n.toFixed(3)}`) : usd(n));
/** A role as shown: one line cut at 60, and the totals' own names told apart. */
const roleName = (s: string) => {
	const n = oneLine(s).slice(0, 60);
	return /^Total( \((agents|agents and caster)\))?$/.test(n) ? `${n} (role)` : n;
};
const bar = (sum: number, top: number) => (sum > 0 && top > 0 && Number.isFinite(sum / top) ? "█".repeat(Math.max(1, Math.round(10 * (sum / top)))) : "");

const counts = (names: string[]) => {
	const m = new Map<string, number>();
	for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
	return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
};

/** One brother's honours as short sentences, in the order the Chapter hands them out. */
const honourLine = (h: Honour): string[] => {
	const n = oneLine(h.brother);
	return [
		...(h.joined ? [`${n} joins the roster`] : []),
		...h.earned.map(e => `${n} earns ${e === "Purity Seal" ? "a" : "the"} ${e}`),
		...(h.kind === "fell" ? [`${n} falls`] : []),
		...(h.corrupted ? [`${n} is corrupted and kept in reserve`] : []),
	];
};
const result = (h: Honour) =>
	h.kind === "first" ? "first build" : h.kind === "saved" ? "saved by the veteran" : h.kind === "fell" ? "fell" : `after ${h.penances} ${h.penances === 1 ? "penance" : "penances"}`;

export function debrief(input: DebriefInput): { markdown: string; summary: string[] } {
	const hs = input.honours;
	const { key, end } = input;
	const evs = input.evs.filter(e => e.key === key);
	const all = stationTimes(evs, key, end);
	const allActive = splitMinutes(all.map(r => r.activeMs));
	const allPaused = splitMinutes(all.map(r => r.pausedMs));
	// A row that rounds to 0 active and 0 paused is noise; its splits are 0, so the totals stay as they were.
	const shown = all.map((_, i) => i).filter(i => allActive[i] || allPaused[i]);
	const rows = shown.map(i => all[i]);
	const active = shown.map(i => allActive[i]);
	const paused = shown.map(i => allPaused[i]);
	const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
	const worked = (ev: Ev["event"]) => evs.filter(e => e.event === ev).reduce((n, e) => n + (e.prior ?? 0), 0);
	const prior = worked("start");
	const byHand = worked("adjust");

	// Seals: one row per id; the granted event pairs with the latest asked at or before it.
	const sealEvs = evs.filter(e => e.event === "seal" && e.seal && Number.isFinite(time(e.ts)));
	const seals = [...new Set(sealEvs.map(e => e.seal as string))].map(id => {
		const mine = sealEvs.filter(e => e.seal === id);
		const granted = mine.filter(e => e.state === "granted").at(-1);
		const asked = mine.filter(e => e.state === "asked" && (!granted || time(e.ts) <= time(granted.ts))).at(-1);
		const a = asked && time(asked.ts);
		const g = granted && time(granted.ts);
		return { id, a, g, wait: a !== undefined && g !== undefined ? Math.max(0, Math.round((g - a) / MIN)) : undefined };
	});

	const sp = evs.filter(e => e.event === "spawn");
	// After the last redraft only: an earlier build is not this plan's, so it gets its own row; the totals keep every spawn.
	const mark = evs.map(e => e.event).lastIndexOf("redraft");
	const before = sp.filter(e => (e.role === "battle-brother" || e.role === "veteran") && evs.indexOf(e) < mark);
	const spawns = sp.filter(e => !before.includes(e));
	const runs = (role: string, squad: string) => spawns.filter(e => e.role === role && e.squad === squad).length;
	const roles = counts(sp.map(e => e.role ?? "unknown"));
	const tiersOf = (squad: string, planned?: string) => {
		const used = spawns.filter(e => e.squad === squad && e.tier).map(e => e.tier as string).filter((t, i, a) => t !== a[i - 1]);
		return used.length ? used.join("→") : planned;
	};
	const known = new Set(input.squads.map(s => s.id));
	const unmatched = spawns.filter(e => (e.role === "battle-brother" || e.role === "veteran") && !known.has(e.squad ?? ""));
	const unmatchedBuilt = unmatched.filter(e => e.role === "battle-brother").length;
	const squadRows = input.squads.map(s => {
		const built = runs("battle-brother", s.id);
		const last = input.notes[s.id]?.failed ? "failed" : built ? "ok" : "—";
		const tier = tiersOf(s.id, s.tier);
		return [cell(s.id), tier ? cell(tier) : "—", String(built), String(Math.max(0, built - 1)), String(runs("veteran", s.id)), last, s.state];
	});
	if (before.length) {
		const built = before.filter(e => e.role === "battle-brother").length;
		const tiers = before.map(e => e.tier).filter((t, i, a): t is string => !!t && t !== a[i - 1]);
		squadRows.push(["(before redraft)", tiers.length ? cell(tiers.join("→")) : "—", String(built), String(Math.max(0, built - 1)), String(before.length - built), "—", "—"]);
	}
	if (unmatched.length) {
		const tiers = unmatched.map(e => e.tier).filter((t, i, a): t is string => !!t && t !== a[i - 1]);
		squadRows.push(["(unmatched)", tiers.length ? cell(tiers.join("→")) : "—", String(unmatchedBuilt), String(Math.max(0, unmatchedBuilt - 1)), String(unmatched.length - unmatchedBuilt), "—", "—"]);
	}
	const models = counts(sp.map(e => e.model ?? "default"));
	const total = (c: [string, number][]) => String(sum(c.map(x => x[1])));
	const agents = input.agents ?? [];
	const isCaster = (a: AgentCost) => a.id === "caster" && a.role === "caster";
	const hasCaster = agents.some(isCaster);
	const who = hasCaster ? "agents and caster" : "agents";
	const spend = group(agents);
	const byRole = [...Map.groupBy(agents, a => a.role)]
		.map(([role, a]) => ({ role, n: a.length, ...group(a) }))
		.sort((a, b) => b.sum - a.sum || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
	const top = Math.max(0, ...byRole.map(r => r.sum));
	// B: each local day's booking, so a run over several days books each of them.
	const days = Map.groupBy(
		evs.filter(e => Number.isFinite(time(e.ts))),
		e => new Date(time(e.ts)).toDateString(),
	);
	const booked = sum([...days.values()].map(d => bookedMin(d, key) ?? 0));
	const rate = booked > 0 && spend.any ? usd(spend.sum / (booked / 60)) : undefined;

	const { apothecary: ap, review: rv } = input.reported ?? {};
	const filled = (o: object | undefined) => o !== undefined && Object.values(o).some(v => v !== undefined);
	const reported = (title: string, o: object | undefined, head: string[], vals: (number | undefined)[]) => [
		`## ${title}`,
		"",
		...(filled(o) ? table(head, [vals.map(num)]) : ["Not reported."]),
		"",
	];

	// Only known verdicts count; a record with none left shows no section.
	const rated = Object.entries(input.ratings ?? {}).filter(([, r]) => r && RATINGS.includes(r.rating));
	const verdicts = (rs: Rating[]) => RATINGS.map(k => rs.filter(r => r.rating === k).length);
	const counts3 = verdicts(rated.map(x => x[1]));
	const tiers = [...Map.groupBy(rated, ([, r]) => `${cell(r.model)}\0${cell(r.effort)}`)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const evidence = (r: Rating) => (Array.isArray(r.evidence) ? [...oneLine(r.evidence.map(oneLine).join(", "))].slice(0, 200).join("").replace(/[\\|]/g, "\\$&") || "—" : "—");
	const agentOf = new Map(agents.map(a => [a.id, a]));

	const md = [
		`# Debrief ${cell(key)}`,
		"",
		`Theatre ${cell(input.theatre)} · ${input.since && Number.isFinite(time(input.since)) ? stamp(new Date(input.since)) : "today (start not recorded)"} → ${stamp(end)} · plugin numbers are exact except the Model requested column; (reported) sections come from the agents.`,
		"",
		"## Time per station",
		"",
		...table(
			["Station", "Active (min)", "Paused (min)"],
			[...rows.map((r, i) => [cell(r.station), String(active[i]), String(paused[i])]), ["Total", String(sum(active)), String(sum(paused))]],
		),
		"",
		...(prior || byHand ? [`Prior estimate ${prior} min, added by hand ${byHand} min: worked ${sum(active) + prior + byHand} min.`, ""] : []),
		"## Seals",
		"",
		...(seals.length
			? table(["Seal", "Asked", "Granted", "Wait (min)"], seals.map(s => [cell(s.id), when(s.a), when(s.g), num(s.wait)]))
			: ["None."]),
		"",
		"## Squads",
		"",
		...(squadRows.length
			? table(["Squad", "Tier", "Builder runs", "Penances", "Veteran runs", "Last result", "State"], squadRows)
			: ["None."]),
		"",
		...(hs
			? [
					"## Honours",
					"",
					...(hs.rows.length
						? table(["Brother", "Squad", "Result", "Honours"], hs.rows.map(r => [cell(r.brother), cell(r.squad), result(r), r.earned.length ? r.earned.join(", ") : "—"]))
						: ["None."]),
					...(hs.rows.some(r => honourLine(r).length) ? ["", ...hs.rows.flatMap(honourLine).map(l => `- ${l}`)] : []),
					...(hs.unsaved === undefined ? [] : ["", `Roster not written (${oneLine(hs.unsaved)}): this record was not saved.`]),
					"",
				]
			: []),
		...(rated.length
			? [
					"## Ratings",
					"",
					"From the Captain's rate action (the reviewers' verdicts).",
					"",
					...table(
						["Agent", "Role", "Squad", "Rating", "Model", "Effort", "Evidence"],
						rated.map(([id, r]) => [cell(id), cell(agentOf.get(id)?.role), cell(agentOf.get(id)?.squad), RATING_WORD[r.rating], cell(r.model), cell(r.effort), evidence(r)]),
					),
					"",
					...table(
						["Model", "Effort", "Proven", "Proven with a regression", "Corrupted", "Agents"],
						[
							...tiers.map(([k, g]) => [...k.split("\0"), ...verdicts(g.map(x => x[1])).map(String), String(g.length)]),
							["Total", "—", ...counts3.map(String), String(rated.length)],
						],
					),
					"",
				]
			: []),
		"## Agents spawned",
		"",
		...table(["Role", "Spawns"], [...roles.map(([n, c]) => [cell(n), String(c)]), ["Total", total(roles)]]),
		"",
		...table(["Model requested", "Spawns"], [...models.map(([n, c]) => [cell(n), String(c)]), ["Total", total(models)]]),
		"",
		"Model requested: the selector Strategium asked of the host; the host may run another.",
		"",
		"## Cost",
		"",
		`Costs are omp's list-price estimates: each agent's own spend as omp prices it (its cost minus its nested subagents', computed as omp's agent view computes it). Tokens include nested subagents'; cost does not. ${hasCaster ? "Agents and the cockpit caster only" : "Agents only"}: the Captain's own session is not included. A subscription plan pays differently. ?: no usage recorded, or a model without a price in omp.`,
		"",
		...(agents.length
			? [
					...table(
						["Agent", "Role", "Squad", "Tokens in", "Tokens out", "Cache", "Cost"],
						agents.map(a => {
							const cache = [a.cache_read, a.cache_write].filter(isCount);
							return [cell(a.id), cell(a.role), cell(isCaster(a) && a.calls ? `${a.calls} ${a.calls === 1 ? "call" : "calls"}${a.model ? ` · ${a.model}` : ""}` : a.squad), tokens(a.tokens_in), tokens(a.tokens_out), cache.length ? String(sum(cache)) : "?", priced(a) ? agentUsd(a.cost!) : "?"];
						}),
					),
					"",
					...table(["Role", "Agents", "Cost", "Share"], [...byRole.map(r => [cell(roleName(r.role)), String(r.n), r.text, bar(r.sum, top)]), [`Total (${who})`, hasCaster ? `${agents.filter(a => !isCaster(a)).length} + caster` : String(agents.length), spend.text, "—"]]),
					"",
					...(rate ? [`Cost per booked hour: ${rate} (${who} only; total ${spend.text} over ${booked} booked min${spend.some ? "; known agents only" : ""})`, ""] : []),
				]
			: ["None.", ""]),
		...reported("Apothecary (reported)", ap, ["Mutants killed", "Survivors", "Fuzz crashes"], [ap?.killed, ap?.survived, ap?.crashes]),
		...reported("Review (reported)", rv, ["Merge bar PASS", "Merge bar FAIL", "Findings opened", "Fixed", "NOT REPRODUCED"], [rv?.pass, rv?.fail, rv?.opened, rv?.fixed, rv?.not_reproduced]),
	].join("\n");

	const list = (c: [string, number][]) => c.map(([n, k]) => `${oneLine(n)} ${k}`).join(", ");
	return {
		markdown: md,
		summary: [
			`TIME ${sum(active)} min active, ${sum(paused)} min paused${rows.length ? `: ${rows.map((r, i) => `${oneLine(r.station)} ${active[i]}`).join(", ")}` : ""}`,
			seals.length ? `SEALS ${seals.map(s => `${oneLine(s.id)} ${s.wait === undefined ? "—" : `${s.wait}m`}`).join(", ")}` : "SEALS none",
			`SPAWNS ${total(roles)}${roles.length ? `: ${list(roles)}` : ""}`,
			agents.length
				? `COST (${who}, list price) ${spend.text} · ${byRole.map(r => `${roleName(r.role) || "—"} ${r.text}`).join(", ")}${rate ? ` · ${rate}/booked h` : ""}`
				: "COST none",
			...(hs ? [`HONOURS ${hs.rows.flatMap(honourLine).join(", ") || "none"}`] : []),
			...(rated.length ? [`RATINGS ${rated.length}: ${RATINGS.map((k, i) => [k, counts3[i]] as const).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ")}`] : []),
		],
	};
}
