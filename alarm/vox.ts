// Strategium vox-caster: synthesizes every sound from scratch (no samples) and plays it.
// Usage: bun vox.ts [50|80|100|done|attention|idle|theme] ["message"]  (level: argv[2], else env STRATEGIUM_P, else done)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../extensions/strategium/env";

export const RATE = 22050;
export const LEVELS = ["50", "80", "100", "done", "attention", "idle", "theme"] as const;
export type Level = (typeof LEVELS)[number];

// Every sound plays one grimdark kit at 100 bpm in C minor: war drums, a distorted bass, a choir, brass and a bell.
// Original material only: the chords are the stock minor-key moves (i, VI, iv, V; VI-VII-I), no melody from any record.
type Buf = Float64Array;
const TAU = Math.PI * 2;
const BEAT = 60 / 100;
const BAR = BEAT * 4;
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const saw = (ph: number) => (ph % 1) * 2 - 1;
/** Linear attack, linear release at the end of `dur`. */
const env = (t: number, a: number, r: number, dur: number) => Math.min(1, t / a) * Math.min(1, Math.max(0, (dur - t) / r));

/** Deterministic noise in [-1, 1). */
function noiseOf(seed: number) {
	let s = seed;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

function add(b: Buf, t0: number, dur: number, gain: number, fn: (t: number) => number) {
	const i0 = Math.floor(t0 * RATE);
	const n = Math.min(Math.floor(dur * RATE), b.length - i0);
	for (let i = 0; i < n; i++) b[i0 + i] += gain * fn(i / RATE);
}

// Kick: a sine that drops from 140 Hz to 42 Hz, with a click.
function kick(b: Buf, t0: number, gain = 0.9) {
	const noise = noiseOf(Math.floor(t0 * 1000) + 1);
	let ph = 0;
	add(b, t0, 0.45, gain, t => {
		ph += (42 + 98 * Math.exp(-t / 0.035)) / RATE;
		return Math.sin(TAU * ph) * Math.exp(-t / 0.16) + 0.35 * noise() * Math.exp(-t / 0.004);
	});
}

// Boom: a long sub drop under a low-passed blast, the hit that opens a war.
function boom(b: Buf, t0: number, gain = 1) {
	const noise = noiseOf(Math.floor(t0 * 1000) + 2);
	let ph = 0;
	let lp = 0;
	add(b, t0, 3.6, gain, t => {
		ph += (36 + 70 * Math.exp(-t / 0.08)) / RATE;
		lp += 0.06 * (noise() - lp);
		return Math.sin(TAU * ph) * Math.exp(-t / 0.9) + 2.5 * lp * Math.exp(-t / 0.3);
	});
}

// Snare and anvil together: a noise crack, a 190 Hz body and inharmonic metal.
function snare(b: Buf, t0: number, gain = 0.45) {
	const noise = noiseOf(Math.floor(t0 * 1000) + 3);
	const metal = [523, 811, 1187, 1543];
	add(b, t0, 0.4, gain, t => {
		let m = 0;
		for (const [k, f] of metal.entries()) m += (Math.sign(Math.sin(TAU * f * t)) * 0.12) / (k + 1);
		return noise() * Math.exp(-t / 0.07) + 0.5 * Math.sin(TAU * 190 * t) * Math.exp(-t / 0.05) + m * Math.exp(-t / 0.1);
	});
}

// Hats: sixteenth noise ticks, high-passed, louder on the off-beats.
function hats(b: Buf, t0: number, bars: number) {
	const noise = noiseOf(4);
	for (let i = 0; i < bars * 16; i++) {
		let lp = 0;
		add(b, t0 + (i * BEAT) / 4, 0.06, i % 2 ? 0.16 : 0.08, () => {
			const n = noise();
			lp += 0.5 * (n - lp);
			return n - lp;
		});
	}
}

/** War drums: four on the floor, snare on 2 and 4, sixteenth hats. */
function drums(b: Buf, t0: number, bars: number) {
	hats(b, t0, bars);
	for (let bar = 0; bar < bars; bar++) {
		const t = t0 + bar * BAR;
		for (let beat = 0; beat < 4; beat++) kick(b, t + beat * BEAT, beat % 2 ? 0.7 : 0.95);
		snare(b, t + BEAT);
		snare(b, t + BEAT * 3);
	}
}

// The wall: distorted bass eighths, a C pedal that climbs to G and Eb at the end of the bar.
const BASS = [36, 36, 36, 36, 36, 36, 43, 39];
function bass(b: Buf, t0: number, bars: number) {
	const step = BEAT / 2;
	for (let i = 0; i < bars * 8; i++) {
		const f = hz(BASS[i % 8]);
		let p1 = 0;
		let p2 = 0;
		let lp = 0;
		add(b, t0 + i * step, step * 0.92, 0.3, t => {
			p1 += f / RATE;
			p2 += (f * 1.006) / RATE;
			lp += 0.18 * (saw(p1) + saw(p2) + Math.sin(TAU * p1 * 0.5) - lp);
			return Math.tanh(4 * lp) * Math.min(1, t / 0.004) * Math.exp(-t / 0.5);
		});
	}
}

// Choir: three slightly detuned voices singing "ah" (harmonics weighted around the vowel's formants).
function choir(b: Buf, t0: number, midi: number, dur: number, gain = 0.2, attack = 0.08) {
	const f0 = hz(midi);
	const formants = [[700, 110], [1220, 120], [2600, 160]];
	const amps: number[] = [];
	for (let h = 1; h * f0 < 5000; h++) {
		let a = 0.15 / h;
		for (const [k, [c, w]] of formants.entries()) a += Math.exp(-(((h * f0 - c) / w) ** 2) / 2) / (k + 1);
		amps.push(a);
	}
	for (const detune of [-0.005, 0, 0.006]) {
		let ph = 0;
		add(b, t0, dur, gain / 3, t => {
			ph += (f0 * (1 + detune) * (1 + 0.005 * Math.sin(TAU * 5.4 * t + detune * 300))) / RATE;
			let s = 0;
			for (let h = 0; h < amps.length; h++) s += amps[h] * Math.sin(TAU * (h + 1) * ph);
			return s * env(t, attack, 0.15, dur);
		});
	}
}

/** The choir on every note of a chord. */
function chord(b: Buf, t0: number, notes: number[], dur: number, gain = 0.2, attack = 0.08) {
	for (const m of notes) choir(b, t0, m, dur, gain, attack);
}

// Brass: a low saw horn that opens up as it swells.
function brass(b: Buf, t0: number, midi: number, dur: number, gain = 0.22) {
	let ph = 0;
	let lp = 0;
	add(b, t0, dur, gain, t => {
		ph += hz(midi) / RATE;
		lp += (0.04 + 0.12 * Math.min(1, t / 0.4)) * (saw(ph) - lp);
		return lp * env(t, 0.05, Math.min(1.4, dur / 2), dur);
	});
}

// Cathedral bell: inharmonic partials, long ring.
function bell(b: Buf, t0: number, f: number, vol: number, dur = 2) {
	for (const [r, a] of [[0.5, 1], [1, 0.9], [1.19, 0.6], [1.56, 0.5], [2, 0.45], [2.51, 0.3], [3.2, 0.2]])
		add(b, t0, dur, vol * a * 0.35, t => Math.min(1, t / 0.004) * Math.exp(-t / (dur / (3 + r * 2))) * Math.sin(TAU * f * r * t));
}

// The breath: a noise sweep and a whistle gliding up an octave, both swelling to the end.
function riser(b: Buf, t0: number, dur: number, gain = 0.22) {
	const noise = noiseOf(5);
	let ph = 0;
	let lp = 0;
	add(b, t0, dur, gain, t => {
		const x = t / dur;
		ph += (700 * 2 ** x) / RATE;
		lp += (0.02 + 0.5 * x * x) * (noise() - lp);
		return (0.5 * Math.sin(TAU * ph) + 0.2 * Math.sin(TAU * 2 * ph) + 0.8 * lp) * x * x;
	});
}

// Drone: C1 and C2, low-passed.
function drone(b: Buf, t0: number, dur: number, gain = 0.4) {
	let p = 0;
	let lp = 0;
	add(b, t0, dur, gain, t => {
		p += hz(36) / RATE;
		lp += 0.03 * (saw(p) + 0.8 * Math.sin(TAU * hz(24) * t) - lp);
		return lp * env(t, 0.6, 0.6, dur);
	});
}

const CM = [60, 63, 67]; // C minor
const AB = [56, 60, 63]; // Ab major (VI)
const BB = [58, 62, 65]; // Bb major (VII)
const C = [60, 64, 67, 72]; // C major: the minor run ends bright

/** The final hit: boom, snare, brass on C and G, the choir on C minor. */
function hit(b: Buf, t0: number, dur: number) {
	boom(b, t0);
	snare(b, t0, 0.6);
	for (const m of [24, 36, 43]) brass(b, t0, m, dur);
	chord(b, t0, CM, dur, 0.22, 0.02);
}

// Theme: four bars of drop (i, VI, iv, V), written once and wrapped so the tails of bar 4 ring into bar 1: it loops without a seam.
function theme(b: Buf) {
	const long = new Float64Array(b.length * 2);
	drums(long, 0, 4);
	bass(long, 0, 4);
	[CM, AB, [53, 56, 60], [55, 59, 62]].forEach((notes, bar) => chord(long, bar * BAR, notes, BAR, 0.16));
	[79, 80, 77, 74].forEach((m, bar) => choir(long, bar * BAR, m, BAR, 0.12)); // the top voice holds a chord tone per bar
	for (const t of [0, BAR * 2]) for (const m of [36, 43]) brass(long, t, m, BAR, 0.14);
	for (let i = 0; i < long.length; i++) b[i % b.length] += long[i];
}

const DESIGN: Record<Level, (b: Buf) => void> = {
	// calm: one boom and a low bell ringing out
	"50": b => { boom(b, 0); bell(b, 0.05, hz(48), 0.6, 2.9); },
	// urgent: one bar of the full groove, then a hard hit
	"80": b => { drums(b, 0, 1); bass(b, 0, 1); snare(b, BAR - BEAT / 4, 0.4); hit(b, BAR, 1.2); },
	// time is up: a breath that climbs and lands on the final hit
	"100": b => { riser(b, 0, 1.2, 0.3); hit(b, 1.2, 2.2); },
	// done: the choir climbs VI, VII to a bright I over the drums, then a dead stop at 2.25 s
	"done": b => {
		[AB, BB, C].forEach((notes, i) => { chord(b, i * BEAT, notes, i === 2 ? 1.2 : BEAT, 0.24, 0.03); kick(b, i * BEAT); });
		snare(b, BEAT * 2, 0.5);
		b.fill(0, Math.floor(2.25 * RATE));
	},
	// attention: a snare roll that speeds up under a riser, into a short hit
	"attention": b => {
		riser(b, 0, 3, 0.26);
		for (let t = 0; t < 3; t += (BEAT / 2) * (1 - 0.8 * (t / 3))) snare(b, t, 0.12 + 0.3 * (t / 3));
		hit(b, 3, 0.9);
	},
	// idle: stand-by, quieter on purpose: a low drone, soft choir swells and one soft bell; the run's clock paused
	"idle": b => { drone(b, 0, 3); chord(b, 0.3, [55, 60], 2.4, 0.1, 0.9); bell(b, 0, hz(48), 0.35, 2.5); },
	// theme: the Strategium theme, four bars (9.6 s) that loop; when a run ends, or by hand
	"theme": theme,
};

/** Pure synthesis: 16-bit mono PCM WAV, soft-clipped by tanh and normalised to its peak (0.9 of full scale; idle 0.5, quieter on purpose). */
export function synth(level: Level): Buffer {
	const secs = { "50": 3, "80": 3.6, "100": 3.4, "done": 2.7, "attention": 3.9, "idle": 3, "theme": BAR * 4 }[level];
	const b = new Float64Array(Math.round(secs * RATE));
	DESIGN[level](b);
	// A one-shot fades out over its last 0.25 s, so a hit still ringing never ends in a click; the theme loops instead.
	if (level !== "theme") for (let i = 0, n = Math.floor(0.25 * RATE); i < n; i++) b[b.length - 1 - i] *= i / n;
	let peak = 0;
	for (let i = 0; i < b.length; i++) peak = Math.max(peak, Math.abs((b[i] = Math.tanh(b[i] * 1.3))));
	const scale = ((level === "idle" ? 0.5 : 0.9) * 32767) / peak;
	const pcm = Buffer.alloc(b.length * 2);
	b.forEach((x, i) => pcm.writeInt16LE(Math.round(x * scale), i * 2));
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
		// The name follows the synthesizer's source, so an edited sound never plays from a stale cache. ponytail: old WAVs stay in tmp; prune them if the folder ever grows.
		const file = join(dir, `${level}-${createHash("sha256").update(readFileSync(import.meta.path)).digest("hex").slice(0, 12)}.wav`);
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
