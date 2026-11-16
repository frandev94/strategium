// Strategium vox-caster: synthesizes every sound from scratch (no samples) and plays it.
// Usage: bun vox.ts [50|80|100|done|attention|theme]  (level: argv[2], else env STRATEGIUM_P, else done; theme is 15 s, by hand only)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../extensions/strategium/env";

export const RATE = 22050;
export const LEVELS = ["50", "80", "100", "done", "attention", "theme"] as const;
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

// Theme: the drop of Darktide's "Disposal Unit" (~100 bpm, Eb double harmonic), rebuilt with no samples. Own master: the dead
// stops, a soft clip tanh(1.3x), then normalised so the peak is 0.9 (synth() writes it as is). Own `add` and noise: not voice/rng.
function theme(b: Buf) {
	const BPM = 100;
	const BEAT = 60 / BPM;
	const BAR = BEAT * 4;
	const DROP = BAR; // the drop lands after one bar of breath
	const END = DROP + BAR * 4; // the last hit
	const gates: [number, number][] = []; // dead stops: everything is silenced in these spans
	const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
	let seed = 40000;
	const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
	const saw = (ph: number) => (ph % 1) * 2 - 1;
	/** Linear attack, linear release at the end of `dur`. */
	const env = (t: number, a: number, r: number, dur: number) => Math.min(1, t / a) * Math.min(1, Math.max(0, (dur - t) / r));
	function add(t0: number, dur: number, gain: number, fn: (t: number) => number) {
		const i0 = Math.floor(t0 * RATE);
		const n = Math.min(Math.floor(dur * RATE), b.length - i0);
		for (let i = 0; i < n; i++) b[i0 + i] += gain * fn(i / RATE);
	}

	// Kick: a sine that drops from 140 Hz to 42 Hz, with a click.
	function kick(t0: number, gain = 0.9) {
		let ph = 0;
		add(t0, 0.45, gain, t => {
			ph += (42 + 98 * Math.exp(-t / 0.035)) / RATE;
			return Math.sin(TAU * ph) * Math.exp(-t / 0.16) + 0.35 * noise() * Math.exp(-t / 0.004);
		});
	}

	// Snare and anvil together: a noise crack, a 190 Hz body and inharmonic metal.
	function snare(t0: number, gain = 0.45) {
		const metal = [523, 811, 1187, 1543];
		add(t0, 0.4, gain, t => {
			let m = 0;
			for (const [k, f] of metal.entries()) m += (Math.sign(Math.sin(TAU * f * t)) * 0.12) / (k + 1);
			return noise() * Math.exp(-t / 0.07) + 0.5 * Math.sin(TAU * 190 * t) * Math.exp(-t / 0.05) + m * Math.exp(-t / 0.1);
		});
	}

	// Hats: sixteenth noise ticks, high-passed, louder on the off-beats.
	function hats(t0: number, bars: number) {
		const step = BEAT / 4;
		for (let i = 0; i < bars * 16; i++) {
			let lp = 0;
			add(t0 + i * step, 0.06, i % 2 ? 0.16 : 0.08, () => {
				const n = noise();
				lp += 0.5 * (n - lp);
				return n - lp;
			});
		}
	}

	// The wall: distorted bass eighths on Eb, with E (the flat second) on the seventh eighth.
	const BASS = [39, 39, 39, 39, 39, 39, 40, 39];
	function bassWall(t0: number, bars: number) {
		const step = BEAT / 2;
		for (let i = 0; i < bars * 8; i++) {
			const f = hz(BASS[i % 8]);
			let p1 = 0;
			let p2 = 0;
			let lp = 0;
			add(t0 + i * step, step * 0.92, 0.34, t => {
				p1 += f / RATE;
				p2 += (f * 1.006) / RATE;
				lp += 0.18 * (saw(p1) + saw(p2) + Math.sin(TAU * p1 * 0.5) - lp);
				return Math.tanh(4 * lp) * Math.min(1, t / 0.004) * Math.exp(-t / 0.5);
			});
		}
	}

	// Drone under the breath: Eb1 and Eb2, low-passed.
	function drone(t0: number, dur: number) {
		let p = 0;
		let lp = 0;
		add(t0, dur, 0.4, t => {
			p += hz(39) / RATE;
			lp += 0.03 * (saw(p) + 0.8 * Math.sin(TAU * hz(27) * t) - lp);
			return lp * env(t, 0.6, 0.3, dur);
		});
	}

	// The breath: a noise sweep and a whistle gliding up from ~900 Hz to ~1850 Hz, with its octave.
	function riser(t0: number, dur: number) {
		let ph = 0;
		let lp = 0;
		let hp = 0;
		add(t0, dur, 0.22, t => {
			const x = t / dur;
			ph += (900 * 2 ** x) / RATE;
			const n = noise();
			lp += (0.02 + 0.5 * x * x) * (n - lp);
			hp = lp - hp * 0.2;
			return (0.6 * Math.sin(TAU * ph) + 0.25 * Math.sin(TAU * 2 * ph) + 0.7 * hp) * x * x;
		});
	}

	// Choir: three slightly detuned voices singing "ah" (harmonics weighted around the vowel's formants).
	function choir(t0: number, midi: number, dur: number, gain = 0.3) {
		const f0 = hz(midi);
		const formants = [
			[700, 110],
			[1220, 120],
			[2600, 160],
		];
		const amps: number[] = [];
		for (let h = 1; h * f0 < 5000; h++) {
			const f = h * f0;
			let a = 0.15 / h;
			for (const [k, [c, w]] of formants.entries()) a += Math.exp(-(((f - c) / w) ** 2) / 2) / (k + 1);
			amps.push(a);
		}
		for (const detune of [-0.005, 0, 0.006]) {
			let ph = 0;
			add(t0, dur, gain / 3, t => {
				ph += (f0 * (1 + detune) * (1 + 0.005 * Math.sin(TAU * 5.4 * t + detune * 300))) / RATE;
				let s = 0;
				for (let h = 0; h < amps.length; h++) s += amps[h] * Math.sin(TAU * (h + 1) * ph);
				return s * env(t, 0.08, 0.15, dur);
			});
		}
	}

	// Brass: a low saw horn for the last hit.
	function brass(t0: number, midi: number, dur: number, gain = 0.25) {
		let ph = 0;
		let lp = 0;
		add(t0, dur, gain, t => {
			ph += hz(midi) / RATE;
			lp += (0.04 + 0.12 * Math.min(1, t / 0.4)) * (saw(ph) - lp);
			return lp * env(t, 0.05, 1.4, dur);
		});
	}

	// 0 · The breath (one bar): drone, heartbeat kicks, then the bass drops out and the riser climbs.
	drone(0, DROP);
	kick(0, 0.8);
	kick(BEAT * 2, 0.8);
	riser(BEAT * 1.5, BEAT * 2.5);

	// 1 · The drop (four bars): the wall, four on the floor, snare on 2 and 4, hats.
	bassWall(DROP, 4);
	hats(DROP, 4);
	for (let bar = 0; bar < 4; bar++) {
		const t = DROP + bar * BAR;
		for (let beat = 0; beat < 4; beat++) kick(t + beat * BEAT, beat % 2 ? 0.7 : 0.95);
		snare(t + BEAT);
		snare(t + BEAT * 3);
	}
	// Bars 1-2 of the drop: the high cluster (Eb4, B4, Bb5), the middle voice wobbling Bb–B on every beat.
	choir(DROP, 63, BAR * 2, 0.22);
	choir(DROP, 82, BAR * 2, 0.2);
	for (let i = 0; i < 8; i++) choir(DROP + i * BEAT, i % 2 ? 71 : 70, BEAT, 0.26);
	// A dead stop on the last eighth of bar 2.
	gates.push([DROP + BAR * 2 - BEAT / 2, DROP + BAR * 2]);
	// Bar 3: one level up, the chromatic fall B · Bb · Ab · G under a held C6.
	[71, 70, 68, 67].forEach((m, i) => choir(DROP + BAR * 2 + i * BEAT, m, BEAT, 0.3));
	choir(DROP + BAR * 2, 84, BAR, 0.16);
	// Bar 4: silence on the first half beat, then the high Eb octaves and the line Eb · D · C# · E.
	gates.push([DROP + BAR * 3, DROP + BAR * 3 + BEAT / 2]);
	choir(DROP + BAR * 3 + BEAT / 2, 75, BAR - BEAT / 2, 0.2);
	[87, 86, 85, 88].forEach((m, i) => choir(DROP + BAR * 3 + BEAT / 2 + i * BEAT * 0.875, m, BEAT * 0.9, 0.24));

	// The last hit: kick, snare, brass on Eb and Bb, and the choir on a long Eb chord with the E rubbing against it.
	kick(END, 1);
	snare(END, 0.5);
	for (const m of [27, 39, 46]) brass(END, m, 3, 0.22);
	for (const m of [51, 58, 63, 64]) choir(END, m, 3, m === 64 ? 0.1 : 0.24);

	// Master: the dead stops, a soft clip, then normalise to 0.9 of full scale.
	for (const [a, z] of gates) for (let i = Math.floor(a * RATE); i < Math.floor(z * RATE); i++) b[i] = 0;
	let peak = 0;
	for (let i = 0; i < b.length; i++) peak = Math.max(peak, Math.abs((b[i] = Math.tanh(b[i] * 1.3))));
	for (let i = 0; i < b.length; i++) b[i] = (b[i] / peak) * 0.9;
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
	// theme: the 15 s Strategium theme (a drop, a dead stop, a chromatic fall, one last hit); by hand only
	"theme": theme,
};

/** Pure synthesis: 16-bit mono PCM WAV (soft-limited by tanh, peak <= 0.85 * int16 max; theme: own master, peak 0.9). */
export function synth(level: Level): Buffer {
	const secs = { "50": 2, "80": 3, "100": 3.4, "done": 3, "attention": 3.9, "theme": 15 }[level];
	const b = new Float64Array(Math.floor(secs * RATE));
	DESIGN[level](b);
	const pcm = Buffer.alloc(b.length * 2);
	b.forEach((x, i) => pcm.writeInt16LE(Math.round(level === "theme" ? x * 32767 : Math.tanh(x) * 0.85 * 32767), i * 2));
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
