// Vault records (#151): parse an untrusted contract file, format one line, insert it under a heading and write the daily.
// Everything here treats the vault and the daily as untrusted input and never throws: failures come back as reason strings.

import { appendFileSync, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withLock } from "./roster";

export const CONTRACT_FILE = ".strategium.json";
export type Contract = { daily: string; heading: string; line: string; createDaily?: true };
export type ContractResult = { contract: Contract } | { error: string };

const MAX_CONTRACT = 16 * 1024;
const MAX_DAILY = 4 * 1024 * 1024;
const DAILY_BAD = "contract invalid: daily must be a relative .md path with {date} inside the vault";
const HEADING_BAD = "contract invalid: heading must be one markdown heading line (# to ######)";
const LINE_BAD = "contract invalid: line must be one line with {text}, only {time} {key} {text}, not starting with #";

const code = (e: unknown): string => String((e as NodeJS.ErrnoException)?.code ?? "error");

function dailyOk(daily: unknown): daily is string {
	if (typeof daily !== "string" || daily.length > 200 || !daily.includes("{date}") || !daily.endsWith(".md")) return false;
	// Empty segments cover absolute (`/x`, `\\x`) and doubled separators; ":" covers drive letters; a leading "." covers `.`, `..`, `.obsidian`, `.git`.
	return daily.split(/[\\/]/).every((s) => s !== "" && !s.startsWith(".") && !/[ .]$/.test(s) && !/[:<>"|?*\0]/.test(s));
}

const headingOk = (h: unknown): h is string => typeof h === "string" && h.length <= 200 && /^#{1,6} \S[^\r\n]*$/.test(h);

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
		text = readFileSync(file, "utf8");
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
	const { daily, heading, line, createDaily } = raw as Record<string, unknown>;
	if (!dailyOk(daily)) return { error: DAILY_BAD };
	if (!headingOk(heading)) return { error: HEADING_BAD };
	if (!lineOk(line)) return { error: LINE_BAD };
	return { contract: { daily, heading, line, ...(createDaily === true ? { createDaily } : {}) } };
}

/** One line, trimmed, capped without splitting a surrogate pair. */
function clean(v: string, max: number): string {
	const s = v.replace(/[\r\n]+/g, " ").trim();
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
	// Lines inside a fenced code block (``` or ~~~, closed by the same mark) are never headings.
	const fenced: boolean[] = [];
	let fence = "";
	for (const l of lines) {
		const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
		fenced.push(fence !== "" || m !== null);
		if (m && fence === "") fence = m[1][0];
		else if (m && m[1][0] === fence) fence = "";
	}
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
 * Append one formatted line to the contract's daily note under its heading. Returns the reason it did not write, or undefined.
 * Reads the daily as bytes, refuses > 4 MiB and non-UTF-8 untouched, and holds `<lockDir>/vault.lock` for the write.
 */
export function recordLine(vault: string, contract: Contract, lockDir: string, now: Date, key: string, text: string, beforeWrite?: () => void): string | undefined {
	try {
		if (!dailyOk(contract.daily)) return DAILY_BAD;
		const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		const target = resolve(vault, ...contract.daily.replaceAll("{date}", date).split(/[\\/]/));
		let realVault: string;
		try {
			realVault = realpathSync(vault);
		} catch (e) {
			return `unreachable (${code(e)})`;
		}
		if (!insideVault(realVault, target)) return "daily outside the vault";
		const line = formatLine(contract.line, { time: `${pad(now.getHours())}:${pad(now.getMinutes())}`, key, text });
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
				// A second pass only when the daily changed between the read and the write (a sync client or the user saved it).
				for (let pass = 0; ; pass++) {
					let old = "";
					let bytes = Buffer.alloc(0);
					let exists = true;
					try {
						const st = lstatSync(target);
						if (!st.isFile()) return "daily not a regular file";
						if (st.size > MAX_DAILY) return "daily larger than 4 MiB";
					} catch (e) {
						if (code(e) !== "ENOENT") throw e;
						exists = false;
					}
					const before = sig();
					if (exists) {
						bytes = readFileSync(target);
						old = bytes.toString("utf8");
						if (!Buffer.from(old, "utf8").equals(bytes)) return "daily not UTF-8";
					} else {
						if (!contract.createDaily) return "daily missing";
						mkdirSync(dirname(target), { recursive: true });
					}
					const next = insertUnder(old, contract.heading, line);
					if (exists && next.startsWith(old)) {
						appendFileSync(target, next.slice(old.length));
						return undefined;
					}
					if (!exists) {
						writeFileSync(target, next);
						return undefined;
					}
					beforeWrite?.();
					if (sig() !== before) {
						if (pass > 0) return "daily changed while writing";
						continue;
					}
					// Mid-file insert: stage the new content in the state dir, then copy it over; a failed copy restores the old bytes.
					const tmp = join(lockDir, `vault-${process.pid}.tmp`);
					try {
						writeFileSync(tmp, next);
						try {
							copyFileSync(tmp, target);
						} catch (e) {
							try {
								writeFileSync(target, bytes);
							} catch {
								// the restore failed too: the error below says so
								return `daily write failed (${code(e)}) and could not be restored`;
							}
							return `daily write failed (${code(e)}), restored`;
						}
					} finally {
						rmSync(tmp, { force: true });
					}
					return undefined;
				}
			},
			500,
		);
		return "busy" in r ? "daily busy" : r.value;
	} catch (e) {
		return `unreachable (${code(e)})`;
	}
}
