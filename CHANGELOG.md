## [0.2.61] - 2026-11-23

### 🚀 Features

- *(cockpit)* Ask the Servo-skull about the whole mission

### 🐛 Bug Fixes

- *(cockpit)* Richer mission facts and an answer that stays in view
- *(cockpit)* A blocked reason survives the fact cap

### 📚 Documentation

- Asking the Servo-skull
- Each Servo-skull question is one paid call
## [0.2.60] - 2026-11-23

### 🐛 Bug Fixes

- *(guard)* A quoted heredoc opener and an empty heredoc body no longer hide commands
- *(guard)* The quote-blind heredoc reading is checked too
## [0.2.59] - 2026-11-23

### 🚀 Features

- *(cockpit)* A chronicle entry about an agent opens that agent or its squad

### 🧪 Testing

- *(cockpit)* Chronicle agent ids survive a restart and every logging site
## [0.2.58] - 2026-11-23

### 📚 Documentation

- The Servo-skull
- The booking timer is no longer called the servo-skull
- *(es)* The Servo-skull, not the locutor

### 🚜 Refactor

- *(cockpit)* The caster is now the Servo-skull

### 🧪 Testing

- *(cockpit)* A takeover end keeps a pre-rename caster spend
## [0.2.57] - 2026-11-23

### 🐛 Bug Fixes

- *(guard)* Heredoc bodies are found by a linear scan
- *(guard)* The heredoc scan matches the regex, word shortening included

### 🧪 Testing

- *(guard)* A quoted heredoc word with no closing quote still counts as text
## [0.2.56] - 2026-11-23

### 🚀 Features

- *(cockpit)* The cockpit shows the debrief summary as its last screen

### 🐛 Bug Fixes

- *(cockpit)* Esc closes the final screen from a detail; the replay ends the run on omp 18 and 19

### 📚 Documentation

- The cockpit's final screen after end
- PR merged on the final screen needs names or a vault

### 🧪 Testing

- *(cockpit)* Keys on the final screen open nothing esc would have to back out of
## [0.2.55] - 2026-11-23

### 🐛 Bug Fixes

- *(guard)* Shell forms that hid a command from the bash guard
- *(guard)* Keep subshell runners refused and the scan linear on newlines and options
- *(guard)* Git with many global options stays refused; faster assignments
## [0.2.54] - 2026-11-23

### 🐛 Bug Fixes

- *(extension)* Notifications read as one sentence and say the next step
- *(extension)* Notification hints that hold, and one sentence style

### 🧪 Testing

- *(extension)* Pin the alarm-exit hint
## [0.2.53] - 2026-11-23

### 🐛 Bug Fixes

- *(timer)* A takeover begin keeps the taken run's state and cockpit
- *(timer)* A takeover settles the taken session's agents and loads the moved cockpit

### 🧪 Testing

- *(timer)* A takeover of a run with no agents keeps the SLICES guard
## [0.2.52] - 2026-11-23

### 🐛 Bug Fixes

- *(tui-shot)* The seal-row check compares cell columns
- *(cockpit)* A cancelled blocking task ends its cockpit row

### 🚜 Refactor

- *(cockpit)* One list of final agent statuses

### 🧪 Testing

- *(cockpit)* The chronicle 200-entry test gets a timeout for loaded Windows machines
## [0.2.51] - 2026-11-23

### 🐛 Bug Fixes

- *(cockpit)* Clean the run key, station name, task text and agent id before drawing
- *(cockpit)* Clean the squad id in the brothers box and the chronicle time

### 🧪 Testing

- *(rules)* The discovery hook gets a timeout for cold Windows runners
- *(cockpit)* Cover a named squad with a hostile slice id
- *(cockpit)* Keep the hostile slice typed so the check passes
## [0.2.50] - 2026-11-23

### 🐛 Bug Fixes

- *(cockpit)* A mid-run todo rebuild no longer logs the station twice
- *(cockpit)* The chronicle keeps its station and waiting seal across a restart and a rebuild
- *(cockpit)* Seed the chronicle's station and waiting seal from the run's phases
## [0.2.49] - 2026-11-23

