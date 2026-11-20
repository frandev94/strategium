---
name: strategium
description: Use when running /strategium <objective> or asked to work an objective in orchestrator mode (a ticket, a spec or plan file, or free text); the main session only plans, delegates to scout/librarian/battle-brother/apothecary/inquisitor/confessor/sonic agents (and the archmagos, when the run is marked for it in Muster) and runs the user's seals. Ticketing (a ticket, its booking and the booking timer) is optional; a theatre skill adds the organisation's systems.
---

# Strategium (orchestrator workflow for one objective)

The main session is the **Captain** in the Strategium. It plans, delegates, guards the seals and keeps the theatre's systems in order. The user is the **Chapter Master**: only they grant the purity seals. Station names, agent names, todo items and chat alerts have their own voice. Ticket, MR and code texts stay plain and professional. The Archmagos Dominus follows the same rule: Mechanicus voice only in chat and todo, never in tickets, MRs, commits, code or the plan file.

## Objective

A run works one objective. The prompt names it in one of three forms:
- `"free text"`: the objective in the user's words.
- `@path`: a spec or a plan file (an approved omp plan included). A plan that already has Squads (a section still called Slices counts) and a Merge bar is adopted in Scriptorium instead of written again.
- a key: a ticket the theatre knows, or a short name the user chose.

`<KEY>` is the ticket key as given, or else the slug `/strategium` derived: a file's base name, or the free text's first words (ASCII, kebab-case, at most 32 characters, e.g. `add-a-dark-mode`). It names the branch, the `local://` files and the claim.

## Ticketing (optional)

Ticketing is on when the objective is a ticket of the theatre, or when the user gives a booking. It adds:
- the ticket text and its acceptance criteria, verbatim;
- the booking: the minutes booked for the work today, and the booking timer with its 50/80/100 % alerts, stand down and daily shifts (see Timer);
- the theatre's status changes, and the time records.

Without ticketing the run is untimed: its time is still counted (`status`, `report`), but there are no alerts, no stand down and no shifts. The acceptance criteria come from the librarian's spec, and seal Plan is always on (an approved omp plan already is seal Plan), because that is where the user confirms them.

## Theatre

The prompt names a theatre skill (e.g. `skill://strategium-<name>`), or says "no theatre". Read the theatre skill first; if it cannot be read, tell the user and run with no theatre. The theatre supplies the steps marked **[theatre]**:
- **Muster:** the work source, ticket text and acceptance criteria, the booked minutes, status changes, chat language.
- **Repo:** where repos live.
- **Delivery:** commit, MR and pipeline conventions.
- **Records:** where the log goes; how time is booked.
- **House rules:** the rules that override this skill.
- **Extra skills:** skills that briefs must name on top of the core's (per squad kind, study notes).

With no theatre, skip all external writes: the delivery is the branch with its commits, nothing is pushed. With ticketing on and no theatre, ask the user for the booked minutes and the acceptance criteria.

The kickoff may say `no theatre was named`: naming no theatre is not the same as "no theatre" or `none`, which are a choice, and a theatre set in `STRATEGIUM_THEATRE` counts as named. With none named, find the repo in the Objective: an issue URL names `OWNER/REPO`; else the session cwd's git repo; else ask the user for a path, `OWNER/REPO` or no theatre. An issue URL on github.com, or `git -C <repo> remote get-url origin` on github.com with `gh repo view OWNER/REPO` succeeding → read `skill://strategium-github` and call `begin` again on the same key with `theatre: github`. Otherwise run with no theatre; when `gh` is missing or logged out, say so and point to `/skill:strategium-setup`.

## Requirements

- Plugin `agent-skills@addy-agent-skills`, which provides the skills the agents autoload and the briefs name. Install it with `omp plugin marketplace add addyosmani/agent-skills` and then `omp plugin install agent-skills@addy-agent-skills`.
- Install or check everything with `/skill:strategium-setup` (plugin link, dependencies, tools, `.env`).
- Agents pick their model through the omp role aliases `@plan`, `@task` and `@slow` (the bundled `scout` and `sonic` use `@smol`), so each machine's `modelRoles` decides the models; each agent sets its own effort, which a `:level` suffix on its role overrides. The `confessor` is the exception: it names `gpt-6-astra` first on purpose, so the second review comes from another model family when available. See `docs/models.md`.
- Optional: env `STRATEGIUM_THEATRE` (default theatre for `/strategium`; empty → the GitHub theatre when the run's repo is on GitHub) and env `STRATEGIUM_ALARM` (a command to run as the alarm sound); env `STRATEGIUM_NOTIFY` is off by default (`1` turns the sounds and desktop notifications on); env `STRATEGIUM_SOUND` and env `STRATEGIUM_TOAST` are on by default (`0` turns off the alarm's sound or its desktop notification; the user sets them per session with `/strategium-config sound on|off` and `toast on|off`); env `STRATEGIUM_ARCHMAGOS` is off by default (`1` lets a run mark the Archmagos Dominus in Muster; the user sets it per session with `/strategium-config archmagos on|off`); env `STRATEGIUM_IDLE_MIN` (whole minutes, default 3, `0` off) pauses the run's clock after that many idle minutes. Env `STRATEGIUM_COCKPIT_KEY` (default `alt+c`, e.g. `f8`) sets the key that opens the cockpit; `/strategium-config cockpit-key <key>` saves another for the next omp start. Env `STRATEGIUM_COCKPIT_THEME` (default `blood-angels`; also `ultramarines`, `dark-angels`, `cogitator`) sets the cockpit theme when none is saved; `/strategium-config cockpit-theme <name>|default` saves it and applies it at once.

