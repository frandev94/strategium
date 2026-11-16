import { expect, test } from "bun:test";
import { LEVELS, RATE, synth } from "./vox";

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
	if (level === "theme") expect(data).toBe(15 * RATE * 2);
	else {
		expect(secs).toBeGreaterThanOrEqual(1.5);
		expect(secs).toBeLessThanOrEqual(4);
	}
	let peak = 0;
	for (let i = 44; i < w.length; i += 2) peak = Math.max(peak, Math.abs(w.readInt16LE(i)));
	expect(peak).toBeGreaterThan(3000);
	expect(peak).toBeLessThan(32767);
});

test("theme is deterministic", () => {
	expect(synth("theme").equals(synth("theme"))).toBe(true);
});

// Content guards for the theme (drift-tolerant: no byte hash, float drift differs per platform).
const theme = synth("theme");
const sample = (i: number) => theme.readInt16LE(44 + i * 2);

test("theme is a registered level", () => {
	expect(LEVELS).toContain("theme");
});

test("theme peak is the 0.9 normalisation", () => {
	let peak = 0;
	for (let i = 0; i < (theme.length - 44) / 2; i++) peak = Math.max(peak, Math.abs(sample(i)));
	expect(Math.abs(peak - 29490)).toBeLessThanOrEqual(1);
});

test("theme gates are silent (6.91-7.19 s, 9.61-9.89 s)", () => {
	for (const [a, b] of [[6.91, 7.19], [9.61, 9.89]]) {
		const nonZero: number[] = [];
		for (let i = Math.ceil(a * RATE); i < b * RATE; i++) if (sample(i) !== 0) nonZero.push(i);
		expect({ span: `${a}-${b}`, nonZero }).toEqual({ span: `${a}-${b}`, nonZero: [] });
	}
});

test("theme RMS stays within 1% of the approved mix", () => {
	let s = 0;
	const n = (theme.length - 44) / 2;
	for (let i = 0; i < n; i++) s += sample(i) ** 2;
	expect(Math.abs(Math.sqrt(s / n) / 10694.6 - 1)).toBeLessThan(0.01);
});