### 🐛 Bug Fixes

- *(cockpit)* The cockpit opens again after the host disposes it

### 🧪 Testing

- *(cockpit)* The host-dispose test lives with the cockpit tests and checks the late-dispose guard
## [0.2.48] - 2026-11-23

### 🚀 Features

- *(timer)* A sub-task booked through its parent or its estimate

### 🐛 Bug Fixes

- *(tooling)* Tui-shot ask check ignores omp's startup tip
- *(tooling)* Tui-shot dialog check accepts omp 19's one-option select
- *(tooling)* The 1/2 counter must be on the Yes row
- *(timer)* A parent group counts wall time, not each key's clock
- *(timer)* A parent joins its group only with its own booking

### 📚 Documentation

- Sub-tasks booked through a parent or an estimate

### 🧪 Testing

- *(tooling)* Pin each ask marker alone
## [0.2.47] - 2026-11-23

### 🚀 Features

- *(timer)* Report splits each overlap between the keys that ran in it

### 🐛 Bug Fixes

- *(timer)* A past day's open block ends at 23:59; no 0-min overlap lines
## [0.2.46] - 2026-11-23

### 🚀 Features

- *(extension)* Switch ends the run and begins another key in one call

### 🐛 Bug Fixes

- *(extension)* Switch keeps the session's own repo and waits for its agents
- *(extension)* Switch refusal names builders; recovery docs

### 📚 Documentation

- Switch between keys
## [0.2.45] - 2026-11-23

### 🚀 Features

- *(extension)* The Captain records decisions in the vault

### 🐛 Bug Fixes

- *(extension)* The secret filter lets paths and branch names through
- *(extension)* Note globs refuse brackets; secret refusal says how to go on

### 📚 Documentation

- The record action, vault notes and the secret filter
## [0.2.44] - 2026-11-23

### 🚀 Features

- *(extension)* Record a run's events in a notes vault

### 🐛 Bug Fixes

- *(extension)* Vault records the real PR command and never loses a daily
- *(extension)* PR line only for a real create; daily placement in more shapes

### 📚 Documentation

- Vault records (setting, contract, events)
## [0.2.43] - 2026-11-23

### 🚀 Features

- *(extension)* Per-tier tally of ratings across runs

### 🐛 Bug Fixes

- *(extension)* A tier proposal stops once a heavier tier is tried; end never fails on the tally
- *(extension)* A lone heavier-tier result does not mute a tier proposal

### 📚 Documentation

- Tier proposals at Muster and lessons promoted after two runs

### ⚙️ Miscellaneous Tasks

- Line endings: no stray CR in the READMEs, tally.test.ts in LF
## [0.2.42] - 2026-11-23

### 🚀 Features

- *(extension)* Reuse a proven battle-brother for a squad's next round

### 🐛 Bug Fixes

- *(extension)* Reuse marker read per line in any markdown form; full SEED
- *(extension)* Reuse never offers a retired or corrupted builder
- *(extension)* Reuse id boundary without backtracking

### 📚 Documentation

- Reuse a proven battle-brother, and redraft versus corruption
## [0.2.41] - 2026-11-23

### 🚀 Features

- *(extension)* Lessons from corrupted agents for the next round

### 📚 Documentation

- *(theatre)* Check the board at the end of the task
- *(theatre)* Board check reads the issue and PR state

### 🧪 Testing

- *(extension)* LESSON line with names off; penance brief carries lessons
## [0.2.40] - 2026-11-23

### 🚀 Features

- *(extension)* Rate each agent from the reviewers' verdict

### 🐛 Bug Fixes

- *(extension)* Rate a blocking-task builder; the FALL line is provisional
- *(extension)* Ratings stay one per agent and are cleaned on every end
- *(extension)* Each agent id keeps its own rating

### 📚 Documentation

- Agent ratings, and the name action in the skill's action list
## [0.2.39] - 2026-11-23

### 🚀 Features

- *(extension)* Agent names, honour badges and the record in the cockpit and debrief

