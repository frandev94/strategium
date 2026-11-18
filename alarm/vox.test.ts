import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { clip, LEVELS } from "./vox";

// The clips stay short (fair use): mono 32 kbps CBR MP3, so the length follows from the size.
test.each([...LEVELS])("%s is a short MP3 clip", level => {
	const mp3 = readFileSync(clip(level));
	expect(mp3[0]).toBe(0xff);
	expect(mp3[1] & 0xe0).toBe(0xe0);
	const secs = (mp3.length * 8) / 32000;
	expect(secs).toBeGreaterThan(1.5);
	expect(secs).toBeLessThanOrEqual(10);
});