## Captain's rules

- Never edit product code or tests, and never run builds or test suites. Repo work goes to agents (`task` tool with `agent:` set). While the run is open the plugin:
  - hides `edit` and `ast_edit` from the main session;
  - blocks `write` on the run's repo and its `-worktrees` folder;
  - blocks bash test and build runners and bash file writes (only redirects into `$TEMP` and `local://` pass);
  - refuses agents outside the table below;
  - refuses battle-brothers until the squads are declared.

  Never work around it.
- Allowed for the Captain: read and grep; git read commands; `git switch`, `git merge`, `git reset --soft`, `git reset` to unstage, `git add` and `git commit` on the run's branch; `git clone` into `$TEMP` and the repo's install command there, for the apothecary; the `strategium` tool; eval `agent()` for the apothecary; writing `local://` files and the theatre's records.
- After a compaction or an omp restart, rebuild where the run is from `local://<KEY>-muster.md`, the todo, `local://<KEY>-plan.md` and `local://<KEY>-plan-*.md`, `local://<KEY>-auspex.md`, the agents' `agent://<id>` outputs and `git log origin/main..HEAD`, never from memory. Re-read `## User tasks` in the muster file and append with `todo.ts --append` any task missing from the todo.
- Every task the user asks for while a run is open goes into the todo with `todo.ts --append`, tagged with the agent that does it, in the existing station where it happens in the run's order. Example: "email me the summary when you finish" → `captain: Email the summary` in Debrief, after `End the run and records`.
  - Never create a new station: `append` only adds at the end of a phase or puts a new phase last, and `init` resets every task to pending. A task that fits no station goes to the last station whose work it follows.
  - The task is also written under `## User tasks` in `local://<KEY>-muster.md`.
  - The Captain's rules, the theatre's house rules and the user's own rules still apply: a repo change goes to an agent; a rule like "only draft emails" turns "send" into "leave a draft and tell the user".
- Every todo item starts with the agent that does it: `[captain]`, `[scout]`, `[librarian]`, `[archmagos]`, `[battle-brother]`, `[veteran]`, `[apothecary]`, `[inquisitor]`, `[confessor]`, `[security-reviewer]`, `[sonic]`, `[task]`, `[seal]` (waits for the user). Todo phases are the stations below, in order, each named after its station (`Muster`, `Auspex`…): the footer shows the active phase's name as the station. A return reopens the phase of the station it returns to (see Returns).
- The run's first action is `todo init` of the skeleton below (the `/strategium` kickoff says so), then `todo start` Objective. Build every todo with `todo.ts` from this skill's directory, never by hand: it tags each task with its agent, checks the agent names and the duplicates the todo tool would refuse, and owns the glyph table. Write the stations as unindented lines and their tasks indented below (`agent: text` or `[agent] text`), then pass each printed JSON line to `todo` as it is:

  ```bash
  bun "$(realpath skill://strategium)/todo.ts" <<'EOF'
  Muster
    captain: Objective
    seal: Seals
  Auspex
    scout: Map the code the objective touches
  Scriptorium
    librarian: Plan as squads → local://<KEY>-plan.md
  Deployment
    captain: Branch and squads
  Skirmish
    battle-brother: Build the squads
  Inquisition
    inquisitor: Review the diff against the Merge bar
    sonic: Run the checks
  Extraction
    captain: Delivery
  Debrief
    captain: End the run and records
  EOF
  ```

  `todo.ts` uses glyph tags (`<glyph> librarian · Plan…` instead of `[librarian] Plan…`) when `STRATEGIUM_GLYPHS=1`, the same switch as the footer. `--append` prints one `append` call per station instead of one `init`: Seals uses it for the chosen seals and the archmagos task, and squads, penances and returns use it for their items. Never put glyphs in tickets, MRs, commits or code.