### 🐛 Bug Fixes

- *(extension)* Roster read after allocation, every honour in the debrief

### 📚 Documentation

- Names, badges and honours in the cockpit and debrief

### 🧪 Testing

- *(extension)* Eval spawn by name, no honours line on an unreadable roster
## [0.2.38] - 2026-11-22

### 🚀 Features

- *(extension)* Service record and shared roster across runs

### 🐛 Bug Fixes

- *(extension)* Roster campaign hold expires, real merges only, dead locks taken
- *(extension)* Ranked brothers return in later runs of the same session
- *(extension)* Only ranked surnames take an epithet in the first pass

### 📚 Documentation

- *(lore)* Service record, honours and the roster
## [0.2.37] - 2026-11-22

### 🚀 Features

- *(extension)* Lore names handed out by the plugin within a run

### 🐛 Bug Fixes

- *(extension)* Names guard covers redrafts, eval labels and repeat spawns
- *(extension)* Names guard for every agent at spawn; name action normalises the agent

### 📚 Documentation

- *(skills)* Agent names and the names setting
## [0.2.36] - 2026-11-22

### 🐛 Bug Fixes

- *(lore)* Agent frontmatter on one line, and lore corrections

### 📚 Documentation

- *(lore)* The Chapter organisation under the Codex Astartes
- *(lore)* Veteran in the 1st Company; Inquisition station and Ancient wording
- *(lore)* Inquisition station order, reserve companies, title mapping

### 🧪 Testing

- *(skills)* The frontmatter test catches a stray carriage return
## [0.2.35] - 2026-11-22

### 🚀 Features

- *(cockpit)* An optional caster narrates the current station

### 🐛 Bug Fixes

- *(cockpit)* Caster races, reasons and sanitizing
- *(cockpit)* Caster report shows calls and model; provider errors explained

### 📚 Documentation

- *(cockpit)* Describe the caster

### 🧪 Testing

- *(tooling)* Tui-shot --caster flag and caster-box replay
## [0.2.34] - 2026-11-22

### 🚀 Features

- *(cockpit)* An optional worn techno-relic look

### 🐛 Bug Fixes

- *(cockpit)* Relic decoration seeded by structure, scratches kept off text
- *(cockpit)* Single-glyph relic scratches and tests for tarnish, rivets and fillers

### 📚 Documentation

- *(cockpit)* Describe the relic look

### 🧪 Testing

- *(tooling)* Tui-shot --relic flag
## [0.2.33] - 2026-11-22

### 🚀 Features

- *(cockpit)* Enter on an agent opens its transcript

### 🐛 Bug Fixes

- *(cockpit)* Transcript reasons, id and file checks, and a closed cockpit reads nothing
- *(cockpit)* The transcript keeps the brief and reads at most once a second
- *(cockpit)* Find the agent's brief past a large session header

### 📚 Documentation

- *(cockpit)* Describe the agent transcript view

### 🧪 Testing

- *(tooling)* Tui-shot replay of the agent transcript
## [0.2.32] - 2026-11-22

### 🚀 Features

- *(cockpit)* Enter opens the detail of the selected line

### 🐛 Bug Fixes

- *(cockpit)* Finished-agent rows survive a restart and never leak to a respawn
- *(cockpit)* Wrap walks words in linear time
- *(cockpit)* Retry a missed agent row while its detail is open
- *(cockpit)* A squad detail retries its agents' rows; gold scroll position

### 📚 Documentation

- *(cockpit)* Describe the detail views

### 🧪 Testing

- *(tooling)* Tui-shot replay of the cockpit details
## [0.2.31] - 2026-11-21

### 🚀 Features

- *(cockpit)* A keyboard cursor over lines and stations

### 🐛 Bug Fixes

- *(cockpit)* A clean reopen and one even inverse block for the selection
- *(cockpit)* Box windows remember their place; tighter CSI-u keys

### 📚 Documentation

- *(cockpit)* Describe the cockpit keys

### 🧪 Testing

