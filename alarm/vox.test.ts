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

// Content guards for the idle sound (loose bounds: survive small retuning, fail if the shape is lost).
const idle = synth("idle");
const idleSample = (i: number) => idle.readInt16LE(44 + i * 2);
// Zero crossings per second between a and b seconds: a proxy for pitch.
const idleZc = (a: number, b: number) => {
	let n = 0;
	for (let i = Math.floor(a * RATE) + 1; i < b * RATE; i++) if ((idleSample(i - 1) < 0) !== (idleSample(i) < 0)) n++;
	return n / (b - a);
};
const idleRms = (a: number, b: number) => {
	let t = 0, n = 0;
	for (let i = Math.floor(a * RATE); i < b * RATE; i++) {
		t += idleSample(i) ** 2;
		n++;
	}
	return Math.sqrt(t / n);
};

test("idle is a registered level", () => {
	expect(LEVELS).toContain("idle");
});

test("idle is not the done sound", () => {
	expect(idle.equals(synth("done"))).toBe(false);
});

test("idle glides downward in pitch", () => {
	expect(idleZc(0.1, 0.3)).toBeGreaterThan(900);
	expect(idleZc(0.9, 1.1)).toBeLessThan(700);
	expect(idleZc(0.1, 0.3)).toBeGreaterThan(idleZc(0.5, 0.7));
	expect(idleZc(0.5, 0.7)).toBeGreaterThan(idleZc(0.9, 1.1));
});

test("idle closing bell still rings after the glide", () => {
	expect(idleRms(1.3, 2.0)).toBeGreaterThan(700);
	expect(idleRms(1.3, 2.0)).toBeLessThan(1800);
});

test("idle glide sits at a moderate level", () => {
	expect(idleRms(0, 1)).toBeGreaterThan(3000);
	expect(idleRms(0, 1)).toBeLessThan(4800);
});
