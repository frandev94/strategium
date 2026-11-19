---
name: strategium-setup
description: Use when installing, repairing or checking the Strategium plugin on a machine (/skill:strategium-setup); verifies the plugin link, installs its plugin dependencies (agent-skills, ponytail, optional obsidian-second-brain), checks tools and fills missing keys in ~/.omp/agent/.env.
---

# Strategium setup

Brings a machine to a working Strategium install. Idempotent: every step checks first and changes only what is missing. Report a table at the end (item | state | action taken).

## Rules
- Never print, log or echo `.env` values. Read the file only for key names (e.g. `sed -E 's/=.*/=<set>/' ~/.omp/agent/.env`). Never write secrets.
- Install or change nothing without the user's OK. Collect everything missing first, then ask once with `ask` (checkboxes, missing items pre-checked).
- Changing an existing `.env` key needs its own explicit OK; by default only missing keys are appended.
- Plugin installs, `.env` and extension changes take effect only in omp sessions started afterwards; a plugin reload inside a running session does not mount the `strategium` tool. Say "restart omp" at the end, and warn that a restart aborts running agents and services, so do it between runs, not during one.
- Verify from a fresh session: `omp -p --no-session "Call the strategium tool with action status and reply with its text."` must answer `IDLE` or a status line, not a missing-tool error.

## 1. Plugin itself
- `omp plugin list --json`: `strategium` present and enabled.
- Missing: ask the user where the strategium repo lives (it has `package.json` with `"name": "strategium"`), then `omp plugin link --dry-run <path>` and `omp plugin link <path>`. Disabled: `omp plugin enable strategium`.
- Plugin root `<R>` = the `path` of `strategium` in `omp plugin list --json` (when invoked as `/skill:strategium-setup`, also two levels above the `[Skill directory: …]` line); later steps use it.
- `omp plugin doctor`: no error for strategium.

## 2. Plugin dependencies

| Plugin | Need | Check | Install |
|---|---|---|---|
| `agent-skills@addy-agent-skills` | required: the skills the agents autoload and briefs name | `omp plugin list --json` (marketplace section) | `omp plugin marketplace add addyosmani/agent-skills`, then `omp plugin install agent-skills@addy-agent-skills` |
| `@dietrichgebert/ponytail` | recommended: smallest-diff mode for every agent | `omp plugin list --json` (npm section) | `omp plugin install https://github.com/DietrichGebert/ponytail` |
| `obsidian-second-brain@obsidian-second-brain` | optional: vault notes/MCP for theatres that keep records in Obsidian | `omp plugin list --json` | `omp plugin marketplace add eugeniughelbur/obsidian-second-brain`, then `omp plugin install obsidian-second-brain@obsidian-second-brain` |

An installed but disabled plugin → offer `omp plugin enable <name>`.

## 3. Skills
`omp skill list --json` must contain:
- core (from agent-skills): `spec-driven-development`, `planning-and-task-breakdown`, `incremental-implementation`, `test-driven-development`, `code-review-and-quality`, `code-simplification`, `debugging-and-error-recovery`, `frontend-ui-engineering`, `source-driven-development`, `doubt-driven-development`;
- from this plugin: `strategium`, `strategium-alarm`, `strategium-github`, `strategium-setup`, `strategium-ui`, `strategium-study`, `strategium-release`;
- public skills `strategium-ui` uses (UI squads are blocked while one is missing). Install user-level with the `skills` CLI (`npx -y skills add <repo> -g -y -s <skill>`; skills land in `~/.agents/skills`, which omp reads):

  | Skill | Repo |
  |---|---|
  | `frontend-design` | `anthropics/skills` |
  | `ui-ux-pro-max` | `nextlevelbuilder/ui-ux-pro-max-skill` (its script needs `python`) |
  | `ux-copy` | `anthropics/knowledge-work-plugins` |
  | `ux-heuristics` | `wondelai/skills` |
  | `accessibility` | `addyosmani/web-quality-skills` |
  | `web-design-guidelines` | `vercel-labs/agent-skills` |

  Several of these repos also ship a skill named `accessibility`; install it only from `addyosmani/web-quality-skills` (always pass `-s`).
- every skill the chosen theatre names under **Extra skills** (read `skill://strategium-<theatre>`). These are required by the theatre: report each missing one as a missing dependency with where it comes from if known (never invent a source), and say which kind of work it blocks (e.g. every squad, UI squads, study notes). Never mark the install OK while one is missing.

## 4. Tools
- `bun --version` (alarm script). Missing → point to https://bun.sh; the timer still works without sound.
- `git --version` (worktrees, commits).
- `git-cliff --version`: only needed to cut plugin releases by hand (`strategium-release`; CI releases on merge); optional, report if missing.
- `gh --version` (`strategium-github` theatre). Then `gh auth status` (exit code only) and `gh project list --owner @me --limit 1 --format json`: output containing `missing required scopes` → report "project scope missing" and offer `gh auth refresh -s project` in the final table as the user's call (it opens the browser); setup never runs it.
- Theatre-specific CLIs named in the theatre skill (e.g. an issue-tracker or forge CLI): check `--version` and report.

