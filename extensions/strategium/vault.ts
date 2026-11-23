// Vault records (#151): parse an untrusted contract file, format one line, insert it under a heading and write the daily.
// Everything here treats the vault and the daily as untrusted input and never throws: failures come back as reason strings.

import { appendFileSync, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withLock } from "./roster";

export const CONTRACT_FILE = ".strategium.json";
export type Contract = { daily: string; heading: string; line: string; createDaily?: true; notes?: string[]; noteHeading?: string };
export type ContractResult = { contract: Contract } | { error: string };

const MAX_CONTRACT = 16 * 1024;
const MAX_DAILY = 4 * 1024 * 1024;
const DAILY_BAD = "contract invalid: daily must be a relative .md path with {date} inside the vault";
const HEADING_BAD = "contract invalid: heading must be one markdown heading line (# to ######)";
const LINE_BAD = "contract invalid: line must be one line with {text}, only {time} {key} {text}, not starting with #";
const NOTES_BAD = "contract invalid: notes must be a list of 1 to 32 relative .md globs (* within a segment, ** as a whole segment)";
const NOTE_HEADING_BAD = "contract invalid: noteHeading must be one markdown heading line (# to ######)";

const code = (e: unknown): string => String((e as NodeJS.ErrnoException)?.code ?? "error");

