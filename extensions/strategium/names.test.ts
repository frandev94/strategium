import { describe, expect, test } from "bun:test";
import { allocateName, baseId, MAX_NAME, NAMED_AGENTS, type NameEntry } from "./names";

// Seeded LCG so draws are reproducible.
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

/** Allocate and append, like the wiring does. */
function give(entries: NameEntry[], req: Parameters<typeof allocateName>[1], avoid?: ReadonlySet<string>, rand?: () => number) {
	const r = allocateName(entries, req, avoid, rand);
	if ("error" in r) throw new Error(r.error);
	if (r.fresh) entries.push(r.entry);
	return r.entry;
}
const spawn = (e: NameEntry) => void (e.spawned = true);
const SERVITOR = /^Servitor[A-Z]{2}[1-9][0-9]?$/;
const PLAIN = /^[A-Z][A-Za-z]*$/;

describe("titles", () => {
	test.each([
		["librarian", "Librarian"],
		["archmagos", "Archmagos"],
		["scout", "Scout"],
		["inquisitor", "Inquisitor"],
		["confessor", "Confessor"],
		["apothecary", "Apothecary"],
		["security-reviewer", "Interrogator"],
		["task", "Adept"],
	])("%s is titled %s", (agent, title) => {
		const e = give([], { agent });
		expect(e.name.startsWith(title)).toBe(true);
		expect(e.name).toBe(title + e.surname);
		expect(e.squad).toBeUndefined();
	});

	test("sonic is a servitor with a designation", () => {
		expect(give([], { agent: "sonic" }, undefined, seeded(1)).name).toMatch(SERVITOR);
	});

	test("the roster has the 11 agents", () => {
		expect(NAMED_AGENTS).toHaveLength(11);
	});
});

describe("builders", () => {
	test("Brother, Penitent after a spawn, then Veteran, one surname", () => {
		const entries: NameEntry[] = [];
		const b = give(entries, { agent: "battle-brother", squad: "cli" });
		expect(b.name).toBe(`Brother${b.surname}`);
		spawn(b);
		const p = give(entries, { agent: "battle-brother", squad: "cli" });
		expect(p.name).toBe(`Penitent${b.surname}`);
		spawn(p);
		const v = give(entries, { agent: "veteran", squad: "cli" });
		expect(v.name).toBe(`Veteran${b.surname}`);
		expect([p.surname, v.surname]).toEqual([b.surname, b.surname]);
		expect(entries.map((e) => e.squad)).toEqual(["cli", "cli", "cli"]);
	});

	test("repeated calls return the same unspawned name, without appending", () => {
		const entries: NameEntry[] = [];
		const a = give(entries, { agent: "battle-brother", squad: "cli" });
		const r = allocateName(entries, { agent: "battle-brother", squad: "cli" });
		expect(r).toEqual({ entry: a, fresh: false });
		expect(entries).toHaveLength(1);
	});

	test("a veteran does not borrow an unspawned brother's name", () => {
		const entries: NameEntry[] = [];
		const b = give(entries, { agent: "battle-brother", squad: "cli" });
		const v = give(entries, { agent: "veteran", squad: "cli" });
		expect(v.name).toBe(`Veteran${b.surname}`);
	});

	test("squads get different surnames", () => {
		const entries: NameEntry[] = [];
		const a = give(entries, { agent: "battle-brother", squad: "a" });
		const b = give(entries, { agent: "battle-brother", squad: "b" });
		expect(a.surname).not.toBe(b.surname);
	});

	test("a second penitent of a squad gets an epithet", () => {
		const entries: NameEntry[] = [];
		spawn(give(entries, { agent: "battle-brother", squad: "cli" }));
		spawn(give(entries, { agent: "battle-brother", squad: "cli" }));
		const again = give(entries, { agent: "battle-brother", squad: "cli" });
		expect(again.name).toBe(`Penitent${again.surname}Unbroken`);
	});

	test("old entries no longer give a squad its surname or title", () => {
		const entries: NameEntry[] = [];
		const first = give(entries, { agent: "battle-brother", squad: "cli" });
		spawn(first);
		entries.forEach((e) => (e.old = true));
		const next = give(entries, { agent: "battle-brother", squad: "cli" });
		expect(next.name.startsWith("Brother")).toBe(true);
		expect(next.surname).not.toBe(first.surname);
		expect(next.name).not.toBe(first.name);
	});
});