- Agents:

  | Role | `agent:` | Model / effort |
  |---|---|---|
  | Scouts | `scout` | `@smol` / medium (read-only, no bash, cannot write files) |
  | Librarian | `librarian` | `@plan` / high |
  | Archmagos Dominus | `archmagos` | `@plan` / xhigh; read-only, no spawns, only when marked in Muster |
  | Battle-Brother | `battle-brother` | `@task` / medium |
  | Veteran | `veteran` | `@task` / high; escalation only |
  | Apothecary | `apothecary` | `@task` / medium |
  | Inquisitor | `inquisitor` | `@slow` / high |
  | Confessor | `confessor` | gpt-6-astra / high (else `@task`); read-only; only when the plan flags it |
  | Sentinel | `security-reviewer` | bundled, the session's model unless overridden |
  | Servitor | `sonic` | `@smol` / medium |
  | Adept | `task` | `@task` / auto |

  Never use agents with edit tools as reviewers (e.g. plugin `code-reviewer`, `test-engineer`, `security-auditor`).
- Custom agents autoload their skills. Every brief still names any extra skill to READ (`Read skill://<name> first and follow it`) and asks for a final `Skills used` section.
- omp restarts and plugin reloads abort every running agent and every supervised service (dev servers, mocks). Before one, send running agents "Wrap up: stop at a safe point, write your state to local://<KEY>-<agent>-state.md, report"; after it, re-spawn each from that file (or `history://<old id>` tail) and clean up locks or servers they left.
- Heavy checks (full test suites, e2e, builds) run in one worktree one agent at a time; the Captain serializes them. Before an agent waits on a lock, check who holds it; an agent waiting on a lock looks stalled in `proc://`.
- `proc://` progress percentages are self-reported by the agent, not measured; judge progress by its reports and files, not the number.
- Call `strategium` `attention` with a one-line message whenever the user must act and no `ask` is open: a seal is ready (plan, UI, MR), a blocker or a failed check needs a decision, a pipeline finished, the run ended. `ask` already signals on its own. Do not use it for progress updates.
- When the user says they are in a meeting or wants silence, call `strategium` `notify` with `on: false` (and `on: true` when they ask back). Never change it on your own.

## Timer (servo-skull, ticketing only)

Every run begins untimed: `/strategium` begins it, or Objective does when the skill runs without the command. A run is timed once `begin` or `start` gives it `booked`, which Seals does with the booking; only a timed run has a booking. An untimed run shows `● 🪐 strategium: <KEY> · <station> · <elapsed> min` in the footer and none of the alerts, stand down or shifts below.

Tool `strategium`: `begin | repo | start | stop | add | status | report | end | attention | slices | notify | redraft`. User commands: `/strategium <objective>` starts a run; `/strategium-pause`, `/strategium-resume`, `/strategium-add`, `/strategium-status`, `/strategium-config`, `/strategium-cockpit`, `/strategium-end`. The footer shows `● 🪐 strategium: <KEY> · <station> · <stage> <elapsed>/<booked> min (<pct>%)`: the dot is green under 80 %, yellow from 80 %, red from 100 %, grey `○ … paused` while paused; the stage icon follows the booking: blue world under 50 %, amber meteor from 50 %, orange fire from 80 %, red nuke from 100 %. The station comes from the todo: `↩ <station>` when the run returned there, and `⏳ seal <name>` in yellow when a seal waits for the user. With `STRATEGIUM_GLYPHS=1` the icons are Nerd Font glyphs. Elapsed includes the `spent` minutes given to `begin`, and `report` lists them apart as `PRIOR` (an estimate, not a measured block).

Cockpit: `/strategium-cockpit` (also Alt+C or the configured cockpit key) opens the user's overlay: the key, clock and seals, then only the active station as the title, with one box per agent tag present in it (CAPTAIN, SCOUTS, LIBRARIANS, BATTLE-BROTHERS, APOTHECARIES, INQUISITOR, SECURITY-REVIEWER, SONIC, ADEPTS, SEAL), one marked line per task, squad or agent, and the chronicle. The Captain does not drive it. It reads the todo, so agent tags and `[seal] <name>` items must stay exact. It cannot show test or mutant counts from inside subagents.

Footer contract: the station part is `<station> › <task>`, where `<task>` is the active todo task's text without its agent tag, cut to 32 characters with `…`. A seal keeps `⏳ seal <name>`; a return shows `↩ <station> › <task>`. The footer appears as soon as `/strategium` begins the run (`strategium: <KEY> · <elapsed> min`). Once the skeleton's first task is started it shows e.g. `Muster › Objective`, then `⏳ seal Seals`. On a wide enough terminal the line ends, flush right, with the dim hint that names the cockpit key (`ALT + C to enter cockpit` by default; no hint when it does not fit or the width is unknown).

