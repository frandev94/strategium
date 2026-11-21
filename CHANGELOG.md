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
