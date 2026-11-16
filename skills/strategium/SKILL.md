---
name: strategium
description: Use when running /strategium <objective> or asked to work an objective in orchestrator mode (a ticket, a spec or plan file, or free text); the main session only plans, delegates to scout/librarian/battle-brother/apothecary/inquisitor/sonic agents and runs the user's seals. Ticketing (a ticket, its booking and the booking timer) is optional; a theatre skill adds the organisation's systems.
---

# Strategium (orchestrator workflow for one objective)

The main session is the **Captain** in the Strategium. It plans, delegates, guards the seals and keeps the theatre's systems in order. The user is the **Chapter Master**: only they grant the purity seals. Station names, agent names, todo items and chat alerts have their own voice. Ticket, MR and code texts stay plain and professional.

## Objective

A run works one objective. The prompt names it in one of three forms:
- `"free text"`: the objective in the user's words.
- `@path`: a spec or a plan file (an approved omp plan included). A plan that already has Slices and a Merge bar is adopted in Scriptorium instead of written again.
- a key: a ticket the theatre knows, or a short name the user chose.

`<KEY>` is the ticket key, or else a short kebab-case slug of the objective (`dark-mode`). It names the branch, the `local://` files and the claim.

## Ticketing (optional)

Ticketing is on when the objective is a ticket of the theatre, or when the user gives a booking. It adds:
- the ticket text and its acceptance criteria, verbatim;
- the booking: the minutes booked for the work today, and the booking timer with its 50/80/100 % alerts, stand down and daily shifts (see Timer);
- the theatre's status changes, and the time records.

Without ticketing the run is untimed: its time is still counted (`status`, `report`), but there are no alerts, no stand down and no shifts. The acceptance criteria come from the librarian's spec, and seal Plan is always on, because that is where the user confirms them.

## Theatre

The prompt names a theatre skill (e.g. `skill://strategium-<name>`), or says "no theatre". Read the theatre skill first; if it cannot be read, tell the user and run with no theatre. The theatre supplies the steps marked **[theatre]**:
- **Muster:** the work source, ticket text and acceptance criteria, the booked minutes, status changes, chat language.
- **Repo:** where repos live.
- **Delivery:** commit, MR and pipeline conventions.
- **Records:** where the log goes; how time is booked.
- **House rules:** the rules that override this skill.
- **Extra skills:** skills that briefs must name on top of the core's (per slice kind, study notes).

With no theatre, skip all external writes: the delivery is the branch with its commits, nothing is pushed. With ticketing on and no theatre, ask the user for the booked minutes and the acceptance criteria.

## Requirements

- Plugin `agent-skills@addy-agent-skills`, which provides the skills the agents autoload and the briefs name. Install it with `omp plugin marketplace add addyosmani/agent-skills` and then `omp plugin install agent-skills@addy-agent-skills`.
- Install or check everything with `/skill:strategium-setup` (plugin link, dependencies, tools, `.env`).
- Agents name a Claude model first, then fall back (another vendor where it helps, then the role aliases `@plan`, `@task`, `@slow`; the bundled agents use `@smol`), so each machine's `modelRoles` decides when the preferred provider is missing.
- Optional: env `STRATEGIUM_THEATRE` (default theatre for `/strategium`) and env `STRATEGIUM_ALARM` (a command to run as the alarm sound).

## Captain's rules

