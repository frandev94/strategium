import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addResults, KINDS, loadTally, parseTally, proposals, type Result, serializeTally, squadKind, type TallyRow, tallyLines, updateTally } from "./tally";

const row = (o: Partial<TallyRow> = {}): TallyRow => ({ model: "@task", effort: "medium", kind: "code", proven: 0, regression: 0, corrupted: 0, ...o });
const res = (o: Partial<Result> = {}): Result => ({ model: "@task", effort: "medium", kind: "code", rating: "proven", ...o });
const LADDER = [
	{ tier: "light", selector: "@smol:medium" },
	{ tier: "standard", selector: "@task:medium" },
	{ tier: "heavy", selector: "@slow:high" },
];
const withDir = (fn: (dir: string) => void) => {
	const dir = mkdtempSync(join(tmpdir(), "st-tally-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};
/** Seeded generator and a random list of results, standing in for a property library. */
const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
const walk = (pick: () => number, max: number, tiers: [string, string][] = [["@a", "low"], ["@b", "high"], ["@c", "default"]]): Result[] =>
	Array.from({ length: Math.floor(pick() * max) }, () => {
		const [model, effort] = tiers[Math.floor(pick() * tiers.length)]!;
		return res({ model, effort, kind: KINDS[Math.floor(pick() * 4)]!, rating: (["proven", "proven-regression", "corrupted"] as const)[Math.floor(pick() * 3)]! });
	});
const text = (rows: unknown[], version: unknown = 1) => JSON.stringify({ version, rows });

test("squadKind: a nested .github/workflows path is a workflow (CN4)", () => {
	expect(squadKind(["pkg/.github/workflows/ci.yml"])).toBe("workflow");
});
describe("squadKind (D4)", () => {
	test("docs: every file is prose", () => expect(squadKind(["README.md", "docs/a.TXT", "b.rst"])).toBe("docs"));
	test("ui: any markup or style file, none of them a workflow", () => expect(squadKind(["src/a.ts", "src/App.tsx"])).toBe("ui"));
	test("workflow: a file under .github/workflows or .gitlab-ci.yml wins", () => {
		expect(squadKind([".github/workflows/ci.yml", "a.tsx"])).toBe("workflow");
		expect(squadKind(["x/.gitlab-ci.yml"])).toBe("workflow");
	});
	test("code: a mixed docs and code squad", () => expect(squadKind(["README.md", "src/a.ts"])).toBe("code"));
	test("Windows backslash paths and case are read the same", () => {
		expect(squadKind([".GitHub\\Workflows\\ci.yml"])).toBe("workflow");
		expect(squadKind(["docs\\A.MD"])).toBe("docs");
	});
	test("no files is code", () => expect(squadKind([])).toBe("code"));
});

describe("addResults", () => {
	test("counts each rating, starts a new key at zero, sorts by model, effort, kind", () => {
		const out = addResults(
			[row({ model: "@task", proven: 1 })],
			[res({ model: "@smol", kind: "docs", rating: "corrupted" }), res({ rating: "proven-regression" }), res({ rating: "proven" }), res({ effort: "high", rating: "proven" })],
		);
		expect(out).toEqual([
			row({ model: "@smol", kind: "docs", corrupted: 1 }),
			row({ model: "@task", effort: "high", proven: 1 }),
			row({ model: "@task", proven: 2, regression: 1 }),
		]);
	});
	test("does not mutate its input", () => {
		const rows = [row({ proven: 1 })];
		addResults(rows, [res()]);
		expect(rows[0]!.proven).toBe(1);
	});
	test("a counter stops at MAX_SAFE_INTEGER", () => {
		expect(addResults([row({ proven: Number.MAX_SAFE_INTEGER })], [res()])[0]!.proven).toBe(Number.MAX_SAFE_INTEGER);
	});
	test("properties (seeded walk, no property library): adds exactly results.length and never lowers a counter", () => {
		const pick = rng(7);
		const sum = (rs: TallyRow[]) => rs.reduce((n, r) => n + r.proven + r.regression + r.corrupted, 0);
		for (let i = 0; i < 200; i++) {
			const before = addResults([], walk(pick, 20));
			const more = walk(pick, 20);
			const after = addResults(before, more);
			expect(sum(after)).toBe(sum(before) + more.length);
			for (const r of before) {
				const n = after.find(x => x.model === r.model && x.effort === r.effort && x.kind === r.kind)!;
				expect([n.proven >= r.proven, n.regression >= r.regression, n.corrupted >= r.corrupted]).toEqual([true, true, true]);
			}
		}
	});
});

describe("parseTally / serializeTally (D2)", () => {
	test("round trip, ending with a newline", () => {
		const rows = [row({ model: "@smol", kind: "docs", corrupted: 2 }), row({ proven: 3, regression: 1 })];
		const s = serializeTally(rows);
		expect(s.endsWith("\n")).toBe(true);
		expect(parseTally(s)).toEqual({ rows });
	});
	test("properties (seeded walk): parse(serialize(rows)) returns the rows", () => {
		const pick = rng(11);
		for (let i = 0; i < 100; i++) {
			const rows = addResults([], walk(pick, 30));
			expect(parseTally(serializeTally(rows))).toEqual({ rows });
		}
	});
	test("an empty tally parses", () => expect(parseTally(text([]))).toEqual({ rows: [] }));
	const refused: [string, string][] = [
		["oversize", `{"version":1,"rows":[],"pad":"${"x".repeat(256 * 1024)}"}`],
		["not JSON", "{nope"],
		["not an object", "[]"],
		["version 2", text([], 2)],
		["rows not an array", JSON.stringify({ version: 1, rows: {} })],
		["row not an object", text([5])],
		["model with a newline", text([row({ model: "a\nb" })])],
		["empty model", text([row({ model: "" })])],
		["model too long", text([row({ model: "m".repeat(61) })])],
		["bad effort", text([row({ effort: "High!" })])],
		["unknown kind", text([{ ...row(), kind: "other" }])],
		["negative counter", text([row({ proven: -1 })])],
		["fractional counter", text([row({ corrupted: 1.5 })])],
		["string counter", text([{ ...row(), regression: "1" }])],
		["unsafe counter", text([row({ proven: 2 ** 53 })])],
		["duplicate row", text([row(), row({ proven: 1 })])],
	];
	for (const [name, body] of refused) test(`refuses the whole file: ${name}`, () => expect(parseTally(body)).toHaveProperty("error"));
	test("the size limit counts bytes, not characters (multibyte model names)", () =>
		expect(parseTally(`{"version":1,"rows":[],"pad":"${"é".repeat(140_000)}"}`)).toEqual({ error: "larger than 256 KiB" }));
});

describe("loadTally", () => {
	test("a missing file is an empty tally", () => withDir(dir => expect(loadTally(dir)).toEqual({ rows: [] })));
	test("a bad file is an error, not a throw", () =>
		withDir(dir => {
			writeFileSync(join(dir, "tally.json"), "{nope");
			expect(loadTally(dir)).toHaveProperty("error");
		}));
	test("a directory in its place is an error, not a throw", () =>
		withDir(dir => {
			mkdirSync(join(dir, "tally.json"));
			expect(loadTally(dir)).toHaveProperty("error");
		}));
});

describe("updateTally", () => {
	test("refuses to write what the next load would refuse: tally invalid, file untouched", () =>
		withDir(dir => {
			expect(updateTally(dir, () => [row({ effort: "High!" })])).toBe("tally invalid (row 0: bad effort)");
			expect(existsSync(join(dir, "tally.json"))).toBe(false);
		}));
	test("writes the new rows and releases the lock", () =>
		withDir(dir => {
			expect(updateTally(dir, rows => addResults(rows, [res()]))).toBeUndefined();
			expect(loadTally(dir)).toEqual({ rows: [row({ proven: 1 })] });
			expect(updateTally(dir, rows => addResults(rows, [res({ rating: "corrupted" })]))).toBeUndefined();
			expect(loadTally(dir)).toEqual({ rows: [row({ proven: 1, corrupted: 1 })] });
			expect(existsSync(join(dir, "roster.lock"))).toBe(false);
		}));
	test("an unreadable file is refused with the reason and its bytes are unchanged", () =>
		withDir(dir => {
			const file = join(dir, "tally.json");
			writeFileSync(file, "{nope");
			const why = updateTally(dir, rows => addResults(rows, [res()]));
			expect(why).toMatch(/^tally unreadable \(.+\)$/);
			expect(readFileSync(file, "utf8")).toBe("{nope");
		}));
	test("a lock held by a live pid is busy and nothing is written", () =>
		withDir(dir => {
			writeFileSync(join(dir, "roster.lock"), `${process.pid}-held`);
			expect(updateTally(dir, rows => addResults(rows, [res()]), 50)).toBe("tally busy");
			expect(existsSync(join(dir, "tally.json"))).toBe(false);
		}));
	test("a throwing fn comes back as a reason and writes nothing", () =>
		withDir(dir => {
			const why = updateTally(dir, () => {
				throw new Error("boom");
			});
			expect(why).toBe("boom");
			expect(existsSync(join(dir, "tally.json"))).toBe(false);
			expect(existsSync(join(dir, "roster.lock"))).toBe(false);
		}));
});

describe("tallyLines", () => {
	test("one TALLY line per row", () =>
		expect(tallyLines([row({ proven: 3, regression: 1, corrupted: 2 })])).toEqual(["TALLY @task medium code: proven 3, proven-regression 1, corrupted 2"]));
	test("no rows, no lines", () => expect(tallyLines([])).toEqual([]));
});

describe("proposals (D7)", () => {
	test("light failing 2 of 3 proposes standard", () =>
		expect(proposals([row({ model: "@smol", kind: "docs", proven: 1, corrupted: 2 })], LADDER)).toEqual([
			"PROPOSE docs squads: default tier standard (now light: @smol medium corrupted 2 of 3)",
		]));
	test("2 of 4 is not a majority", () => expect(proposals([row({ model: "@smol", proven: 2, corrupted: 2 })], LADDER)).toEqual([]));
	test("fewer than 3 results is not enough", () => expect(proposals([row({ model: "@smol", corrupted: 2 })], LADDER)).toEqual([]));
	test("heavy failing proposes nothing", () => expect(proposals([row({ model: "@slow", effort: "high", corrupted: 5 })], LADDER)).toEqual([]));
	test("CB1: a lone result at standard does not mute the proposal", () =>
		expect(proposals([row({ model: "@smol", corrupted: 3 }), row({ proven: 1 })], LADDER)).toEqual([
			"PROPOSE code squads: default tier standard (now light: @smol medium corrupted 3 of 3)",
		]));
	test("CB1: standard with 3 results (adopted): no proposal", () =>
		expect(proposals([row({ model: "@smol", corrupted: 3 }), row({ proven: 3 })], LADDER)).toEqual([]));
	test("CB1: a standard row with results of another kind does not silence the kind", () =>
		expect(proposals([row({ model: "@smol", corrupted: 3 }), row({ kind: "docs", proven: 1 })], LADDER)).toHaveLength(1));
	test("CB1: then standard failing proposes heavy", () =>
		expect(proposals([row({ model: "@smol", corrupted: 3 }), row({ proven: 1, corrupted: 3 })], LADDER)).toEqual([
			"PROPOSE code squads: default tier heavy (now standard: @task medium corrupted 3 of 4)",
		]));
	test("an unmapped model proposes nothing", () => expect(proposals([row({ model: "hand-typed", corrupted: 5 })], LADDER)).toEqual([]));
	test("effort default maps to a selector without a colon", () =>
		expect(proposals([row({ model: "@smol", effort: "default", corrupted: 3 })], [{ tier: "light", selector: "@smol" }, { tier: "standard", selector: "@task" }])).toEqual([
			"PROPOSE code squads: default tier standard (now light: @smol default corrupted 3 of 3)",
		]));
	test("light and standard both failing for a kind give one line proposing heavy", () =>
		expect(proposals([row({ model: "@smol", corrupted: 3 }), row({ corrupted: 4 })], LADDER)).toEqual([
			"PROPOSE code squads: default tier heavy (now standard: @task medium corrupted 4 of 4)",
		]));
	test("each kind gets its own line, in kind order", () =>
		expect(proposals([row({ model: "@smol", kind: "ui", corrupted: 3 }), row({ model: "@smol", kind: "code", corrupted: 3 })], LADDER).map(l => l.split(" ")[1])).toEqual(["code", "ui"]));
	test("properties (seeded walk): never proposes a tier at or below the failing one", () => {
		const pick = rng(13);
		const names = LADDER.map(l => l.tier);
		for (let i = 0; i < 200; i++) {
			const rows = addResults([], walk(pick, 40, LADDER.map(l => l.selector.split(":") as [string, string])));
			for (const line of proposals(rows, LADDER)) {
				const m = /default tier (\w+) \(now (\w+):/.exec(line)!;
				expect(names.indexOf(m[1]!)).toBeGreaterThan(names.indexOf(m[2]!));
			}
		}
	});
});
