---
name: strategium-alarm
description: Use when a long task, build, run or timer finishes or needs the user's attention, or to set the Strategium booking alarm (sound at 50/80/100 % of a booking).
---

# Strategium alarm (vox-caster)

`bun <plugin>/alarm/vox.ts [50|80|100|done|attention|idle|theme] ["message"]` plays a synthesized sound (no audio files, no dependencies) and exits 0 when playback ends. The level is argv[2], else env `STRATEGIUM_P`, else `done`. With a message (argv[3], else env `STRATEGIUM_MSG`) it also shows a desktop notification titled "Strategium" (Windows toast, macOS notification, Linux `notify-send`), so the user sees it with the terminal hidden. A missing audio player prints one line to stderr; it never fails. `STRATEGIUM_SOUND=0` skips the sound.

| Level | Sound |
|---|---|
| `50` | one bar of war drums and distorted bass, then a hard hit (boom, brass; no choir) |
| `80` | the `50` groove with a brass and choir swell over it, then the full hit (with the choir) |
| `100` | time is up: the `80` groove and swell with a riser climbing too, then the full hit ringing longer |
| `done` | task complete: the choir climbs to a bright chord over the drums, then a dead stop |
| `attention` | the user is needed: a horn call (two stabs on C, a held G), then a short snare roll into a hit |
| `idle` | stand-by, quieter on purpose: a low drone, soft choir swells and one soft bell; the run's clock paused after idle minutes |
| `theme` | the Strategium theme: four bars of drop (9.6 s) that loop without a seam; plays when the session's run ends (`strategium` `end`, `/strategium-end`); also by hand |

## Booking alarm and attention

Set env `STRATEGIUM_ALARM` to `bun <plugin>/alarm/vox.ts`. The Strategium extension runs it with `STRATEGIUM_P` and `STRATEGIUM_SOUND`, and with `STRATEGIUM_MSG` only when toasts are on:
- at 50/80/100 % of the booking (timer sound + notification);
- with `attention` when the main session calls the `ask` tool during a run, when a plan review waits for the user, or when the Captain calls `strategium` with action `attention` and a message.
- with `idle` when the run's clock pauses after N idle minutes (`STRATEGIUM_IDLE_MIN`, default 3).

They run only while notifications are on: env `STRATEGIUM_NOTIFY=1`, or `/strategium-config notify on` / the `strategium` tool's `notify` action for the session. They are off by default. Under `notify`, `/strategium-config sound on|off` and `toast on|off` (env `STRATEGIUM_SOUND`, `STRATEGIUM_TOAST`, on by default) pick the sound and the desktop notification; with both off no alarm runs.

## End-of-task signal

Run `bun <plugin>/alarm/vox.ts done "<what finished>"` as a background job and do not wait for it.

Before running `vox.ts` by hand inside omp, call `strategium` `notify` (no `on`) and play only when it reports `on`.