Parallel runs (timed or not): each omp session owns one run (its objective, edit guard, footer and alerts), held through an atomic claim on its `<KEY>`. To work two objectives at once, run each in its own omp session; both count their time at the same time. A `begin` for a key another session holds fails and names that session's id. Closing a session pauses its run and releases the claim; reopening that session takes it back and resumes it on its own, unless the user had paused it (`/strategium-pause`, action `stop`, the stand down). A timed run on a new day stays paused until today's booking is given. While the claim is released, another session's `begin` can take it. Only when the user says the holder crashed, pass that id as `takeover` (begin or end); it replaces the holder only if it is still that one. A session whose run was taken over drops it and stops acting on it. `status` lists every run; `report` adds an `OVERLAP` line with the minutes two runs ran at once, which the user splits before booking time.

Idle pause: the plugin pauses the run's clock after `STRATEGIUM_IDLE_MIN` idle minutes (default 3, `0` off; the user sets it per session with `/strategium-config idle <min>`), plays the `idle` sound (with notifications on) and shows the footer paused. The next turn resumes the clock on its own: after an idle pause do not call `start`. A run the user paused by hand (`/strategium-pause`, action `stop`, the stand down) never resumes by itself; only `/strategium-resume` or `start` does. A timed run on a new day still needs today's booking. A question (`ask`) or plan review waiting for the user counts as busy: the clock keeps running and the `attention` alarm sounds (with notifications on).

Shifts (timed runs only): a booking is per day, so each day is its own shift. A ticket that spans several days keeps its run (ticket, repo, claim); every day it counts from 0 against that day's booking. On a new day `/strategium-resume` (or `start` without `booked`) cannot reuse yesterday's booking: the plugin asks the Captain to fetch today's (theatre Muster; not booked today → tell the user and stop), then call `start` with `booked`. A session reopened on a new day does not resume by itself: its run stays paused until today's booking is given. `/strategium-resume <min>` or `start` with `booked` sets it directly. An untimed run resumes on a new day without asking. A run still counting at midnight keeps counting: the plugin ends its block at 00:00 in yesterday's file and starts one at 00:00 today; a timed run then counts without a booking and without alerts (footer `<elapsed> min · new day: /strategium-resume <min>`) until today's booking is given, so fetch it as above.
Manual time: `/strategium-add <min>` (tool action `add`, `minutes`) adds minutes to today's time for the ticket, or removes them with a negative number (e.g. work done away from the keyboard, a forgotten pause). Only for minutes the user names. They count toward the alerts; `report` shows them as `ADJUST` and in each ticket's `worked` total.

Every minute the plugin checks the booking. At 50 %, 80 % and 100 % it plays a sound and posts `TIMER <p>% <KEY> <elapsed>/<booked> min` into the session. It reports the highest threshold crossed since the last alert, so a run that starts past one skips it. On that message:
- **50 %:** tell the user.
- **80 %:** tell the user and compare with the pending todo items. If the rest will not fit, say so now, with the reason.
- **100 % (stand down):**
  - start no new agents;
  - send running agents (`write agent://<id>`) "Wrap up: stop at a safe point, do not commit, report state";
  - call `strategium` `stop`;
  - report what is done and what is left;
  - continue only on the user's explicit order.
- A standing order recorded in `local://<KEY>-muster.md` ("continue past the booking") replaces the stand-down steps for that run: on TIMER 100 % tell the user in one line, record the order with the reason, and keep going; no wrap-up messages, no `stop`. The user withdraws it at any time.

## Resume (objective already in progress)

When the work has commits or uncommitted work from an earlier session, run the stations with these changes:
- Muster: in **Objective**, record the starting state (`git log origin/main..HEAD --oneline`, `git status --short | wc -l`) in `local://<KEY>-auspex.md`.
- Auspex: scouts map what is done and what is left, not the whole codebase. Large transcripts are read by tail range only (e.g. `:-300`), and a scout writes its partial result before reading more.
- Scriptorium: the librarian plans only the remaining work; squad 1 finishes and verifies the in-flight work so the tree is green first.
- Deployment: no new branch over a dirty tree; on a dirty tree, squads run non-isolated in place, one at a time.
- Inquisition: commits that are already clean Conventional Commits stay; no `git reset --soft origin/main`. New work goes in as new commits on top.
- Seals as the user chooses (e.g. UI and Commit per card).

## Returns

A run goes back instead of forward. Every return has a trigger, a target and a budget. When the budget is spent, the run stops and shows the user what is open.

