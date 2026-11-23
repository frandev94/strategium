import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_FILE, type Contract, type ContractResult, formatLine, insertUnder, loadContract, matchNote, noteTarget, recordLine, recordNote, secretKind } from "./vault";

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
		put({ ...GOOD, extra: ["x"] });
		expect(loadContract(vault)).toEqual({ contract: GOOD });
	});

	test("N1: a UTF-8 BOM before the JSON is accepted", () => {
		put("\uFEFF" + JSON.stringify(GOOD));
		expect(loadContract(vault)).toEqual({ contract: GOOD });
	});

	test("createDaily: true is carried, anything else is dropped", () => {
		put({ ...GOOD, createDaily: true });
		expect(loadContract(vault)).toEqual({ contract: { ...GOOD, createDaily: true } });
		for (const createDaily of [false, "true", 1, null]) {
			put({ ...GOOD, createDaily });
			expect(loadContract(vault)).toEqual({ contract: GOOD });
		}
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
		["Daily /{date}.md"],
		["Daily./{date}.md"],
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

	test("headings inside fenced code blocks are not matched and do not end the section", () => {
		expect(insertUnder("```\n## Log\n```\n", H, L)).toBe("```\n## Log\n```\n\n## Log\n- NEW\n");
		expect(insertUnder("~~~md\n## Log\n~~~\n## Log\n- a\n", H, L)).toBe("~~~md\n## Log\n~~~\n## Log\n- a\n- NEW\n");
		expect(insertUnder("## Log\n- a\n```\n## Next\n```\n- b\n## Next\n", H, L)).toBe("## Log\n- a\n```\n## Next\n```\n- b\n- NEW\n## Next\n");
		// a different fence mark inside a block does not close it
		expect(insertUnder("```\n~~~\n## Log\n```\n", H, L)).toBe("```\n~~~\n## Log\n```\n\n## Log\n- NEW\n");
	});

	test("CN2: a fence that never closes is ignored, so repeated events do not duplicate the heading", () => {
		let c = "# Day\n```\n## Log\n- a\n";
		for (let i = 0; i < 3; i++) c = insertUnder(c, H, `- E${i}`);
		expect(c).toBe("# Day\n```\n## Log\n- a\n- E0\n- E1\n- E2\n");
		expect(c.match(/## Log/g)).toHaveLength(1);
	});

	test("CN3: <!-- --> spans are masked like fences; an unclosed one is ignored", () => {
		expect(insertUnder("<!--\n## Log\n-->\n", H, L)).toBe("<!--\n## Log\n-->\n\n## Log\n- NEW\n");
		expect(insertUnder("## Log\n- a\n<!--\n## Next\n-->\n- b\n## Next\n", H, L)).toBe("## Log\n- a\n<!--\n## Next\n-->\n- b\n- NEW\n## Next\n");
		expect(insertUnder("<!-- x -->\n## Log\n- a\n", H, L)).toBe("<!-- x -->\n## Log\n- a\n- NEW\n");
		expect(insertUnder("<!--\n## Log\n- a\n", H, L)).toBe("<!--\n## Log\n- a\n- NEW\n");
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
	const contract: Contract = { ...GOOD, createDaily: true };
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

	test("a missing daily is not created by default: the reason is daily missing and nothing is written", () => {
		expect(rec("x", "1", GOOD)).toBe("daily missing");
		expect(existsSync(join(vault, "Daily"))).toBe(false);
		mkdirSync(join(vault, "Daily"));
		writeFileSync(daily(), "# Day\n");
		expect(rec("x", "1", GOOD)).toBeUndefined();
		expect(readFileSync(daily(), "utf8")).toBe("# Day\n\n## 📝 Log\n- 05:12 - Strategium 1: x\n");
	});

	test("a concurrent append between read and write is kept: the insert is redone once on fresh bytes", () => {
		mkdirSync(join(vault, "Daily"));
		writeFileSync(daily(), "## 📝 Log\n- a\n## Next\n");
		let calls = 0;
		const r = recordLine(vault, contract, state, now, "1", "x", () => {
			if (calls++ === 0) appendFileSync(daily(), "- late\n");
		});
		expect(r).toBeUndefined();
		expect(calls).toBe(2);
		expect(readFileSync(daily(), "utf8")).toBe("## 📝 Log\n- a\n- 05:12 - Strategium 1: x\n## Next\n- late\n");
	});

	test("a daily that keeps changing is left as the other writer made it and reported", () => {
		mkdirSync(join(vault, "Daily"));
		writeFileSync(daily(), "## 📝 Log\n- a\n## Next\n");
		let n = 0;
		const r = recordLine(vault, contract, state, now, "1", "x", () => appendFileSync(daily(), `- late${n++}\n`));
		expect(r).toBe("daily changed while writing");
		expect(readFileSync(daily(), "utf8")).toBe("## 📝 Log\n- a\n## Next\n- late0\n- late1\n");
	});

	test("a failing mid-file write leaves the old bytes and no temp file", () => {
		mkdirSync(join(vault, "Daily"));
		const old = "## 📝 Log\n- a\n## Next\n- keep\n";
		writeFileSync(daily(), old);
		chmodSync(daily(), 0o444);
		try {
			const r = rec();
			if (r === undefined) return; // this host lets a read-only file be written (root): nothing to prove
			expect(r).toMatch(/^daily write failed/);
			expect(readFileSync(daily(), "utf8")).toBe(old);
			expect(readdirSync(state).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		} finally {
			chmodSync(daily(), 0o666);
		}
	});

	const MID = "## 📝 Log\n- a\n## Next\n- keep\n";
	const tmps = () => (existsSync(state) ? readdirSync(state).filter((f) => f.endsWith(".tmp")) : []);

	test("N2: when only the copy fails the old bytes come back and the reason says restored", () => {
		mkdirSync(join(vault, "Daily"));
		writeFileSync(daily(), MID);
		const boom = () => {
			throw Object.assign(new Error("x"), { code: "EIO" });
		};
		expect(recordLine(vault, contract, state, now, "1", "x", undefined, boom)).toBe("daily write failed (EIO), restored");
		expect(readFileSync(daily(), "utf8")).toBe(MID);
		expect(tmps()).toEqual([]);
	});

	test("CN4: the temp file is gone after a successful mid-file insert", () => {
		mkdirSync(join(vault, "Daily"));
		writeFileSync(daily(), MID);
		let seen: string[] = [];
		expect(recordLine(vault, contract, state, now, "1", "x", () => (seen = tmps()))).toBeUndefined();
		expect(seen).toHaveLength(1); // staged before the last size/mtime check, so only the copy is left in the window
		expect(tmps()).toEqual([]);
	});

	test("N4: the append fast path stages no temp file and never reaches the write hook", () => {
		mkdirSync(join(vault, "Daily"));
		writeFileSync(daily(), "# Day\nnotes");
		let hook = 0;
		let copies = 0;
		const copy = () => void copies++;
		expect(recordLine(vault, contract, state, now, "1", "x", () => void hook++, copy)).toBeUndefined();
		expect([hook, copies, tmps()]).toEqual([0, 0, []]);
	});
});

describe("loadContract notes and noteHeading (#152)", () => {
	const NOTES_BAD = "contract invalid: notes must be a list of 1 to 32 relative .md globs (* within a segment, ** as a whole segment)";
	const NH_BAD = "contract invalid: noteHeading must be one markdown heading line (# to ######)";

	test("keeps a valid notes list and noteHeading, omits them when absent", () => {
		put({ ...GOOD, notes: ["Projects/*.md", "Hosts/**/*.md", "a\\b.md"], noteHeading: "## Registro de trabajo" });
		expect(loadContract(vault)).toEqual({ contract: { ...GOOD, notes: ["Projects/*.md", "Hosts/**/*.md", "a\\b.md"], noteHeading: "## Registro de trabajo" } });
		put(GOOD);
		expect(loadContract(vault)).toEqual({ contract: GOOD });
	});

	test("refuses each bad glob and the whole contract with it", () => {
		const bad: unknown[] = ["/x.md", "C:\\x.md", "../x.md", ".obsidian/*.md", "a/**b/c.md", "a/***/c.md", "a/?.md", "x.txt", "a//b.md", "a/b /c.md", "a/" + "x".repeat(198) + ".md", 5, null, {}];
		for (const g of bad) {
			put({ ...GOOD, notes: [g] });
			expect(err(loadContract(vault))).toBe(NOTES_BAD);
		}
		for (const notes of [[], "x.md", null, 7, Array.from({ length: 33 }, (_, i) => `n${i}.md`)]) {
			put({ ...GOOD, notes });
			expect(err(loadContract(vault))).toBe(NOTES_BAD);
		}
		put({ ...GOOD, notes: Array.from({ length: 32 }, (_, i) => `n${i}.md`) });
		expect(err(loadContract(vault))).toBeUndefined();
	});

	test("refuses a bad noteHeading", () => {
		for (const noteHeading of ["Log", "##", "## a\nb", 3, null, "#".repeat(7) + " x"]) {
			put({ ...GOOD, noteHeading });
			expect(err(loadContract(vault))).toBe(NH_BAD);
		}
	});
});

describe("matchNote (#152)", () => {
	const yes = (g: string, n: string) => expect(matchNote(g, n)).toBe(true);
	const no = (g: string, n: string) => expect(matchNote(g, n)).toBe(false);

	test("* stays inside one segment", () => {
		yes("Projects/*.md", "Projects/Strategium.md");
		no("Projects/*.md", "Projects/a/b.md");
		no("Projects/*.md", "Other/a.md");
		yes("Hosts/*-server.md", "Hosts/web-server.md");
		no("Hosts/*-server.md", "Hosts/web-servers.md");
		yes("a*b*c.md", "aXbYc.md");
		no("a*b*c.md", "acb.md");
		no("ab*ba.md", "aba.md"); // the parts must not overlap
		yes("*.md", "x.md");
	});

	test("** is zero or more whole segments", () => {
		yes("**/*.md", "a.md");
		yes("**/*.md", "a/b/c.md");
		yes("Hosts/**/*.md", "Hosts/x.md");
		yes("Hosts/**/*.md", "Hosts/a/b/x.md");
		no("Hosts/**/*.md", "Other/x.md");
		no("Hosts/**/x.md", "Hosts/a/y.md");
		yes("a/**/b/**/c.md", "a/b/x/y/b/c.md");
	});

	test("\\ and / are alike", () => {
		yes("Projects\\*.md", "Projects/a.md");
		yes("Projects/*.md", "Projects\\a.md");
	});

	test("a glob without * matches iff the segment lists are equal; case folds only on win32/darwin", () => {
		yes("A/b.md", "A/b.md");
		no("A/b.md", "A/b/c.md");
		no("A/b.md", "A.md");
		const real = process.platform;
		const as = (p: string) => Object.defineProperty(process, "platform", { value: p, configurable: true });
		try {
			as("linux");
			no("Projects/*.md", "projects/a.md");
			as("win32");
			yes("Projects/*.md", "projects/A.md");
			as("darwin");
			yes("Projects/*.md", "projects/A.md");
		} finally {
			as(real);
		}
	});

	test("a 32-glob x 100-segment worst case stays under 100 ms", () => {
		const note = Array.from({ length: 100 }, () => "a".repeat(189) + "b").join("/");
		const globs = Array.from({ length: 32 }, () => Array.from({ length: 100 }, () => "**/a*b*b").join("/") + ".md");
		const t = performance.now();
		for (const g of globs) matchNote(g, note);
		expect(performance.now() - t).toBeLessThan(100);
	});
});

describe("recordNote (#152)", () => {
	const now = new Date(2026, 10, 21, 5, 12, 33);
	const LINE = "- 05:12 - Strategium 152: did x";
	const contract: Contract = { ...GOOD, notes: ["Projects/*.md", "Hosts/**/*.md", "Daily/*.md"] };
	const note = (n = "Projects/K.md") => join(vault, ...n.split("/"));
	const seed = (content: string | Buffer, n = "Projects/K.md") => {
		mkdirSync(join(note(n), ".."), { recursive: true });
		writeFileSync(note(n), content);
	};
	const rec = (n = "Projects/K.md", c: Contract = contract, text = "did x") => recordNote(vault, c, state, now, "152", text, n);
	const read = (n = "Projects/K.md") => readFileSync(note(n), "utf8");

	test("with noteHeading: adds the line under an existing section, keeping every other byte", () => {
		const c = { ...contract, noteHeading: "## Registro" };
		const head = "\uFEFF# K\r\n\r\n## Registro\r\n- old\r\n";
		const tail = "\r\n## Next\r\n- keep\r\n";
		seed(head + tail);
		expect(rec("Projects/K.md", c)).toBeUndefined();
		expect(read()).toBe(head + LINE + "\r\n" + tail);
	});

	test("with noteHeading: a missing heading is added at the end", () => {
		seed("# K\ntext");
		expect(rec("Projects/K.md", { ...contract, noteHeading: "## Registro" })).toBeUndefined();
		expect(read()).toBe(`# K\ntext\n\n## Registro\n${LINE}\n`);
	});

	test("without noteHeading: the line goes after the last line, with and without a final EOL", () => {
		seed("# K\ntext\n");
		expect(rec()).toBeUndefined();
		expect(read()).toBe(`# K\ntext\n${LINE}\n`);
		seed("# K\ntext");
		expect(rec()).toBeUndefined();
		expect(read()).toBe(`# K\ntext\n${LINE}\n`);
		expect(rec()).toBeUndefined();
		expect(read()).toBe(`# K\ntext\n${LINE}\n${LINE}\n`);
	});

	test("without noteHeading: CRLF and a BOM are kept; an empty or BOM-only note gets just the line", () => {
		seed("\uFEFF# K\r\ntext");
		expect(rec()).toBeUndefined();
		expect(read()).toBe(`\uFEFF# K\r\ntext\r\n${LINE}\r\n`);
		seed("");
		expect(rec()).toBeUndefined();
		expect(read()).toBe(`${LINE}\n`);
		seed("\uFEFF");
		expect(rec()).toBeUndefined();
		expect(read()).toBe(`\uFEFF${LINE}\n`);
	});

	test("refuses a contract without notes, a path outside the globs and a bad path; nothing is created", () => {
		seed("x");
		const no = (n: string, c: Contract = contract) => noteTarget(vault, c, now, n);
		expect(no("Projects/K.md", GOOD)).toEqual({ error: "the contract lists no notes" });
		expect(no("Other/K.md")).toEqual({ error: "not allowed by the contract's notes" });
		for (const n of ["../x.md", "/x.md", "C:\\x.md", "Projects/*.md", "Projects/K.txt", ".git/x.md", "Projects//K.md"]) {
			expect(no(n)).toEqual({ error: "not a relative .md path inside the vault" });
		}
		expect(rec("Other/K.md")).toBe("note not allowed by the contract's notes");
		expect(existsSync(note("Other/K.md"))).toBe(false);
		expect(read()).toBe("x");
	});

	test("refuses today's daily (any case on win32) and a missing note, which is not created", () => {
		mkdirSync(join(vault, "Daily"));
		writeFileSync(join(vault, "Daily", "2026-11-21.md"), "d");
		expect(rec("Daily/2026-11-21.md")).toBe("note is today's daily");
		expect(readFileSync(join(vault, "Daily", "2026-11-21.md"), "utf8")).toBe("d");
		expect(rec("Projects/New.md")).toBe("note missing");
		expect(existsSync(note("Projects/New.md"))).toBe(false);
		expect(existsSync(join(vault, "Projects"))).toBe(false);
	});

	test("another day's daily matching a glob is a normal note", () => {
		seed("old\n", "Daily/2026-11-20.md");
		expect(rec("Daily/2026-11-20.md")).toBeUndefined();
		expect(read("Daily/2026-11-20.md")).toBe(`old\n${LINE}\n`);
	});

	test("refuses a folder, and a symlink or junction that leaves the vault", () => {
		mkdirSync(note("Projects/K.md"), { recursive: true });
		expect(rec()).toBe("note not a regular file");
		const outside = join(root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "K.md"), "out");
		symlinkSync(outside, join(vault, "Hosts"), "junction");
		expect(rec("Hosts/K.md")).toBe("note outside the vault");
		expect(readFileSync(join(outside, "K.md"), "utf8")).toBe("out");
	});

	test("refuses a note over 4 MiB and one that is not UTF-8, leaving both byte-equal", () => {
		const big = "a".repeat(4 * 1024 * 1024 + 1);
		seed(big);
		expect(rec()).toBe("note larger than 4 MiB");
		expect(read()).toBe(big);
		const bytes = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
		seed(bytes);
		expect(rec()).toBe("note not UTF-8");
		expect(readFileSync(note()).equals(bytes)).toBe(true);
	});

	test("reports note busy while vault.lock is held", () => {
		seed("x\n");
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "vault.lock"), `${process.pid}-held`);
		expect(rec()).toBe("note busy");
		expect(read()).toBe("x\n");
	});

	test("a failed copy restores the note and says so", () => {
		seed("# K\n## Registro\n- a\n## N\n");
		const boom = () => {
			throw Object.assign(new Error("x"), { code: "EIO" });
		};
		const r = recordNote(vault, { ...contract, noteHeading: "## Registro" }, state, now, "152", "x", "Projects/K.md", undefined, boom);
		expect(r).toBe("note write failed (EIO), restored");
		expect(read()).toBe("# K\n## Registro\n- a\n## N\n");
	});
});

describe("secretKind (#152)", () => {
	const A = "a".repeat(36);
	const refuse: [string, string][] = [
		["token", "ghp_" + "A1b2".repeat(9)],
		["token", "github_pat_" + "A1b2C3d4E5f6G7h8I9j0K1"],
		["token", "sk-ant-api03-" + "Ab1_-".repeat(5)],
		["token", "AKIAIOSFODNN7EXAMPLE"],
		["token", "AIza" + "a".repeat(35)],
		["token", "xoxb-1234567890-abcdef"],
		["token", "glpat-" + "a".repeat(20)],
		["token", "npm_" + A],
		["token", "Authorization: Bearer abcdef0123456789abcdef"],
		["token", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig"],
		["private key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
		["private key", "-----BEGIN PRIVATE KEY-----"],
		["NAME=value", "GITHUB_TOKEN=abc"],
		["NAME=value", "export API_KEY=xyz"],
		["NAME=value", "(DB_PASS=hunter2)"],
		["credential", "password=hunter2"],
		["credential", "client_secret = x"],
		["credential", "api_key: AbCdEf0123456789xyz"],
		["key-like string", "key " + "aB3dEf6hIj9lMn2pQr5tUv8xYz1BcD4F".repeat(2).slice(0, 40)],
	];
	test.each(refuse)("refuses %s: %s", (kind, text) => {
		expect(secretKind(text)).toBe(kind);
	});

	test("never echoes: the kind is one of the five names", () => {
		for (const [, t] of refuse) expect(["token", "private key", "NAME=value", "credential", "key-like string"]).toContain(secretKind(t) ?? "");
	});

	const pass = [
		"seal Plan granted; PR #153 opened: https://github.com/frandev94/strategium/pull/153",
		"installed caddy on host openclaw, port 8080, config in /etc/caddy/Caddyfile",
		"decided: notes go under ## Log",
		"bug: a stray \\r in agents/*.md broke the YAML frontmatter",
		"commit 9837527a1b2c3d4e5f60718293a4b5c6d7e8f901",
		"id 123e4567-e89b-12d3-a456-426614174000",
		"the token expired, rotated the API key",
		"x = 1 and a=b",
		"set NODE_ENV to production",
		"GET /api/v1/users?id=7",
		"sk-learn installed",
		"skill://strategium-github",
		"",
	];
	test.each(pass)("passes prose: %s", (text) => {
		expect(secretKind(text)).toBeUndefined();
	});

	test("NODE_ENV=production is the accepted false positive", () => {
		expect(secretKind("NODE_ENV=production")).toBe("NAME=value");
	});

	test("hostile 200k inputs stay under 200 ms each", () => {
		const inputs = ["A".repeat(200_000), " A".repeat(100_000), "ghp_".repeat(50_000), "-----BEGIN ".repeat(20_000), "eyJ".repeat(66_000), "Bearer" + " ".repeat(200_000), "password" + " ".repeat(200_000), "export" + " ".repeat(200_000), ";A".repeat(100_000), "a".repeat(31) + " ", ("a".repeat(31) + " ").repeat(6_000)];
		for (const s of inputs) {
			const t = performance.now();
			secretKind(s);
			expect(performance.now() - t).toBeLessThan(200);
		}
	});

	test("property: a secret stays one inside any surrounding text; plain lower-case words never are", () => {
		const rnd = seeded(5);
		const word = () => "abcdefghijklmnopqrstuvwxyz".slice(0, 1 + Math.floor(rnd() * 12)).split("").sort(() => rnd() - 0.5).join("");
		const words = (n: number) => Array.from({ length: n }, word).join(" ");
		for (const [, s] of refuse) for (let i = 0; i < 20; i++) expect(secretKind(`${words(i % 4)} ${s} ${words(i % 3)}`)).toBeDefined();
		for (let i = 0; i < 300; i++) expect(secretKind(words(1 + Math.floor(rnd() * 20)))).toBeUndefined();
	});

	test("property: a glob without * matches iff the segment lists are equal", () => {
		const rnd = seeded(9);
		const seg = () => ["a", "b", "Ab", "x.y"][Math.floor(rnd() * 4)];
		const path = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, seg).join(rnd() < 0.5 ? "/" : "\\") + ".md";
		for (let i = 0; i < 300; i++) {
			const g = path();
			const n = rnd() < 0.5 ? g.replaceAll("\\", "/") : path();
			const eq = g.split(/[\\/]/).join("/") === n.split(/[\\/]/).join("/");
			expect(matchNote(g, n)).toBe(process.platform === "linux" ? eq : g.toLowerCase().split(/[\\/]/).join("/") === n.toLowerCase().split(/[\\/]/).join("/"));
		}
	});
});
