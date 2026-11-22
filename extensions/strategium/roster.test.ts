import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NameEntry } from "./names";
import {
	applyRun,
	type Brothers,
	corrupted,
	crux,
	honours,
	loadRoster,
	type Outcome,
	parseRoster,
	rankBrothers,
	retryable,
	runOutcomes,
	type Service,
	serializeRoster,
	squadBrothers,
	unfinished,
	updateRoster,
	withRosterLock,
} from "./roster";

const svc = (o: Partial<Service> = {}): Service => ({ passed: 0, penances: 0, falls: 0, squads: 0, purity: 0, halo: 0, laurel: 0, ...o });
const map = (o: Record<string, Partial<Service>>) => {
	const m: Record<string, Service> = Object.create(null);
	for (const [k, v] of Object.entries(o)) m[k] = svc(v);
	return m;
};
const builder = (squad: string, surname: string, extra: Partial<NameEntry> = {}): NameEntry => ({
	name: `Brother${surname}`,
	agent: "battle-brother",
	surname,
	squad,
	spawned: true,
	...extra,
});
const veteran = (squad: string, surname: string, extra: Partial<NameEntry> = {}): NameEntry => ({
	name: `Veteran${surname}`,
	agent: "veteran",
	surname,
	squad,
	spawned: true,
	...extra,
});

describe("runOutcomes (D3)", () => {
	test("ok on the first build: passed, Purity Seal", () => {
		const o = runOutcomes({ names: [builder("a", "Lorenzo")], builds: { a: 1 }, ended: { a: "ok" } });
		expect(o).toEqual([{ brother: "Lorenzo", squad: "a", kind: "first", penances: 0 }]);
		const r = applyRun(map({}), o, false);
		expect(r.Lorenzo).toEqual(svc({ passed: 1, squads: 1, purity: 1 }));
	});
	test("ok after a fix round: +1 passed, a penance, no honour", () => {
		const o = runOutcomes({ names: [builder("a", "Lorenzo")], builds: { a: 3 }, ended: { a: "ok" } });
		expect(o[0]).toMatchObject({ kind: "penance", penances: 2 });
		expect(applyRun(map({}), o, false).Lorenzo).toEqual(svc({ passed: 1, squads: 1, penances: 2 }));
	});
	test("ok with a veteran spawned: saved, +2 passed, Iron Halo, builds-1 penances", () => {
		const names = [builder("a", "Lorenzo"), veteran("a", "Lorenzo")];
		const o = runOutcomes({ names, builds: { a: 2 }, ended: { a: "ok" } });
		expect(o[0]).toMatchObject({ kind: "saved", penances: 1 });
		expect(applyRun(map({}), o, false).Lorenzo).toEqual(svc({ passed: 2, squads: 1, penances: 1, halo: 1 }));
	});
	test("a veteran named but never spawned, with a Penitent passing, is a penance, no Iron Halo", () => {
		const names = [builder("a", "Lorenzo"), { ...builder("a", "Lorenzo"), name: "PenitentLorenzo" }, veteran("a", "Lorenzo", { spawned: undefined })];
		const o = runOutcomes({ names, builds: { a: 2 }, ended: { a: "ok" } });
		expect(o[0]).toMatchObject({ kind: "penance", penances: 1 });
		expect(applyRun(map({}), o, false).Lorenzo.halo).toBe(0);
	});
	test("failed: +1 fall, +1 squad, nothing passed", () => {
		const names = [builder("a", "Lorenzo"), veteran("a", "Lorenzo")];
		const o = runOutcomes({ names, builds: { a: 2 }, ended: { a: "failed" } });
		expect(o[0]).toMatchObject({ kind: "fell" });
		expect(applyRun(map({}), o, false).Lorenzo).toEqual(svc({ falls: 1, squads: 1, penances: 1 }));
	});
	test("a squad that never ended, retired builders and non-builders record nothing", () => {
		const names = [
			builder("a", "Lorenzo"), // still running: no `ended`
			builder("b", "Gideon", { old: true }), // retired by a redraft
			{ name: "LibrarianTigurius", agent: "librarian", surname: "Tigurius", squad: "c", spawned: true } as NameEntry,
		];
		expect(runOutcomes({ names, builds: { a: 1, b: 1, c: 1 }, ended: { a: undefined, b: "ok", c: "ok" } })).toEqual([]);
	});
	test("junk in a hand-edited run file is ignored, never thrown", () => {
		const names = [builder("a", "Lorenzo"), builder("b", "Gideon")];
		const ended = { a: "ok", b: "maybe", c: 7 } as unknown as Record<string, "ok" | "failed">;
		const builds = { a: -4, b: 2 } as unknown as Record<string, number>;
		expect(runOutcomes({ names, builds, ended })).toEqual([{ brother: "Lorenzo", squad: "a", kind: "first", penances: 0 }]);
		expect(runOutcomes({ names, builds: "x" as never, ended: null as never })).toEqual([]);
		expect(runOutcomes({ names: "x" as never, builds: {}, ended: { a: "ok" } })).toEqual([]);
		expect(runOutcomes({ names: [], builds: {}, ended: undefined })).toEqual([]);
	});
	test("a surname the roster would refuse is never recorded", () => {
		const names = [builder("a", "lower"), builder("b", "__proto__")];
		expect(runOutcomes({ names, builds: { a: 1, b: 1 }, ended: { a: "ok", b: "ok" } })).toEqual([]);
	});
	test("unfinished: a squad with a live builder and no outcome", () => {
		const names = [builder("a", "Lorenzo"), builder("b", "Gideon")];
		expect(unfinished({ names, ended: { a: "ok" } })).toBe(true);
		expect(unfinished({ names, ended: { a: "ok", b: "ok" } })).toBe(false);
		expect(unfinished({ names: [builder("a", "Lorenzo", { old: true })], ended: undefined })).toBe(false);
	});
});