- Never edit product code or tests, and never run builds or test suites. Repo work goes to agents (`task` tool with `agent:` set). The plugin blocks `edit`/`write` on the run's repo and its `-worktrees` folder in the main session, and `ast_edit` for the whole session while the run is open; never work around it through bash.
- Allowed for the Captain: read and grep; git read commands, `git worktree add/remove`, `git merge` of slice branches, `git reset --soft`; commits through the eval `commit` namespace; the `strategium` tool; writing `local://` files and the theatre's records.
- Every todo item starts with the agent that does it: `[captain]`, `[scout]`, `[librarian]`, `[battle-brother]`, `[veteran]`, `[apothecary]`, `[inquisitor]`, `[security-reviewer]`, `[sonic]`, `[task]`, `[seal]` (waits for the user). Todo phases are the stations below, in order, each named after its station (`Muster`, `Auspex`…): the footer shows the active phase's name as the station. A return reopens the phase of the station it returns to (see Returns).
- Glyph todo tags: only when the prompt says "Use glyph todo tags" (the user's terminal has a Nerd Font), put the agent's glyph before its name, e.g. `󰗚 librarian · Plan remaining work as slices → local://<KEY>-plan.md`. Copy glyphs from this table only; never guess a codepoint. Keep the name next to the glyph. Never put glyphs in tickets, MRs, commits or code.

  | Tag | Glyph | Nerd Font name |
  |---|---|---|
  | captain | 󰡗 | md-chess_king U+F0857 |
  | scout | 󰐷 | md-radar U+F0437 |
  | librarian | 󰗚 | md-book_open_page_variant U+F05DA |
  | battle-brother | 󱢾 | md-shield_sword U+F18BE |
  | veteran | 󰞇 | md-sword_cross U+F0787 |
  | apothecary | 󰛯 | md-medical_bag U+F06EF |
  | inquisitor | 󰊛 | md-gavel U+F029B |
  | security-reviewer | 󰶚 | md-shield_search U+F0D9A |
  | sonic | 󰚌 | md-skull U+F068C (servo-skull) |
  | task | 󰑴 | md-school U+F0474 |
  | seal | 󰑺 | md-seal U+F047A |
- Agents:

  | Role | `agent:` | Preferred model / effort (fallback) |
  |---|---|---|
  | Scouts | `scout` | `@smol` / medium (read-only, no bash, cannot write files) |
  | Librarian | `librarian` | claude-opus-5-5 / high (`@plan`) |
  | Battle-Brother | `battle-brother` | claude-sonnet-5-5 / medium (`@task`) |
  | Veteran | `veteran` | claude-sonnet-5-5 / high (`@task`); escalation only |
  | Apothecary | `apothecary` | claude-sonnet-5-5 / high (`@task`) |
  | Inquisitor | `inquisitor` | claude-opus-5-5 / high (gpt-6-astra, then `@slow`) |
  | Sentinel | `security-reviewer` | bundled, `@slow` unless overridden |
  | Servitor | `sonic` | `@smol` / medium |
  | Adept | `task` | `@task` / auto |

  Never use agents with edit tools as reviewers (e.g. plugin `code-reviewer`, `test-engineer`, `security-auditor`).
- Custom agents autoload their skills. Every brief still names any extra skill to READ (`Read skill://<name> first and follow it`) and asks for a final `Skills used` section.
- omp restarts and plugin reloads abort every running agent and every supervised service (dev servers, mocks). Before one, send running agents "Wrap up: stop at a safe point, write your state to local://<KEY>-<agent>-state.md, report"; after it, re-spawn each from that file (or `history://<old id>` tail) and clean up locks or servers they left.
- Heavy checks (full test suites, e2e, builds) run in one worktree one agent at a time; the Captain serializes them. Before an agent waits on a lock, check who holds it; an agent waiting on a lock looks stalled in `proc://`.
- `proc://` progress percentages are self-reported by the agent, not measured; judge progress by its reports and files, not the number.
- Call `strategium` `attention` with a one-line message whenever the user must act and no `ask` is open: a seal is ready (plan, UI, MR), a blocker or a failed check needs a decision, a pipeline finished, the run ended. `ask` already signals on its own. Do not use it for progress updates.

## Timer (servo-skull, ticketing only)

Only a timed run (one begun with `booked`) has a booking. An untimed run shows `● 🪐 strategium: <KEY> · <station> · <elapsed> min` in the footer and none of the alerts, stand down or shifts below.

Tool `strategium`: `begin | repo | start | stop | add | status | report | end | attention`. User commands: `/strategium pause | resume | add | status | end`. The footer shows `● 🪐 strategium: <KEY> · <station> · <stage> <elapsed>/<booked> min (<pct>%)`: the dot is green under 80 %, yellow from 80 %, red from 100 %, grey `○ … paused` while paused; the stage icon follows the booking: blue world under 50 %, amber meteor from 50 %, orange fire from 80 %, red nuke from 100 %. The station comes from the todo: `↩ <station>` when the run returned there, and `⏳ seal <name>` in yellow when a seal waits for the user. With `STRATEGIUM_GLYPHS=1` the icons are Nerd Font glyphs. Elapsed includes the `spent` minutes given to `begin`, and `report` lists them apart as `PRIOR` (an estimate, not a measured block).

Parallel runs (timed or not): each omp session owns one run (its objective, edit guard, footer and alerts), held through an atomic claim on its `<KEY>`. To work two objectives at once, run each in its own omp session; both count their time at the same time. A `begin` for a key another session holds fails and names that session's id. Closing a session pauses its run and releases the claim, so another session's `begin` can take it. Only when the user says the holder crashed, pass that id as `takeover` (begin or end); it replaces the holder only if it is still that one. A session whose run was taken over drops it and stops acting on it. `status` lists every run; `report` adds an `OVERLAP` line with the minutes two runs ran at once, which the user splits before booking time.

Shifts (timed runs only): a booking is per day, so each day is its own shift. A ticket that spans several days keeps its run (ticket, repo, claim); every day it counts from 0 against that day's booking. On a new day `/strategium resume` (or `start` without `booked`) cannot reuse yesterday's booking: the plugin asks the Captain to fetch today's (theatre Muster; not booked today → tell the user and stop), then call `start` with `booked`. `/strategium resume <min>` or `start` with `booked` sets it directly. An untimed run resumes on a new day without asking.
Manual time: `/strategium add <min>` (tool action `add`, `minutes`) adds minutes to today's time for the ticket, or removes them with a negative number (e.g. work done away from the keyboard, a forgotten pause). Only for minutes the user names. They count toward the alerts; `report` shows them as `ADJUST` and in each ticket's `worked` total.

Every minute the plugin checks the booking. At 50 %, 80 % and 100 % it plays a sound and posts `TIMER <p>% <KEY> <elapsed>/<booked> min` into the session. It reports the highest threshold crossed since the last alert, so a run that starts past one skips it. On that message:
- **50 %:** tell the user.
- **80 %:** tell the user and compare with the pending todo items. If the rest will not fit, say so now, with the reason.
- **100 % (stand down):**
  - start no new agents;
  - send running agents (`write agent://<id>`) "Wrap up: stop at a safe point, do not commit, report state";
  - call `strategium` `stop`;
  - report what is done and what is left;
  - continue only on the user's explicit order.
- A standing order recorded in Muster ("continue past the booking") replaces the stand-down steps for that run: on TIMER 100 % tell the user in one line, record the order with the reason, and keep going; no wrap-up messages, no `stop`. The user withdraws it at any time.

## Resume (objective already in progress)

When the work has commits or uncommitted work from an earlier session, run the stations with these changes:
- Muster: record the starting state (`git log origin/main..HEAD --oneline`, `git status --short | wc -l`) in `local://<KEY>-auspex.md`.
- Auspex: scouts map what is done and what is left, not the whole codebase. Large transcripts are read by tail range only (e.g. `:-300`), and a scout writes its partial result before reading more.
- Scriptorium: the librarian plans only the remaining work; slice 1 finishes and verifies the in-flight work so the tree is green first.
- Deployment: no new branch and no drop pods over a dirty tree; slices run in place, one at a time, unless the work splits into files with no overlap.
- Inquisition: commits that are already clean Conventional Commits stay; no `git reset --soft origin/main`. New work goes in as new commits on top.
- Seals as the user chooses (e.g. UI and Commit per card).

## Returns

A run goes back instead of forward. Every return has a trigger, a target and a budget. When the budget is spent, the run stops and shows the user what is open.

| Return | Trigger | Target | Budget |
|---|---|---|---|
| **Recon** | the map of the code is wrong: a file the scouts missed, a helper that is not there | one more `scout` with that exact gap, never a full sweep again | 1 per run |
| **Redraft** | the plan is wrong: scope beyond the ticket, slices that do not cover the acceptance criteria, or a slice whose acceptance check cannot be satisfied as written | the same `librarian` redrafts the remaining work; what already passed stays as it is | 1 per run |
| **Rally** | the code is wrong: acceptance check red, apothecary survivors, BLOCKING findings | a `battle-brother` fix run with the failure report, never the previous report | 2 rounds per slice, then one `veteran` run |
| **Retrial** | the fixed code needs a new look | the `inquisitor` again, then `sonic` for the checks | 2 rounds per Merge bar item, then the item stays FAIL |
| **Stand down** | the budget is spent, or the failure is not in the code: the ticket is wrong, the environment is broken, a theatre is missing | the user, with the open items and what was tried | — |

- **Rally or redraft:** if the code can satisfy the slice's acceptance check as written, it is a rally; if it cannot, the slice was cut wrong and it is a redraft. Never spend a rally on a slice that cannot pass.
- **A return past a granted seal breaks the seal**: ask for it again when the flow reaches it (`[seal] UI (2)`). The user may waive it when the change does not touch what was sealed.
- **Reopen the station you return to**: `todo append` its items to that phase and `todo start` its task, so the panel shows the run going back.
- **A return never rewrites what already passed**: Merge bar items that were PASS stay PASS.
- A slice rewritten by a redraft is a new slice with its own rally budget.

## Stations

### 0. Muster [captain]
0. Requirements: `read skill://test-driven-development`, `skill://spec-driven-development` and `skill://code-review-and-quality`. If any read fails, stop and tell the user to install `agent-skills@addy-agent-skills` (see Requirements). Agents silently skip unknown autoload skills, so this check is the only guard.
   Then read every skill the theatre lists under **Extra skills**. A missing one blocks the kind of work it covers (all slices, UI slices, study notes): tell the user, point to `/skill:strategium-setup`, and do not start that work without it. Never drop it from a brief silently.
1. Resolve the objective (see Objective) and its `<KEY>`. For a ticket, **[theatre]**: ticket text, acceptance criteria, booked minutes and status change; a ticket that is not booked today → stop. For a file, read it; for free text, take it as written.
2. Seals: ask with `ask` which seals apply. Defaults checked: Plan, UI (only if the objective changes UI), MR (only when the theatre delivers one). Optional: before each commit. Without ticketing, Plan cannot be unchecked. Record them as `[seal]` todo items.
3. Booking, in the same `ask` as the seals. With ticketing: the booked minutes (from the theatre, editable) and the minutes already worked today that the timer has not tracked (`strategium` `status` shows what it already has; **[theatre]** proposes a figure from its records, with no theatre propose 0). Without ticketing: one optional booking field, empty by default; left empty, the run is untimed.
4. `strategium` `begin` with `key` and `theatre`, plus `booked` and `spent` for a timed run. If elapsed is already ≥ the booking, apply the 100 % rule now, before any agent starts: say so with the reason and continue only on the user's explicit order.
5. `todo init` with the stations below and their tagged items.

### 1. Auspex [scout]
- **[theatre]** Find the repo. Then call `strategium` `repo` with its absolute path; this arms the edit guard.
- 1–3 `scout` agents in one `task` batch, distinct focuses: code paths the ticket touches; existing helpers, patterns and tests to reuse; repo conventions (MR template, commit rules, i18n, test and check commands, repo skills). Briefs give file ranges for anything large (transcripts, logs, generated files), never "read the whole file".
- The Captain merges their outputs into `local://<KEY>-auspex.md`.
- If later work shows the map is wrong, correct it with one recon (see Returns).

### 2. Scriptorium [librarian] → seal Plan
- One `librarian` agent with the objective (a ticket's text with its acceptance criteria verbatim, the file, or the free text) and `local://<KEY>-auspex.md`; it writes `local://<KEY>-plan.md` (Spec, Slices, Merge bar). Without ticketing, the Spec proposes the acceptance criteria. An adopted plan that already has Slices and a Merge bar is checked against the auspex map and written in that shape, not planned again.
- Challenge gaps: scope beyond the objective, slices without a check. Fixes go back to the same librarian (`write agent://<id>`).
- `[seal] Plan`: show the slices and the Merge bar. Nothing is built before the OK.
- The plan can be redrafted once (see Returns). The Merge bar items that were already PASS stay PASS.

### 3. Deployment [captain]
- Branch `<type>/<KEY>-<short-name>` from `origin/main` in the main checkout; for a slug key, `<type>/<KEY>`.
- Each `parallel: yes` slice gets a drop pod: `git worktree add ../<repo>-worktrees/<KEY>-<slice> -b <branch>-<slice>`, never inside the repo or a workspace glob.
- For node repos, add a `node_modules` junction (Windows: `cmd /c mklink /J`) or symlink to the main checkout's `node_modules`.
- `parallel: no` slices run in the main checkout, one at a time.

### 4. Skirmish [battle-brother] [apothecary]
- Parallel slices: one `task` batch with `agent: battle-brother`, one per worktree. Sequential slices: one after the other.
- Each brief: slice text, directory, files, acceptance check, extra skills to read (`strategium-ui` for UI slices; `source-driven-development` for external APIs/libraries; `debugging-and-error-recovery` when fixing failures; plus the theatre's **Extra skills** for that kind of slice), and "commit nothing".
- When a slice reports done, run one `apothecary` with the slice's spec criteria, new test files and production paths, never the battle-brother's report. It runs in its own throwaway pod, never in a directory another agent is using: `git worktree add --detach ../<repo>-worktrees/<KEY>-apo HEAD`, copy the slice's changed and untracked files into it (`git ls-files -m -o --exclude-standard`), add the `node_modules` link, and remove the pod afterwards (link first).
- Survivors or weak tests → a rally: a `battle-brother` fix run with the apothecary table (see Returns).
- A slice that fails twice (acceptance check red, or two fix runs that leave survivors) → one `veteran` run (same brief, plus both failure reports). Still failing → stand down and show the user. Medium is the default for code because higher effort did not reliably pass more tests in published coding benchmarks; high is spent only where medium visibly failed.
- A slice whose acceptance check cannot be satisfied as written is not a rally: redraft it (see Returns) instead of spending another round.
- `[seal] Commit` only if chosen in Muster.

### 5. Inquisition [inquisitor] → seal UI
- Commit each slice on its slice branch with the eval `commit` namespace (`wip(<scope>): <slice> (<KEY>)`), then `git merge --no-ff` the slice branches into the run's branch. A conflict → one `task` agent resolves it. With the Commit seal, ask before these commits.
- One `inquisitor` on `origin/main..HEAD` with `local://<KEY>-plan.md`. Add one `security-reviewer` in the same batch only if the diff touches auth, external input, secrets or network exposure.
- BLOCKING findings or FAIL items → a rally with all of them, then a retrial by the inquisitor. Max 2 rounds; then the item stays FAIL and the run shows the open items (see Returns).
- A FAIL item that shows the slice's acceptance check was wrong, not the code, is a redraft (see Returns), not another rally.
- One `sonic` agent runs the repo's full check commands (from the auspex file) and reports exact numbers.
- One `task` agent, read-only: "Read skill://strategium-study and follow it for <KEY> on origin/main..HEAD; write to local://<KEY>-study.md; change no files", plus the theatre's additions for study notes.
- `[seal] UI` (objectives that change UI): run the app and open the changed screen in a visible browser so the user can click through it.
- After the seal, turn the wip commits into Conventional Commits with `git reset --soft origin/main` + the eval `commit` namespace (the branch is unpushed).

### 6. Extraction [captain] → seal MR
- **[theatre]** Delivery: MR title and description, including a `## Merge bar` checklist ticked from the inquisitor's PASS items; show it to the user: `[seal] MR`. After the OK: push once, open the MR as draft, watch the pipeline as a background bash job, and mark it ready when green.
- With no theatre: nothing is pushed. Show the branch and its `git log`; that is the delivery.
- Remove the drop pods: junction or symlink first, then `git worktree remove`, then the slice branches.

### 7. Debrief [captain]
- `strategium` `end`.
- **[theatre]** Records.
- `strategium` `report` gives the day's real blocks; for a timed run, the theatre says when and how to book them.
