// Service record and shared roster (#134): pure record logic plus the locked, synchronous file I/O.
// Nothing here throws to a caller that handles a tool call: a busy lock or a bad file comes back as a value.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NameEntry } from "./names";
import { writeAtomic } from "./timer";

export type Service = { passed: number; penances: number; falls: number; squads: number; purity: number; halo: number; laurel: number };
export type Brothers = Record<string, Service>;
export type Outcome = { brother: string; squad: string; kind: "first" | "penance" | "saved" | "fell"; penances: number };

const COUNTERS = ["passed", "penances", "falls", "squads", "purity", "halo", "laurel"] as const;
const NAME_RE = /^[A-Z][A-Za-z]{1,19}$/;
const MAX_BYTES = 256 * 1024;
export const STALE_MS = 10_000;
const RETRY_MS = 20;

const empty = (): Brothers => Object.create(null);
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const grow = (a: number, by: number) => Math.min(Number.MAX_SAFE_INTEGER, a + by);

/** Kept in reserve: derived from the counters, so it can never go stale. */
export const corrupted = (s: Service): boolean => s.falls >= 3 || (s.squads >= 5 && s.penances > s.passed);
export const crux = (s: Service): boolean => s.passed >= 10;

/** Available brothers, best first: passed desc, falls asc, penances asc, name asc. Corrupted and `skip` are left out. */
export function rankBrothers(brothers: Brothers, skip: ReadonlySet<string>): string[] {
	return Object.keys(brothers)
		.filter(n => !skip.has(n) && !corrupted(brothers[n] as Service))
		.sort((a, b) => {
			const x = brothers[a] as Service;
			const y = brothers[b] as Service;
			return y.passed - x.passed || x.falls - y.falls || x.penances - y.penances || (a < b ? -1 : a > b ? 1 : 0);
		});
}

const isBuilder = (e: NameEntry) => (e.agent === "battle-brother" || e.agent === "veteran") && !e.old;

/**
 * D3: one outcome per squad whose latest builder ended and that has a not-retired builder name.
 * Reads a hand-edited run file: anything but "ok"/"failed" in `ended` or a safe integer in `builds` is ignored.
 */
export function runOutcomes(run: { names?: readonly NameEntry[]; builds?: unknown; ended?: unknown }): Outcome[] {
	if (!Array.isArray(run.names) || !isObject(run.ended)) return [];
	const builds = isObject(run.builds) ? run.builds : {};
	const out: Outcome[] = [];
	for (const [squad, end] of Object.entries(run.ended)) {
		if (end !== "ok" && end !== "failed") continue;
		const own = (run.names as NameEntry[]).filter(e => isBuilder(e) && e.squad === squad);
		const brother = own[0]?.surname;
		if (!brother || !NAME_RE.test(brother)) continue;
		const n = count(builds[squad]);
		const kind = end === "failed" ? "fell" : own.some(e => e.agent === "veteran" && e.spawned) ? "saved" : n <= 1 ? "first" : "penance";
		out.push({ brother, squad, kind, penances: Math.max(0, n - 1) });
	}
	return out;
}

/** True while a squad with a not-retired, spawned builder has no outcome: a merge then does not earn the Laurel. */
export function unfinished(run: { names?: readonly NameEntry[]; ended?: unknown }): boolean {
	if (!Array.isArray(run.names)) return false;
	const ended = isObject(run.ended) ? run.ended : {};
	return (run.names as NameEntry[]).some(e => isBuilder(e) && e.spawned && e.squad !== undefined && ended[e.squad] !== "ok" && ended[e.squad] !== "failed");
}

