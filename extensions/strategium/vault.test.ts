import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_FILE, type Contract, type ContractResult, formatLine, insertUnder, loadContract, recordLine } from "./vault";

// Seeded LCG so draws are reproducible.
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

let root: string;
let vault: string;
let state: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "vault-test-"));
	vault = join(root, "vault");
	state = join(root, "state");
	mkdirSync(vault);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const GOOD = { daily: "Daily/{date}.md", heading: "## 📝 Log", line: "- {time} - Strategium {key}: {text}" };
const put = (obj: unknown) => writeFileSync(join(vault, CONTRACT_FILE), typeof obj === "string" ? obj : JSON.stringify(obj));
const err = (r: ContractResult) => ("error" in r ? r.error : undefined);
const DAILY_BAD = "contract invalid: daily must be a relative .md path with {date} inside the vault";
const HEADING_BAD = "contract invalid: heading must be one markdown heading line (# to ######)";
const LINE_BAD = "contract invalid: line must be one line with {text}, only {time} {key} {text}, not starting with #";

describe("loadContract", () => {
	test("accepts the documented example and ignores unknown keys", () => {
		put({ ...GOOD, notes: ["x"] });
		expect(loadContract(vault)).toEqual({ contract: GOOD });
	});

	test("reports an unreachable vault", () => {
		expect(err(loadContract(join(root, "nope")))).toBe("unreachable (ENOENT)");
		writeFileSync(join(root, "file"), "x");
		expect(err(loadContract(join(root, "file")))).toBe("unreachable (not a folder)");
	});

	test("reports a missing contract", () => {
		expect(err(loadContract(vault))).toBe("no contract (.strategium.json)");
	});

	test("refuses a contract that is not a regular file", () => {
		mkdirSync(join(vault, CONTRACT_FILE));
		expect(err(loadContract(vault))).toBe("contract invalid: not a regular file");
	});

	test("refuses a contract larger than 16 KiB", () => {
		put(JSON.stringify({ ...GOOD, pad: "x".repeat(16 * 1024) }));
		expect(err(loadContract(vault))).toBe("contract invalid: larger than 16 KiB");
	});

	test("refuses non-JSON and non-object JSON", () => {
		put("{nope");
		expect(err(loadContract(vault))).toBe("contract invalid: not JSON");
		for (const body of ["null", "[]", '"x"', "3"]) {
			put(body);
			expect(err(loadContract(vault))).toBe("contract invalid: not an object");
		}
	});

	test.each([
		["/x/{date}.md"],
		["C:/x/{date}.md"],
		["\\\\srv\\{date}.md"],
		["../{date}.md"],
		["Daily/../{date}.md"],
		[".obsidian/{date}.md"],
		["Daily/.hidden/{date}.md"],
		[".strategium.json/{date}.md"],
		["Daily/{date}.txt"],
		["Daily/day.md"],
		["Daily//{date}.md"],
		["Daily/{date}.md/"],
		["Da:ily/{date}.md"],
		["Da<ily/{date}.md"],
		['Da"ily/{date}.md'],
		["Da|ily/{date}.md"],
		["Da?ily/{date}.md"],
		["Da*ily/{date}.md"],
		["Da\0ily/{date}.md"],
		[""],
		["x".repeat(201) + "{date}.md"],
	])("refuses daily %j", (daily) => {
		put({ ...GOOD, daily });
		expect(err(loadContract(vault))).toBe(DAILY_BAD);
	});

	test("refuses a non-string daily", () => {
		put({ ...GOOD, daily: 3 });
		expect(err(loadContract(vault))).toBe(DAILY_BAD);
		put({ heading: GOOD.heading, line: GOOD.line });
		expect(err(loadContract(vault))).toBe(DAILY_BAD);
	});

	test("accepts backslash separators and a {date} inside a name", () => {
		put({ ...GOOD, daily: "Journal\\{date}-log.md" });
		expect(err(loadContract(vault))).toBeUndefined();
	});

	test.each([["Log"], ["#Log"], ["####### Log"], ["## "], ["## a\nb"], ["## a\r"], [3], ["## " + "x".repeat(200)]])(
		"refuses heading %j",
		(heading) => {
			put({ ...GOOD, heading });
			expect(err(loadContract(vault))).toBe(HEADING_BAD);
		},
	);

	test.each([
		["- no text placeholder"],
		["- {text} {foo}"],
		["- {text} {Time}"],
		["# {text}"],
		["  # {text}"],
		["- {text}\n- {text}"],
		["x".repeat(300) + "{text}"],
		[7],
	])("refuses line %j", (line) => {
		put({ ...GOOD, line });
		expect(err(loadContract(vault))).toBe(LINE_BAD);
	});

	test("accepts every placeholder, repeated, and literal braces without a word", () => {
		put({ ...GOOD, line: "{time} {key} {text} {text} {} {1 2}" });
		expect(err(loadContract(vault))).toBeUndefined();
	});
});

