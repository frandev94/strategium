// Strategium vox-caster: synthesizes every sound from scratch (no samples) and plays it.
// Usage: bun vox.ts [50|80|100|done|attention|idle|theme] ["message"]  (level: argv[2], else env STRATEGIUM_P, else done); env STRATEGIUM_SOUND=0 skips the sound; env STRATEGIUM_VOLUME 0-100 (default 20)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../extensions/strategium/env";

export const RATE = 22050;
export const LEVELS = ["50", "80", "100", "done", "attention", "idle", "theme"] as const;
export type Level = (typeof LEVELS)[number];

// Every sound plays one grimdark kit at 100 bpm in C minor: war drums with a double kick, a drop-C guitar and bass, a choir, brass and a bell.
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

/** The backbeat: sixteenth hats and the snare on 2 and 4; the kicks follow the guitar (see `riff`). */
function backbeat(b: Buf, t0: number, bars: number) {
	hats(b, t0, bars);
	for (let bar = 0; bar < bars; bar++) for (const beat of [1, 3]) snare(b, t0 + bar * BAR + beat * BEAT);
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

// Guitar: detuned saws summed per chord, driven hard through tanh, then a two-pole "cab" low-pass. Muted = palm mute: darker and choked.
function guitar(b: Buf, t0: number, notes: number[], dur: number, muted: boolean, gain = 0.2) {
	const fs = notes.flatMap(m => [hz(m), hz(m) * 1.004]);
	const ph = fs.map(() => 0);
	let pre = 0;
	let c1 = 0;
	let c2 = 0;
	const cut = muted ? 0.09 : 0.22;
	add(b, t0, dur, gain, t => {
		let s = 0;
		for (let k = 0; k < fs.length; k++) s += saw((ph[k] += fs[k] / RATE));
		pre += 0.5 * (s - pre);
		c1 += cut * (Math.tanh(5 * pre) - c1);
		c2 += cut * (c1 - c2);
		return c2 * (muted ? Math.min(1, t / 0.002) * Math.exp(-t / 0.09) : env(t, 0.003, 0.05, dur));
	});
}

// Bass: an octave under the guitar, two detuned saws and a sub sine, lightly driven and low-passed so it growls without fizz.
function bass(b: Buf, t0: number, midi: number, dur: number, muted: boolean, gain = 0.28) {
	const f = hz(midi);
	let p1 = 0;
	let p2 = 0;
	let lp = 0;
	add(b, t0, dur, gain, t => {
		p1 += f / RATE;
		p2 += (f * 1.006) / RATE;
		lp += 0.12 * (saw(p1) + saw(p2) - lp);
		const s = Math.tanh(3 * lp) + 0.8 * Math.sin(TAU * p1);
		return s * (muted ? Math.min(1, t / 0.003) * Math.exp(-t / 0.12) : env(t, 0.004, 0.06, dur));
	});
}

/** A ringing power chord (root, fifth and octave) with the bass on the root below. */
function power(b: Buf, t0: number, root: number, dur: number, gain = 0.2) {
	guitar(b, t0, [root, root + 7, root + 12], dur, false, gain);
	bass(b, t0, root - 12, dur, false);
}

// The riff, one bar per chord in sixteenths: x = palm-muted low C, P = power chord on the bar's root (rings through the rests), n = next lead note.
// Bars 1-3 chug a C pedal under i, VI, iv; bar 4 turns around on V with a harmonic-minor run (G Ab G B C B Ab G) back to the top.
const RIFF: [string, number][] = [["P-xxP-xxx-P-xPxx", 36], ["P-xxP-xxx-P-xPxx", 44], ["P-xxP-xxx-P-xPxx", 41], ["P-xxP-xxnnnnnnnn", 43]];
const RUN = [43, 44, 43, 47, 48, 47, 44, 43];
/** The riff with the bass and the double kick locked to every guitar hit. */
function riff(b: Buf, t0: number, bars = RIFF) {
	const step = BEAT / 4;
	let lead = 0;
	bars.forEach(([pattern, root], bar) => {
		for (let i = 0; i < 16; i++) {
			const c = pattern[i];
			if (c === "-") continue;
			const t = t0 + bar * BAR + i * step;
			kick(b, t, i % 4 ? 0.55 : 0.9);
			if (c === "x") { guitar(b, t, [36], step * 0.9, true); bass(b, t, 24, step * 0.9, true); }
			else if (c === "n") { guitar(b, t, [RUN[lead++]], step * 0.95, false, 0.16); bass(b, t, root - 12, step * 0.9, true); }
			else {
				let n = 1;
				while (pattern[i + n] === "-") n++;
				power(b, t, root, step * n * 0.95);
			}
		}
	});
}

const CM = [60, 63, 67]; // C minor
const AB = [56, 60, 63]; // Ab major (VI)
const BB = [58, 62, 65]; // Bb major (VII)
const C = [60, 64, 67, 72]; // C major: the minor run ends bright

/** The final hit: boom, snare, a ringing C power chord, brass on C and G, and (unless `choir` is false) the choir on C minor. */
function hit(b: Buf, t0: number, dur: number, choir = true) {
	boom(b, t0);
	snare(b, t0, 0.6);
	power(b, t0, 36, dur, 0.24);
	for (const m of [24, 36, 43]) brass(b, t0, m, dur);
	if (choir) chord(b, t0, CM, dur, 0.22, 0.02);
}

// Theme: four bars of drop (i, VI, iv, V) led by the riff, written once and wrapped so the tails of bar 4 ring into bar 1: it loops without a seam.
function theme(b: Buf) {
	const long = new Float64Array(b.length * 2);
	backbeat(long, 0, 4);
	riff(long, 0);
	[CM, AB, [53, 56, 60], [55, 59, 62]].forEach((notes, bar) => chord(long, bar * BAR, notes, BAR, 0.1));
	[79, 80, 77, 74].forEach((m, bar) => choir(long, bar * BAR, m, BAR, 0.08)); // the top voice holds a chord tone per bar
	for (const t of [0, BAR * 2]) for (const m of [36, 43]) brass(long, t, m, BAR, 0.1);
	for (let i = 0; i < long.length; i++) b[i % b.length] += long[i];
}

/** One bar of the groove on C: the backbeat, a riff bar (with its double kick) and a pickup snare into the next bar. */
function groove(b: Buf, t0: number, pattern: string) {
	backbeat(b, t0, 1);
	riff(b, t0, [[pattern, 36]]);
	snare(b, t0 + BAR - BEAT / 4, 0.4);
}

/** The swell: a soft boom under brass and the choir rising on C minor. */
function swell(b: Buf, t0: number, dur: number) {
	boom(b, t0, 0.6);
	for (const m of [24, 36]) brass(b, t0, m, dur, 0.2);
	chord(b, t0, CM, dur, 0.2, 0.3);
}

const DESIGN: Record<Level, (b: Buf) => void> = {
	// Each level adds a layer to the one before: 50 the groove into a hit, 80 the swell over it, 100 the riser too.
	// The riff tightens with each: 50 the theme's gallop, 80 denser chugs, 100 straight sixteenths.
	// 50 %: one bar of the groove, then a hard hit with no choir
	"50": b => { groove(b, 0, "P-xxP-xxx-P-xPxx"); hit(b, BAR, 1.2, false); },
	// 80 %: the groove under the swell, then the full hit
	"80": b => { groove(b, 0, "P-xxP-xxPxxxPxxx"); swell(b, 0, BAR); hit(b, BAR, 1.2); },
	// time is up: the groove, the swell and a riser climbing together, then the full hit ringing longer
	"100": b => { groove(b, 0, "Pxxxxxxxxxxxxxxx"); swell(b, 0, BAR); riser(b, 0, BAR, 0.3); hit(b, BAR, 1.4); },
	// done: choir and power chords climb VI, VII to a bright I over the drums, then a dead stop at 2.25 s
	"done": b => {
		[AB, BB, C].forEach((notes, i) => {
			const dur = i === 2 ? 1.2 : BEAT;
			chord(b, i * BEAT, notes, dur, 0.24, 0.03);
			power(b, i * BEAT, [44, 46, 48][i], dur, 0.22);
			kick(b, i * BEAT);
		});
		snare(b, BEAT * 2, 0.5);
		b.fill(0, Math.floor(2.25 * RATE));
	},
	// attention: a horn call (two stabs on C, a held G) doubled by the guitar, then a snare and double-kick roll into the hit
	"attention": b => {
		for (const t of [0, BEAT]) {
			kick(b, t);
			power(b, t, 36, 0.4, 0.24);
			for (const m of [36, 48]) brass(b, t, m, 0.4, 0.3);
			chord(b, t, CM, 0.4, 0.22, 0.02);
		}
		kick(b, BEAT * 2);
		power(b, BEAT * 2, 43, 1.2, 0.24);
		for (const m of [43, 55]) brass(b, BEAT * 2, m, 1.2, 0.3);
		chord(b, BEAT * 2, [55, 59, 62], 1.2, 0.22, 0.02);
		for (let t = BEAT * 3; t < BAR; t += BEAT / 8) {
			const x = (t - BEAT * 3) / BEAT;
			snare(b, t, 0.15 + 0.35 * x);
			kick(b, t, 0.3 + 0.4 * x);
		}
		hit(b, BAR, 0.9);
	},
	// idle: stand-by, quieter on purpose: a low drone, soft choir swells and one soft bell; the run's clock paused
	"idle": b => { drone(b, 0, 3); chord(b, 0.3, [55, 60], 2.4, 0.1, 0.9); bell(b, 0, hz(48), 0.35, 2.5); },
	// theme: the Strategium theme, four bars (9.6 s) that loop; when a run ends, or by hand
	"theme": theme,
};

/** Pure synthesis: 16-bit mono PCM WAV, soft-clipped by tanh and normalised to its peak: 0.9 of full scale (idle 0.5, quieter on purpose) times `vol` %. */
export function synth(level: Level, vol = 20): Buffer {
	const secs = { "50": 3.6, "80": 3.6, "100": 3.9, "done": 2.7, "attention": 3.6, "idle": 3, "theme": BAR * 4 }[level];
	const b = new Float64Array(Math.round(secs * RATE));
	DESIGN[level](b);
	// A one-shot fades out over its last 0.25 s, so a hit still ringing never ends in a click; the theme loops instead.
	if (level !== "theme") for (let i = 0, n = Math.floor(0.25 * RATE); i < n; i++) b[b.length - 1 - i] *= i / n;
	let peak = 0;
	for (let i = 0; i < b.length; i++) peak = Math.max(peak, Math.abs((b[i] = Math.tanh(b[i] * 1.3))));
	const scale = ((level === "idle" ? 0.5 : 0.9) * (vol / 100) * 32767) / peak;
	const pcm = Buffer.alloc(b.length * 2);
	b.forEach((x, i) => pcm.writeInt16LE(Math.round(x * scale), i * 2));
	const h = Buffer.alloc(44);
	h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
	h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
	h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
	h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([h, pcm]);
}

const ok = (r: { error?: Error; status: number | null }) => !r.error && r.status === 0;

/** True when a player ran and succeeded. */
function play(file: string): boolean {
	const run = (cmd: string, args: string[], env?: Record<string, string>) =>
		spawnSync(cmd, args, { stdio: "ignore", env: { ...childEnv(), ...env } });
	if (process.platform === "win32")
		// The path travels in an env var: a quote in it would break the script.
		return ok(run("powershell", ["-NoProfile", "-Command", "(New-Object Media.SoundPlayer $env:VOX_FILE).PlaySync()"], { VOX_FILE: file }));
	if (process.platform === "darwin") return ok(run("afplay", [file]));
	const players: [string, string[]][] = [["paplay", [file]], ["aplay", ["-q", file]], ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", file]]];
	for (const [cmd, args] of players) if (ok(run(cmd, args))) return true;
	console.error("vox: no audio player worked (paplay, aplay, ffplay)");
	return false;
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
	} else run("notify-send", ["Strategium", escapeMarkup(msg)]);
}

/** notify-send renders libnotify markup: escape & first, then < and >. */
export function escapeMarkup(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Which channels an alarm run uses: a toast needs a message; the sound plays unless STRATEGIUM_SOUND is 0, false, off or no. */
export function channels(env: Record<string, string | undefined>, msg: string | undefined): { toast: boolean; sound: boolean } {
	return { toast: !!msg, sound: !/^(0|false|off|no)$/i.test(env.STRATEGIUM_SOUND?.trim() ?? "") };
}

/** STRATEGIUM_VOLUME as a whole percentage, clamped to 0-100; unset or not a number gives the default, 20 (an alarm should not startle). */
export function volume(env: Record<string, string | undefined>): number {
	const raw = env.STRATEGIUM_VOLUME?.trim();
	const v = Number(raw);
	return raw && Number.isFinite(v) ? Math.round(Math.min(100, Math.max(0, v))) : 20;
}

if (import.meta.main) {
	const arg = process.argv[2] ?? process.env.STRATEGIUM_P ?? "done";
	const level = (LEVELS as readonly string[]).includes(arg) ? (arg as Level) : "done";
	const msg = process.argv[3] ?? process.env.STRATEGIUM_MSG;
	const ch = channels(process.env, msg);
	try {
		if (ch.toast) toast(msg!);
		if (ch.sound) {
			const dir = join(tmpdir(), "strategium-vox");
			const vol = volume(process.env);
			// The name follows the synthesizer's source and the volume, so an edited sound never plays from a stale cache. ponytail: old WAVs stay in tmp; prune them if the folder ever grows.
			const file = join(dir, `${level}-${vol}-${createHash("sha256").update(readFileSync(import.meta.path)).digest("hex").slice(0, 12)}.wav`);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			if (!existsSync(file)) {
				try {
					// `wx`: never write through a symlink another user planted in the cache dir.
					writeFileSync(file, synth(level, vol), { flag: "wx", mode: 0o600 });
				} catch {
					// Another process wrote it first: use what is there.
				}
			}
			if (!play(file)) process.exitCode = 1;
		}
	} catch (e) {
		console.error(`vox: ${(e as Error).message}`);
		process.exitCode = 1;
	}
}