describe("applyRun (D4)", () => {
	const two = (a: number, b: number) => [
		{ brother: "Lorenzo", squad: "a", kind: a === 1 ? "first" : "penance", penances: a - 1 },
		{ brother: "Gideon", squad: "b", kind: b === 1 ? "first" : "penance", penances: b - 1 },
	] as const;
	test("Laurel for every brother when merged and every squad passed first", () => {
		const r = applyRun(map({}), [...two(1, 1)], true);
		expect(r.Lorenzo?.laurel).toBe(1);
		expect(r.Gideon?.laurel).toBe(1);
	});
	test("no Laurel when one squad needed a penance, when not merged, or when a squad fell", () => {
		expect(applyRun(map({}), [...two(1, 2)], true).Lorenzo?.laurel).toBe(0);
		expect(applyRun(map({}), [...two(1, 1)], false).Lorenzo?.laurel).toBe(0);
		const fell = [{ brother: "Lorenzo", squad: "a", kind: "fell", penances: 0 }] as const;
		expect(applyRun(map({}), [...fell], true).Lorenzo?.laurel).toBe(0);
	});
	test("no outcomes: no Laurel and no new brothers", () => {
		expect(Object.keys(applyRun(map({ Leon: {} }), [], true))).toEqual(["Leon"]);
	});
	test("returns a new map and keeps the old one and other brothers intact", () => {
		const before = map({ Leon: { passed: 3 }, Lorenzo: { passed: 1 } });
		const after = applyRun(before, [...two(1, 1)], false);
		expect(before.Lorenzo?.passed).toBe(1);
		expect(after.Lorenzo?.passed).toBe(2);
		expect(after.Leon).toEqual(svc({ passed: 3 }));
	});
	test("counters only grow, whatever the outcomes", () => {
		const kinds = ["first", "penance", "saved", "fell"] as const;
		for (const kind of kinds)
			for (const merged of [true, false]) {
				const before = map({ Lorenzo: { passed: 4, penances: 2, falls: 1, squads: 6, purity: 2, halo: 1, laurel: 1 } });
				const after = applyRun(before, [{ brother: "Lorenzo", squad: "a", kind, penances: 1 }], merged).Lorenzo as Service;
				for (const k of Object.keys(before.Lorenzo as Service) as (keyof Service)[]) expect(after[k]).toBeGreaterThanOrEqual((before.Lorenzo as Service)[k]);
			}
	});
	test("a counter at the safe-integer limit stays valid", () => {
		const big = map({ Lorenzo: { passed: Number.MAX_SAFE_INTEGER } });
		const r = applyRun(big, [{ brother: "Lorenzo", squad: "a", kind: "saved", penances: 0 }], false);
		expect(Number.isSafeInteger(r.Lorenzo?.passed)).toBe(true);
	});
});