describe("formatLine", () => {
	test("substitutes time, key and text", () => {
		expect(formatLine(GOOD.line, { time: "05:12", key: "151", text: "run begun" })).toBe("- 05:12 - Strategium 151: run begun");
	});

	test("makes values one line, trims and caps them", () => {
		expect(formatLine("{key}|{text}", { time: "t", key: "  a\r\n\nb ", text: "x\ny" })).toBe("a b|x y");
		expect(formatLine("{key}|{text}", { time: "t", key: "k".repeat(100), text: "t".repeat(300) })).toBe("k".repeat(64) + "|" + "t".repeat(200));
	});

	test("does not cut a surrogate pair in half", () => {
		const out = formatLine("{text}", { time: "t", key: "k", text: "a".repeat(199) + "😀" });
		expect(out).toBe("a".repeat(199));
	});

	test("property: one line, and a placeholder inside a value is never expanded", () => {
		const rnd = seeded(7);
		const bits = ["{text}", "{time}", "{key}", "x", " ", "\n", "\r\n", "{", "}", "é"];
		const val = () => Array.from({ length: Math.floor(rnd() * 8) }, () => bits[Math.floor(rnd() * bits.length)]).join("");
		const one = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
		for (let i = 0; i < 300; i++) {
			const v = { time: val(), key: val(), text: val() };
			const out = formatLine("{time}#{key}#{text}", v);
			expect(out).not.toMatch(/[\r\n]/);
			expect(out).toBe(`${one(v.time)}#${one(v.key).slice(0, 64)}#${one(v.text).slice(0, 200)}`);
		}
	});
});

