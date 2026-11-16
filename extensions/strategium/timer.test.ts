import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	append,
	blocks,
	bookedMin,
	claim,
	dueAlert,
	elapsedMin,
	type Ev,
	holds,
	load,
	nowIso,
	openKeys,
	overlapMin,
	release,
} from "./timer";

const base = new Date(2026, 10, 16, 9, 0, 0);
const at = (min: number) => new Date(base.getTime() + min * 60_000);
const t = (min: number) => nowIso(at(min));

const closed: Ev[] = [
	{ ts: t(0), event: "start", key: "A", booked: 100 },
	{ ts: t(10), event: "stop", key: "A" },
	{ ts: t(20), event: "start", key: "A" },
	{ ts: t(35), event: "stop", key: "A" },
];
const open: Ev[] = [{ ts: t(0), event: "start", key: "A", booked: 10 }];
const ab: Ev[] = [
	{ ts: t(0), event: "start", key: "A", booked: 10 },
	{ ts: t(5), event: "stop", key: "A" },
	{ ts: t(6), event: "start", key: "B", booked: 10 },
];
const par: Ev[] = [
	{ ts: t(0), event: "start", key: "A", booked: 60 },
	{ ts: t(10), event: "start", key: "B", booked: 30 },
	{ ts: t(25), event: "stop", key: "A" },
];

describe("elapsed time", () => {
	test("sums closed blocks", () => expect(elapsedMin(closed, "A", at(60))).toBe(25));
	test("an open block counts to now", () => expect(elapsedMin(open, "A", at(7))).toBe(7));
	test("booked falls back to an earlier start", () => expect(bookedMin(closed, "A")).toBe(100));
	test("prior minutes count once across pause/resume", () => {
		const prior: Ev[] = [
			{ ts: t(0), event: "start", key: "C", booked: 100, prior: 45 },
			{ ts: t(10), event: "stop", key: "C" },
			{ ts: t(20), event: "start", key: "C", booked: 100 },
		];
		expect(elapsedMin(prior, "C", at(25))).toBe(60);
		expect(dueAlert(prior, "C", at(25))).toBe(50);
	});
});

describe("alerts", () => {
	test("50 fires at half the booking, not before", () => {
		expect(dueAlert(open, "A", at(4))).toBeUndefined();
		expect(dueAlert(open, "A", at(5))).toBe(50);
	});
	test("after a 50 alert: nothing, then 80, and only 100 after a jump", () => {
		const after50: Ev[] = [...open, { ts: t(5), event: "alert", key: "A", p: 50 }];
		expect(dueAlert(after50, "A", at(6))).toBeUndefined();
		expect(dueAlert(after50, "A", at(8))).toBe(80);
		expect(dueAlert(after50, "A", at(12))).toBe(100);
	});
	test("prior already past the booking fires 100 at once", () =>
		expect(dueAlert([{ ts: t(0), event: "start", key: "D", booked: 60, prior: 90 }], "D", at(0))).toBe(100));
});

describe("manual adjustments", () => {
	const adj: Ev[] = [
		{ ts: t(0), event: "start", key: "E", booked: 60 },
		{ ts: t(10), event: "adjust", key: "E", prior: 30 },
		{ ts: t(20), event: "stop", key: "E" },
		{ ts: t(25), event: "adjust", key: "E", prior: -5 },
	];
	test("added and removed minutes change the worked time", () => expect(elapsedMin(adj, "E", at(40))).toBe(45));
	test("an adjustment does not open or close the ticket", () => {
		expect(openKeys(adj)).toEqual([]);
		expect(openKeys(adj.slice(0, 2))).toEqual(["E"]);
		expect(elapsedMin(adj.slice(0, 2), "E", at(15))).toBe(45);
	});
	test("adjustments push alerts over the threshold", () => expect(dueAlert(adj.slice(0, 2), "E", at(15))).toBe(50));
	test("worked time never goes below zero", () =>
		expect(elapsedMin([{ ts: t(0), event: "adjust", key: "F", prior: -30 }], "F", at(5))).toBe(0));
	test("adjustments are not part of the overlap", () =>
		expect(overlapMin([...adj, { ts: t(30), event: "adjust", key: "G", prior: 10 }], at(40))).toBe(0));
});