/** D3 + D4: a new map; counters only grow. The Laurel needs a merge and every outcome a first-build pass. */
export function applyRun(brothers: Brothers, outcomes: readonly Outcome[], merged: boolean): Brothers {
	const next = empty();
	for (const [name, s] of Object.entries(brothers)) next[name] = { ...s };
	const laurel = merged && outcomes.length > 0 && outcomes.every(o => o.kind === "first");
	const crowned = new Set<string>();
	for (const o of outcomes) {
		const s = (next[o.brother] ??= { passed: 0, penances: 0, falls: 0, squads: 0, purity: 0, halo: 0, laurel: 0 });
		s.squads = grow(s.squads, 1);
		s.penances = grow(s.penances, o.penances);
		if (o.kind === "fell") s.falls = grow(s.falls, 1);
		else s.passed = grow(s.passed, o.kind === "saved" ? 2 : 1);
		if (o.kind === "first") s.purity = grow(s.purity, 1);
		if (o.kind === "saved") s.halo = grow(s.halo, 1);
		if (laurel && !crowned.has(o.brother)) {
			crowned.add(o.brother);
			s.laurel = grow(s.laurel, 1);
		}
	}
	return next;
}

export type Brother = { name: string; surname: string; service?: Service; crux?: true; corrupted?: true };

/** Squad id → the squad's current builder: the last spawned not-retired builder entry, else the last one. `service` is undefined for a recruit or an unreadable roster. */
export function squadBrothers(names: readonly NameEntry[] | undefined, brothers: Brothers | undefined): Record<string, Brother> {
	const out: Record<string, Brother> = Object.create(null);
	const own = (Array.isArray(names) ? (names as NameEntry[]) : []).filter(e => isBuilder(e) && e.squad !== undefined);
	for (const squad of new Set(own.map(e => e.squad as string))) {
		const mine = own.filter(e => e.squad === squad);
		const e = (mine.findLast(x => x.spawned) ?? mine.at(-1)) as NameEntry;
		const service = brothers && Object.hasOwn(brothers, e.surname) ? brothers[e.surname] : undefined;
		out[squad] = { name: e.name, surname: e.surname, ...(service ? { service } : {}), ...(service && crux(service) ? { crux: true } : {}), ...(service && corrupted(service) ? { corrupted: true } : {}) };
	}
	return out;
}

export type Honour = {
	brother: string;
	squad: string;
	kind: Outcome["kind"];
	penances: number;
	earned: ("Purity Seal" | "Iron Halo" | "Laurel Imperialis" | "Crux Terminatus")[];
	joined?: true;
	corrupted?: true;
};

/**
 * One row per outcome, from the `applyRun(before)` diff so it can never disagree with the saved record.
 * Laurel, Crux, joined and corrupted belong to the brother, so they sit on his first row. Without `before` the old record is unknown: no joined, Crux or corrupted.
 */
export function honours(outcomes: readonly Outcome[], merged: boolean, before?: Brothers): Honour[] {
	const old = before ?? empty();
	const after = applyRun(old, outcomes, merged);
	const seen = new Set<string>();
	return outcomes.map(o => {
		const b = Object.hasOwn(old, o.brother) ? old[o.brother] : undefined;
		const a = after[o.brother] as Service;
		const first = !seen.has(o.brother);
		seen.add(o.brother);
		const earned: Honour["earned"] = [];
		if (o.kind === "first") earned.push("Purity Seal");
		if (o.kind === "saved") earned.push("Iron Halo");
		if (first && a.laurel > (b?.laurel ?? 0)) earned.push("Laurel Imperialis");
		const known = first && before !== undefined;
		if (known && crux(a) && !(b && crux(b))) earned.push("Crux Terminatus");
		return {
			brother: o.brother,
			squad: o.squad,
			kind: o.kind,
			penances: o.penances,
			earned,
			...(known && !b ? { joined: true as const } : {}),
			...(known && corrupted(a) && !(b && corrupted(b)) ? { corrupted: true as const } : {}),
		};
	});
}

/** D7: the whole file is readable or it is not; no partial salvage. */
export function parseRoster(text: string): { brothers: Brothers } | { error: string } {
	if (text.length > MAX_BYTES) return { error: "larger than 256 KiB" };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { error: "not valid JSON" };
	}
	if (!isObject(raw)) return { error: "not a JSON object" };
	if (raw.version !== 1) return { error: "version is not 1" };
	if (!isObject(raw.brothers)) return { error: "brothers is not an object" };
	const brothers = empty();
	for (const [name, rec] of Object.entries(raw.brothers)) {
		const shown = JSON.stringify(name.slice(0, 30));
		if (!NAME_RE.test(name)) return { error: `bad brother name ${shown}` };
		if (!isObject(rec)) return { error: `record of ${shown} is not an object` };
		const s = {} as Service;
		for (const k of COUNTERS) {
			const v = rec[k];
			if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return { error: `${shown} ${k} is not a non-negative integer` };
			s[k] = v;
		}
		brothers[name] = s;
	}
	return { brothers };
}