describe("roles", () => {
	test("every call gives a fresh, different name", () => {
		const entries: NameEntry[] = [];
		const names = Array.from({ length: 5 }, () => give(entries, { agent: "scout" }).name);
		expect(new Set(names).size).toBe(5);
	});

	test("a surname held by one persona is not used by another role", () => {
		const entries: NameEntry[] = [{ name: "BrotherGrimaldus", agent: "battle-brother", surname: "Grimaldus", squad: "a" }];
		for (let i = 0; i < 4; i++) give(entries, { agent: "confessor" }, undefined, seeded(i));
		expect(entries.filter((e) => e.surname === "Grimaldus")).toHaveLength(1);
	});

	test("again keeps the persona, with an epithet once spawned", () => {
		const entries: NameEntry[] = [];
		const i = give(entries, { agent: "inquisitor" });
		expect(allocateName(entries, { agent: "inquisitor", again: true })).toEqual({ entry: i, fresh: false });
		spawn(i);
		const again = give(entries, { agent: "inquisitor", again: true });
		expect(again).toEqual({ name: `${i.name}Unbroken`, agent: "inquisitor", surname: i.surname });
		spawn(again);
		expect(give(entries, { agent: "inquisitor", again: true }).name).toBe(`${i.name}Steadfast`);
	});

	test("again picks the latest name of that agent only", () => {
		const entries: NameEntry[] = [];
		const i = give(entries, { agent: "inquisitor" });
		spawn(i);
		spawn(give(entries, { agent: "confessor" }));
		expect(give(entries, { agent: "inquisitor", again: true }).surname).toBe(i.surname);
	});

	test("a spawned servitor on again gets a new designation", () => {
		const entries: NameEntry[] = [];
		spawn(give(entries, { agent: "sonic" }, undefined, seeded(3)));
		const n = give(entries, { agent: "sonic", again: true }, undefined, seeded(4));
		expect(n.name).toMatch(SERVITOR);
		expect(entries.map((e) => e.name).length).toBe(2);
		expect(new Set(entries.map((e) => e.name)).size).toBe(2);
	});

	test("pool exhaustion falls back to a pool name with an epithet", () => {
		const entries: NameEntry[] = [];
		const names = Array.from({ length: 4 }, () => give(entries, { agent: "archmagos" }).name);
		expect(names.slice(0, 3).every((n) => /^Archmagos(Cawl|Telok|Kane)$/.test(n))).toBe(true);
		expect(names[3]).toMatch(/^Archmagos(Cawl|Telok|Kane)Unbroken$/);
	});

	test("nothing free is an error naming the setting", () => {
		const entries: NameEntry[] = [];
		for (let i = 0; i < 3 * (1 + 8); i++) give(entries, { agent: "archmagos" });
		const r = allocateName(entries, { agent: "archmagos" });
		expect("error" in r && r.error).toContain("/strategium-config names off");
	});

	test("names issued earlier in the process are avoided", () => {
		const avoid = new Set(["ScoutTelion", "ScoutCyrus"]);
		for (let i = 0; i < 12; i++) expect(avoid.has(give([], { agent: "scout" }, avoid, seeded(i)).name)).toBe(false);
	});
});

