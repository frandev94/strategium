import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NameEntry } from "./names";
import {
	applyRun,
	corrupted,
	crux,
	loadRoster,
	parseRoster,
	rankBrothers,
	runOutcomes,
	type Service,
	serializeRoster,
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