export function serializeRoster(brothers: Brothers): string {
	const sorted: Record<string, Service> = {};
	for (const name of Object.keys(brothers).sort()) sorted[name] = brothers[name] as Service;
	return `${JSON.stringify({ version: 1, brothers: sorted })}\n`;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const rosterFile = (dir: string) => join(dir, "roster.json");

/** Missing file: empty roster. Anything unreadable: `{ error }`, and the file is never touched. */
export function loadRoster(dir: string): { brothers: Brothers } | { error: string } {
	const file = rosterFile(dir);
	try {
		if (statSync(file).size > MAX_BYTES) return { error: "larger than 256 KiB" };
		return parseRoster(readFileSync(file, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { brothers: empty() };
		return { error: msg(err) };
	}
}

/** True when `pid` is certainly gone: kill(pid, 0) says ESRCH (EPERM means it lives, another user's). */
function dead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** EEXIST is a held lock; on Windows a lock being deleted answers EPERM or EACCES for a moment, so those wait too. */
export const retryable = (code: string | undefined, platform: string = process.platform): boolean =>
	code === "EEXIST" || (platform === "win32" && (code === "EPERM" || code === "EACCES"));

/** Remove a lock older than STALE_MS or whose holder pid (the token's first number) is dead, but only if it is still the same file we looked at. */
function takeStale(lock: string): void {
	try {
		const seen = statSync(lock);
		if (Date.now() - seen.mtimeMs <= STALE_MS) {
			const pid = Number(/^(\d+)-/.exec(readFileSync(lock, "utf8"))?.[1]);
			if (!(pid > 0) || !dead(pid)) return;
		}
		const now = statSync(lock);
		// shortcut: a holder may replace the lock between this re-check and the rm; stale takeover is rare, upgrade to a rename-claim if it ever bites.
		if (now.mtimeMs === seen.mtimeMs && now.ino === seen.ino) rmSync(lock, { force: true });
	} catch {
		// Gone already: the next create wins or loses on its own.
	}
}

/**
 * Run `fn` under `<dir>/roster.lock` (exclusive create, 20 ms retries up to `waitMs`, stale after 10 s or when its holder's pid is dead).
 * `{ busy: true }` when the lock could not be taken, including a state dir that cannot hold it. `fn`'s own errors propagate after the release.
 */
export function withRosterLock<T>(dir: string, fn: () => T, waitMs = 2000): { value: T } | { busy: true } {
	const lock = join(dir, "roster.lock");
	const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
	const deadline = Date.now() + waitMs;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		for (;;) {
			try {
				writeFileSync(lock, token, { flag: "wx", mode: 0o600 });
				break;
			} catch (err) {
				if (!retryable((err as NodeJS.ErrnoException).code)) return { busy: true };
				takeStale(lock);
				if (Date.now() >= deadline) return { busy: true };
				sleep(RETRY_MS);
			}
		}
	} catch {
		return { busy: true };
	}
	try {
		return { value: fn() };
	} finally {
		try {
			if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
		} catch {
			// Already gone: nothing to release.
		}
	}
}

/** Lock, load, refuse on an unreadable roster, apply `fn`, write atomically. Returns the reason it did not write, or undefined. */
export function updateRoster(dir: string, fn: (brothers: Brothers) => Brothers, waitMs?: number): string | undefined {
	try {
		const r = withRosterLock(
			dir,
			() => {
				const loaded = loadRoster(dir);
				if ("error" in loaded) return `roster unreadable (${loaded.error})`;
				writeAtomic(rosterFile(dir), serializeRoster(fn(loaded.brothers)));
				return undefined;
			},
			waitMs,
		);
		return "busy" in r ? "roster busy" : r.value;
	} catch (err) {
		return msg(err);
	}
}