describe("insertUnder", () => {
	const H = "## Log";
	const L = "- NEW";

	test("empty file gets heading and line", () => {
		expect(insertUnder("", H, L)).toBe("## Log\n- NEW\n");
	});

	test("missing heading appends a blank line, the heading and the line", () => {
		expect(insertUnder("# Day\ntext\n", H, L)).toBe("# Day\ntext\n\n## Log\n- NEW\n");
		expect(insertUnder("# Day\ntext\n\n", H, L)).toBe("# Day\ntext\n\n## Log\n- NEW\n");
		expect(insertUnder("# Day\ntext", H, L)).toBe("# Day\ntext\n\n## Log\n- NEW\n");
	});

	test("heading last goes right under it", () => {
		expect(insertUnder("# Day\n## Log\n", H, L)).toBe("# Day\n## Log\n- NEW\n");
		expect(insertUnder("# Day\n## Log\n- a\n", H, L)).toBe("# Day\n## Log\n- a\n- NEW\n");
		expect(insertUnder("## Log\n- a", H, L)).toBe("## Log\n- a\n- NEW\n");
	});

	test("a middle section stops before the next same-level heading, trailing blanks stay", () => {
		expect(insertUnder("## Log\n- a\n\n## Next\n- z\n", H, L)).toBe("## Log\n- a\n- NEW\n\n## Next\n- z\n");
		expect(insertUnder("## Log\n\n## Next\n", H, L)).toBe("## Log\n- NEW\n\n## Next\n");
	});

	test("deeper headings stay inside the section; higher ones end it", () => {
		expect(insertUnder("## Log\n### Sub\n- a\n## Next\n", H, L)).toBe("## Log\n### Sub\n- a\n- NEW\n## Next\n");
		expect(insertUnder("## Log\n- a\n# Top\n", H, L)).toBe("## Log\n- a\n- NEW\n# Top\n");
		expect(insertUnder("## Log\n- a\n#tag not heading\n", H, L)).toBe("## Log\n- a\n#tag not heading\n- NEW\n");
	});

	test("uses the first matching heading and tolerates trailing spaces on it", () => {
		expect(insertUnder("## Log  \n- a\n## Log\n- b\n", H, L)).toBe("## Log  \n- a\n- NEW\n## Log\n- b\n");
	});

	test("CRLF files keep CRLF, including a file without final EOL", () => {
		expect(insertUnder("# D\r\n## Log\r\n- a\r\n## N\r\n", H, L)).toBe("# D\r\n## Log\r\n- a\r\n- NEW\r\n## N\r\n");
		expect(insertUnder("## Log\r\n- a", H, L)).toBe("## Log\r\n- a\r\n- NEW\r\n");
		expect(insertUnder("# D\r\ntext", H, L)).toBe("# D\r\ntext\r\n\r\n## Log\r\n- NEW\r\n");
	});

	test("a BOM is kept and ignored for matching", () => {
		expect(insertUnder("\uFEFF## Log\n- a\n", H, L)).toBe("\uFEFF## Log\n- a\n- NEW\n");
		expect(insertUnder("\uFEFF", H, L)).toBe("\uFEFF## Log\n- NEW\n");
		expect(insertUnder("\uFEFF# D\n", H, L)).toBe("\uFEFF# D\n\n## Log\n- NEW\n");
	});

	test("property: existing lines survive in order, one new line lands inside the section", () => {
		const rnd = seeded(42);
		const pool = ["# Top", "## Log", "### Sub", "## Other", "text", "- item", "", "", "#tag"];
		const strip = (a: string[]) => {
			const c = [...a];
			while (c.at(-1) === "") c.pop();
			return c;
		};
		for (let i = 0; i < 400; i++) {
			const lines = Array.from({ length: Math.floor(rnd() * 10) }, () => pool[Math.floor(rnd() * pool.length)]);
			const eol = rnd() < 0.5 ? "\r\n" : "\n";
			const bom = rnd() < 0.3 ? "\uFEFF" : "";
			const finalEol = rnd() < 0.7 ? eol : "";
			const orig = bom + lines.join(eol) + (lines.length ? finalEol : "");
			const res = insertUnder(orig, H, L);
			const split = (s: string) => s.replace(/^\uFEFF/, "").split(/\r?\n/);
			const before = split(orig);
			const after = split(res);
			expect(res.startsWith(bom)).toBe(true);
			expect(after.filter((l) => l === L).length).toBe(1);
			const at = after.indexOf(L);
			const rest = after.filter((_, k) => k !== at);
			const hadHeading = before.some((l) => l.trimEnd() === H);
			if (hadHeading) {
				expect(strip(rest)).toEqual(strip(before));
				const h = after.findIndex((l) => l.trimEnd() === H);
				expect(at).toBeGreaterThan(h);
				for (const between of after.slice(h + 1, at)) expect(between).not.toMatch(/^#{1,2}\s/);
			} else {
				const r = strip(rest);
				expect(r.pop()).toBe(H);
				expect(strip(r)).toEqual(strip(before));
			}
			const style = orig.includes("\r\n") ? "\r\n" : "\n"; // a file with no CRLF in it counts as LF
			if (style === "\r\n") expect(res.replace(/\r\n/g, "")).not.toMatch(/\n/);
			// A mid-file insert leaves a missing final EOL as it was; the unit tests above cover the insert-at-the-end case.
			if (orig === "" || orig.endsWith("\n") || !hadHeading) expect(res.endsWith(style)).toBe(true);
		}
	});
});

describe("recordLine", () => {
	const contract: Contract = GOOD;
	const now = new Date(2026, 10, 21, 5, 12, 33);
	const daily = () => join(vault, "Daily", "2026-11-21.md");
	const rec = (text = "run begun", key = "151", c: Contract = contract) => recordLine(vault, c, state, now, key, text);

	test("creates a missing daily and folder with heading and line at the local time", () => {
		expect(rec()).toBeUndefined();
		expect(readFileSync(daily(), "utf8")).toBe("## 📝 Log\n- 05:12 - Strategium 151: run begun\n");
	});

	test("inserts under the heading and leaves the other bytes identical", () => {
		mkdirSync(join(vault, "Daily"));
		const head = "---\r\ntitle: x\r\n---\r\n\r\n## 📝 Log\r\n- 04:00 - old\r\n";
		const tail = "\r\n## Next\r\n- keep\r\n";
		writeFileSync(daily(), "\uFEFF" + head + tail);
		expect(rec("seal Plan granted")).toBeUndefined();
		const out = readFileSync(daily(), "utf8");
		expect(out).toBe("\uFEFF" + head + "- 05:12 - Strategium 151: seal Plan granted\r\n" + tail);
	});

	test("appends only a suffix when the heading is missing", () => {
		mkdirSync(join(vault, "Daily"));
		writeFileSync(daily(), "# Day\nnotes");
		expect(rec()).toBeUndefined();
		expect(readFileSync(daily(), "utf8")).toBe("# Day\nnotes\n\n## 📝 Log\n- 05:12 - Strategium 151: run begun\n");
	});

	test("a second event adds a second line under the same heading", () => {
		rec("run begun");
		rec("run ended");
		expect(readFileSync(daily(), "utf8")).toBe(
			"## 📝 Log\n- 05:12 - Strategium 151: run begun\n- 05:12 - Strategium 151: run ended\n",
		);
	});

	test("refuses a daily over 4 MiB and leaves it alone", () => {
		mkdirSync(join(vault, "Daily"));
		const big = "a".repeat(4 * 1024 * 1024 + 1);
		writeFileSync(daily(), big);
		expect(rec()).toBe("daily larger than 4 MiB");
		expect(readFileSync(daily(), "utf8")).toBe(big);
	});

	test("refuses a daily that is not UTF-8 and leaves it alone", () => {
		mkdirSync(join(vault, "Daily"));
		const bytes = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
		writeFileSync(daily(), bytes);
		expect(rec()).toBe("daily not UTF-8");
		expect(readFileSync(daily()).equals(bytes)).toBe(true);
	});

	test("refuses a daily that is a folder", () => {
		mkdirSync(daily(), { recursive: true });
		expect(rec()).toBe("daily not a regular file");
	});

	test("refuses a daily that is a symlink to a file inside the vault", () => {
		mkdirSync(join(vault, "Daily"));
		writeFileSync(join(vault, "real.md"), "x");
		try {
			symlinkSync(join(vault, "real.md"), daily(), "file");
		} catch {
			return; // no symlink right on this host
		}
		expect(rec()).toBe("daily not a regular file");
		expect(readFileSync(join(vault, "real.md"), "utf8")).toBe("x");
	});

	test("refuses a junction/symlink that escapes the vault and writes nothing outside", () => {
		const outside = join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(vault, "Daily"), "junction");
		expect(rec()).toBe("daily outside the vault");
		expect(existsSync(join(outside, "2026-11-21.md"))).toBe(false);
	});

	test("refuses an escape through a nested missing folder under a link", () => {
		const outside = join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(vault, "Link"), "junction");
		expect(rec("x", "1", { ...contract, daily: "Link/sub/{date}.md" })).toBe("daily outside the vault");
		expect(existsSync(join(outside, "sub"))).toBe(false);
	});

	test("refuses an unvalidated contract with a bad daily", () => {
		expect(rec("x", "1", { ...contract, daily: "../{date}.md" })).toBe(DAILY_BAD);
		expect(existsSync(join(root, "2026-11-21.md"))).toBe(false);
	});

	test("reports daily busy while vault.lock is held, then works once it is gone", () => {
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "vault.lock"), `${process.pid}-held`);
		expect(rec()).toBe("daily busy");
		expect(existsSync(daily())).toBe(false);
		rmSync(join(state, "vault.lock"));
		expect(rec()).toBeUndefined();
	});

	test("never throws: a vault that vanished is a reason", () => {
		rmSync(vault, { recursive: true });
		expect(rec()).toMatch(/^unreachable \(/);
	});
});
