// Strategium vox-caster: synthesizes every sound from scratch (no samples) and plays it.
// Usage: bun vox.ts [50|80|100|done]  (level: argv[2], else env STRATEGIUM_P, else done)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../extensions/strategium/env";

export const RATE = 22050;
export const LEVELS = ["50", "80", "100", "done", "attention"] as const;
export type Level = (typeof LEVELS)[number];

type Buf = Float64Array;
const TAU = Math.PI * 2;

function rng(seed: number) {
	let s = seed;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Add f(phase) with attack/decay envelope; `decay` is seconds to fall to ~1/e.
function voice(b: Buf, t0: number, dur: number, vol: number, decay: number, f: (t: number) => number) {
	const i0 = Math.floor(t0 * RATE);
	const n = Math.min(Math.floor(dur * RATE), b.length - i0);
	for (let i = 0; i < n; i++) {
		const t = i / RATE;
		b[i0 + i] += vol * Math.min(1, t / 0.004) * Math.exp(-t / decay) * f(t);
	}
}

// Cathedral bell: inharmonic partials, long ring.
function bell(b: Buf, t0: number, hz: number, vol: number, dur = 2) {
	const parts = [[0.5, 1], [1, 0.9], [1.19, 0.6], [1.56, 0.5], [2, 0.45], [2.51, 0.3], [3.2, 0.2]];
	for (const [r, a] of parts) voice(b, t0, dur, vol * a * 0.35, dur / (3 + r * 2), t => Math.sin(TAU * hz * r * t));
}

// Binharic cant: fast square-ish machine chirps at pseudo-random pitches.
function cant(b: Buf, t0: number, count: number, step: number, vol: number, seed: number) {
	const r = rng(seed);
	for (let k = 0; k < count; k++) {
		const hz = 700 + Math.floor(r() * 8) * 180;
		voice(b, t0 + k * step, step * 0.7, vol, step, t => Math.sign(Math.sin(TAU * hz * t)) * 0.5 + Math.sin(TAU * hz * 2 * t) * 0.2);
	}
}

// Vox static: noise burst.
function static_(b: Buf, t0: number, dur: number, vol: number, seed: number) {
	const r = rng(seed);
	voice(b, t0, dur, vol, dur, () => r() * 2 - 1);
}

// Klaxon wail: sawtooth sweeping lo->hi, repeated.
function klaxon(b: Buf, t0: number, wails: number, len: number, lo: number, hi: number, vol: number) {
	for (let k = 0; k < wails; k++) {
		let ph = 0;
		voice(b, t0 + k * len, len * 0.95, vol, 99, t => {
			ph += (lo + (hi - lo) * Math.min(1, t / (len * 0.8))) / RATE;
			return (ph % 1) * 2 - 1;
		});
	}
}

// Kettle drum: a low thud whose pitch sags, with a felt-mallet noise attack.
function timpani(b: Buf, t0: number, hz: number, vol: number, seed: number) {
	const r = rng(seed);
	let ph = 0;
	voice(b, t0, 0.9, vol, 0.35, t => {
		ph += (hz * (1 + 0.15 * Math.exp(-t / 0.05))) / RATE;
		return Math.sin(TAU * ph) + 0.25 * (r() * 2 - 1) * Math.exp(-t / 0.02);
	});
}

// War-call horn: a blown horn note that swells in and holds, doubled at the octave and fifth (horn section),
// with light vibrato. War horns are blown, not struck, so the attack is slow and the end fades.
function blow(b: Buf, t0: number, hz: number, dur: number, vol: number, mult = [0.5, 1, 1.5, 2]) {
	for (const m of mult) {
		let ph = 0;
		voice(b, t0, dur, vol / mult.length, 99, t => {
			ph += (hz * m * (1 + 0.004 * Math.sin(TAU * 5 * t))) / RATE;
			const env = Math.min(1, t / 0.18) * Math.min(1, (dur - t) / 0.25);
			return env * (0.65 * ((ph % 1) * 2 - 1) + 0.35 * Math.sin(TAU * ph));
		});
	}
}

// Dark call to war in C minor: C, up to the minor third Eb, then down to a long low G; war drums under it.
function warCall(b: Buf) {
	blow(b, 0, 130.81, 0.9, 1.2);
	blow(b, 0.95, 155.56, 0.7, 1.2);
	blow(b, 1.7, 98, 2.2, 1.4);
	[0, 0.95, 1.7, 2.4, 3.1].forEach((t, k) => timpani(b, t, 55, 0.7, 200 + k));
}

const DESIGN: Record<Level, (b: Buf) => void> = {
	// calm: one low bell toll answered by three servo-skull chirps
	"50": b => { bell(b, 0, 220, 0.8, 2); cant(b, 0.9, 3, 0.09, 0.25, 7); },
	// urgent: two bell tolls with static crackle and a fast cant run
	"80": b => { bell(b, 0, 247, 0.7, 1.4); bell(b, 0.9, 262, 0.7, 1.6); static_(b, 0.85, 0.12, 0.12, 3); cant(b, 1.8, 8, 0.06, 0.3, 11); },
	// extraction: klaxon wails over a hammered bell
	"100": b => { klaxon(b, 0, 4, 0.85, 380, 760, 0.4); bell(b, 0, 185, 0.6, 3.4); static_(b, 0, 0.1, 0.15, 5); },
	// done: ascending bell fanfare, then a final deep toll
	"done": b => { [330, 392, 494, 659].forEach((hz, i) => bell(b, i * 0.28, hz, 0.55, 1.2)); bell(b, 1.2, 165, 0.8, 2); cant(b, 1.3, 2, 0.08, 0.2, 2); },
	// attention: a dark call to war, horn section in C minor (C - Eb - low G) over war drums
	"attention": warCall,
};

/** Pure synthesis: 16-bit mono PCM WAV (soft-limited by tanh, peak <= 0.85 * int16 max). */
export function synth(level: Level): Buffer {
	const secs = { "50": 2, "80": 3, "100": 3.4, "done": 3, "attention": 3.9 }[level];
	const b = new Float64Array(Math.floor(secs * RATE));
	DESIGN[level](b);
	const pcm = Buffer.alloc(b.length * 2);
	b.forEach((x, i) => pcm.writeInt16LE(Math.round(Math.tanh(x) * 0.85 * 32767), i * 2));
	const h = Buffer.alloc(44);
	h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
	h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
	h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
	h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([h, pcm]);
}

function play(file: string) {
	const run = (cmd: string, args: string[], env?: Record<string, string>) =>
		spawnSync(cmd, args, { stdio: "ignore", env: { ...childEnv(), ...env } });
	if (process.platform === "win32")
		// The path travels in an env var: a quote in it would break the script.
		return run("powershell", ["-NoProfile", "-Command", "(New-Object Media.SoundPlayer $env:VOX_FILE).PlaySync()"], {
			VOX_FILE: file,
		});
	if (process.platform === "darwin") return run("afplay", [file]);
	const players: [string, string[]][] = [["paplay", [file]], ["aplay", ["-q", file]], ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", file]]];
	for (const [cmd, args] of players) if (!run(cmd, args).error) return;
	console.error("vox: no audio player found (paplay, aplay, ffplay)");
}

/** Desktop notification so the user sees it with the terminal hidden; best effort, never throws. */
function toast(msg: string) {
	const run = (cmd: string, args: string[], env?: Record<string, string>) =>
		spawnSync(cmd, args, { stdio: "ignore", env: { ...childEnv(), ...env } });
	if (process.platform === "win32") {
		// Built-in WinRT toast through Windows PowerShell; the text travels in an env var, never in the script.
		const ps = [
			"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
			"$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
			"$x = $t.GetElementsByTagName('text')",
			"$x.Item(0).AppendChild($t.CreateTextNode('Strategium')) > $null",
			"$x.Item(1).AppendChild($t.CreateTextNode($env:VOX_MSG)) > $null",
			"$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
			"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))",
		].join("; ");
		run("powershell", ["-NoProfile", "-Command", ps], { VOX_MSG: msg });
	} else if (process.platform === "darwin") {
		run("osascript", ["-e", 'display notification (system attribute "VOX_MSG") with title "Strategium"'], { VOX_MSG: msg });
	} else run("notify-send", ["Strategium", msg]);
}

if (import.meta.main) {
	const arg = process.argv[2] ?? process.env.STRATEGIUM_P ?? "done";
	const level = (LEVELS as readonly string[]).includes(arg) ? (arg as Level) : "done";
	const msg = process.argv[3] ?? process.env.STRATEGIUM_MSG;
	try {
		if (msg) toast(msg);
		const dir = join(tmpdir(), "strategium-vox");
		const file = join(dir, `${level}.wav`);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (!existsSync(file)) {
			try {
				// `wx`: never write through a symlink another user planted in the cache dir.
				writeFileSync(file, synth(level), { flag: "wx", mode: 0o600 });
			} catch {
				// Another process wrote it first: use what is there.
			}
		}
		play(file);
	} catch (e) {
		console.error(`vox: ${(e as Error).message}`);
	}
}
