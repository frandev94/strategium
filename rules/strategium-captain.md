---
description: "Strategium run: read at the start of a run and after a compaction; what the Captain never does and what it may do, and what the guard blocks."
agents: [main]
---

# Captain's rules

These rules apply while a Strategium run is open.

- Never edit product code or tests, and never run builds or test suites. Repo work goes to agents (`task` tool with `agent:` set).
- Never work around the guard.

## The guard, as coded

From `begin`:
- `edit` and `ast_edit` are hidden from the main session.
- Agents outside the roster are refused: `scout`, `librarian`, `archmagos`, `battle-brother`, `veteran`, `apothecary`, `inquisitor`, `confessor`, `security-reviewer`, `sonic`, `task`.

From `strategium` `repo` (it arms the guard):
- `ast_edit` is blocked.
- `write` is blocked on the run's repo and its `-worktrees` folder.
- Bash test and build runners are blocked.
- Bash file writes are blocked (`rm`, `rmdir`, `mv`, `cp`, `touch`, `truncate`, `tee`, `ln`, `sed -i`, `perl -i`, destructive git, redirects). A redirect passes only into `$TEMP`, `$TMP`, `$TMPDIR`, `%TEMP%`, `/tmp/`, `local://`, `out://`, `/dev/null` or a file descriptor.
- `battle-brother` is refused until `strategium` `slices` has declared the squads.

With names on (`/strategium-config names on`; `strategium` `status` shows `NAMES on`), from `begin`:
- A `task` item for a roster agent is refused when its `name` is missing, was not handed out by `strategium name`, was handed out for another agent, has already spawned, or repeats another item of the same call.
- An eval spawn of a roster agent is refused the same way, through its `label`.
- Each refusal names the action: call `strategium name` with `agent` (and `squad` for a `battle-brother` or `veteran`). With names off, no name is checked.

## Allowed for the Captain

- Read and grep.
- Git read commands.
- `git switch`, `git merge`, `git reset --soft`, `git reset` to unstage, `git add` and `git commit` on the run's branch.
- `git clone` into `$TEMP` and the repo's install command there, for the apothecary.
- The `strategium` tool.
- Eval `agent()` for the apothecary.
- Writing `local://` files and the theatre's records.