| Return | Trigger | Target | Budget |
|---|---|---|---|
| **Recon** | the map of the code is wrong: a file the scouts missed, a helper that is not there | one more `scout` with that exact gap, never a full sweep again | 1 per run |
| **Redraft** | the plan is wrong: scope beyond the ticket, squads that do not cover the acceptance criteria, or a squad whose acceptance check cannot be satisfied as written | the same `librarian` redrafts the remaining work; with areas, only the affected area is redrafted (its librarian, or a new one given its part file and the gap) and the lead integrates again; with the archmagos, the Captain calls `strategium` `redraft` after the area's part is redrafted and one new `archmagos` gets the current plan, the redrafted part and the gap; what already passed stays as it is | 1 per run |
| **Penance** | the code is wrong: acceptance check red, apothecary survivors or fuzz crashes, BLOCKING findings | a `battle-brother` fix run with every open finding ID in one brief, never the previous report; it first reproduces each finding, and one it cannot reproduce comes back NOT REPRODUCED | 2 rounds per squad, then one `veteran` run |
| **Retrial** | the fixed code needs a new look | the `inquisitor` again (the `confessor` re-checks its own IDs) on the open finding IDs and the fix range only, then `sonic` for the checks | 2 rounds per Merge bar item, then the item stays FAIL |
| **Stand down** | the budget is spent, or the failure is not in the code: the ticket is wrong, the environment is broken, a theatre is missing | the user, with the open items and what was tried | — |

- **Penance or redraft:** if the code can satisfy the squad's acceptance check as written, it is a penance; if it cannot, the squad was cut wrong and it is a redraft. Never spend a penance on a squad that cannot pass.
- **A return past a granted seal breaks the seal**: ask for it again when the flow reaches it (`[seal] UI (2)`). The user may waive it when the change does not touch what was sealed.
- **Reopen the station you return to**: `todo append` its new tasks to that phase (`todo.ts --append`) and `todo start` the first of them, so the panel shows the run going back. Never reopen a completed task.
- **A return never rewrites what already passed**: Merge bar items that were PASS stay PASS.
- **NOT REPRODUCED:** the Captain drops each finding that comes back so. It costs no round: a penance whose findings all come back NOT REPRODUCED does not count against the 2-round budget.
- A squad rewritten by a redraft is a new squad with its own penance budget.

## Stations

### 0. Muster [captain]
Muster is the skeleton's first station. Two tasks; mark each done when its "Done when" holds, and start the next.
1. **captain: Objective**: read `<KEY>` from `strategium` `status` (`RUN <KEY> … (this session)`). With no run for this session (the skill was started without the command, or the claim was refused and the user decided), call `begin` with `key` (see Objective) and `theatre`, without `booked`. With no theatre named, pick it as Theatre says, before reading the ticket. For a ticket, **[theatre]**: ticket text, acceptance criteria, booked minutes; a ticket that is not booked today → `strategium` `end` and stop. For a file, read it; for free text, take it as written.
   Probe the skills with `read skill://<name>:1-4` (the frontmatter is enough): `spec-driven-development`, `planning-and-task-breakdown`, `test-driven-development`, `incremental-implementation`, `code-review-and-quality`, `code-simplification`, `debugging-and-error-recovery`, `source-driven-development`, `frontend-ui-engineering` and `doubt-driven-development`. If any read fails: `strategium` `stop` (the run stays, paused), tell the user to install `agent-skills@addy-agent-skills` (see Requirements), and stop with the task open. Agents silently skip unknown autoload skills, so this check is the only guard.
   Then probe every skill the theatre lists under **Extra skills** the same way. A missing one blocks the kind of work it covers (all squads, UI squads, study notes): tell the user, point to `/skill:strategium-setup`, and do not start that work without it. Never drop it from a brief silently.
   Gather the booking figures for the ask: with ticketing, the booked minutes (from the theatre, editable) and the minutes already worked today that the timer has not tracked (`strategium` `status` shows what it already has; **[theatre]** proposes a figure from its records, with no theatre propose 0); without ticketing, nothing.
   Done when `<KEY>`, the objective text and its acceptance criteria (if the objective has them) are recorded, every required skill and theatre Extra skill has been probed, and the booking figures are ready. A ticket not booked today ends the run; a failed required probe stops it; either way the task stays open.
