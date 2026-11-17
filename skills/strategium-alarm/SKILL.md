---
name: strategium-alarm
description: Use when a long task, build, run or timer finishes or needs the user's attention, or to set the Strategium booking alarm (sound at 50/80/100 % of a booking).
---

# Strategium alarm (vox-caster)

`bun <plugin>/alarm/vox.ts [50|80|100|done|attention|idle|theme] ["message"]` plays a synthesized sound (no audio files, no dependencies) and exits 0 when playback ends. The level is argv[2], else env `STRATEGIUM_P`, else `done`. With a message (argv[3], else env `STRATEGIUM_MSG`) it also shows a desktop notification titled "Strategium" (Windows toast, macOS notification, Linux `notify-send`), so the user sees it with the terminal hidden. A missing audio player prints one line to stderr; it never fails.

| Level | Sound |
|---|---|
| `50` | calm: one low bell toll, three servo-skull chirps |
| `80` | urgent: two bell tolls, static crackle, fast chirp run |
| `100` | extraction: klaxon wails over a deep bell |
| `done` | task complete: ascending bell fanfare, final deep toll |
| `attention` | the user is needed: a dark call to war, a horn section in C minor (C, Eb, then a long low G) over war drums |
| `idle` | stand-by: a power-down glide and one soft low bell; the run's clock paused after idle minutes |
| `theme` | the Strategium theme: 15 s, a drop with a dead stop and a chromatic fall; plays when the session's run ends (`strategium` `end`, `/strategium-end`); also by hand |

## Booking alarm and attention

Set env `STRATEGIUM_ALARM` to `bun <plugin>/alarm/vox.ts`. The Strategium extension runs it with `STRATEGIUM_P` and `STRATEGIUM_MSG`:
- at 50/80/100 % of the booking (timer sound + notification);
- with `attention` when the main session calls the `ask` tool during a run, when a plan review waits for the user, or when the Captain calls `strategium` with action `attention` and a message.
- with `idle` when the run's clock pauses after N idle minutes (`STRATEGIUM_IDLE_MIN`, default 3).

They run only while notifications are on: env `STRATEGIUM_NOTIFY=1`, or `/strategium-config notify on` / the `strategium` tool's `notify` action for the session. They are off by default.

## End-of-task signal

Run `bun <plugin>/alarm/vox.ts done "<what finished>"` as a background job and do not wait for it.

Before running `vox.ts` by hand inside omp, call `strategium` `notify` (no `on`) and play only when it reports `on`.