- *(tooling)* Tui-shot replay of the cockpit cursor
- *(cockpit)* The cursor is not saved to the cockpit file
## [0.2.30] - 2026-11-21

### 🚀 Features

- *(cockpit)* Cost per agent in the cockpit and the debrief

### 🐛 Bug Fixes

- *(cockpit)* Cost totals say they are agents only and list price
- *(cockpit)* One cost check, and a debrief that survives absurd costs

### 📚 Documentation

- *(cockpit)* Describe the cost per agent

### 🧪 Testing

- *(tooling)* Tui-shot replay of the cost on agent rows
## [0.2.29] - 2026-11-21

### 🚀 Features

- *(cockpit)* Run report at Debrief

### 🐛 Bug Fixes

- *(cockpit)* A truer debrief: requested models, used tiers, redrafts and pauses
- *(cockpit)* Builds from before a redraft get their own debrief row

### 📚 Documentation

- *(cockpit)* Describe the Debrief report
## [0.2.28] - 2026-11-21

### 🚀 Features

- *(cockpit)* Strategium signal action for subagents
- *(agents)* Builders and reviewers signal their milestones

### 🐛 Bug Fixes

- *(cockpit)* A block clears on the next tool call and rings at most once a minute
- *(cockpit)* A block lasts until the agent signals again
- *(cockpit)* Every new block rings; docs say how a block is read and cleared

### 📚 Documentation

- *(cockpit)* Describe the signal action

### 🧪 Testing

- *(tooling)* Tui-shot replay of signalled and blocked rows
## [0.2.27] - 2026-11-21

### 🚀 Features

- *(tooling)* Port the tui-shot harness to TypeScript on Bun
- *(tooling)* Port the banner generator to TypeScript
- *(cockpit)* Live status under each deployed agent

### 🐛 Bug Fixes

- *(tooling)* Tui-shot workflow uses runner.temp only where allowed
- *(tooling)* The CI rerun takes PNGs of every snapshot
- *(tooling)* Tui-shot triggers on the cockpit's imports, with a summary table
- *(tooling)* Clearer failures in the Bun dev tools
- *(tooling)* Readable errors and more tests in the Bun dev tools
- *(cockpit)* Safer live status files and a stall before the first tool call
- *(cockpit)* No stall without a live row
- *(cockpit)* The overlay timer only reads the run; a redeploy ignores an old live file

### 📚 Documentation

- *(tooling)* Document the tui-shot CI job
- *(tooling)* Name the Bun dev tools
- *(cockpit)* Describe the live agent lines

### 🧪 Testing

- *(tooling)* Tui-shot replay of the live agent lines

### ⚙️ Miscellaneous Tasks

- *(tooling)* Run the tui-shot replays on a Windows runner
## [0.2.26] - 2026-11-21

### 🚀 Features

- *(skills)* Run rules as plugin rules that omp loads

### 🐛 Bug Fixes

- *(skills)* Tighter plan-copy condition, no rule repeated in SKILL.md
- *(skills)* Plan-copy condition without exponential backtracking

### 📚 Documentation

- *(skills)* SKILL.md links the run rules; rules/ ships with the plugin
## [0.2.25] - 2026-11-21

### 🚀 Features

- *(skills)* Check tiers, a timed baseline and flaky failures marked as known

### 📚 Documentation

- Check tiers, the timed baseline and deleted tests in the READMEs
- *(skills)* When the sonic runs, the single-command case, and a new flaky test still opens a penance
- *(skills)* A new flaky failure gets a finding ID and a fair reproduction
## [0.2.24] - 2026-11-21

### 🚀 Features

- *(skills)* Plan mode keeps a todo with only the plan stations

### 🐛 Bug Fixes

- *(skills)* A hand-off needs a finished plan todo; todo.ts refuses a flag as a station
- *(skills)* Decide the plan hand-off by station order

### 📚 Documentation

- *(skills)* Plan-mode todo, the fresh-session rebuild and the proposed plan
## [0.2.23] - 2026-11-21

### 🐛 Bug Fixes

- *(alarm)* Always play the bundled vox and report a failing run
- *(alarm)* Pass SystemDrive and the desktop audio variables to the child