function dailyOk(daily: unknown): daily is string {
	if (typeof daily !== "string" || daily.length > 200 || !daily.includes("{date}") || !daily.endsWith(".md")) return false;
	// Empty segments cover absolute (`/x`, `\\x`) and doubled separators; ":" covers drive letters; a leading "." covers `.`, `..`, `.obsidian`, `.git`.
	return daily.split(/[\\/]/).every((s) => s !== "" && !s.startsWith(".") && !/[ .]$/.test(s) && !/[:<>"|?*\x00-\x1f]/.test(s));
}

const headingOk = (h: unknown): h is string => typeof h === "string" && h.length <= 200 && /^#{1,6} \S[^\r\n]*$/.test(h);

/** A vault-relative `.md` path of at most 200 chars. `wild` allows `*` inside a segment and `**` as a whole segment (a glob); otherwise no `*` (a note). */
function pathOk(p: unknown, wild: boolean): p is string {
	if (typeof p !== "string" || p.length > 200 || !p.endsWith(".md")) return false;
	return p.split(/[\\/]/).every((s) => s !== "" && !s.startsWith(".") && !/[ .]$/.test(s) && !/[:<>"|?\x00-\x1f]/.test(s) && (wild ? s === "**" || (!s.includes("**") && !/[[\]{}]/.test(s)) : !s.includes("*")));
}

const notesOk = (n: unknown): n is string[] => Array.isArray(n) && n.length >= 1 && n.length <= 32 && n.every((g) => pathOk(g, true));

function lineOk(l: unknown): l is string {
	if (typeof l !== "string" || l.length > 300 || /[\r\n]/.test(l) || !l.includes("{text}") || /^\s*#/.test(l)) return false;
	return [...l.matchAll(/\{([\w-]+)\}/g)].every((m) => ["time", "key", "text"].includes(m[1]));
}

/** Read `<vault>/.strategium.json`: a regular file of at most 16 KiB holding a JSON object with `daily`, `heading` and `line`. */
export function loadContract(vault: string): ContractResult {
	try {
		if (!statSync(vault).isDirectory()) return { error: "unreachable (not a folder)" };
	} catch (e) {
		return { error: `unreachable (${code(e)})` };
	}
	const file = join(vault, CONTRACT_FILE);
	let text: string;
	try {
		const st = lstatSync(file);
		if (!st.isFile()) return { error: "contract invalid: not a regular file" };
		if (st.size > MAX_CONTRACT) return { error: "contract invalid: larger than 16 KiB" };
		text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
	} catch (e) {
		return { error: code(e) === "ENOENT" ? `no contract (${CONTRACT_FILE})` : `unreachable (${code(e)})` };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { error: "contract invalid: not JSON" };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "contract invalid: not an object" };
	const { daily, heading, line, createDaily, notes, noteHeading } = raw as Record<string, unknown>;
	if (!dailyOk(daily)) return { error: DAILY_BAD };
	if (!headingOk(heading)) return { error: HEADING_BAD };
	if (!lineOk(line)) return { error: LINE_BAD };
	if (notes !== undefined && !notesOk(notes)) return { error: NOTES_BAD };
	if (noteHeading !== undefined && !headingOk(noteHeading)) return { error: NOTE_HEADING_BAD };
	return {
		contract: { daily, heading, line, ...(createDaily === true ? { createDaily } : {}), ...(notes !== undefined ? { notes: notes as string[] } : {}), ...(noteHeading !== undefined ? { noteHeading: noteHeading as string } : {}) },
	};
}

/** One line, trimmed, capped without splitting a surrogate pair. */
function clean(v: string, max: number): string {
	const s = v.replace(/[\x00-\x1f\u2028\u2029]+/g, " ").trim();
	if (s.length <= max) return s;
	const c = s.charCodeAt(max - 1);
	return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

/** Substitute `{time}`, `{key}` and `{text}` in one pass, so a value holding a placeholder is never expanded again. */
export function formatLine(fmt: string, v: { time: string; key: string; text: string }): string {
	const vals = { time: clean(v.time, 64), key: clean(v.key, 64), text: clean(v.text, 200) };
	return fmt.replace(/\{(time|key|text)\}/g, (_, k: keyof typeof vals) => vals[k]);
}

/**
 * Put `line` right after the last non-blank line of the section under `heading`, or at the end under a new heading.
 * Existing lines are never changed; the file's EOL style and BOM are kept.
 */
export function insertUnder(content: string, heading: string, line: string): string {
	const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
	const body = content.slice(bom.length);
	const cr = body.includes("\r\n") ? "\r" : "";
	// Pieces split on "\n" only, so joining them with "\n" restores every original byte; a trailing "" means a final EOL.
	const lines = body.split("\n");
	const want = heading.trimEnd();
	// Lines inside a fenced code block (``` or ~~~, closed by the same mark) or an HTML comment are never headings.
	// A fence or comment that never closes masks nothing: the daily is then read as if it had none.
	const fenced: boolean[] = [];
	let fence = "";
	let comment = false;
	for (const l of lines) {
		const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
		const inComment = comment;
		if (fence === "" && !comment && l.includes("<!--") && !l.includes("-->", l.indexOf("<!--") + 4)) comment = true;
		else if (comment && l.includes("-->")) comment = false;
		fenced.push(fence !== "" || m !== null || inComment || comment);
		if (comment || inComment) continue;
		if (m && fence === "") fence = m[1][0];
		else if (m && m[1][0] === fence) fence = "";
	}
	if (fence !== "" || comment) fenced.fill(false);
	const h = lines.findIndex((l, i) => !fenced[i] && l.trimEnd() === want);
	if (h >= 0) {
		const level = /^#+/.exec(want)![0].length;
		const next = new RegExp(`^#{1,${level}}\\s`);
		let end = h + 1;
		while (end < lines.length && (fenced[end] || !next.test(lines[end]))) end++;
		let at = end;
		while (at > h + 1 && lines[at - 1].trim() === "") at--;
		if (at === lines.length) {
			lines[at - 1] += cr;
			lines.push("");
		}
		lines.splice(at, 0, line + cr);
	} else {
		if (lines[lines.length - 1] !== "") {
			lines[lines.length - 1] += cr;
			lines.push("");
		}
		const last = lines[lines.length - 2];
		lines.pop();
		if (last !== undefined && last.trim() !== "") lines.push(cr);
		lines.push(want + cr, line + cr, "");
	}
	return bom + lines.join("\n");
}

const fold = (p: string): string => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);

/** One path segment against a pattern whose `*` match any run of chars: the parts between the stars are found in order, no regex. */
function segMatch(pat: string, s: string): boolean {
	const parts = pat.split("*");
	if (parts.length === 1) return pat === s;
	const last = parts[parts.length - 1];
	if (!s.startsWith(parts[0]) || !s.endsWith(last)) return false;
	const end = s.length - last.length;
	let pos = parts[0].length;
	if (pos > end) return false;
	for (let i = 1; i < parts.length - 1; i++) {
		const at = s.indexOf(parts[i], pos);
		if (at < 0 || at + parts[i].length > end) return false;
		pos = at + parts[i].length;
	}
	return true;
}

/**
 * Does `note` match the contract glob? Segments split on `/` or `\`, folded like `insideVault`; `**` is zero or more whole segments.
 * The classic wildcard walk: on a mismatch resume at the last `**` with one more note segment consumed, so no path is exponential.
 */
export function matchNote(glob: string, note: string): boolean {
	const g = fold(glob).split(/[\\/]/);
	const n = fold(note).split(/[\\/]/);
	let gi = 0;
	let ni = 0;
	let star = -1;
	let mark = 0;
	while (ni < n.length) {
		if (g[gi] === "**") {
			star = gi++;
			mark = ni;
		} else if (gi < g.length && segMatch(g[gi], n[ni])) {
			gi++;
			ni++;
		} else if (star >= 0) {
			gi = star + 1;
			ni = ++mark;
		} else return false;
	}
	return gi === g.length;
}

/** True when `path`'s nearest existing ancestor, resolved through links, is `realVault` or inside it. */
function insideVault(realVault: string, path: string): boolean {
	let at = path;
	for (;;) {
		try {
			lstatSync(at);
			break;
		} catch (e) {
			const parent = dirname(at);
			if (code(e) !== "ENOENT" || parent === at) return false;
			at = parent;
		}
	}
	let real: string;
	try {
		real = realpathSync(at);
	} catch {
		return false;
	}
	const rel = relative(fold(realVault), fold(real));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * The locked read-insert-write shared by the daily and the notes. `label` prefixes every reason. Appends when `insert` only adds a suffix;
 * otherwise stages the new content in the state dir and copies it over, restoring the old bytes if the copy fails.
 */
function writeLine(
	target: string,
	label: "daily" | "note",
	insert: (old: string) => string,
	create: boolean,
	lockDir: string,
	beforeWrite: (() => void) | undefined,
	copy: (from: string, to: string) => void,
): string | undefined {
	const r = withLock(
		lockDir,
		"vault.lock",
		(): string | undefined => {
			const sig = (): string | undefined => {
				try {
					const st = lstatSync(target);
					return `${st.size}:${st.mtimeMs}`;
				} catch {
					return undefined;
				}
			};
			// A second pass only when the file changed between the read and the write (a sync client or the user saved it).
			for (let pass = 0; ; pass++) {
				let old = "";
				let bytes = Buffer.alloc(0);
				let exists = true;
				try {
					const st = lstatSync(target);
					if (!st.isFile()) return `${label} not a regular file`;
					if (st.size > MAX_DAILY) return `${label} larger than 4 MiB`;
				} catch (e) {
					if (code(e) !== "ENOENT") throw e;
					exists = false;
				}
				const before = sig();
				if (exists) {
					bytes = readFileSync(target);
					old = bytes.toString("utf8");
					if (!Buffer.from(old, "utf8").equals(bytes)) return `${label} not UTF-8`;
				} else {
					if (!create) return `${label} missing`;
					mkdirSync(dirname(target), { recursive: true });
				}
				const next = insert(old);
				if (exists && next.startsWith(old)) {
					appendFileSync(target, next.slice(old.length));
					return undefined;
				}
				if (!exists) {
					writeFileSync(target, next);
					return undefined;
				}
				// Mid-file insert: stage the new content in the state dir first, so the last size/mtime check leaves only the copy in the window.
				const tmp = join(lockDir, `vault-${process.pid}.tmp`);
				try {
					writeFileSync(tmp, next);
					beforeWrite?.();
					if (sig() !== before) {
						if (pass > 0) return `${label} changed while writing`;
						continue;
					}
					try {
						copy(tmp, target);
					} catch (e) {
						try {
							writeFileSync(target, bytes);
						} catch {
							return `${label} write failed (${code(e)}) and could not be restored`;
						}
						return `${label} write failed (${code(e)}), restored`;
					}
				} finally {
					rmSync(tmp, { force: true });
				}
				return undefined;
			}
		},
		500,
	);
	return "busy" in r ? `${label} busy` : r.value;
}

const dateOf = (now: Date): string => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const timeOf = (now: Date): string => `${pad(now.getHours())}:${pad(now.getMinutes())}`;

/**
 * Append one formatted line to the contract's daily note under its heading. Returns the reason it did not write, or undefined.
 * Reads the daily as bytes, refuses > 4 MiB and non-UTF-8 untouched, and holds `<lockDir>/vault.lock` for the write.
 */
export function recordLine(vault: string, contract: Contract, lockDir: string, now: Date, key: string, text: string, beforeWrite?: () => void, copy: (from: string, to: string) => void = copyFileSync): string | undefined {
	try {
		if (!dailyOk(contract.daily)) return DAILY_BAD;
		const target = resolve(vault, ...contract.daily.replaceAll("{date}", dateOf(now)).split(/[\\/]/));
		let realVault: string;
		try {
			realVault = realpathSync(vault);
		} catch (e) {
			return `unreachable (${code(e)})`;
		}
		if (!insideVault(realVault, target)) return "daily outside the vault";
		const line = formatLine(contract.line, { time: timeOf(now), key, text });
		return writeLine(target, "daily", (old) => insertUnder(old, contract.heading, line), !!contract.createDaily, lockDir, beforeWrite, copy);
	} catch (e) {
		return `unreachable (${code(e)})`;
	}
}

/** Validate `note` (a vault-relative path from the model) against the contract's globs and the vault. Reasons carry no `note <path>:` prefix. */
export function noteTarget(vault: string, contract: Contract, now: Date, note: string): { path: string } | { error: string } {
	try {
		if (!contract.notes?.length) return { error: "the contract lists no notes" };
		if (!pathOk(note, false)) return { error: "not a relative .md path inside the vault" };
		if (!contract.notes.some((g) => matchNote(g, note))) return { error: "not allowed by the contract's notes" };
		let realVault: string;
		try {
			realVault = realpathSync(vault);
		} catch (e) {
			return { error: `unreachable (${code(e)})` };
		}
		const path = resolve(vault, ...note.split(/[\\/]/));
		const real = (p: string): string => {
			try {
				return realpathSync(p);
			} catch {
				return p;
			}
		};
		if (dailyOk(contract.daily) && fold(real(path)) === fold(real(resolve(vault, ...contract.daily.replaceAll("{date}", dateOf(now)).split(/[\\/]/))))) return { error: "is today's daily" };
		if (!insideVault(realVault, path)) return { error: "outside the vault" };
		try {
			if (!lstatSync(path).isFile()) return { error: "not a regular file" };
		} catch (e) {
			return { error: code(e) === "ENOENT" ? "missing" : `unreachable (${code(e)})` };
		}
		return { path };
	} catch (e) {
		return { error: `unreachable (${code(e)})` };
	}
}

/**
 * Append one formatted line to an existing note the contract allows: under `noteHeading` when set, else after the note's last line.
 * Never creates the note. Returns the reason it did not write (`note …`), or undefined.
 */
export function recordNote(vault: string, contract: Contract, lockDir: string, now: Date, key: string, text: string, note: string, beforeWrite?: () => void, copy: (from: string, to: string) => void = copyFileSync): string | undefined {
	try {
		const t = noteTarget(vault, contract, now, note);
		if ("error" in t) return `note ${t.error}`;
		const { noteHeading } = contract;
		if (noteHeading !== undefined && !headingOk(noteHeading)) return "note heading invalid";
		const line = formatLine(contract.line, { time: timeOf(now), key, text });
		const insert = (old: string): string => {
			if (noteHeading !== undefined) return insertUnder(old, noteHeading, line);
			const bom = old.startsWith("\uFEFF") ? "\uFEFF" : "";
			const body = old.slice(bom.length);
			const eol = body.includes("\r\n") ? "\r\n" : "\n";
			return old + (body === "" || body.endsWith("\n") ? "" : eol) + line + eol;
		};
		return writeLine(t.path, "note", insert, false, lockDir, beforeWrite, copy);
	} catch (e) {
		return `unreachable (${code(e)})`;
	}
}

const KINDS: [string, RegExp][] = [
	["private key", /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/],
	[
		"token",
		/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}/,
	],
	["NAME=value", /(?:^|[\s;,(`'"])(?:export\s+)?[A-Z][A-Z0-9_]{2,}=[^\s=]/],
	["token", /\bBearer\s+\S{16,}/i],
	[
		"credential",
		/\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret)\s*=\s*\S|\b(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret)\s*:\s*[A-Za-z0-9._~+/-]{16,}/i,
	],
];

/**
 * Name the kind of secret `text` looks like, or undefined. Scans all of it. Every pattern is a literal followed by one class run bounded
 * by a literal or a minimum, so a hostile input stays linear; the matched text is never returned.
 */
export function secretKind(text: string): string | undefined {
	for (const [kind, re] of KINDS) if (re.test(text)) return kind;
	// JWT: a header run holding `eyJ` plus 8 more chars, a dot, 8 more chars. Maximal runs keep the scan linear (a regex would retry every `eyJ`).
	for (const m of text.matchAll(/[A-Za-z0-9_-]+/g)) {
		const end = m.index + m[0].length;
		const at = m[0].indexOf("eyJ");
		if (text[end] !== "." || at < 0 || m[0].length - at - 3 < 8) continue;
		const tail = /[A-Za-z0-9_-]{8}/y;
		tail.lastIndex = end + 1;
		if (tail.test(text)) return "token";
	}
	// No separators in the class: paths, URLs and slugs break into short runs, a bare base64/hex-like key does not.
	for (const m of text.matchAll(/[A-Za-z0-9+=]{32,}/g)) if (/[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) && /\d/.test(m[0])) return "key-like string";
	return undefined;
}
