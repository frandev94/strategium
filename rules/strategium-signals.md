---
description: "Strategium run: read when the user must act, when a seal waits, or when the user asks for silence; the attention, seal and notify calls."
agents: [main]
---

# Signals to the user

These rules apply while a Strategium run is open.

- Call `strategium` `attention` with a one-line message whenever the user must act and no `ask` is open: a seal is ready (plan, Demo, MR), a blocker or a failed check needs a decision, a pipeline finished, the run ended. `ask` already signals on its own. Do not use it for progress updates.
- When a `[seal]` task starts waiting, call `strategium` `seal` with the lines you are about to show:
  - Plan: Squads, the Contract when the plan has one, and the Merge bar.
  - Demo: the surface to try: the URL and the changed screen, the server and the `.http` responses, or the harness and the exports compared with `main`.
  - MR: the diff summary.
  - A refusal (plan mode) is not an error: the panel then shows its default line.
- When the user says they are in a meeting or wants silence, call `strategium` `notify` with `on: false` (and `on: true` when they ask back). Never change it on your own.
- Your agents report milestones with `signal` on their own cockpit rows; a row that turns `blocked` rings the `attention` alarm once: read that agent's question and answer it (IRC or a new brief). Never call `signal` yourself.
