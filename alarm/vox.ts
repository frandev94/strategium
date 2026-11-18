// Strategium vox-caster: plays a short clip of Darktide's "Disposal Unit" per level (alarm/clips/<level>.mp3; the cuts are in alarm/clips/README.md).
// Usage: bun vox.ts [50|80|100|done|attention|idle|theme] ["message"]  (level: argv[2], else env STRATEGIUM_P, else done)
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { childEnv } from "../extensions/strategium/env";

export const LEVELS = ["50", "80", "100", "done", "attention", "idle", "theme"] as const;
export type Level = (typeof LEVELS)[number];

export const clip = (level: Level) => join(import.meta.dir, "clips", `${level}.mp3`);

function play(file: string) {
	const run = (cmd: string, args: string[], env?: Record<string, string>) =>
		spawnSync(cmd, args, { stdio: "ignore", env: { ...childEnv(), ...env } });
	if (process.platform === "win32") {
		// Built-in WPF MediaPlayer (Media.SoundPlayer reads WAV only); the path travels in an env var, never in the script.
		const ps = [
			"Add-Type -AssemblyName PresentationCore",
			"$p = New-Object System.Windows.Media.MediaPlayer",
			"$p.Open([Uri]$env:VOX_FILE)",
			"for ($i = 0; -not $p.NaturalDuration.HasTimeSpan -and $i -lt 50; $i++) { Start-Sleep -Milliseconds 100 }",
			"$p.Play()",
			"Start-Sleep -Milliseconds ($p.NaturalDuration.TimeSpan.TotalMilliseconds + 200)",
			"$p.Close()",
		].join("; ");
		return run("powershell", ["-NoProfile", "-Command", ps], { VOX_FILE: file });
	}
	if (process.platform === "darwin") return run("afplay", [file]);
	// paplay reads MP3 from libsndfile 1.1 on; an older one exits non-zero and the next player is tried.
	const players: [string, string[]][] = [["paplay", [file]], ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", file]], ["mpg123", ["-q", file]]];
	for (const [cmd, args] of players) if (run(cmd, args).status === 0) return;
	console.error("vox: no audio player could play the clip (paplay, ffplay, mpg123)");
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
		play(clip(level));
	} catch (e) {
		console.error(`vox: ${(e as Error).message}`);
	}
}
