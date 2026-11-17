---
name: strategium-tui-shot
description: Use when developing or debugging the Strategium cockpit, footer or any TUI change and you need to see it in real omp (screenshot), check compatibility with another plugin such as ponytail, or reproduce what a user sees. Dev-only, Windows only; not shipped with the plugin.
---

# Screenshot the real omp TUI

`tools/tui-shot/shot.py` runs the real `omp --no-extensions -e <this repo>` in a Windows ConPTY (140x45), with an isolated `STRATEGIUM_STATE_DIR` and a run seeded on disk, then renders the captured VT stream with xterm.js 5.5 and turns it into a PNG with headless Edge (throwaway profile). No model call is spent: omp resumes a hand-written session whose id matches the run's claim (`01a1eb00-…-d3a0`, key `demo-shot`), so the extension sees an owned run on its first tick.

## Run (from the repo root)

```
python tools/tui-shot/shot.py --seed=skirmish           # screen.png (the footer the seeded run draws, before Alt+C) + overlay.png (after Alt+C)
python tools/tui-shot/shot.py --seed=scriptorium --ponytail   # also load ponytail -> screen-ponytail.png, overlay-ponytail.png
```

Output goes to `%TEMP%\strategium-tui-shot\` (`<name>.png`, `.html`, `.raw`), never into the repo. It takes about 15-40 s. Options: `--suffix=-x` names the outputs, `--plugin=DIR` another checkout or worktree (default: this repo), `--ponytail=DIR`, `--omp=EXE`, `--edge=EXE`, `--out=DIR`, `--no-png` (keep only `.html`/`.raw`). Edge, omp and ponytail are discovered; the script exits with the flag to pass if one is missing. Different `--suffix` values can run in parallel.

Read the PNG with `read` (it decodes images inline) and describe what you see: footer text, overlay layout, truncation, colors, glyph vs emoji. Check the `.png` exists before claiming anything.

## Seeds (the `SEEDS` dict in shot.py)

| seed | where | shows |
|---|---|---|
| `scriptorium` (default) | station Scriptorium, seal `Plan` in progress | planning station, a seal waiting for the Chapter Master, later phases all pending |
| `skirmish` | station Skirmish, task `Build squad alpha` | two live agents (AlphaBrother, GammaVeteran), one stopped slice (beta), a mix of completed/in_progress/pending tasks |

Add a seed: add an entry to `SEEDS` with `phases` (list of `{name, tasks:[{content:"[role] Title", status}]}`), `where` (`station`, plus `seal` or `task`) and `extra` (run-file fields such as `agents`, `stopped`); the `choices` of `--seed` follow the dict. The run file shape is whatever `extensions/strategium/index.ts` reads from `STRATEGIUM_STATE_DIR/runs/<sid>.json`; if it changes, update the seeds. Seeds are data only, no layout logic.

## Cleanup

The script removes its work dir (state, session, edge profile) itself and kills the omp and Edge process trees. Delete old outputs with `rm -r "$TEMP/strategium-tui-shot"`. If a run was killed, look for stray `omp.exe`/`msedge.exe` started from `strategium-tui-shot` and stop them.

## Limits

- Windows 10 1809+ only (ConPTY via ctypes); Python 3 stdlib only.
- The picture is xterm.js, not Windows Terminal: font (`CaskaydiaCove Nerd Font Mono` if installed, else a fallback, so glyphs may show as boxes), colors, ligatures and line height differ. It is right for layout, text and truncation, not for exact pixels.
- Emoji width: the Unicode 11 addon makes emoji 2 cells wide, as Windows Terminal does; other terminals differ.
- Needs network: xterm.js loads from the jsdelivr CDN. Edge's `--virtual-time-budget` gives it 20 s.
- Alt+C is sent as a win32-input-mode record; the overlay is the screen plus the Alt+C delta replayed in one stream, so only the final state is captured, not animation. Alternate-screen overlays are shown as the terminal ends up after the full stream.
- The footer shows the cwd `strategium-tui-shot\work<suffix>\cwd` (fixed name, so shots compare). Fixed size 140x45; the seeded run is `untimed` with `theatre: none`: it does not exercise booking, ticketing or real agents.
- It runs the real omp with `--no-extensions`, so only this repo (and `--ponytail`) is loaded; your user plugins and config do not interfere, but a changed extension API in omp still breaks it.
- The session-id/claim trick depends on `timer.ts` `lockPath()` (`<key>-<sha1(key)[:8]>.lock` holding the session id). The seeded run's first tick draws the footer; if the footer does not show the run, check that first.
