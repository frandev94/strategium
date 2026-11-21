---
description: "Strategium run: read at the start of a run and whenever the user asks for a task; how the todo is built and how user tasks enter it."
agents: [main]
---

# The run's todo

These rules apply while a Strategium run is open.

## User tasks

- Every task the user asks for goes into the todo with `todo.ts --append`, tagged with the agent that does it, in the existing station where it happens in the run's order. Example: "email me the summary when you finish" → `captain: Email the summary` in Debrief, after `End the run and records`.
- Never create a new station: `append` only adds at the end of a phase or puts a new phase last, and `init` resets every task to pending. A task that fits no station goes to the last station whose work it follows.
- Also write the task under `## User tasks` in `local://<KEY>-muster.md`.
- The run's rules, the theatre's house rules and the user's own rules still apply: a repo change goes to an agent; a rule like "only draft emails" turns "send" into "leave a draft and tell the user".
- In omp plan mode a task for a station after Scriptorium goes only under `## User tasks` until the todo is rebuilt after approval, because the plan-mode todo holds no later station. The rebuild adds it.

## Tags and phases

- Every todo item starts with the agent that does it: `[captain]`, `[scout]`, `[librarian]`, `[archmagos]`, `[battle-brother]`, `[veteran]`, `[apothecary]`, `[inquisitor]`, `[confessor]`, `[security-reviewer]`, `[sonic]`, `[task]`, `[seal]` (waits for the user).
- Todo phases are the stations, in order, each named after its station (`Muster`, `Auspex`…): the footer shows the active phase's name as the station.
- A return reopens the phase of the station it returns to.

## Building it

- The run's first action is `todo init` of the skeleton in the skill, then `todo start` Objective.
- In omp plan mode that first `init` is the same skeleton built with `todo.ts --to Scriptorium`, so the todo holds only Muster, Auspex and Scriptorium and the footer never shows a station that cannot run there.
- Build every todo with `todo.ts`, never by hand. It tags each task, checks the agent names and the duplicates the todo tool would refuse, and owns the glyph table.