### 📚 Documentation

- *(alarm)* The bundled vox plays, only the toggles remain

### 🧪 Testing

- *(alarm)* Restore the environment the childEnv test changes
## [0.2.22] - 2026-11-21

### 🚀 Features

- *(skills)* Seal Demo replaces seal UI, and a Contract section at seal Plan

### 📚 Documentation

- *(skills)* Agents run the Demo surface, and the Contract item covers waivers
- *(skills)* The Captain starts no server, the agent stops what it started

### 🧪 Testing

- Use the Demo seal name in cockpit tests and tui-shot replays
## [0.2.21] - 2026-11-21

### 🚀 Features

- *(cockpit)* Seal panel instead of the SEAL box, SEALS row as a chain

### 🐛 Bug Fixes

- *(cockpit)* Bound loaded seal lines and the footer seal name

### 📚 Documentation

- *(cockpit)* Describe the seal panel, the seal action and the SEALS chain

### 🧪 Testing

- *(tui-shot)* Seal-row follows the chain contract, new seal-panel replay
## [0.2.20] - 2026-11-21

### 🐛 Bug Fixes

- *(cockpit)* A rebuilt todo logs no station in the chronicle

### 🧪 Testing

- *(cockpit)* A rebuilt todo still logs a seal grant once
## [0.2.19] - 2026-11-21

### 🐛 Bug Fixes

- *(extension)* Move per-session settings off the old session id

### 🧪 Testing

- *(extension)* An unset setting does not move as a session value
## [0.2.18] - 2026-11-21

### 🚀 Features

- *(extension)* Per-commit seal as a /strategium-config setting

### 📚 Documentation

- Muster reads the commit setting instead of asking it
## [0.2.17] - 2026-11-21

### 🐛 Bug Fixes

- *(skills)* Correct five small text defects in Muster and the GitHub theatre
## [0.2.16] - 2026-11-21

### 🚀 Features

- *(cockpit)* Keep the cockpit state across an omp restart

### 🐛 Bug Fixes

- *(cockpit)* Validate saved chronicle entries and share the cap

### 🧪 Testing

- *(tooling)* Tui-shot replay that restarts omp with the cockpit open
## [0.2.15] - 2026-11-21

### 🚀 Features

- *(skills)* Plans give each squad a cost tier
- *(extension)* Route each battle-brother to its squad's tier

### 🐛 Bug Fixes

- *(extension)* Read squad builds as own keys only

### 📚 Documentation

- *(skills)* Tier brief in plan mode and the smol fallback wording
## [0.2.14] - 2026-11-21

### 🚀 Features

- *(skills)* A redraft re-plans from a refreshed map
- *(extension)* Redraft in both plan paths waits for a refresh scout

### 📚 Documentation

- *(skills)* Say what a deferred plan-mode redraft does not cover
## [0.2.13] - 2026-11-21

### 🚀 Features

- *(skills)* Plan mode walks the normal stations

### 🐛 Bug Fixes

- *(extension)* Keep the plan-mode station out of the fresh session's footer
- *(skills)* Defer plan-mode GitHub writes and place the baseline task

### 🧪 Testing

- *(extension)* Drop the unused stations parameter
## [0.2.12] - 2026-11-21

### 🚀 Features

- *(skills)* Orders replaces the Seals pseudo-seal

### 🐛 Bug Fixes

- *(skills)* Clarify the Orders ask and the split sizing step

### 🧪 Testing

- *(cockpit)* Prove the Muster Orders task is no seal
- *(cockpit)* Drop the Muster special case from the run helper
## [0.2.11] - 2026-11-21

### 🚀 Features

- *(alarm)* Metal kit with guitar, bass and double kick, and a configurable volume

### 🐛 Bug Fixes

- *(alarm)* Read STRATEGIUM_VOLUME with vox's own parser in the extension
## [0.2.10] - 2026-11-20

### 🚀 Features

- *(skills)* Review-and-merge loop after the PR as a Muster option

### 🐛 Bug Fixes

