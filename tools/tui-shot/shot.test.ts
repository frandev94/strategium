import { expect, test } from "bun:test";
import { allExit, type Args, parseArgs, parseSnaps, rec, type Row, Snap, squadMarks, tableRow, TABLE_HEAD, unifiedDiff } from "./shot";

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