describe("derived state", () => {
	test("Crux Terminatus at 10 passed", () => {
		expect(crux(svc({ passed: 9 }))).toBe(false);
		expect(crux(svc({ passed: 10 }))).toBe(true);
	});
	test("corrupted by 3 falls", () => {
		expect(corrupted(svc({ falls: 2 }))).toBe(false);
		expect(corrupted(svc({ falls: 3 }))).toBe(true);
	});
	test("corrupted by more penances than passes only from 5 squads", () => {
		expect(corrupted(svc({ squads: 4, passed: 0, penances: 9 }))).toBe(false);
		expect(corrupted(svc({ squads: 5, passed: 2, penances: 3 }))).toBe(true);
		expect(corrupted(svc({ squads: 5, passed: 3, penances: 3 }))).toBe(false);
	});
	test("depends only on the counters (honours do not matter)", () => {
		expect(corrupted(svc({ falls: 3, halo: 9, purity: 9, laurel: 9 }))).toBe(true);
		expect(crux(svc({ passed: 10, falls: 9 }))).toBe(true);
	});
});

describe("rankBrothers (D6)", () => {
	test("passed desc, falls asc, penances asc, name asc", () => {
		const b = map({
			Zed: { passed: 2 },
			Amy: { passed: 2 },
			Bob: { passed: 2, falls: 1 },
			Cal: { passed: 2, penances: 1 },
			Top: { passed: 5 },
			Low: {},
		});
		expect(rankBrothers(b, new Set())).toEqual(["Top", "Amy", "Zed", "Cal", "Bob", "Low"]);
	});
	test("skips the skip set and corrupted brothers", () => {
		const b = map({ Amy: { passed: 9 }, Bob: { passed: 3 }, Cal: { passed: 2, falls: 3 }, Dan: {} });
		expect(rankBrothers(b, new Set(["Amy"]))).toEqual(["Bob", "Dan"]);
	});
});

describe("parseRoster / serializeRoster (D7)", () => {
	const ok = (brothers: unknown, version: unknown = 1) => JSON.stringify({ version, brothers });
	const full = { passed: 1, penances: 0, falls: 0, squads: 1, purity: 1, halo: 0, laurel: 0 };

	test("round-trips a valid roster", () => {
		const b = map({ Lorenzo: { passed: 3, squads: 4, halo: 1 }, Gideon: { falls: 2 } });
		const back = parseRoster(serializeRoster(b));
		expect(back).toEqual({ brothers: b });
		expect(parseRoster(serializeRoster(map({})))).toEqual({ brothers: {} });
	});
	test("the parsed map has no prototype", () => {
		const r = parseRoster(ok({ Lorenzo: full }));
		if ("error" in r) throw new Error(r.error);
		expect(Object.getPrototypeOf(r.brothers)).toBeNull();
	});
	for (const [label, text] of [
		["bad JSON", "{nope"],
		["not an object", "[]"],
		["null", "null"],
		["wrong version", ok({}, 2)],
		["missing version", JSON.stringify({ brothers: {} })],
		["brothers an array", ok([])],
		["brothers null", ok(null)],
		["lowercase name", ok({ lorenzo: full })],
		["name too short", ok({ A: full })],
		["name too long", ok({ [`A${"b".repeat(20)}`]: full })],
		["name with a digit", ok({ Lorenzo1: full })],
		["__proto__ name", `{"version":1,"brothers":{"__proto__":${JSON.stringify(full)}}}`],
		["record not an object", ok({ Lorenzo: 3 })],
		["negative counter", ok({ Lorenzo: { ...full, passed: -1 } })],
		["fractional counter", ok({ Lorenzo: { ...full, passed: 1.5 } })],
		["string counter", ok({ Lorenzo: { ...full, passed: "1" } })],
		["unsafe counter", ok({ Lorenzo: { ...full, passed: 2 ** 53 } })],
		["missing counter", ok({ Lorenzo: { passed: 1 } })],
		["oversize", ok({ Lorenzo: full }) + " ".repeat(256 * 1024)],
	] as const)
		test(`unreadable: ${label}`, () => {
			const r = parseRoster(text);
			expect("error" in r && r.error.length > 0).toBe(true);
		});
});

