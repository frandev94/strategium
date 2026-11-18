---
name: strategium-tui-shot
description: Use when developing or debugging the Strategium cockpit, footer or any TUI change and you need to see it in real omp (screenshot), check compatibility with another plugin such as ponytail, reproduce what a user sees, or replay the regressions already fixed (fullscreen cockpit, ask dialog behind the cockpit, Esc/q close...). Dev-only, Windows only; not shipped with the plugin.
---

# Screenshot the real omp TUI

`tools/tui-shot/shot.py` runs the real `omp --no-extensions -e <this repo>` in a Windows ConPTY (140x45), with an isolated `STRATEGIUM_STATE_DIR` and a run seeded on disk, then renders the captured VT stream with xterm.js 5.5 and turns it into a PNG with headless Edge (throwaway profile). No model call is spent: omp resumes a hand-written session whose id matches the run's claim (`01a1eb00-…-d3a0`, key `demo-shot`), so the extension sees an owned run on its first tick.

## Run (from the repo root)

```
python tools/tui-shot/shot.py --seed=skirmish           # screen.png (the footer the seeded run draws, before Alt+C) + overlay.png (after Alt+C)
python tools/tui-shot/shot.py --seed=scriptorium --ponytail   # also load ponytail -> screen-ponytail.png, overlay-ponytail.png
python tools/tui-shot/shot.py --replay=NAME | --all     # regression replays, see below
```