- *(skills)* Review & merge loop as a captain task, retrial routing, merge refusal
## [0.2.9] - 2026-11-20

### 📚 Documentation

- *(skills)* User tasks during a run go into the stations
## [0.2.8] - 2026-11-20

### 🚀 Features

- *(setup)* Warn when plan, slow or task model roles are unset
## [0.2.7] - 2026-11-20

### 🐛 Bug Fixes

- *(github-theatre)* See PRs already linked to the issue at Muster
- *(github-theatre)* Wire build on into branch and push, default by link kind
## [0.2.6] - 2026-11-20

### 🐛 Bug Fixes

- *(cockpit)* No-phase station title reads "no station yet"
## [0.2.5] - 2026-11-20

### 🐛 Bug Fixes

- *(cockpit)* Count async jobs as agent at work; VOX OPEN when the prompt is free

### 📚 Documentation

- *(readme)* Cockpit status counts background jobs; VOX OPEN line
## [0.2.4] - 2026-11-20

### 🚀 Features

- *(cockpit)* Themeable cockpit with blood-angels default

### 📚 Documentation

- Give the README a grimdark banner, badges and callouts
- Adopt a Blood Angels palette for the README assets
- Address the README review notes
- Describe the cockpit-theme setting
## [0.2.3] - 2026-11-19

### 🚀 Features

- *(github-theatre)* One card per piece of work, one useful issue comment

### 🐛 Bug Fixes

- *(github-theatre)* Gate issue-field writes on TRIAGE, name the missing-scope text

### 📚 Documentation

- *(readme)* Describe the GitHub theatre's single card and summary comment
## [0.2.2] - 2026-11-19

### 🐛 Bug Fixes

- *(agents)* Drop Fable from archmagos, give confessor a distinct fallback

### 📚 Documentation

- Explain the model roles Strategium uses; fix security-reviewer's model
- Recommended model config, checked by strategium-setup
- *(models)* Role suffixes override agent effort; fix review findings
- *(models)* Unset slow/smol inherit default with its effort suffix

### 🚜 Refactor

- *(agents)* Route every agent through omp role aliases

### ⚙️ Miscellaneous Tasks

- Move actions/checkout to v7.0.1 (Node 24)
## [0.2.1] - 2026-11-19

### 🚀 Features

- *(cockpit)* Configurable cockpit key with a conflict warning
- *(alarm)* Switch the alarm sound and the desktop toast separately

### 🐛 Bug Fixes

- *(cockpit)* End eval agents through their spawn key
- *(cockpit)* Tie deployed agents to the station name
- *(timer)* Keep counting a run that crosses midnight
- *(tui-shot)* Vendor xterm.js so shots and replays run offline
- *(cockpit)* Cap box lines so the chronicle stays visible

### 📚 Documentation

- *(github)* Map the Kanban template Status names
- *(skills)* Automatic releases and the manual fallback
- *(readme)* Describe automatic releases
- State what bumps the version

### ⚙️ Miscellaneous Tasks

- *(release)* Cut a release on every merge to main
- *(release)* Install git-cliff from its checksummed binary and finish a missing release first
## [0.2.0] - 2026-11-18

### 🚀 Features