describe("loadRoster", () => {
	const withDir = (fn: (dir: string) => void) => {
		const dir = mkdtempSync(join(tmpdir(), "st-roster-"));
		try {
			fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	test("a missing file is an empty roster, a missing dir too", () =>
		withDir(dir => {
			expect(loadRoster(dir)).toEqual({ brothers: {} });
			expect(loadRoster(join(dir, "nope"))).toEqual({ brothers: {} });
		}));
	test("a corrupt file is an error and is left untouched", () =>
		withDir(dir => {
			writeFileSync(join(dir, "roster.json"), "{corrupt");
			expect("error" in loadRoster(dir)).toBe(true);
			expect(readFileSync(join(dir, "roster.json"), "utf8")).toBe("{corrupt");
		}));
	test("an oversize file is an error", () =>
		withDir(dir => {
			writeFileSync(join(dir, "roster.json"), " ".repeat(256 * 1024 + 1));
			expect("error" in loadRoster(dir)).toBe(true);
		}));
	test("an unreadable path (a directory) is an error, not a throw", () =>
		withDir(dir => {
			mkdirSync(join(dir, "roster.json"));
			expect("error" in loadRoster(dir)).toBe(true);
		}));
});

describe("withRosterLock (D8)", () => {
	const withDir = (fn: (dir: string) => void) => {
		const dir = mkdtempSync(join(tmpdir(), "st-lock-"));
		try {
			fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	test("runs fn, returns its value and releases the lock", () =>
		withDir(dir => {
			const r = withRosterLock(dir, () => {
				expect(existsSync(join(dir, "roster.lock"))).toBe(true);
				return 42;
			});
			expect(r).toEqual({ value: 42 });
			expect(existsSync(join(dir, "roster.lock"))).toBe(false);
		}));
	test("creates the state dir when it does not exist", () =>
		withDir(dir => {
			expect(withRosterLock(join(dir, "deep", "state"), () => 1)).toEqual({ value: 1 });
		}));
	test("releases the lock when fn throws", () =>
		withDir(dir => {
			expect(() =>
				withRosterLock(dir, () => {
					throw new Error("boom");
				}),
			).toThrow("boom");
			expect(existsSync(join(dir, "roster.lock"))).toBe(false);
		}));
	test("a fresh foreign lock is busy within waitMs and is left alone", () =>
		withDir(dir => {
			writeFileSync(join(dir, "roster.lock"), "other-token");
			const t0 = Date.now();
			let ran = false;
			const r = withRosterLock(dir, () => (ran = true), 50);
			expect(r).toEqual({ busy: true });
			expect(ran).toBe(false);
			expect(Date.now() - t0).toBeLessThan(1000);
			expect(readFileSync(join(dir, "roster.lock"), "utf8")).toBe("other-token");
		}));
	test("a lock older than 10 s is taken over", () =>
		withDir(dir => {
			const lock = join(dir, "roster.lock");
			writeFileSync(lock, "dead-token");
			const old = new Date(Date.now() - 11_000);
			utimesSync(lock, old, old);
			expect(withRosterLock(dir, () => "got it", 500)).toEqual({ value: "got it" });
			expect(existsSync(lock)).toBe(false);
		}));
	test("a lock 9 s old is not taken over", () =>
		withDir(dir => {
			const lock = join(dir, "roster.lock");
			writeFileSync(lock, "slow-token");
			const t = new Date(Date.now() - 9_000);
			utimesSync(lock, t, t);
			expect(withRosterLock(dir, () => 1, 50)).toEqual({ busy: true });
		}));
	test("release leaves a lock that a stale takeover handed to someone else", () =>
		withDir(dir => {
			const lock = join(dir, "roster.lock");
			withRosterLock(dir, () => writeFileSync(lock, "someone-else"));
			expect(readFileSync(lock, "utf8")).toBe("someone-else");
		}));
	test("a lock it cannot create at all is busy, not a throw", () =>
		withDir(dir => {
			writeFileSync(join(dir, "file"), "x");
			expect(withRosterLock(join(dir, "file", "sub"), () => 1, 50)).toEqual({ busy: true });
		}));
	test("a lock whose holder process is dead is taken at once, however fresh", () =>
		withDir(dir => {
			const dead = Bun.spawnSync({ cmd: [process.execPath, "-e", "0"] }).pid;
			writeFileSync(join(dir, "roster.lock"), `${dead}-token`);
			const t0 = Date.now();
			expect(withRosterLock(dir, () => "got it", 5000)).toEqual({ value: "got it" });
			expect(Date.now() - t0).toBeLessThan(1000);
			expect(existsSync(join(dir, "roster.lock"))).toBe(false);
		}));
	test("a fresh lock whose holder is alive is busy", () =>
		withDir(dir => {
			writeFileSync(join(dir, "roster.lock"), `${process.pid}-token`);
			expect(withRosterLock(dir, () => 1, 50)).toEqual({ busy: true });
		}));
	test("the token a holder writes starts with its pid", () =>
		withDir(dir => {
			withRosterLock(dir, () => expect(readFileSync(join(dir, "roster.lock"), "utf8")).toStartWith(`${process.pid}-`));
		}));
	test("EEXIST retries everywhere; EPERM and EACCES only on win32 (a lock mid-delete there)", () => {
		expect(retryable("EEXIST", "linux")).toBe(true);
		for (const code of ["EPERM", "EACCES"]) {
			expect(retryable(code, "win32")).toBe(true);
			expect(retryable(code, "linux")).toBe(false);
		}
		expect(retryable("ENOENT", "win32")).toBe(false);
		expect(retryable(undefined, "win32")).toBe(false);
	});
});

describe("updateRoster", () => {
	const withDir = (fn: (dir: string) => void) => {
		const dir = mkdtempSync(join(tmpdir(), "st-upd-"));
		try {
			fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	test("creates the file from nothing and applies fn", () =>
		withDir(dir => {
			expect(updateRoster(dir, () => map({ Lorenzo: { passed: 1 } }))).toBeUndefined();
			expect(loadRoster(dir)).toEqual({ brothers: map({ Lorenzo: { passed: 1 } }) });
			expect(existsSync(join(dir, "roster.lock"))).toBe(false);
		}));
	test("reads the current file, so two updates accumulate", () =>
		withDir(dir => {
			const inc = (b: Record<string, Service>) => map({ Lorenzo: { passed: (b.Lorenzo?.passed ?? 0) + 1 } });
			updateRoster(dir, inc);
			updateRoster(dir, inc);
			expect((loadRoster(dir) as { brothers: Record<string, Service> }).brothers.Lorenzo?.passed).toBe(2);
		}));
	test("an unreadable roster is refused and left byte-identical", () =>
		withDir(dir => {
			writeFileSync(join(dir, "roster.json"), "{corrupt");
			let called = false;
			const err = updateRoster(dir, b => ((called = true), b));
			expect(err).toContain("unreadable");
			expect(called).toBe(false);
			expect(readFileSync(join(dir, "roster.json"), "utf8")).toBe("{corrupt");
			expect(existsSync(join(dir, "roster.lock"))).toBe(false);
		}));
	test("a busy lock returns 'roster busy' and writes nothing", () =>
		withDir(dir => {
			writeFileSync(join(dir, "roster.lock"), "other");
			expect(updateRoster(dir, () => map({ Lorenzo: {} }), 50)).toBe("roster busy");
			expect(existsSync(join(dir, "roster.json"))).toBe(false);
		}));
	test("a throwing fn comes back as a message, never thrown, and frees the lock", () =>
		withDir(dir => {
			expect(
				updateRoster(dir, () => {
					throw new Error("kaput");
				}),
			).toContain("kaput");
			expect(existsSync(join(dir, "roster.lock"))).toBe(false);
		}));
	test("a write that cannot happen (roster.json is a directory) is a message, not a throw", () =>
		withDir(dir => {
			mkdirSync(join(dir, "roster.json"));
			expect(typeof updateRoster(dir, b => b)).toBe("string");
		}));
});

describe("squadBrothers (#135)", () => {
	const rec = map({ Lorenzo: { passed: 10, purity: 4, halo: 1, laurel: 1 }, Gideon: { falls: 3 } });
	test("takes the last spawned builder of each squad: Brother, then Penitent, then Veteran", () => {
		const names = [
			builder("a", "Lorenzo"),
			builder("a", "Lorenzo", { name: "PenitentLorenzo" }),
			veteran("a", "Lorenzo"),
			builder("b", "Gideon"),
		];
		const r = squadBrothers(names, rec);
		expect(r.a?.name).toBe("VeteranLorenzo");
		expect(r.b?.name).toBe("BrotherGideon");
		expect(r.a).toMatchObject({ surname: "Lorenzo", service: rec.Lorenzo, crux: true });
		expect(r.b).toMatchObject({ surname: "Gideon", corrupted: true });
		expect(r.b?.crux).toBeUndefined();
	});
	test("an unspawned builder is shown only when no spawned one exists", () => {
		const names = [builder("a", "Lorenzo"), builder("a", "Lorenzo", { name: "PenitentLorenzo", spawned: undefined })];
		expect(squadBrothers(names, rec).a?.name).toBe("BrotherLorenzo");
		expect(squadBrothers([builder("a", "Leon", { spawned: undefined })], rec).a?.name).toBe("BrotherLeon");
	});
	test("ignores retired and non-builder entries", () => {
		const names: NameEntry[] = [
			builder("a", "Lorenzo", { old: true }),
			{ name: "ScoutTelion", agent: "scout", surname: "Telion", squad: "z", spawned: true },
			{ name: "LibrarianStern", agent: "librarian", surname: "Stern", spawned: true },
		];
		expect(Object.keys(squadBrothers(names, rec))).toEqual([]);
	});
	test("a recruit and an unreadable roster have no service; undefined names give nothing", () => {
		expect(squadBrothers([builder("a", "Leon")], rec).a?.service).toBeUndefined();
		expect(squadBrothers([builder("a", "Lorenzo")], undefined).a).toMatchObject({ name: "BrotherLorenzo", surname: "Lorenzo" });
		expect(squadBrothers([builder("a", "Lorenzo")], undefined).a?.service).toBeUndefined();
		expect(squadBrothers(undefined, rec)).toEqual({});
	});
	test("a surname of __proto__ or constructor is not an inherited record", () => {
		const r = squadBrothers([builder("a", "__proto__"), builder("b", "constructor")], {} as Brothers);
		expect(r.a?.service).toBeUndefined();
		expect(r.b?.service).toBeUndefined();
		expect(squadBrothers([builder("__proto__", "Leon")], rec).__proto__?.name).toBe("BrotherLeon");
	});
	test("property: the result never holds a retired or non-builder entry", () => {
		// properties: no property-test library in the repo, so a seeded walk stands in for fast-check.
		let seed = 7;
		const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
		const agents = ["battle-brother", "veteran", "scout", "librarian"];
		for (let i = 0; i < 200; i++) {
			const names: NameEntry[] = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, n) => ({
				name: `X${i}n${n}`,
				agent: agents[Math.floor(rnd() * 4)] as string,
				surname: "Leon",
				squad: ["a", "b"][Math.floor(rnd() * 2)],
				...(rnd() < 0.5 ? { spawned: true as const } : {}),
				...(rnd() < 0.4 ? { old: true as const } : {}),
			}));
			for (const b of Object.values(squadBrothers(names, undefined))) {
				const e = names.find(x => x.name === b.name);
				expect(e && !e.old && (e.agent === "battle-brother" || e.agent === "veteran")).toBe(true);
			}
		}
	});
});

describe("honours (#135)", () => {
	const out = (brother: string, squad: string, kind: Outcome["kind"], penances = 0): Outcome => ({ brother, squad, kind, penances });
	test("first gives the Purity Seal, saved the Iron Halo, fell a fall and nothing", () => {
		const h = honours([out("Leon", "a", "first"), out("Tycho", "b", "saved", 1), out("Dante", "c", "fell", 2)], false, map({}));
		expect(h.map(x => [x.brother, x.squad, x.kind, x.penances, x.earned])).toEqual([
			["Leon", "a", "first", 0, ["Purity Seal"]],
			["Tycho", "b", "saved", 1, ["Iron Halo"]],
			["Dante", "c", "fell", 2, []],
		]);
	});
	test("a merge with every squad on its first build gives each brother the Laurel", () => {
		const h = honours([out("Leon", "a", "first"), out("Tycho", "b", "first")], true, map({}));
		expect(h.map(x => x.earned)).toEqual([["Purity Seal", "Laurel Imperialis"], ["Purity Seal", "Laurel Imperialis"]]);
		expect(honours([out("Leon", "a", "first"), out("Tycho", "b", "penance", 1)], true, map({})).flatMap(x => x.earned)).toEqual(["Purity Seal"]);
	});
	test("a brother with two squads gets the Laurel once, on his first row", () => {
		const h = honours([out("Leon", "a", "first"), out("Leon", "b", "first")], true, map({}));
		expect(h.map(x => x.earned)).toEqual([["Purity Seal", "Laurel Imperialis"], ["Purity Seal"]]);
	});
	test("the Crux is earned at 9 to 10 passed and not at 10 to 11", () => {
		expect(honours([out("Leon", "a", "first")], false, map({ Leon: { passed: 9 } }))[0]?.earned).toEqual(["Purity Seal", "Crux Terminatus"]);
		expect(honours([out("Leon", "a", "first")], false, map({ Leon: { passed: 10 } }))[0]?.earned).toEqual(["Purity Seal"]);
		expect(honours([out("Leon", "a", "saved", 1)], false, map({ Leon: { passed: 8 } }))[0]?.earned).toEqual(["Iron Halo", "Crux Terminatus"]);
	});
	test("corrupted is set only on the false to true transition", () => {
		const fall = [out("Leon", "a", "fell")];
		expect(honours(fall, false, map({ Leon: { falls: 2 } }))[0]?.corrupted).toBe(true);
		expect(honours(fall, false, map({ Leon: { falls: 3 } }))[0]?.corrupted).toBeUndefined();
		expect(honours(fall, false, map({ Leon: { falls: 0 } }))[0]?.corrupted).toBeUndefined();
		expect(honours([out("Leon", "a", "penance", 2)], false, map({ Leon: { squads: 4, passed: 1, penances: 1 } }))[0]?.corrupted).toBe(true);
	});
	test("joined is set only for a brother absent from before, and only on his first row", () => {
		const h = honours([out("Leon", "a", "first"), out("Leon", "b", "first"), out("Tycho", "c", "first")], false, map({ Tycho: {} }));
		expect(h.map(x => x.joined)).toEqual([true, undefined, undefined]);
		expect(honours([out("__proto__", "a", "first")], false, {} as Brothers)[0]?.joined).toBe(true);
	});
	test("with before undefined there is no joined, Crux or corrupted", () => {
		const h = honours([out("Leon", "a", "first"), out("Tycho", "b", "fell")], true, undefined);
		expect(h.map(x => [x.joined, x.corrupted, x.earned.includes("Crux Terminatus")])).toEqual([[undefined, undefined, false], [undefined, undefined, false]]);
		expect(h[0]?.earned).toEqual(["Purity Seal"]);
	});
	test("property: counts equal the applyRun diff, and without before there is no joined, Crux or corrupted", () => {
		let seed = 11;
		const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
		const kinds = ["first", "penance", "saved", "fell"] as const;
		const who = ["Leon", "Tycho", "Dante"];
		for (let i = 0; i < 300; i++) {
			const before = map(
				Object.fromEntries(
					who
						.filter(() => rnd() < 0.6)
						.map(n => [n, { passed: Math.floor(rnd() * 12), falls: Math.floor(rnd() * 4), squads: Math.floor(rnd() * 7), penances: Math.floor(rnd() * 7), purity: 1 }]),
				),
			);
			const outcomes = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, n) =>
				out(who[Math.floor(rnd() * 3)] as string, `s${n}`, kinds[Math.floor(rnd() * 4)] as Outcome["kind"], Math.floor(rnd() * 3)),
			);
			const merged = rnd() < 0.5;
			const after = applyRun(before, outcomes, merged);
			const rows = honours(outcomes, merged, before);
			for (const n of who) {
				const mine = rows.filter(r => r.brother === n);
				if (!mine.length) continue;
				const b = before[n] ?? svc();
				const a = after[n] as Service;
				const got = (k: string) => mine.filter(r => r.earned.includes(k as never)).length;
				expect(got("Purity Seal")).toBe(a.purity - b.purity);
				expect(got("Iron Halo")).toBe(a.halo - b.halo);
				expect(got("Laurel Imperialis")).toBe(a.laurel - b.laurel);
				expect(got("Crux Terminatus")).toBe(crux(a) && !crux(b) ? 1 : 0);
				expect(mine.filter(r => r.corrupted).length).toBe(corrupted(a) && !corrupted(b) ? 1 : 0);
				expect(mine.filter(r => r.kind === "fell").length).toBe(outcomes.filter(o => o.brother === n && o.kind === "fell").length);
			}
			for (const r of honours(outcomes, merged, undefined)) {
				expect(r.joined).toBeUndefined();
				expect(r.corrupted).toBeUndefined();
				expect(r.earned).not.toContain("Crux Terminatus");
			}
		}
	});
});
