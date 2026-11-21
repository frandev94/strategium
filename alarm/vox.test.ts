import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { LEVELS, RATE, type Level, channels, escapeMarkup, synth, volume } from "./vox";

const samples = (level: Level, vol?: number) => {
	const w = synth(level, vol);
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

test("volume scales the peak: 100 is twice 50", () => {
	expect(Math.abs(peakOf(samples("50", 100)) - 2 * peakOf(samples("50", 50)))).toBeLessThanOrEqual(2);
});

test.each([
	[undefined, 20], ["", 20], ["loud", 20], ["30", 30], [" 80 ", 80], ["150", 100], ["-5", 0], ["33.6", 34],
])("volume(STRATEGIUM_VOLUME=%p) is %p", (v, want) => {
	expect(volume({ STRATEGIUM_VOLUME: v })).toBe(want);
});

test("escapeMarkup escapes &, < and > for libnotify, & first", () => {
	expect(escapeMarkup("a & b <i>x</i> &lt;")).toBe("a &amp; b &lt;i&gt;x&lt;/i&gt; &amp;lt;");
});

test("channels: no toast without a message", () => {
	expect(channels({}, undefined).toast).toBe(false);
	expect(channels({}, "").toast).toBe(false);
	expect(channels({}, "hi").toast).toBe(true);
});

test.each(["0", "false", "OFF", "no"])("channels: no sound when STRATEGIUM_SOUND is %s", v => {
	expect(channels({ STRATEGIUM_SOUND: v }, "hi").sound).toBe(false);
});

test("channels: sound when STRATEGIUM_SOUND is unset or 1", () => {
	expect(channels({}, "hi").sound).toBe(true);
	expect(channels({ STRATEGIUM_SOUND: "1" }, undefined).sound).toBe(true);
});

test("channels: STRATEGIUM_SOUND is trimmed", () => {
	expect(channels({ STRATEGIUM_SOUND: " off " }, "hi").sound).toBe(false);
});

test("running vox with STRATEGIUM_SOUND=0 and no message synthesizes and plays nothing", () => {
	const tmp = mkdtempSync(join(realpathSync(tmpdir()), "vox-test-"));
	try {
		// No message (no toast) and no sound: the run must not even create its WAV cache. An empty PATH keeps a regression from reaching a real player.
		const env = { SystemRoot: process.env.SystemRoot, STRATEGIUM_SOUND: "0", TMPDIR: tmp, TEMP: tmp, TMP: tmp, PATH: tmp };
		const r = spawnSync(process.execPath, [join(import.meta.dir, "vox.ts"), "done"], { env: env as Record<string, string>, stdio: "ignore" });
		expect(r.status).toBe(0);
		expect(existsSync(join(tmp, "strategium-vox"))).toBe(false);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("running vox with sound on and no audio player exits non-zero", () => {
	const tmp = mkdtempSync(join(realpathSync(tmpdir()), "vox-test-"));
	try {
		// An empty PATH leaves no player to run; volume 0 keeps a regression silent.
		const env = { SystemRoot: process.env.SystemRoot, STRATEGIUM_SOUND: "1", STRATEGIUM_VOLUME: "0", TMPDIR: tmp, TEMP: tmp, TMP: tmp, PATH: tmp };
		const r = spawnSync(process.execPath, [join(import.meta.dir, "vox.ts"), "done"], { env: env as Record<string, string>, stdio: "ignore" });
		expect(r.status).not.toBe(0);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
