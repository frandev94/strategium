import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	append,
	blocks,
	bookedMin,
	claim,
	DAY_RE,
	dayFile,
	dueAlert,
	elapsedMin,
	type Ev,
	holds,
	load,
	lockPath,
	nowIso,
	openKeys,
	overlapMin,
	release,
	writeAtomic,
} from "./timer";

const base = new Date(2026, 10, 16, 9, 0, 0);
const at = (min: number) => new Date(base.getTime() + min * 60_000);
const t = (min: number) => nowIso(at(min));
const timerPath = join(import.meta.dir, "timer.ts").replaceAll("\\", "/");

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
	test("a start that carries a booking on an open key changes the booking only", () => {
		const evs: Ev[] = [
			{ ts: t(0), event: "start", key: "A" },
			{ ts: t(10), event: "start", key: "A", booked: 60 },
		];
		expect(elapsedMin(evs, "A", at(30))).toBe(30);
		expect(blocks(evs, at(30))).toEqual([{ key: "A", start: "09:00", end: "now", min: 30 }]);
		expect(openKeys(evs)).toEqual(["A"]);
		expect(bookedMin(evs, "A")).toBe(60);
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

// A line half-written by a killed process must not take the whole day down.
describe("reading a day file", () => {
	test("a corrupted line is skipped and the rest of the day survives", () => {
		const dir = mkdtempSync(join(tmpdir(), "st-load-"));
		try {
			const file = join(dir, "day.jsonl");
			append(file, { ts: t(0), event: "start", key: "A", booked: 60 });
			appendFileSync(file, '{"ts":"2026-11-16T09:0\n');
			append(file, { ts: t(10), event: "stop", key: "A" });
			const evs = load(file);
			expect(evs.map(e => e.key)).toEqual(["A", "A"]);
			expect(elapsedMin(evs, "A", at(60))).toBe(10);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("a truncated line does not swallow the event that follows it", () => {
		const dir = mkdtempSync(join(tmpdir(), "st-load-"));
		try {
			const file = join(dir, "day.jsonl");
			append(file, { ts: t(0), event: "start", key: "A", booked: 60 });
			// A process killed mid-write leaves half a line with no newline, so the next append merges with it.
			appendFileSync(file, '{"ts":"2026-11-16T09:0');
			append(file, { ts: t(10), event: "stop", key: "A" });
			const evs = load(file);
			expect(evs.map(e => e.event)).toEqual(["start", "stop"]);
			expect(elapsedMin(evs, "A", at(60))).toBe(10);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("a day name is a plain date, never a path", () => {
		expect(DAY_RE.test("2026-11-16")).toBe(true);
		expect(DAY_RE.test("../../../../home/user/.ssh/known_hosts")).toBe(false);
		expect(DAY_RE.test("2026-11-16.jsonl")).toBe(false);
	});
});

// Claims race between omp sessions, so these spawn real processes that claim at the same time.
describe("ticket claims across processes", () => {
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
		writeFileSync(lockPath(dir, "RACE-1"), "session-dead0001");
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
			expect(readFileSync(lockPath(dir, "RACE-1"), "utf8")).toMatch(/^s[0-7]$/);
			expect(existsSync(`${lockPath(dir, "RACE-1")}.force`)).toBe(false);
		}));
	test("takeover naming the wrong holder is refused", () =>
		withDir(async dir => {
			deadLock(dir);
			expect(() => claim(dir, "RACE-1", "me", "someone-else")).toThrow();
			expect(holds(dir, "RACE-1", "me")).toBe(false);
		}));
	test("a takeover id shorter than the last 8 characters is refused", () =>
		withDir(async dir => {
			deadLock(dir);
			// "1" would match a live session whose id ends in 1; only the full 8 count.
			expect(() => claim(dir, "RACE-1", "me", "1")).toThrow();
			expect(holds(dir, "RACE-1", "me")).toBe(false);
		}));
	test("a guard left by a killed process does not block the takeover forever", () =>
		withDir(async dir => {
			deadLock(dir);
			// An old guard: the process that wrote it is gone.
			writeFileSync(`${lockPath(dir, "RACE-1")}.force`, "session-dead0001 1");
			expect(() => claim(dir, "RACE-1", "me", "dead0001")).not.toThrow();
			expect(holds(dir, "RACE-1", "me")).toBe(true);
		}));
	test("two keys that sanitise alike do not share a lock", () =>
		withDir(async dir => {
			claim(dir, "A/B", "a");
			expect(holds(dir, "A_B", "a")).toBe(false);
			expect(() => claim(dir, "A_B", "b")).not.toThrow();
		}));
	test("release only by the holder", () =>
		withDir(async dir => {
			claim(dir, "K", "a");
			release(dir, "K", "b");
			expect(holds(dir, "K", "a")).toBe(true);
			release(dir, "K", "a");
			expect(holds(dir, "K", "a")).toBe(false);
		}));
	test("claiming a ticket you already hold does not throw", () =>
		withDir(async dir => {
			claim(dir, "K", "a");
			expect(() => claim(dir, "K", "a")).not.toThrow();
			expect(holds(dir, "K", "a")).toBe(true);
		}));
	test("a takeover with the right id takes the lock even from a live holder", () =>
		withDir(async dir => {
			claim(dir, "K", "session-live0009");
			// The user decides that session is gone: the plugin obeys.
			expect(() => claim(dir, "K", "thief", "live0009")).not.toThrow();
			expect(holds(dir, "K", "thief")).toBe(true);
		}));
	test("a guard older than five minutes is stale; a fresh one still blocks", () =>
		withDir(async dir => {
			deadLock(dir);
			writeFileSync(`${lockPath(dir, "RACE-1")}.force`, `session-dead0001 ${Date.now() - 6 * 60_000}`);
			expect(() => claim(dir, "RACE-1", "me", "dead0001")).not.toThrow();
		}));
	test("a guard one minute old blocks the takeover", () =>
		withDir(async dir => {
			deadLock(dir);
			writeFileSync(`${lockPath(dir, "RACE-1")}.force`, `session-dead0001 ${Date.now() - 60_000}`);
			expect(() => claim(dir, "RACE-1", "me", "dead0001")).toThrow();
		}));
});

// One test per rule the numbers rest on, so a change in the maths cannot pass unnoticed.
describe("the rules behind the numbers", () => {
	test("dayFile names the day with a zero-padded month and day", () => {
		expect(dayFile("/d", new Date(2026, 0, 5))).toEndWith("2026-01-05.jsonl");
		expect(dayFile("/d", new Date(2026, 11, 31))).toEndWith("2026-12-31.jsonl");
	});

	test("nowIso carries the local offset, and it moves with daylight saving", async () => {
		const script = `import { nowIso } from "${timerPath}"; console.log(nowIso(new Date(2026,0,15,12)) + " " + nowIso(new Date(2026,6,15,12)))`;
		const proc = Bun.spawn({
			cmd: [process.execPath, "-e", script],
			env: { ...process.env, TZ: "Europe/Madrid" },
			stdout: "pipe",
		});
		const out = await new Response(proc.stdout).text();
		expect(out.trim()).toBe("2026-01-15T12:00:00+01:00 2026-07-15T12:00:00+02:00");
	});

	test("the overlap of three tickets counts the union, not the pairs", () => {
		const three: Ev[] = [
			{ ts: t(0), event: "start", key: "A", booked: 60 },
			{ ts: t(0), event: "start", key: "B", booked: 60 },
			{ ts: t(0), event: "start", key: "C", booked: 60 },
			{ ts: t(30), event: "stop", key: "A" },
			{ ts: t(30), event: "stop", key: "B" },
			{ ts: t(30), event: "stop", key: "C" },
		];
		expect(overlapMin(three, at(60))).toBe(30);
	});

	test("an adjustment inside two open tickets does not change the overlap", () => {
		const evs: Ev[] = [
			{ ts: t(0), event: "start", key: "A", booked: 60 },
			{ ts: t(10), event: "start", key: "B", booked: 60 },
			{ ts: t(20), event: "adjust", key: "A", prior: 5 },
			{ ts: t(30), event: "stop", key: "A" },
			{ ts: t(40), event: "stop", key: "B" },
		];
		expect(overlapMin(evs, at(40))).toBe(20);
	});

	test("the alert of one key does not silence another", () => {
		const evs: Ev[] = [
			{ ts: t(0), event: "start", key: "A", booked: 100 },
			{ ts: t(5), event: "alert", key: "B", p: 100 },
		];
		expect(dueAlert(evs, "A", at(60))).toBe(50);
	});

	test("crossing two thresholds at once fires only the highest", () => {
		const evs: Ev[] = [{ ts: t(0), event: "start", key: "A", booked: 100 }];
		expect(dueAlert(evs, "A", at(95))).toBe(80);
	});

	test("after a gap only the highest threshold reached fires", () => {
		const evs: Ev[] = [
			{ ts: t(0), event: "start", key: "A", booked: 60 },
			{ ts: t(50), event: "stop", key: "A" },
		];
		expect(dueAlert(evs, "A", at(120))).toBe(80);
	});

	test("bookedMin returns the booking of the last start that carries one", () => {
		const evs: Ev[] = [
			{ ts: t(0), event: "start", key: "A", booked: 100 },
			{ ts: t(10), event: "stop", key: "A" },
			{ ts: t(20), event: "start", key: "A", booked: 240 },
		];
		expect(bookedMin(evs, "A")).toBe(240);
	});

	test("a block of 90 seconds is reported as 1 minute", () => {
		const evs: Ev[] = [
			{ ts: t(0), event: "start", key: "A" },
			{ ts: t(1.5), event: "stop", key: "A" },
		];
		expect(blocks(evs, at(2))[0].min).toBe(1);
	});

	test("a repeated start does not restart the open block", () => {
		const evs: Ev[] = [
			{ ts: t(0), event: "start", key: "A" },
			{ ts: t(5), event: "start", key: "A" },
		];
		expect(blocks(evs, at(10))[0].start).toBe("09:00");
	});

	test("a blank line does not break the day", () => {
		const dir = mkdtempSync(join(tmpdir(), "st-blank-"));
		try {
			const file = join(dir, "day.jsonl");
			append(file, { ts: t(0), event: "start", key: "A", booked: 60 });
			appendFileSync(file, "\n\n");
			append(file, { ts: t(10), event: "stop", key: "A" });
			expect(load(file).length).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a block left open in a past day ends with that day", () => {
		const yesterday = new Date(2026, 10, 15, 22, 0, 0);
		const evs: Ev[] = [{ ts: nowIso(yesterday), event: "start", key: "A", booked: 60 }];
		// Now is the next day: the block must not grow past the end of the day it started in.
		const today = new Date(2026, 10, 16, 12, 0, 0);
		expect(blocks(evs, today)[0]).toMatchObject({ end: "23:59", min: 119 });
	});
});

describe("writeAtomic", () => {
	const withDir = (fn: (dir: string) => void) => {
		const dir = mkdtempSync(join(tmpdir(), "st-atomic-"));
		try {
			fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	test("creates missing parent directories and writes the data", () =>
		withDir(dir => {
			const file = join(dir, "a", "b", "f.json");
			writeAtomic(file, "one");
			expect(readFileSync(file, "utf8")).toBe("one");
		}));
	test("replaces an existing file and leaves no temp file behind", () =>
		withDir(dir => {
			const file = join(dir, "f.json");
			writeAtomic(file, "one");
			writeAtomic(file, "two");
			expect(readFileSync(file, "utf8")).toBe("two");
			expect(readdirSync(dir)).toEqual(["f.json"]);
		}));
	test("throws when the target cannot be replaced (a directory)", () =>
		withDir(dir => {
			mkdirSync(join(dir, "f.json"));
			expect(() => writeAtomic(join(dir, "f.json"), "x")).toThrow();
		}));
});
