import { expect, test } from "bun:test";
import { LEVELS, RATE, synth } from "./vox";

test.each([...LEVELS])("%s is a valid, unclipped 1.5-4 s WAV", level => {
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
	expect(secs).toBeLessThanOrEqual(4);
	let peak = 0;
	for (let i = 44; i < w.length; i += 2) peak = Math.max(peak, Math.abs(w.readInt16LE(i)));
	expect(peak).toBeGreaterThan(3000);
	expect(peak).toBeLessThan(32767);
});