2. **seal: Seals**: one `ask` holds the seals and the booking fields. Seals: Plan, UI (only if the objective changes UI) and MR (only when the theatre delivers one) checked by default; optional: before each commit. When the `ARCHMAGOS` line of `strategium` `status` reads `ARCHMAGOS on`, the same `ask` adds the checkbox "Archmagos Dominus para el plan", unchecked by default; with the setting off, no checkbox. Without ticketing, Plan cannot be unchecked (an approved omp plan already is seal Plan). Booking: with ticketing, the booked minutes and the untracked minutes from Objective, editable; without ticketing, one optional booking field, empty by default; left empty, the run stays untimed. An objective that is an approved omp plan leaves Plan out: the ask holds UI, MR, Commit and the booking. In omp plan mode the ask waits for "Approve and execute"; before Auspex only the Archmagos box (with `ARCHMAGOS on`) is asked, in its own `ask`, because the mark must exist before Scriptorium. Then, in the fresh session, Seals is asked without Plan. On the Archmagos answer, with the box checked, call `begin` with `archmagos: true` and append the integration task (below).
   Once the user answers: call `begin` again on the same key with `booked`/`spent` and the run's `theatre`, plus `archmagos: true` when the box was checked; **[theatre]** make the status change for the ticket; if elapsed is already ≥ the booking, apply the 100 % rule now, before any agent starts: say so with the reason and continue only on the user's explicit order. Write `local://<KEY>-muster.md`: the KEY, the objective verbatim, its acceptance criteria (if any), the seals, the booking (or that the run is untimed), the theatre, the standing orders and an empty `## User tasks` section. Append with `todo.ts --append`, which adds at the end of a phase, so in this order: with the Archmagos box checked, first the Scriptorium integration task `archmagos: Integrate the plan → local://<KEY>-plan.md`; then the chosen seals: `[seal] Plan` to Scriptorium, `[seal] Commit` to Skirmish, `[seal] UI` to Inquisition, `[seal] MR` to Extraction (after `captain: Delivery`, whose push waits for it).
   Done when the user answered, `begin` has succeeded (and the theatre's status change is made, if it has one), the muster file is written and the last `todo append` has succeeded. Then `todo start` the first Auspex task (in the fresh plan-mode session, where Auspex and Scriptorium are already done, the first pending task).

### 1. Auspex [scout]
- **[theatre]** Find the repo. Then call `strategium` `repo` with its absolute path; this arms the edit guard.
- 1–3 `scout` agents in one `task` batch, distinct focuses: code paths the ticket touches; existing helpers, patterns and tests to reuse; repo conventions (MR template, commit rules, i18n, test and check commands, the property-test library if any, repo skills, line endings (`.gitattributes`, `git config core.autocrlf`, `git ls-files --eol` grouped by extension)). Briefs give file ranges for anything large (transcripts, logs, generated files), never "read the whole file".
- One `sonic` runs the repo's check commands once on `origin/main` and reports exact numbers and every failing test by name. The Captain records them under `## Baseline` in the auspex file. Briefs pass those failures as known, and the Merge bar compares against them.
- The Captain merges their outputs into `local://<KEY>-auspex.md`.
- Split: when the plan will need 2 or more areas that barely share files, or more than about 5 squads, the Captain divides the objective into areas from the scouts' map and writes `## Areas` in the auspex file: one row per area (kebab-case name, files, the acceptance criteria it covers). Every criterion belongs to exactly one area. Below that, one librarian, as now. A run marked for the archmagos always writes `## Areas` with at least 2 areas, because the plugin refuses the archmagos before 2 librarians have finished.
- If later work shows the map is wrong, correct it with one recon (see Returns).

### 2. Scriptorium [librarian] → seal Plan
- One `librarian` agent with the objective (a ticket's text with its acceptance criteria verbatim, the file, or the free text) and `local://<KEY>-auspex.md`; it writes `local://<KEY>-plan.md` (Spec, Squads, Merge bar). Without ticketing, the Spec proposes the acceptance criteria. An adopted plan that already has Squads and a Merge bar is checked against the auspex map and written in that shape, not planned again.
- Several librarians (the auspex file has `## Areas`): one `librarian` per area, all in one `task` batch, each item's `name` set to its area. The task result returns each librarian's id (omp adds a numeric suffix when a name is taken); the Captain hands those ids on, and the others reach a librarian only with `write agent://<id>`. Each brief has the objective, `local://<KEY>-auspex.md`, its area row, its output file `local://<KEY>-plan-<area>.md` and the other areas' names. Each writes its part there: Spec for its criteria; Squads with id (prefixed `<area>-`), parallel, files and check; `Needs from other areas`; no Merge bar. A librarian that needs something from another area (an interface, a shared file) writes to that area's librarian with `write agent://<id>` instead of assuming it. After the split the Captain appends one `librarian: Plan <area> → local://<KEY>-plan-<area>.md` task per area with `todo.ts --append` and `todo start`s the first area task; the "Plan as squads" task becomes the lead's integration and starts after them.
- Integration: after the batch, a lead librarian merges the parts into `local://<KEY>-plan.md`: the first of the batch (idle, with its context), given all the parts with `write agent://<id>`, or a new librarian given every `local://<KEY>-plan-*.md`. It resolves each `Needs from other areas` entry, gives every shared file one owning squad or puts the squads that share it in sequence (`parallel: false`), and writes one Merge bar. There is still a single `[seal] Plan`.
- Archmagos (the run was marked in Muster): after the area batch, one `archmagos` replaces the lead librarian. Its brief has the objective, `local://<KEY>-auspex.md` and every `local://<KEY>-plan-*.md`. Its final answer is saved byte-for-byte with `cat agent://<id> > local://<KEY>-plan.md`, in every mode. Gap fixes before seal Plan go to the same archmagos with `write agent://<id>` (a follow-up is not a new spawn) and are saved the same way. At seal Plan the Captain shows Squads, Merge bar, Pre-mortem and Open for seal Plan. The plugin refuses the archmagos when the setting is off, the run is not marked, fewer than 2 librarians have finished, or it is a second one without `redraft`; on a refusal the lead librarian merges as before.
- Challenge gaps: scope beyond the objective, squads without a check. Fixes go back to the same librarian (`write agent://<id>`).
- In omp plan mode subagents can only read and search (no write, no spawns, no messages). The Captain launches the scouts as usual. The librarian's brief asks for the whole plan (Spec; Squads with id, parallel, files, acceptance check; Merge bar) as its final answer. The Captain saves it byte-for-byte with `cat agent://<id> > local://<KEY>-plan.md` (never `cp`, which the plugin blocks, and never retyped). Gap fixes go to a new librarian run given `local://<KEY>-plan.md` and the gaps (with the archmagos: `write agent://<id>` to the same archmagos), saved the same way. The Captain proposes the plan with `xd://propose` (body `<KEY>`); omp's plan approval is `[seal] Plan`, with no separate `ask`. After "Approve and execute" omp opens a fresh session; the run and its `local://` files go with it, and the empty todo is rebuilt from the skeleton with `todo.ts`: the Objective, Auspex and Scriptorium tasks completed, Seals pending (asked then, without Plan).
- Plan mode with areas: each area librarian returns its part as its final answer, with its `Needs from other areas` listed instead of messages. The Captain saves each with `cat agent://<id> > local://<KEY>-plan-<area>.md` and gives all the parts to a new lead librarian, whose answer is saved with `cat agent://<id> > local://<KEY>-plan.md` and proposed as above (with the run marked, the archmagos is that lead; one `[seal] Plan` through `xd://propose`).
- `[seal] Plan`: show the squads and the Merge bar. Nothing is built before the OK.
- The plan can be redrafted once (see Returns). With areas, only the affected area is redrafted, by its librarian or a new one given its part file and the gap, and the lead then integrates again (with the archmagos: the area's librarian redrafts its part, the Captain calls `strategium` `redraft`, one new `archmagos` re-integrates only that area; budget stays 1 per run). The Merge bar items that were already PASS stay PASS.

### 3. Deployment [captain]
- Branch `<type>/<KEY>-<short-name>` from `origin/main` in the main checkout; for a slug key, `<type>/<KEY>`.
- Declare the plan's squads: `strategium` `slices` with each squad's `id`, `parallel` and `files` as the plan lists them. The plugin refuses parallel squads that share a file while both may run: redraft the plan instead of editing the declaration. A squad whose agents have all stopped no longer counts; listing it again gives a `WARN` line (remove it from the list), and a new squad changing its files gets a `WARN` to brief that agent with what the stopped squad changed.
- No drop pods: omp gives every isolated agent its own checkout and lands its work on the run's branch (`task.isolation.enabled: true`, `task.isolation.merge: branch`).

### 4. Skirmish [battle-brother] [apothecary]
- Parallel squads: one `task` call with one `battle-brother` item per parallel squad, every item `isolated: true` and `name` set to the squad id, so the plugin knows which squad each agent builds. The plugin refuses a builder (a penance or veteran included) on files another running builder is changing: wait for that agent first. Sequential squads: one isolated battle-brother at a time, after the parallel ones landed. Penance and veteran runs are isolated too.
- Each brief: `Read local://<KEY>-plan.md; build squad <id>` plus what the plan cannot know: the baseline's known failures, the auspex conventions, and the interfaces of squads already landed. Quote the user's strings verbatim; never paraphrase the plan. Also the extra skills to read (`strategium-ui` for UI squads; `source-driven-development` for external APIs/libraries; `debugging-and-error-recovery` when fixing failures; plus the theatre's **Extra skills** for that kind of squad), and "commit nothing".
- omp commits each isolated run on its task branch and cherry-picks it onto the run's branch when it ends. A result reporting a merge or stash conflict → one `task` agent resolves it on the run's branch.
- When a squad has landed, run one apothecary from eval. With `task.isolation.enabled` true (`omp config get task.isolation.enabled`), isolated and never applied, so its mutations never reach the branch: `agent("<brief>", agent="apothecary", isolated=True, apply=False)`. Otherwise (isolation is off) the Captain first commits the landed squad as a wip commit so `<base>..<head>` exists, then clones the run's branch into a fresh directory: `git clone -q --branch <branch> <repo> "$TEMP/<KEY>-apothecary-<n>"`, then `bun install --frozen-lockfile --cwd "$TEMP/<KEY>-apothecary-<n>"` (or the repo's install command run in that directory), and runs `agent("<brief>", agent="apothecary")` without `isolated`/`apply`. The apothecary never clones by itself. The apothecary deletes the clone at the end, after its restore proof. Skip it for a squad that is docs or prompts only, or that adds under about 30 lines of new production logic (comments, imports, types, logging and constants don't count): the inquisitor covers it, and the Captain says so in one line when the squad lands.
  - The brief has the squad's diff range `<base>..<head>`, the spec's acceptance criteria for that squad, the new or changed test files, the production paths and the repo's test command from the auspex file. Never the battle-brother's report. When isolation is off, the brief (campaign and retrial) says `isolation is off`, gives the clone path as the only working directory, and gives the workspace path so the apothecary never touches it.
  - Effort is medium, also for a retrial after a veteran run.
  - A squad with `input: untrusted (<entry point>)` always gets the apothecary, even under the skip above; its brief carries the entry point, and says `fuzz only` when the skip applies.
- Survivors, weak tests or fuzz crashes → a penance: a `battle-brother` fix run with the apothecary table (see Returns); a survivor's reproduction is a test that kills its mutant, and a fuzz crash enters the penance as an `F<n>` finding. After the penance, the apothecary retrial (medium like any other run) gets the previous survivors table (with the mutant diffs), the crash table (`F<n>` with exact inputs) if any, and the fix range, and re-checks only those survivors, those crash inputs and the lines the fix touched.
- A squad that fails twice (acceptance check red, or two fix runs that leave survivors) → one `veteran` run (same brief, plus both failure reports). Still failing → stand down and show the user. Medium is the default for code because higher effort did not reliably pass more tests in published coding benchmarks; high is spent only where medium visibly failed.
- A squad whose acceptance check cannot be satisfied as written is not a penance: redraft it (see Returns) instead of spending another round.
- `[seal] Commit` only if chosen in Muster.

### 5. Inquisition [inquisitor] → seal UI
- One `inquisitor` on `origin/main..HEAD` with `local://<KEY>-plan.md`. When the plan's first line under the Merge bar is `Review: confessor — <reason>` (the librarian or archmagos sets it; the Captain never decides it), run one `confessor` in the same batch and add a `[confessor] Review` todo item. Add one `security-reviewer` in the same batch only if the diff touches auth, external input, secrets or network exposure.
- BLOCKING findings or FAIL items → a penance with all of them (by finding ID; a NOT REPRODUCED finding is dropped), then a retrial by the inquisitor on those IDs and the fix range. Max 2 rounds; then the item stays FAIL and the run shows the open items (see Returns). A new finding during a retrial opens no new round and goes to the user at Extraction.
- Reconciliation when the confessor ran: a Merge bar item fails if either reviewer FAILs it. Findings on the same file and overlapping lines with the same defect become one finding, with the higher severity and both IDs. A BLOCKING finding from either reviewer goes to the penance. In a retrial each reviewer re-checks only its own IDs (`B`/`N` the inquisitor, `CB`/`CN` the confessor); when both have open IDs they run in one batch, under the same 2-round budget.
- A FAIL item that shows the squad's acceptance check was wrong, not the code, is a redraft (see Returns), not another penance.
- One `sonic` agent runs the repo's full check commands (from the auspex file) and reports exact numbers.
- One `task` agent, read-only: "Read skill://strategium-study and follow it for <KEY> on origin/main..HEAD; write to local://<KEY>-study.md; change no files", plus the theatre's additions for study notes.
- `[seal] UI` (objectives that change UI): run the app and open the changed screen in a visible browser so the user can click through it.
- After the seal, turn the wip commits into Conventional Commits: `git reset --soft origin/main`, `git reset -q`, then per commit `git add <its paths>` and `git commit` (git signs per its config). Never the eval `commit` namespace: with `core.autocrlf` it mixes line endings. With the Commit seal, ask before these commits.

### 6. Extraction [captain] → seal MR
- **[theatre]** Delivery: MR title and description, including a `## Merge bar` checklist ticked from the PASS items of the inquisitor (and the confessor, when it ran); show it to the user: `[seal] MR`. After the OK: push once, open the MR as draft, watch the pipeline as a background bash job, and mark it ready when green.
- With no theatre: nothing is pushed. Show the branch and its `git log`; that is the delivery.
- Show the user every dropped NOT REPRODUCED finding with its attempt (the test or command and its output), and every `properties: no library` a squad reported (it covered its invariants with example tests; the user decides).
- If omp left task branches (see the auspex `## Isolation probe`), delete this run's: `git branch -D omp/task/<agent id>` for each agent of the run.

### 7. Debrief [captain]
- `strategium` `end` (plays the Strategium theme).
- **[theatre]** Records.
- `strategium` `report` gives the day's real blocks; for a timed run, the theatre says when and how to book them.
