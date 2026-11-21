---
description: "Strategium run: read after a compaction or an omp restart, and before a restart or plugin reload; how to rebuild the run's state."
agents: [main]
---

# Rebuild and restarts

These rules apply while a Strategium run is open.

## After a compaction or an omp restart

- Rebuild where the run is from files, never from memory: `local://<KEY>-muster.md`, the todo, `local://<KEY>-plan.md` and `local://<KEY>-plan-*.md`, `local://<KEY>-auspex.md`, the agents' `agent://<id>` outputs and `git log origin/main..HEAD`.
- Re-read `skill://strategium` and every `rule://` listed in its `## Rules`.
- Re-read `## User tasks` in the muster file and append with `todo.ts --append` any task missing from the todo.
- In omp plan mode append only the tasks for Muster to Scriptorium. Tasks for later stations wait under `## User tasks` until the rebuild after approval.
- Do not filter with `--to Scriptorium` here: it errors when the user-task list has no Scriptorium task. Pick the tasks by name.

## Before an omp restart or a plugin reload

- Both abort every running agent and every supervised service (dev servers, mocks).
- Before one, send running agents "Wrap up: stop at a safe point, write your state to local://<KEY>-<agent>-state.md, report".
- After it, re-spawn each agent from that file (or the tail of `history://<old id>`) and clean up the locks or servers they left.