describe("prefer and skip", () => {
	const alloc = (entries: NameEntry[], req: Parameters<typeof allocateName>[1], opts: { prefer?: string[]; skip?: Set<string> }, rand = seeded(3)) => {
		const r = allocateName(entries, req, undefined, rand, opts);
		if ("error" in r) throw new Error(r.error);
		if (r.fresh) entries.push(r.entry);
		return r.entry;
	};

	test("the first free preferred surname wins over the draw, in order", () => {
		const entries: NameEntry[] = [];
		const prefer = ["Gideon", "Leon", "Uriel"];
		expect(alloc(entries, { agent: "battle-brother", squad: "a" }, { prefer }).surname).toBe("Gideon");
		expect(alloc(entries, { agent: "battle-brother", squad: "b" }, { prefer }).surname).toBe("Leon");
		expect(alloc(entries, { agent: "battle-brother", squad: "c" }, { prefer }).surname).toBe("Uriel");
	});

	test("a role takes its preferred surname", () => {
		expect(alloc([], { agent: "scout" }, { prefer: ["Cyrus"] }).name).toBe("ScoutCyrus");
	});

	test("skipped surnames are never chosen, even if preferred", () => {
		const skip = new Set(["Gideon"]);
		for (let i = 0; i < 40; i++) {
			const e = alloc([], { agent: "battle-brother", squad: "a" }, { prefer: ["Gideon"], skip }, seeded(i));
			expect(e.surname).not.toBe("Gideon");
		}
	});

	test("with every preferred surname taken or skipped, it recruits from the pool", () => {
		const entries: NameEntry[] = [];
		const first = alloc(entries, { agent: "battle-brother", squad: "a" }, { prefer: ["Gideon"] });
		const second = alloc(entries, { agent: "battle-brother", squad: "b" }, { prefer: ["Gideon", "Leon"], skip: new Set(["Leon"]) });
		expect(first.surname).toBe("Gideon");
		expect(second.surname).not.toMatch(/^(Gideon|Leon)$/);
		expect(second.name.startsWith("Brother")).toBe(true);
	});

	test("a squad keeps its surname when preferences change", () => {
		const entries: NameEntry[] = [];
		const b = alloc(entries, { agent: "battle-brother", squad: "a" }, { prefer: ["Gideon"] });
		const v = alloc(entries, { agent: "veteran", squad: "a" }, { prefer: ["Leon"], skip: new Set(["Gideon"]) });
		expect(v.surname).toBe(b.surname);
	});

	test("without options the result is unchanged", () => {
		expect(alloc([], { agent: "scout" }, {}, seeded(5))).toEqual(give([], { agent: "scout" }, undefined, seeded(5)));
	});

	// The brother pool, learned from the code: unheld surnames are handed out until none is left.
	const brotherPool = () => {
		const entries: NameEntry[] = [];
		for (let i = 0; i < 200; i++) {
			const r = allocateName(entries, { agent: "battle-brother", squad: `p${i}` }, undefined, seeded(i));
			if ("error" in r) break;
			entries.push(r.entry);
		}
		return entries.map((e) => e.surname);
	};

	test("with the whole pool skipped but one surname, that one is chosen for any seed", () => {
		const pool = brotherPool();
		expect(pool.length).toBeGreaterThan(40);
		const last = pool[7];
		const skip = new Set(pool.filter((s) => s !== last));
		for (let i = 0; i < 40; i++) expect(alloc([], { agent: "battle-brother", squad: "a" }, { skip }, seeded(i)).surname).toBe(last);
	});

	test("with the whole pool skipped there is no free name", () => {
		const r = allocateName([], { agent: "battle-brother", squad: "a" }, undefined, seeded(1), { skip: new Set(brotherPool()) });
		expect(r).toEqual({ error: expect.stringContaining("no free name left for battle-brother") });
	});

	test("skip binds pass 2: a skipped surname held by a retired builder is never reused", () => {
		const pool = brotherPool();
		const retired: NameEntry[] = pool.map((s, i) => ({ name: `Brother${s}`, agent: "battle-brother", surname: s, squad: `r${i}`, spawned: true, old: true }));
		const open = pool[3];
		for (let i = 0; i < 40; i++) {
			const skip = new Set(pool.filter((s) => s !== open));
			expect(alloc([...retired], { agent: "battle-brother", squad: "new" }, { skip }, seeded(i)).surname).toBe(open);
		}
		const all = allocateName([...retired], { agent: "battle-brother", squad: "new" }, undefined, seeded(1), { skip: new Set(pool) });
		expect("error" in all).toBe(true);
	});
});

describe("servitors", () => {
	test("designation is drawn from rand and retried until free", () => {
		const a = give([], { agent: "sonic" }, undefined, seeded(7));
		const r = allocateName([], { agent: "sonic" }, new Set([a.name]), seeded(7));
		expect("error" in r).toBe(false);
		if (!("error" in r)) expect(r.entry.name).not.toBe(a.name);
	});

	test("an exhausted draw gives an error", () => {
		const r = allocateName([], { agent: "sonic" }, new Set(["ServitorAA1"]), () => 0);
		expect("error" in r && r.error).toContain("sonic");
	});
});

describe("errors", () => {
	test.each([
		[{ agent: "wizard" }, "unknown agent"],
		[{ agent: "battle-brother" }, "needs a squad"],
		[{ agent: "veteran" }, "needs a squad"],
		[{ agent: "scout", squad: "a" }, "drop squad"],
		[{ agent: "battle-brother", squad: "a", again: true }, "again is not for"],
		[{ agent: "scout", again: true }, "no earlier name"],
	])("%j is refused", (req, reason) => {
		const r = allocateName([], req);
		expect("error" in r && r.error).toContain(reason);
	});
});