Output goes to `%TEMP%\strategium-tui-shot\` (`<name>.png`, `.html`, `.raw`), never into the repo. It takes about 15-40 s. Options: `--suffix=-x` names the outputs, `--plugin=DIR` another checkout, worktree or export (default: this repo), `--ponytail=DIR`, `--omp=EXE`, `--edge=EXE`, `--out=DIR`, `--no-png` (keep only `.html`/`.raw`), `--keep-work` (replays: keep the work dir). Edge, omp and ponytail are discovered; the script exits with the flag to pass if one is missing. Different `--suffix` values can run in parallel.

Read the PNG with `read` (it decodes images inline) and describe what you see: footer text, overlay layout, truncation, colors, glyph vs emoji. Check the `.png` exists before claiming anything.

## Seeds (the `SEEDS` dict in shot.py)

| seed | where | shows |
|---|---|---|
| `scriptorium` (default) | station Scriptorium, seal `Plan` in progress | planning station, a seal waiting for the Chapter Master, later phases all pending |
| `skirmish` | station Skirmish, task `Build squad alpha` | two live agents (AlphaBrother, GammaVeteran), one stopped slice (beta), a mix of completed/in_progress/pending tasks |
| `timed` | scriptorium, a booked run (not `untimed`) | today's day file in the state dir has a `start` event with `booked: 240`, 10 minutes ago, as `startKey` writes it; used by `first-tick-clock` |

Add a seed: add an entry to `SEEDS` with `phases` (list of `{name, tasks:[{content:"[role] Title", status}]}`), `where` (`station`, plus `seal` or `task`), `extra` (run-file fields such as `agents`, `stopped`) and optionally `timed: <booked min>`; the `choices` of `--seed` follow the dict. The run file shape is whatever `extensions/strategium/index.ts` reads from `STRATEGIUM_STATE_DIR/runs/<sid>.json`; if it changes, update the seeds. Seeds are data only, no layout logic.

## Replays: regressions as scenarios

```
python tools/tui-shot/shot.py --replay=ask-behind-cockpit --plugin=%TEMP%\strategium-tui-shot\plugin-head   # one scenario: exit 0 PASS, 1 FAIL, 2 unknown name (lists the names)
python tools/tui-shot/shot.py --all --plugin=%TEMP%\strategium-tui-shot\plugin-head                          # every scenario, then a table with the plugin's sha; exit 1 if a FIXED or KNOWN one does not PASS
```

Each scenario starts its own omp in the ConPTY (work dir `work<suffix>-<name>`), sends keys (win32-input-mode records, the `KEYS` table), resizes the console (`ResizePseudoConsole`, logged by byte offset), waits, and takes named snapshots. A snapshot is the screen xterm.js holds after the stream up to that byte (the page replays the resizes at their offsets, so the size is right), read as text: one string per cell, wide cells and their continuation cells, the active buffer (`normal`/`alternate`). The checks read that text, never the PNG. It prints one line per check (`ok`/`FAIL`, with got/expected and the screen on failure), then `PASS NAME (R..)` or `FAIL NAME (R..)`. Outputs in `%TEMP%\strategium-tui-shot\`: `<scenario>-<checkpoint>.raw` (the stream up to there), `.html`, and `.png` for the checkpoints marked png (`--no-png` skips only the PNGs; Edge is always needed for the text). `--keep-work` keeps the work dir (state, `replay.log`). A scenario takes about 10-20 s, `run-end-closes` up to 70 s (it waits for the 60 s tick).

Run against an **export** of a commit, never against a worktree that is changing. Put the short sha next to it as `<dir>.sha`; the table header prints it:

```
git -C <repo> archive <rev> extensions skills package.json | tar -x -C %TEMP%\strategium-tui-shot\plugin-head
git -C <repo> rev-parse --short <rev> > %TEMP%\strategium-tui-shot\plugin-head.sha
```

`skills/` is needed: `index.ts` imports `skills/strategium/todo`.

Kinds: `FIXED` (PASS = the fix holds), `KNOWN` (PASS = an omp limit shows up exactly as documented), `OPEN` (no fix yet: shown, never changes the exit code). The "before" proof of a fix is the same scenario against an export from before it (`plugin-a184d43` for R9/R10: `fullscreen-height` and `ask-behind-cockpit` must FAIL there).

| scenario | R | kind | PASS means |
|---|---|---|---|
| `fullscreen-height` | R9 | FIXED | open: alternate buffer, row 0 `╔═…STRATEGIUM`, last row `╚═ esc/q close`, rows between framed at both edges (`║` or the `╟`/`╢` rules), no footer or editor under it; before opening, no frame |
| `fullscreen-resize` | R9/F6 | FIXED | after resizing to 140x30 the frame is 30 rows; at 100x45 col 99 is framed; at 60x45 it is the stacked layout with `esc/q close` on the last row and nothing past col 59 |
| `frame-edges` | R4, R5 | FIXED | at 140, 100 and 72 cols every framed row ends at col W-1, the CHRONICLE rule ends `─╢` with no notch, and the boxes of the grid share one right edge |
| `glyph-width` | R2 | FIXED | no `⚔ ☠ ⏳`; no wide cell in the footer run line or in the cockpit |
| `seal-row` | R3 | FIXED | the SEALS row has U+F047A/U+F051F glyphs 1 cell wide, each followed by a space, and no `✠` |
| `archmagos` | R13 | FIXED | the `[archmagos]` task (`Merge the plan`) is in the cockpit |
| `agent-status` | F11 | FIXED | idle session: the header has `AWAITING YOUR ORDERS`, not `AGENT AT WORK`/`PLAN REVIEW PENDING`, and the row still ends with `║` |
| `first-tick-clock` | R6 | FIXED | `timed` seed, cockpit opened right after the first heartbeat: the clock row has `/240 min`, not `⧗ …` |
| `resume-booking` | R7 | FIXED | after `/strategium-pause` and `/strategium-resume 240` on an untimed run, footer and cockpit clock show `/240 min` and the cockpit has a bar |
| `no-widget` | R8 | FIXED | nothing of the cockpit above the editor; the footer run line is there |
| `ask-behind-cockpit` | R10 | FIXED | the cockpit is open, the fake model calls the real `ask`, F9 closes the cockpit, the dialog appears in the normal buffer and takes the keys, the answer reaches the agent (`replay.log` has `tool_call ask` and a non-error `tool_result`) |
| `run-end-closes` | R12 | FIXED | deleting the run file closes the cockpit on the next tick (≤ 65 s); normal buffer; no `demo-shot` run line |
| `footer-hint` | R14 | FIXED | the last char of `ALT + C to enter cockpit` is at col W-1 at 140 and at 100 cols; on failure it prints the gap and the last 3 rows |
| `esc-close` | R19 | FIXED | every Esc encoding closes the cockpit (`win32` record, `\x1b`, CSI-u variants with modifiers, event types and lock bits); prints `variant closed sent saw`, `saw` being what `onTerminalInput` received. Variants other than `win32` go through conhost's own input parser, so `saw` may differ from `sent`: marked `not faithful` |
| `q-close` | R19 | FIXED | `q` (win32 record and plain) closes the cockpit; footer and editor rows equal the ones before opening (clock rows skipped) |
| `capslock-altc` | R1 | KNOWN | Caps Lock + Alt+C opens no cockpit; omp shows `Nothing to copy` (its `app.clipboard.copyPrompt` matches first) |
| `select-behind-cockpit` | R10 (rest) | KNOWN | a dialog opened with no `tool_call` (`/replay-select`) while the cockpit is open stays stuck: no value after `q` either; F9 cannot reach it |
| `ponytail-notice` | R16 | OPEN | `Strategium loaded:` is in the stream when ponytail is loaded too |

Not replayable on screen: R11 (the code path is gone; `no-widget` covers its replacement), R15 (xterm.js DOM renderer artifact in the PNG; the text checks read the border cell itself), R17 (no expected value until the same screen is captured in Windows Terminal; `footer-hint` prints the last rows for that), R18 (subagent isolation, nothing on screen). Also not replayed: F9 on `tool_approval_requested`/`plan_review_requested` (needs approval or plan-mode settings; the index tests cover it) and F11 `AGENT AT WORK`/`PLAN REVIEW PENDING` (only the idle state).

### Add a scenario

1. A `steps_<name>(R)` function drives the run: `R.open()` (Alt+C, then quiet), `R.key("esc"|"q"|"down"|"enter"|…)` (add a record to `KEYS`), `R.type_text(s)`, `R.send(raw)`, `R.resize(c, r)`, `R.wait_quiet(quiet, timeout)`, `R.wait_for(b"word", timeout)` (a word without spaces: ConPTY may paint a gap as a cursor move), `R.alt_open()` (last `?1049h`/`?1049l` in the stream), `R.sleep(s)`, `R.snap("checkpoint", png=True)`. The run is settled first (heartbeat and 2 s of quiet); `"settle": False` waits for the heartbeat only.
2. A `checks_<name>(C)` function: `C.s["checkpoint"]` is a `Snap` (`row(y)`, `at(y, x)`, `has(text)`, `where(text)`, `col_of(y, text)`, `last_col(y)`, `wide_cells()`, `framed()`, `type`, `cols`, `rows`); record with `C.ck(name, ok, got, want, snap)` (the snap is printed on failure); `C.log_has("tool_call", name="ask")` reads `replay.log`; `C.say(line)` prints a note.
3. An entry in `REPLAYS`: `r`, `kind`, `seed`, optionally `ext: True` (fake provider), `ponytail: True`, `settle: False`. Never weaken a check to make a scenario pass: a FAIL on a fixed scenario is a finding.

### The fake provider (`tools/tui-shot/replay-ext.ts`)

Dev-only, loaded as an extra `-e` by the scenarios with `ext: True`; not in `package.json`, `tsconfig.json` or the plugin manifest. It does nothing unless `STRATEGIUM_REPLAY_DIR` is set (the harness sets it to the work dir). It registers the provider `replay` with model `ask`; `ext: True` also writes `replay.yml` pinning every `modelRoles` entry to `replay/ask` and starts omp with `--model replay/ask --config replay.yml`, so no real model is ever called (no network, no tokens). When the user message ends in `replay-ask`, the fake stream starts, waits for the file `<work>/go`, then calls the real `ask` tool (or `write xd://ask`) with a form `REPLAY: pick one` (`Yes`/`No`); after the tool result it answers `REPLAY-ANSWER <result>`. Any other turn (title...) gets the text `replay`. `/replay-select` opens `ctx.ui.select` after 3 s. `replay.log` (JSONL, `ev`: `input` = the bytes `onTerminalInput` saw, `tool_call`, `tool_result`, `stream`, `select`) is what the checks read. `ask` is not mounted in `-p` mode, so this only works in the interactive ConPTY.