## 4b. omp isolation
- `omp config get task.isolation.enabled` must be `true` and `omp config get task.isolation.merge` must be `branch`: Strategium squads run isolated and land on the run's branch.
- When missing, offer `omp config set task.isolation.enabled true` and `omp config set task.isolation.merge branch` in the same `ask`, and say that the task tool shows `isolated` only in sessions started afterwards.

## 4c. Model roles
The recommended config and its reasons are in `<R>/docs/models.md`; read it before advising.
- `omp config get modelRoles` and `omp config get task.agentModelOverrides`. Strategium agents need `plan` (librarian, archmagos), `slow` (inquisitor) and `task` (battle-brother, veteran, apothecary, confessor without Codex); the bundled `scout` and `sonic` use `smol`.
- Unset `plan` or `task` → report that they run on the session's model. Unset `slow` → it uses the configured `default`; only with `default` unset too does it fall to omp's slow list (`gpt-5.6-sol` with a Codex login, else Fable 5.2, the costliest model).
- A `:level` suffix on `plan`, `task` or `smol` overrides the effort of every agent on that role (e.g. `plan: …:xhigh` runs the librarian at `xhigh`, `smol: …:low` runs scout and sonic at `low`): report it and recommend the role without a suffix.
- Compare every role with the recommended config and show a table (role | current | recommended | why). Recommend; never push the user's existing choices: a different model or effort that is set on purpose is fine, only flag `max` effort or Fable as costly.
- Offer the missing or changed roles in the same `ask`. Roles are not per-key settings (`omp config get modelRoles.plan` is an unknown key): with the user's OK, edit the `modelRoles:` map in `config.yml` in the directory `omp config path` prints (usually `~/.omp/agent/`), touching only those roles and quoting `@` aliases, or point them to `/model` → Roles. Changing an already-set role needs its own explicit OK. Re-read with `omp config get modelRoles` afterwards.
- A non-Anthropic account: keep the role layout (strong model for `slow`/`plan`, mid model for `task`, fast model for `smol`) and ask which models they have; never invent ids, list them with `omp models --kind chat`.

## 5. `.env` (`~/.omp/agent/.env`; omp loads it into every session for keys not already set in the process environment)

| Key | Need | Default / how to fill |
|---|---|---|
| `STRATEGIUM_THEATRE` | optional | Name `<t>` of an installed `strategium-<t>` skill (list them from `omp skill list --json`); empty → the GitHub theatre when the run's repo is on GitHub, else none |
| `STRATEGIUM_ALARM` | recommended | `bun <R>/alarm/vox.ts` (forward slashes). The level arrives in env `STRATEGIUM_P` |
| `STRATEGIUM_STATE_DIR` | optional | leave unset (default `~/.omp/agent/state/strategium`) |
| `STRATEGIUM_GLYPHS` | optional | `1` only if the user's terminal font is a Nerd Font (ask; show one glyph, e.g. U+F05DA, and ask whether it renders as a book); else leave unset and todo tags stay `[name]` |
| `STRATEGIUM_NOTIFY` | recommended | `0` (off; sounds and desktop notifications on with `1`; per session `/strategium-config notify on` or `off`) |
| `STRATEGIUM_SOUND` | optional | `1` (the alarm's sound, on by default; `0` turns it off; per session `/strategium-config sound on` or `off`) |
| `STRATEGIUM_TOAST` | optional | `1` (the alarm's desktop notification, on by default; `0` turns it off; per session `/strategium-config toast on` or `off`) |
| `STRATEGIUM_IDLE_MIN` | optional | `3` (minutes of idle before the run's clock pauses; `0` off; per session `/strategium-config idle <min>`) |
| `STRATEGIUM_ARCHMAGOS` | optional | `0` (off; `1` lets runs mark the Archmagos Dominus in Muster; per session `/strategium-config archmagos on` or `off`) |
| `STRATEGIUM_COCKPIT_KEY` | optional | `alt+c` (the key that opens the cockpit, e.g. `f8` or `ctrl+shift+k`; it needs `ctrl`, `alt` or `super`, or is `f1`-`f12`; `/strategium-config cockpit-key <key>` saves another for the next omp start and wins over it) |
| `OBSIDIAN_VAULT_PATH` | only with obsidian-second-brain | absolute path of the vault; check the folder exists and contains `.obsidian/` |

- Ask the user for the values in one `ask` form (text inputs prefilled with the defaults; the vault path has no default).
- Append each missing key as `KEY=value` on its own line; create the file if absent. Never rewrite other lines.
- A key also set in the process environment (`printenv KEY` non-empty) wins over `.env`: report "set in the OS environment, `.env` ignored" without showing either value.

## 6. Smoke check
- `bun test` in `<R>` → all pass, 0 fail (timer, parallel tickets, claim races, alarm WAVs).
- Offer to play `bun <R>/alarm/vox.ts done` once so the user hears the alarm.
- Final table and "start a new omp session to load the changes".