describe("parallel tickets", () => {
	test("open keys after a switch", () => expect(openKeys(ab)).toEqual(["B"]));
	test("two keys open at once", () => expect(openKeys(par.slice(0, 2))).toEqual(["A", "B"]));
	test("each key counts its own time", () => {
		expect(elapsedMin(par, "A", at(40))).toBe(25);
		expect(elapsedMin(par, "B", at(40))).toBe(30);
		expect(dueAlert(par, "B", at(40))).toBe(100);
	});
	test("overlap is the time two keys ran together", () => {
		expect(overlapMin(ab, at(16))).toBe(0);
		expect(overlapMin(par, at(40))).toBe(15);
		expect(overlapMin(par.slice(0, 2), at(20))).toBe(10);
	});
	test("blocks end an open block in now", () =>
		expect(blocks(ab, at(16))).toEqual([
			{ key: "A", start: "09:00", end: "09:05", min: 5 },
			{ key: "B", start: "09:06", end: "now", min: 10 },
		]));
});

// A crashed or sleeping session's block is closed at its last heartbeat, written to the file after newer events.
describe("gap closed at the last heartbeat", () => {
	test("load puts a late-written stop back in time order", () => {
		const dir = mkdtempSync(join(tmpdir(), "st-gap-"));
		try {
			const file = join(dir, "day.jsonl");
			append(file, { ts: t(0), event: "start", key: "A", booked: 60 }); // session A, later silent
			append(file, { ts: t(10), event: "start", key: "B", booked: 60 }); // session B
			append(file, { ts: t(40), event: "stop", key: "B" });
			append(file, { ts: t(20), event: "stop", key: "A" }); // A's gap closed at its last beat, written late
			const evs = load(file);
			expect(evs.map(e => e.ts)).toEqual([t(0), t(10), t(20), t(40)]);
			expect(openKeys(evs)).toEqual([]);
			expect(elapsedMin(evs, "A", at(60))).toBe(20); // the silent 20-60 is not counted
			expect(overlapMin(evs, at(60))).toBe(10); // A and B together only 10-20
			expect(blocks(evs, at(60)).find(b => b.key === "A")).toEqual({ key: "A", start: "09:00", end: "09:20", min: 20 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// Claims race between omp sessions, so these spawn real processes that claim at the same time.
describe("ticket claims across processes", () => {
	const timerPath = join(import.meta.dir, "timer.ts").replaceAll("\\", "/");
	const race = async (dir: string, takeover: string | undefined) => {
		const arg = takeover === undefined ? "undefined" : JSON.stringify(takeover);
		const procs = Array.from({ length: 8 }, (_, i) =>
			Bun.spawn({
				cmd: [
					process.execPath,
					"-e",
					`import { claim } from "${timerPath}"; try { claim(${JSON.stringify(dir)}, "RACE-1", "s${i}", ${arg}); console.log("WIN") } catch { console.log("LOSE") }`,
				],
				stdout: "pipe",
			}),
		);
		const outs = await Promise.all(procs.map(p => new Response(p.stdout).text()));
		return outs.filter(o => o.includes("WIN")).length;
	};
	const withDir = async (fn: (dir: string) => Promise<void>) => {
		const dir = mkdtempSync(join(tmpdir(), "st-claim-"));
		try {
			await fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	const deadLock = (dir: string) => {
		mkdirSync(join(dir, "claims"), { recursive: true });
		writeFileSync(join(dir, "claims", "RACE-1.lock"), "session-dead0001");
	};

	test("exactly one of 8 simultaneous begins wins", () => withDir(async dir => expect(await race(dir, undefined)).toBe(1)));
	test("a held ticket is refused without takeover", () =>
		withDir(async dir => {
			deadLock(dir);
			expect(await race(dir, undefined)).toBe(0);
		}));
	test("exactly one of 8 takeovers of the same dead holder wins", () =>
		withDir(async dir => {
			deadLock(dir);
			expect(await race(dir, "dead0001")).toBe(1);
			expect(readFileSync(join(dir, "claims", "RACE-1.lock"), "utf8")).toMatch(/^s[0-7]$/);
			expect(existsSync(join(dir, "claims", "RACE-1.lock.force"))).toBe(false);
		}));
	test("takeover naming the wrong holder is refused", () =>
		withDir(async dir => {
			deadLock(dir);
			expect(() => claim(dir, "RACE-1", "me", "someone-else")).toThrow();
			expect(holds(dir, "RACE-1", "me")).toBe(false);
		}));
	test("release only by the holder", () =>
		withDir(async dir => {
			claim(dir, "K", "a");
			release(dir, "K", "b");
			expect(holds(dir, "K", "a")).toBe(true);
			release(dir, "K", "a");
			expect(holds(dir, "K", "a")).toBe(false);
		}));
});