## Cleanup

The script removes its work dir (state, session, edge profile) itself (unless `--keep-work`) and kills the omp and Edge process trees. Delete old outputs with `rm -r "$TEMP/strategium-tui-shot"`. If a run was killed, look for stray `omp.exe`/`msedge.exe` started from `strategium-tui-shot` and stop them.

## Limits

- Windows 10 1809+ only (ConPTY via ctypes); Python 3 stdlib only.
- The picture is xterm.js, not Windows Terminal: font (`CaskaydiaCove Nerd Font Mono` if installed, else a fallback, so glyphs may show as boxes), colors, ligatures and line height differ. It is right for layout, text and truncation, not for exact pixels.
- Emoji width: the Unicode 11 addon makes emoji 2 cells wide, as Windows Terminal does; other terminals differ.
- Needs network: xterm.js loads from the jsdelivr CDN. Edge's `--virtual-time-budget` gives it 20 s.
- Alt+C is sent as a win32-input-mode record. A snapshot is the final screen after the stream up to that byte, so flicker and animation between checkpoints are not seen (take a checkpoint where it matters). The CSI-u Esc variants of `esc-close` pass through conhost's own parser, so they show what omp really received, not what Windows Terminal would send.
- The harness can drive `ask` through the fake provider; it still does not exercise booking tools, ticketing or real agents, and never calls a model.
- The footer shows the cwd `strategium-tui-shot\work<suffix>\cwd` (fixed name, so shots compare). Start size 140x45; the seeded run is `untimed` with `theatre: none` unless the seed is `timed`.
- It runs the real omp with `--no-extensions`, so only this repo (and `--ponytail`, and the fake provider) is loaded; your user plugins and config do not interfere, but a changed extension API in omp still breaks it.
- The session-id/claim trick depends on `timer.ts` `lockPath()` (`<key>-<sha1(key)[:8]>.lock` holding the session id). The seeded run's first tick draws the footer; if the footer does not show the run, check that first.