describe("baseId", () => {
	test("strips omp's numeric suffix only", () => {
		expect(baseId("BrotherLorenzo-2")).toBe("BrotherLorenzo");
		expect(baseId("BrotherLorenzo-12")).toBe("BrotherLorenzo");
		expect(baseId("ServitorKX7")).toBe("ServitorKX7");
		expect(baseId("a-b")).toBe("a-b");
	});
});

describe("properties", () => {
	// 1: format and length over every title x pool name x epithet (drain each agent, spawning to force epithets).
	test("every name matches its format and fits MAX_NAME", () => {
		for (const agent of NAMED_AGENTS.filter((a) => a !== "sonic" && a !== "veteran" && a !== "battle-brother")) {
			const entries: NameEntry[] = [];
			for (;;) {
				const r = allocateName(entries, { agent }, undefined, seeded(entries.length));
				if ("error" in r) break;
				expect(r.entry.name).toMatch(PLAIN);
				expect(r.entry.name.length).toBeLessThanOrEqual(MAX_NAME);
				entries.push(r.entry);
			}
			expect(entries.length).toBeGreaterThan(8);
		}
		// builders: drain squads until the surname pool and epithets run out, with penances on the way
		const entries: NameEntry[] = [];
		for (let squad = 0; ; squad++) {
			let more = false;
			for (const agent of ["battle-brother", "battle-brother", "battle-brother", "veteran"] as const) {
				const r = allocateName(entries, { agent, squad: `s${squad}` }, undefined, seeded(squad));
				if ("error" in r) continue;
				more = true;
				expect(r.entry.name).toMatch(PLAIN);
				expect(r.entry.name.length).toBeLessThanOrEqual(MAX_NAME);
				r.entry.spawned = true;
				entries.push(r.entry);
			}
			if (!more || squad > 400) break;
		}
		for (let i = 0; i < 200; i++) {
			const r = allocateName([], { agent: "sonic" }, undefined, seeded(i));
			expect("error" in r).toBe(false);
			if (!("error" in r)) {
				expect(r.entry.name).toMatch(SERVITOR);
				expect(r.entry.name.length).toBeLessThanOrEqual(MAX_NAME);
			}
		}
	});

	// 2: fresh is never taken; non-fresh is an existing unspawned entry.
	// 3: a squad's live entries share one surname that no other live entry holds.
	test("random runs never duplicate a name and keep squad surnames apart", () => {
		for (let seed = 1; seed <= 40; seed++) {
			const rand = seeded(seed);
			const entries: NameEntry[] = [];
			const avoid = new Set([`BrotherLorenzo`, `ScoutTelion`, `ServitorAB1`]);
			const squads = ["a", "b", "c", "d"];
			for (let step = 0; step < 60; step++) {
				const k = draw(rand, 6);
				const req =
					k < 2 ? { agent: k ? "battle-brother" : "veteran", squad: squads[draw(rand, 4)] }
					: { agent: NAMED_AGENTS.filter((a) => a !== "battle-brother" && a !== "veteran")[draw(rand, 9)] };
				const before = JSON.stringify(entries);
				const r = allocateName(entries, req, avoid, rand);
				expect(JSON.stringify(entries)).toBe(before);
				if ("error" in r) continue;
				if (r.fresh) {
					expect(entries.some((e) => e.name === r.entry.name)).toBe(false);
					expect(avoid.has(r.entry.name)).toBe(false);
					entries.push(r.entry);
				} else {
					expect(entries).toContain(r.entry);
					expect(r.entry.spawned).toBeUndefined();
				}
				if (draw(rand, 2)) entries[draw(rand, entries.length)].spawned = true;
				if (step === 30) entries.filter((e) => e.squad).forEach((e) => (e.old = true));
			}
			const live = entries.filter((e) => !e.old);
			for (const squad of squads) {
				const mine = live.filter((e) => e.squad === squad);
				const surnames = new Set(mine.map((e) => e.surname));
				expect(surnames.size).toBeLessThanOrEqual(1);
				for (const s of surnames) expect(live.filter((e) => e.surname === s && e.squad !== squad)).toEqual([]);
			}
			expect(new Set(entries.map((e) => e.name)).size).toBe(entries.length);
		}
	});
});

function draw(rand: () => number, n: number) {
	return Math.floor(rand() * n);
}
