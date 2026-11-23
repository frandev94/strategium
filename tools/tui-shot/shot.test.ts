import { expect, test } from "bun:test";
import { allExit, type Args, CASTER_TEXT, casterEnv, namesEnv, parseArgs, replayCaster, parseSnaps, rec, relicEnv, REPLAYS, snapOf, type Row, Snap, squadMarks, tableRow, TABLE_HEAD, unifiedDiff } from "./shot";

const args = (argv: string[]) => {
	const a = parseArgs(argv);
	if ("error" in a) throw new Error(a.error);
	return a;
};
const snap = (rows: string[][], wide: [number, number][] = []) =>
	new Snap({ name: "t", type: "normal", cols: rows[0].length, rows: rows.length, cells: rows, wide });

test("parseArgs defaults", () => {
	const a: Args = args([]);
	expect(a.seed).toBe("scriptorium");
	expect(a.ponytail).toBeNull();
	expect(a.suffix).toBeNull();
	expect(a.replay).toBeNull();
	expect([a.noPng, a.allPng, a.all, a.keepWork, a.help]).toEqual([false, false, false, false, false]);
	expect(a.out.endsWith("strategium-tui-shot")).toBe(true);
});

test("parseArgs takes --x=v and --x v alike", () => {
	expect(args(["--seed=skirmish", "--replay", "q-close", "--no-png"])).toMatchObject({ seed: "skirmish", replay: "q-close", noPng: true });
	expect(args(["--suffix=-x"]).suffix).toBe("-x"); // = form takes a value that starts with "-"
});

test("parseArgs --ponytail: bare, =DIR, DIR, and bare before a flag", () => {
	expect(args(["--ponytail"]).ponytail).toBe(true);
	expect(args(["--ponytail=C:/p"]).ponytail).toBe("C:/p");
	expect(args(["--ponytail", "C:/p"]).ponytail).toBe("C:/p");
	expect(args(["--ponytail", "--all"])).toMatchObject({ ponytail: true, all: true });
});

test("parseArgs --relic: a plain flag, off by default, no value", () => {
	expect(args([]).relic).toBe(false);
	expect(args(["--relic"]).relic).toBe(true);
	expect(args(["--relic", "--all"])).toMatchObject({ relic: true, all: true });
	for (const v of ["=1", "=0", "=2"]) expect(parseArgs([`--relic${v}`])).toHaveProperty("error", expect.stringContaining("--relic"));
});

test("relicEnv always pins STRATEGIUM_RELIC, so a user's own value never changes a shot", () => {
	expect(relicEnv(false)).toEqual({ STRATEGIUM_RELIC: "0" });
	expect(relicEnv(true)).toEqual({ STRATEGIUM_RELIC: "1" });
});

test("parseArgs --caster: off by default, bare = default text, =TEXT and TEXT, bare before a flag", () => {
	expect(args([]).caster).toBeNull();
	expect(args(["--caster"]).caster).toBe(CASTER_TEXT);
	expect(args(["--caster=Alpha is green"]).caster).toBe("Alpha is green");
	expect(args(["--caster", "Alpha is green"]).caster).toBe("Alpha is green");
	expect(args(["--caster", "--all"])).toMatchObject({ caster: CASTER_TEXT, all: true });
});

test("casterEnv always pins STRATEGIUM_CASTER and its fake text, so a user's own values never change a shot", () => {
	expect(casterEnv(null)).toEqual({ STRATEGIUM_CASTER: "0", STRATEGIUM_CASTER_FAKE: "" });
	expect(casterEnv("Alpha is green")).toEqual({ STRATEGIUM_CASTER: "1", STRATEGIUM_CASTER_FAKE: "Alpha is green" });
});

test("replayCaster: a caster scenario keeps its own text whatever --caster says, the others follow the flag", () => {
	expect(replayCaster({ caster: true }, "OTHER")).toBe(CASTER_TEXT);
	expect(replayCaster({ caster: true }, null)).toBe(CASTER_TEXT);
	expect(replayCaster({}, "OTHER")).toBe("OTHER");
	expect(replayCaster({}, null)).toBeNull();
});

test("the caster-box replay is registered on the skirmish seed and always runs with the caster", () => {
	expect(REPLAYS["caster-box"]).toMatchObject({ seed: "skirmish", kind: "FIXED", caster: true });
});

test("namesEnv always pins STRATEGIUM_NAMES, so a user's own value never changes a shot", () => {
	expect(namesEnv(false)).toEqual({ STRATEGIUM_NAMES: "0" });
	expect(namesEnv(true)).toEqual({ STRATEGIUM_NAMES: "1" });
});

test("only the cockpit-names replay runs with names on", () => {
	expect(REPLAYS["cockpit-names"]).toMatchObject({ r: "#135", seed: "names", kind: "FIXED", ext: true, names: true });
	expect(Object.entries(REPLAYS).filter(([, sc]) => sc.names).map(([n]) => n)).toEqual(["cockpit-names"]);
});

