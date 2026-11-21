---
description: "Strategium run: read when entering a station (Muster, Auspex, Scriptorium, Skirmish, Inquisition, Extraction) or a return; each station's hard rules."
agents: [main]
---

# Hard rules per station

These rules apply while a Strategium run is open.

## Muster

- Never drop a missing extra skill from a brief silently. A missing theatre Extra skill blocks the kind of work it covers: tell the user, point to `/skill:strategium-setup`, and do not start that work without it.
- Plan alone never opens the Orders `ask`. Without ticketing it cannot be unchecked (an approved omp plan already is seal Plan); it shows only inside an ask that opens for another field.
- Commit is never a field of the ask: it follows the commit setting. With the setting off the user can still ask for it in words before Skirmish; the Captain records it in the muster file and appends `[seal] Commit` with `todo.ts --append`.

## Auspex

- Briefs give file ranges for anything large (transcripts, logs, generated files), never "read the whole file".
- Every check command comes from the repo's config (package scripts, Makefile, CI workflow) or was run once by the baseline `sonic`. Never invent one.
- A failure the baseline lists as known or flaky never opens a penance.

## Scriptorium

- Nothing is built before seal Plan's OK. A later change to the sealed Contract breaks seal Plan.
- Save plan outputs as `rule://strategium-plan-copy` says.

## Skirmish

- Quote the user's strings verbatim; never paraphrase the plan.
- The apothecary never clones by itself: with isolation off, the Captain clones the run's branch into a fresh directory and gives that path.
- Never give the apothecary the battle-brother's report.

## Inquisition

- The Captain never decides the `Review: confessor` line; the librarian or archmagos sets it in the plan.
- The Captain never starts servers or tools for a Demo, and never builds: an agent (`task` or `sonic`) does it. The Captain shows its output in the `seal` panel.
- Turn wip commits into Conventional Commits with `git reset --soft origin/main`, `git reset -q`, then `git add` and `git commit` per commit. Never use the eval `commit` namespace: with `core.autocrlf` it mixes line endings.

## Extraction

- Push only after seal MR's OK, and push once (the Review & merge loop pushes its fix commits with a plain `git push`, with no new MR seal).

## Returns

- A return needs a trigger, a target and a budget; once the budget is spent, the run stops and shows what is open.
- Recon is one more `scout` with the exact gap, never a full sweep again; 1 per run.
- A redraft's Auspex is not a Recon: it spends the Redraft budget and its scouts never re-map the whole repo.
- Penance or redraft: if the code can satisfy the squad's acceptance check as written, it is a penance; if not, it is a redraft. Never spend a penance on a squad that cannot pass.
- A penance brief carries every open finding ID, never the previous report.
- A return past a granted seal breaks the seal (except the Review & merge loop): ask for it again when the flow reaches it.
- Reopen the station you return to: `todo append` its new tasks to that phase and `todo start` the first. Never reopen a completed task.
- A return never rewrites what already passed: Merge bar items that were PASS stay PASS.
- NOT REPRODUCED: the Captain drops each finding that comes back so; it costs no round.
