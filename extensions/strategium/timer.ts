import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

/** A day file is `YYYY-MM-DD.jsonl`; anything else never becomes a path. */
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// The sanitised key keeps the lock readable; the hash keeps two keys apart ("A/B" and "A_B"
// would otherwise share one lock). Exported so tests and tools use the same name.
export const safeName = (key: string) => `${key.replace(/[^\w.-]/g, "_")}-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`;
export const lockPath = (dir: string, key: string) => join(dir, "claims", `${safeName(key)}.lock`);
const holder = (lock: string) => {
	try {
		return readFileSync(lock, "utf8");
	} catch {
		return undefined;
	}
};

/**
 * Claim `key` for session `sid` with an exclusive create, so two sessions starting the same ticket at once
 * cannot both win. A live holder keeps it.
 * `takeover` (the holder crashed) is the holder's id as reported by the refusal (its last 8 characters are
 * enough). Under an exclusive `<lock>.force` guard the lock is replaced only if it still names that holder:
 * a compare-and-swap, so of several sessions taking over the same dead holder exactly one wins, and a holder
 * that changed in between is never stolen.
 */
export function claim(dir: string, key: string, sid: string, takeover?: string): void {
	const lock = lockPath(dir, key);
	mkdirSync(join(dir, "claims"), { recursive: true, mode: 0o700 });
	const create = () => writeFileSync(lock, sid, { flag: "wx" });
	try {
		return create();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	if (holder(lock) === sid) return;
	const held = () =>
		new Error(
			`${key} is held by omp session ${holder(lock)?.slice(-8)}; end it there, or take it over with that id if that session is gone`,
		);
	if (!takeover) throw held();
	// The takeover id is the last 8 characters of the holder's session id, compared in full: a short
	// id can never match, so it cannot steal a live session that happens to end the same way.
	const want = takeover.slice(-8);
	const guard = `${lock}.force`;
	acquireGuard(guard, sid, held);
	try {
		const now = holder(lock);
		if (!now || now.slice(-8) !== want) throw held();
		// Replace the lock in one step: rm + create leaves it missing, and a session reading it
		// then believes it lost the ticket.
		const tmp = `${lock}.${process.pid}.swap`;
		writeFileSync(tmp, sid, { flag: "wx" });
		renameSync(tmp, lock);
	} finally {
		rmSync(guard, { force: true });
	}
}

/**
 * Take the takeover guard. A guard left by a killed process would block every later takeover,
 * so an old one is dropped; a fresh one means another session is taking over right now.
 */
function acquireGuard(guard: string, sid: string, held: () => Error): void {
	const stale = (): boolean => {
		try {
			const age = Date.now() - Number(readFileSync(guard, "utf8").split(" ")[1]);
			return !Number.isFinite(age) || age > 5 * 60_000;
		} catch {
			return false;
		}
	};
	try {
		writeFileSync(guard, `${sid} ${Date.now()}`, { flag: "wx" });
		return;
	} catch {}
	if (!stale()) throw held();
	rmSync(guard, { force: true });
	try {
		writeFileSync(guard, `${sid} ${Date.now()}`, { flag: "wx" });
	} catch {
		throw held();
	}
}

/** True while `sid` holds `key`; a session checks it before acting on its ticket. */
export function holds(dir: string, key: string, sid: string): boolean {
	return holder(lockPath(dir, key)) === sid;
}

/** Release `key` if `sid` holds it. */
export function release(dir: string, key: string, sid: string): void {
	if (holds(dir, key, sid)) rmSync(lockPath(dir, key), { force: true });
}

/**
 * `prior`: minutes worked on `key` today before tracking started (estimate, set by `begin`).
 * `adjust` events carry a manual correction in `prior` (plus or minus minutes, set by `add`).
 */
export type Ev = {
	ts: string;
	event: "start" | "stop" | "alert" | "adjust" | "station" | "seal" | "spawn" | "redraft";
	key: string;
	booked?: number;
	prior?: number;
	p?: number;
	station?: string; // station event: the todo station entered
	seal?: string; // seal event: the seal id
	state?: "asked" | "granted"; // seal event
	role?: string; // spawn event: agent name
	tier?: string;
	model?: string;
	squad?: string;
};
const isSpan = (e: Ev) => e.event === "start" || e.event === "stop";

export const THRESHOLDS = [50, 80, 100];

const pad = (n: number) => String(n).padStart(2, "0");
const ms = (ts: string) => new Date(ts).getTime();

/** Minutes spent on `key`: every `prior` and adjustment, plus every start->stop span; an open start runs to `now`. */
export function elapsedMin(evs: Ev[], key: string, now: Date): number {
	let total = 0;
	let open: number | undefined;
	for (const e of evs) {
		if (e.key !== key) continue;
		if (e.event === "start" || e.event === "adjust") total += (e.prior ?? 0) * 60_000;
		if (e.event === "start" && open === undefined) open = ms(e.ts);
		else if (e.event === "stop" && open !== undefined) {
			total += ms(e.ts) - open;
			open = undefined;
		}
	}
	if (open !== undefined) total += now.getTime() - open;
	return Math.max(0, total / 60_000);
}

/** `booked` of the last start of `key` that carries one. */
export function bookedMin(evs: Ev[], key: string): number | undefined {
	for (let i = evs.length - 1; i >= 0; i--) {
		const e = evs[i];
		if (e.key === key && e.event === "start" && e.booked !== undefined) return e.booked;
	}
	return undefined;
}

/** Keys whose last start/stop event is a start (several when tickets run in parallel). */
export function openKeys(evs: Ev[]): string[] {
	const last = new Map<string, string>();
	for (const e of evs) if (isSpan(e)) last.set(e.key, e.event);
	return [...last].filter(([, ev]) => ev === "start").map(([k]) => k);
}

/** Minutes during which two or more keys were open at once (events in time order, as `load` returns them). */
export function overlapMin(evs: Ev[], now: Date): number {
	const open = new Set<string>();
	let total = 0;
	let since = 0;
	for (const e of evs.filter(isSpan)) {
		const t = ms(e.ts);
		if (open.size >= 2) total += t - since;
		since = t;
		if (e.event === "start") open.add(e.key);
		else open.delete(e.key);
	}
	if (open.size >= 2) total += now.getTime() - since;
	return total / 60_000;
}

/** Every stretch between two span events with at least one key open (events in time order); an open span runs to `now`. */
function stretches(evs: Ev[], now: Date): { start: number; end: number; keys: string[] }[] {
	const open = new Set<string>();
	const out: { start: number; end: number; keys: string[] }[] = [];
	let since = 0;
	const close = (t: number) => {
		if (open.size && t > since) out.push({ start: since, end: t, keys: [...open].sort() });
	};
	for (const e of evs.filter(isSpan)) {
		const t = ms(e.ts);
		close(t);
		since = t;
		if (e.event === "start") open.add(e.key);
		else open.delete(e.key);
	}
	close(now.getTime());
	return out;
}

/** Every maximal interval during which two or more keys were open; a change in the key set starts a new one. */
export function overlaps(evs: Ev[], now: Date): { start: Date; end: Date; keys: string[] }[] {
	const out: { start: number; end: number; keys: string[] }[] = [];
	for (const s of stretches(evs, now)) {
		if (s.keys.length < 2) continue;
		const last = out.at(-1);
		if (last && last.end === s.start && last.keys.join("\0") === s.keys.join("\0")) last.end = s.end;
		else out.push(s);
	}
	return out.map(o => ({ start: new Date(o.start), end: new Date(o.end), keys: o.keys }));
}

/** Minutes of span per key with each stretch shared equally by the keys open in it: the totals add up to the wall time. */
export function splitMin(evs: Ev[], now: Date): Map<string, number> {
	const out = new Map<string, number>();
	for (const s of stretches(evs, now))
		for (const k of s.keys) out.set(k, (out.get(k) ?? 0) + (s.end - s.start) / s.keys.length / 60_000);
	return out;
}

/** Highest newly crossed threshold, or undefined. After a gap only the highest fires, once. */
export function dueAlert(evs: Ev[], key: string, now: Date): number | undefined {
	const booked = bookedMin(evs, key);
	if (!booked) return undefined;
	const el = elapsedMin(evs, key, now);
	let reached = 0;
	for (const p of THRESHOLDS) if (el >= (booked * p) / 100) reached = p;
	let alerted = 0;
	for (const e of evs) if (e.key === key && e.event === "alert" && (e.p ?? 0) > alerted) alerted = e.p ?? 0;
	return reached > alerted ? reached : undefined;
}

/** Work blocks of the day; HH:MM times, an open block ends in "now" (or at 23:59 when `past`: `now` is then that day's end). */
export function blocks(evs: Ev[], now: Date, past = false): { key: string; start: string; end: string; min: number }[] {
	const out: { key: string; start: string; end: string; min: number }[] = [];
	const open = new Map<string, string>();
	for (const e of evs) {
		if (e.event === "start" && !open.has(e.key)) open.set(e.key, e.ts);
		else if (e.event === "stop" && open.has(e.key)) {
			const s = open.get(e.key) as string;
			out.push({ key: e.key, start: s.slice(11, 16), end: e.ts.slice(11, 16), min: Math.floor((ms(e.ts) - ms(s)) / 60_000) });
			open.delete(e.key);
		}
	}
	for (const [key, s] of open) {
		// A block left open in a past day ends with that day, not with now: the time after it is not work.
		const started = new Date(s);
		const sameDay = !past && started.toDateString() === now.toDateString();
		const end = sameDay ? now : new Date(started.getFullYear(), started.getMonth(), started.getDate(), 23, 59, 59);
		out.push({ key, start: s.slice(11, 16), end: sameDay ? "now" : "23:59", min: Math.floor((end.getTime() - ms(s)) / 60_000) });
	}
	return out;
}

export function dayFile(dir: string, d: Date): string {
	return join(dir, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`);
}

/**
 * Day events in time order. A gap closed at a session's last heartbeat is appended late with an earlier timestamp,
 * so the file is not always chronological; the sort is stable, so same-second events keep their file order.
 */
export function load(file: string): Ev[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(l => l.trim())
		// A half-written line (a killed process) must not take the whole day down with it.
		.map(l => {
			try {
				return JSON.parse(l) as Ev;
			} catch {
				// A half-written line has no newline, so it merges with the next one: recover the
				// event that follows it instead of losing both.
				const i = l.lastIndexOf('{"ts"');
				if (i > 0) {
					try {
						return JSON.parse(l.slice(i)) as Ev;
					} catch {
						return undefined;
					}
				}
				return undefined;
			}
		})
		.filter((e): e is Ev => e !== undefined)
		.sort((a, b) => ms(a.ts) - ms(b.ts));
}

export function append(file: string, ev: Ev): void {
	appendFileSync(file, `${JSON.stringify(ev)}\n`, { mode: 0o600 });
}

/** Local time with offset, seconds precision (toISOString is UTC). */
export function nowIso(d: Date = new Date()): string {
	const off = -d.getTimezoneOffset();
	const sign = off >= 0 ? "+" : "-";
	const a = Math.abs(off);
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
		`${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
	);
}

/** Write through a temp file and rename, so a reader in another session never sees half a file. */
export function writeAtomic(file: string, data: string): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, data, { mode: 0o600 });
	// Windows refuses the rename for a moment while a scanner or indexer holds the target or the temp file open.
	// ponytail: ~1 s of bounded retries, Windows only (blocking, like the sync write); a longer lock still throws.
	for (let tries = 0; ; tries++) {
		try {
			return renameSync(tmp, file);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (process.platform !== "win32" || tries >= 20 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw err;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
	}
}