test("parseArgs rejects an unknown flag, a missing value and a bad seed", () => {
	expect(parseArgs(["--bogus"])).toEqual({ error: "unrecognized arguments: --bogus" });
	expect(parseArgs(["--rep=q-close"])).toHaveProperty("error"); // no prefix abbreviations
	expect(parseArgs(["--replay"])).toEqual({ error: "argument --replay: expected one argument" });
	expect(parseArgs(["--seed=nope"])).toHaveProperty("error", expect.stringContaining("invalid choice: 'nope'"));
});

test("Snap.colOf counts a wide cell's continuation as no text", () => {
	const s = snap([["漢", "", "a", "b", " "]], [[0, 0]]);
	expect(s.colOf(0, "ab")).toBe(2);
	expect(s.colOf(0, "漢")).toBe(0);
	expect(s.colOf(0, "zz")).toBe(-1);
});

test("Snap row helpers: lastCol, where, framed, wideCells", () => {
	const s = snap([["╔", "═", "x", " "], [" ", "a", " ", " "], [" ", " ", " ", " "]], [[1, 1], [0, 2]]);
	expect(s.lastCol(0)).toBe(2);
	expect(s.lastCol(2)).toBe(-1);
	expect(s.where("a")).toBe(1);
	expect(s.where("zz")).toBe(-1);
	expect(s.framed()).toBe(true);
	expect(snap([[" ", "╔"]]).framed()).toBe(false);
	expect(s.wideCells()).toEqual([[0, 2], [1, 1]]);
	expect(s.wideCells(1, 2)).toEqual([[1, 1]]);
	expect(s.dump()).toEqual([" 0 |╔═x", " 1 | a"]);
});

test("parseSnaps reads the HTML-escaped dump Edge writes", () => {
	const d = [{ name: "open", type: "alternate", cols: 3, rows: 1, cells: [["<", "&", "\u00a0"]], wide: [] }];
	const dom = `<html><body data-done="1"><div id="term"></div><pre id="dump">${JSON.stringify(d).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\u00a0/g, "&nbsp;")}</pre></body></html>`;
	const snaps = parseSnaps(dom);
	expect([...snaps.keys()]).toEqual(["open"]);
	expect(snaps.get("open")!.cells[0]).toEqual(["<", "&", "\u00a0"]);
	expect(parseSnaps('<pre id="dump"></pre>').size).toBe(0);
});

test("unifiedDiff: header, hunk range and 3 lines of context", () => {
	const a = ["1", "2", "3", "4", "5", "6", "7", "8"], b = [...a];
	b[4] = "five";
	expect(unifiedDiff(a, b, "expected", "got")).toEqual(["--- expected", "+++ got", "@@ -2,7 +2,7 @@", " 2", " 3", " 4", "-5", "+five", " 6", " 7", " 8"]);
	expect(unifiedDiff(a, a, "expected", "got")).toEqual([]);
	expect(unifiedDiff([], ["x"], "expected", "got")).toEqual(["--- expected", "+++ got", "@@ -0,0 +1 @@", "+x"]);
});

test("table rows pad to 24/6/5/6 and --all ignores OPEN rows", () => {
	const rows: Row[] = [["q-close", "R19", "FIXED", "PASS", null], ["ponytail-notice", "R16", "OPEN", "SKIP", "ponytail plugin not found"]];
	expect(TABLE_HEAD).toBe("scenario                 | R      | kind  | result | first failing check");
	expect(tableRow(rows[0])).toBe("q-close                  | R19    | FIXED | PASS   | ");
	expect(allExit(rows)).toBe(0);
	expect(allExit([...rows, ["capslock-altc", "R1", "KNOWN", "FAIL", "no cockpit"]])).toBe(1);
});

test("rec() writes a win32-input-mode record", () => {
	expect(rec(67, 46, 99, 1, 2)).toBe("\x1b[67;46;99;1;2;1_");
});

test("squadMarks reads ▷ as ▶ and sorts by squad", () => {
	const s = snap([[..."║ ▷ ⛨ squad gamma forging"], [..."║ ✓ ⛨ squad beta returned "]]);
	expect(squadMarks(s)).toEqual([["✓", "⛨", "beta", "returned"], ["▶", "⛨", "gamma", "forging"]]);
});

test("parseArgs: a value flag followed by a flag is an error; -h wins even with a bad seed", () => {
	expect(parseArgs(["--replay", "--all"])).toEqual({ error: "argument --replay: expected one argument" });
	expect(parseArgs(["--seed=nope", "-h"])).toMatchObject({ help: true });
});

test("unifiedDiff merges changes 6 equal lines apart into one hunk and splits them at 7 (difflib n=3)", () => {
	const mk = (gap: number) => {
		const a = Array.from({ length: gap + 10 }, (_, i) => String(i)), b = [...a];
		b[3] = "x";
		b[3 + gap + 1] = "y";
		return unifiedDiff(a, b, "e", "g").filter(l => l.startsWith("@@")).length;
	};
	expect(mk(6)).toBe(1);
	expect(mk(7)).toBe(2);
});

test("snapOf names the missing checkpoint and the ones it has", () => {
	const C = { s: new Map([["a", snap([["x"]])], ["b", snap([["y"]])]]) } as any;
	expect(snapOf(C, "a")).toBe(C.s.get("a"));
	expect(() => snapOf(C, "zz")).toThrow('no snapshot "zz" (have: a, b)');
});
