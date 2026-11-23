// Per-tier tally of the Captain's ratings across runs (#144): pure logic plus the locked, synchronous file I/O.
// It sits beside roster.json under the same lock; nothing here throws to a tool call: a busy lock or a bad file comes back as a value.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { oneLine, type Rating } from "./cockpit";
import { withRosterLock } from "./roster";
import { writeAtomic } from "./timer";

export const KINDS = ["code", "docs", "ui", "workflow"] as const;
export type Kind = (typeof KINDS)[number];
export type TallyRow = { model: string; effort: string; kind: Kind; proven: number; regression: number; corrupted: number };
export type Result = { model: string; effort: string; kind: Kind; rating: Rating["rating"] };

const MAX_BYTES = 256 * 1024;
const EFFORT_RE = /^[a-z][a-z0-9-]{0,15}$/; // the parseRating rule in index.ts
const COUNTERS = ["proven", "regression", "corrupted"] as const;
const BY_RATING = { proven: "proven", "proven-regression": "regression", corrupted: "corrupted" } as const;
const DOCS = /\.(md|mdx|txt|rst|adoc)$/;
const UI = /\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less)$/;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tallyFile = (dir: string) => join(dir, "tally.json");
const keyOf = (r: { model: string; effort: string; kind: string }) => `${r.model}\n${r.effort}\n${r.kind}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A squad's kind from its declared files; a terminal UI written in .ts counts as code (known limit: files are all there is to go on). */
export function squadKind(files: readonly string[]): Kind {
	const paths = files.map(f => f.toLowerCase().replaceAll("\\", "/"));
	if (paths.some(f => f.startsWith(".github/workflows/") || f.includes("/.github/workflows/") || f === ".gitlab-ci.yml" || f.endsWith("/.gitlab-ci.yml"))) return "workflow";
	if (paths.length && paths.every(f => DOCS.test(f))) return "docs";
	return paths.some(f => UI.test(f)) ? "ui" : "code";
}

/** A new array sorted by model, effort, kind; a key not seen before starts at zero; a counter stops at MAX_SAFE_INTEGER. */
export function addResults(rows: readonly TallyRow[], results: readonly Result[]): TallyRow[] {
	const byKey = new Map(rows.map(r => [keyOf(r), { ...r }]));
	for (const { model, effort, kind, rating } of results) {
		const row = byKey.get(keyOf({ model, effort, kind })) ?? { model, effort, kind, proven: 0, regression: 0, corrupted: 0 };
		const counter = BY_RATING[rating];
		row[counter] = Math.min(Number.MAX_SAFE_INTEGER, row[counter] + 1);
		byKey.set(keyOf(row), row);
	}
	return [...byKey.values()].sort((a, b) => cmp(a.model, b.model) || cmp(a.effort, b.effort) || cmp(a.kind, b.kind));
}

export const serializeTally = (rows: readonly TallyRow[]): string =>
	`${JSON.stringify({ version: 1, rows: rows.map(r => ({ model: r.model, effort: r.effort, kind: r.kind, proven: r.proven, regression: r.regression, corrupted: r.corrupted })) })}\n`;

/** The whole file is readable or it is not; no partial salvage. */
export function parseTally(text: string): { rows: TallyRow[] } | { error: string } {
	if (text.length > MAX_BYTES) return { error: "larger than 256 KiB" };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { error: "not valid JSON" };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "not a JSON object" };
	const file = raw as { version?: unknown; rows?: unknown };
	if (file.version !== 1) return { error: "version is not 1" };
	if (!Array.isArray(file.rows)) return { error: "rows is not an array" };
	const seen = new Set<string>();
	const rows: TallyRow[] = [];
	for (const [i, r] of file.rows.entries()) {
		const o = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
		const bad = (why: string) => ({ error: `row ${i}: ${why}` });
		if (typeof o.model !== "string" || o.model.length < 1 || o.model.length > 60 || oneLine(o.model) !== o.model) return bad("bad model");
		if (typeof o.effort !== "string" || !EFFORT_RE.test(o.effort)) return bad("bad effort");
		if (!KINDS.includes(o.kind as Kind)) return bad("unknown kind");
		for (const c of COUNTERS) if (typeof o[c] !== "number" || !Number.isSafeInteger(o[c]) || (o[c] as number) < 0) return bad(`bad ${c}`);
		const row = o as TallyRow;
		if (seen.has(keyOf(row))) return bad("duplicate row");
		seen.add(keyOf(row));
		rows.push({ model: row.model, effort: row.effort, kind: row.kind, proven: row.proven, regression: row.regression, corrupted: row.corrupted });
	}
	return { rows };
}

/** Missing file: empty tally. Anything unreadable: `{ error }`, and the file is never touched. */
export function loadTally(dir: string): { rows: TallyRow[] } | { error: string } {
	const file = tallyFile(dir);
	try {
		if (statSync(file).size > MAX_BYTES) return { error: "larger than 256 KiB" };
		return parseTally(readFileSync(file, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { rows: [] };
		return { error: msg(err) };
	}
}

/** Lock (the roster's), load, refuse an unreadable file, apply `fn`, write atomically. Returns the reason it did not write, or undefined. */
export function updateTally(dir: string, fn: (rows: TallyRow[]) => TallyRow[], waitMs?: number): string | undefined {
	try {
		const r = withRosterLock(
			dir,
			() => {
				const loaded = loadTally(dir);
				if ("error" in loaded) return `tally unreadable (${loaded.error})`;
				const text = serializeTally(fn(loaded.rows));
				// Never write what the next load would refuse.
				const check = parseTally(text);
				if ("error" in check) return `tally invalid (${check.error})`;
				writeAtomic(tallyFile(dir), text);
				return undefined;
			},
			waitMs,
		);
		return "busy" in r ? "tally busy" : r.value;
	} catch (err) {
		return msg(err);
	}
}

export const tallyLines = (rows: readonly TallyRow[]): string[] =>
	rows.map(r => `TALLY ${r.model} ${r.effort} ${r.kind}: proven ${r.proven}, proven-regression ${r.regression}, corrupted ${r.corrupted}`);

/**
 * One line per kind at most, toward a heavier tier only. A row maps to the ladder tier whose selector it is
 * (`default` effort: the bare model); it counts when it has 3+ results and corrupted is the majority.
 * `ladder` runs lightest to heaviest.
 */
export function proposals(rows: readonly TallyRow[], ladder: readonly { tier: string; selector: string }[]): string[] {
	const lines: string[] = [];
	for (const kind of KINDS) {
		const failing = rows.filter(r => r.kind === kind && r.proven + r.regression + r.corrupted >= 3 && 2 * r.corrupted > r.proven + r.regression + r.corrupted);
		for (let t = ladder.length - 2; t >= 0; t--) {
			const row = failing.find(r => (r.effort === "default" ? r.model : `${r.model}:${r.effort}`) === ladder[t]!.selector);
			if (!row) continue;
			lines.push(`PROPOSE ${kind} squads: default tier ${ladder[t + 1]!.tier} (now ${ladder[t]!.tier}: ${row.model} ${row.effort} corrupted ${row.corrupted} of ${row.proven + row.regression + row.corrupted})`);
			break;
		}
	}
	return lines;
}