- First version of the Strategium plugin
- The run can go back, with a trigger, a target and a budget
- Work any objective, and make the booking timer optional
- The footer shows the station the run is at
- Todo.ts builds the run's todo, with plain or glyph tags
- *(alarm)* Add a 15 s theme level to the vox-caster
- *(todo)* Give the captain a crowned shield glyph
- *(extension)* Enforce the Captain's limits during a run
- Strategium-release skill (SemVer tags, git-cliff changelog)
- /strategium-* commands and switchable notifications
- *(slices)* Clearer overlap errors and tracking of stopped slices
- Show a load line when a session starts
- The run follows an approved plan into its new session
- *(timer)* Pause the clock after N idle minutes and resume on the next turn
- *(footer)* Show the active todo task next to the station
- *(skill)* Leaner apothecary, Muster in five tasks and per-area librarians
- *(strategium)* Archmagos setting, run mark and spawn guards
- *(todo)* Archmagos agent tag with the md-head_cog glyph
- *(agents)* Add the Archmagos Dominus planner
- *(agents)* Add the confessor, a second reviewer from another model family
- *(agents)* Penance reproduces findings first, property tests and a fuzz pass
- *(skill)* Rename Rally to Penance and wire the confessor, properties and fuzz
- *(strategium)* /strategium begins the run at once and a later booking is recorded
- *(skill)* Visible two-task Muster with a skeleton todo and a muster record
- *(cockpit)* Pure cockpit view, seals, chronicle and renderers
- *(cockpit)* Live widget, overlay, /strategium-cockpit and Alt+C
- *(cockpit)* Opt-in widget and a clock that follows a later booking
- *(cockpit)* Drop the widget and show only the active station
- *(cockpit)* Full-screen cockpit with agent status and footer hint
- *(alarm)* Original grimdark synth kit for every vox level
- *(alarm)* 50, 80 and 100 build on each other; attention is a horn call
- *(strategium)* Kickoff tells a missing theatre from an explicit none
- *(skills)* GitHub theatre, the default ticketing for GitHub repos

### 🐛 Bug Fixes

- Harden the state, the claims and the edit guard
- The edit guard sees every contract, and a block that crosses midnight
- A block closes in the day it started, and the state dir is read on every use
- *(alarm)* Key the vox WAV cache by the synthesizer source
- *(todo)* Take glyph tags from STRATEGIUM_GLYPHS
- Retry the run file rename while Windows holds it
- Move the run on the order omp really sends approval events
- *(apothecary)* Work only in the Captain's clone when isolation is off
- *(apothecary)* Refuse a clone path that is the workspace or outside $TEMP
- *(strategium)* Refuse redraft before the run's first archmagos
- *(cockpit)* Full-width chronicle, aligned boxes, Archmagos box and Nerd seal glyphs

### 📚 Documentation

- Package the plugin for omp (README, gitignore, marketplace catalog)
- Fill the empty table headers in the README
- Spanish README, run diagram and the fixes the audit found in the docs
- The timer reports the highest threshold crossed
- Rename the stations so each one names its own trade
- Keep Deployment for the station that puts the slices in position
- Give the returns names of their own
- Name no faction in the skill, and say it as the README says it
- Palimpsest becomes Redraft
- Strategium is a workflow, and ticketing is an option of it
- Describe omp isolation, the Captain's limits and scoped retrials
- *(skill)* Plan-mode flow for the plan seal
- Call the plan's units of work squads
- Describe the idle pause and STRATEGIUM_IDLE_MIN
- Link omp in Install and add a copy-paste setup prompt
- Penance, the confessor and a detailed workflow diagram
- A shorter, styled workflow diagram
- Draw the returns next to their table
- Call the Muster seal what it is
- *(readme)* Vertical going-back diagram
- Describe the cockpit
- Describe the opt-in cockpit widget and the Archmagos box
- Describe the station view and drop the widget
- *(cockpit)* Warn about stuck dialogs and Alt+C with Caps Lock
- *(readme)* Straight orthogonal edges in the going-back diagram
- *(readme)* Flowchart symbols and returns in the run diagram
- *(readme)* Drop the going-back diagram, the run diagram shows the returns
- *(readme)* Explain each agent's job and limit
- *(readme)* Agent icons from Material Design Icons
- Describe the GitHub theatre and its default rule

### 🚜 Refactor

- *(footer)* Split tick into renderFooter and maybeAlert

### 🧪 Testing

- Pin the rules behind the numbers and cover the state machine
- *(footer)* Pin the booking alert and paused footers
- Ignore the user's default theatre
- Cover the plan-approval move, the edit guard and slice tracking

### ⚙️ Miscellaneous Tasks

- Run bun test on GitHub Actions
- *(dev)* Tui-shot harness and dev skill to screenshot real omp
- *(dev)* Replay scenarios for past cockpit regressions

### 💼 Other

- Strict typecheck with bun run check, also in CI
