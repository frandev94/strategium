import { expect, test } from "bun:test";
import { LEVELS, RATE, type Level, synth } from "./vox";

const samples = (level: Level) => {
	const w = synth(level);
	return Array.from({ length: (w.length - 44) / 2 }, (_, i) => w.readInt16LE(44 + i * 2));
};
const peakOf = (s: number[]) => s.reduce((p, x) => Math.max(p, Math.abs(x)), 0);

test.each([...LEVELS])("%s is a valid, unclipped WAV of the expected length", level => {
	const w = synth(level);
	expect(w.toString("ascii", 0, 4)).toBe("RIFF");
	expect(w.toString("ascii", 8, 12)).toBe("WAVE");
	expect(w.toString("ascii", 36, 40)).toBe("data");
	const data = w.readUInt32LE(40);
	expect(w.length).toBe(44 + data);
	expect(w.readUInt32LE(4)).toBe(36 + data);
	expect(w.readUInt32LE(24)).toBe(RATE);
	const secs = data / 2 / RATE;
	expect(secs).toBeGreaterThanOrEqual(1.5);
	expect(secs).toBeLessThanOrEqual(level === "theme" ? 10 : 4);
	const peak = peakOf(samples(level));
	expect(peak).toBeGreaterThan(3000);
	expect(peak).toBeLessThan(32767);
});

test.each([...LEVELS])("%s is deterministic", level => {
	expect(synth(level).equals(synth(level))).toBe(true);
});

test("theme is exactly four bars at 100 bpm, so it loops on the beat", () => {
	expect(samples("theme").length).toBe(Math.round(9.6 * RATE));
});

test("idle is the quietest sound", () => {
	const idle = peakOf(samples("idle"));
	for (const level of LEVELS) if (level !== "idle") expect(idle).toBeLessThan(peakOf(samples(level)) * 0.7);
});

test("done stops dead: silence after 2.25 s", () => {
	expect(samples("done").slice(Math.ceil(2.25 * RATE)).every(x => x === 0)).toBe(true);
});
