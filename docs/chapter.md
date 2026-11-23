# The Chapter: how Strategium's roster maps to the Codex Astartes

Strategium borrows its names from the Warhammer 40,000 Codex Astartes. This is a lore adaptation, not a simulation: where the lore and the workflow disagree, the workflow wins and the difference is written down here. Agent ids, environment variables, settings, commands, theme values and station names are a contract and never change to fit the lore. This file is the single source for the terms. The READMEs, the agent definitions and the skills repeat them and link here. Technical output (issues, pull requests, commits, reports, errors, the plan file) stays plain.

## Rank, department, role

Three separate ideas, never merged into one word:

- Rank is a place in the hierarchy (Captain, Battle-Brother, Neophyte).
- Department is organisational membership (Librarius, Apothecarion, 10th Company), or an external organisation when the agent is not part of the Chapter.
- Role is what the agent does in Strategium (writes the spec, builds a squad, reviews).

Membership, command and workflow delegation are different things. A librarian belongs to the Librarius, yet the Captain is the one that delegates its work. The cockpit groups agents by station, which is workflow, not hierarchy. A box in the cockpit says nothing about rank or department.

## Command

- Chapter Master: you. The only one who grants seals. Seals and their mechanics are unchanged.
- Captain: the main omp session. It sits on Chapter Command and commands the run's company: it plans, delegates, runs the stations and asks for the seals. It never edits product code.

The Chapter Master also belongs to Chapter Command.

## Chain of command

The Codex chain, from the top: Chapter Master, Captain, Lieutenant, Sergeant, Battle-Brother, Neophyte. Aspirants are candidates who are not yet Space Marines.

| Rank | Used by Strategium | Note |
|---|---|---|
| Chapter Master | yes, the user | grants every seal |
| Captain | yes, the main session | commands the run |
| Lieutenant | no | the "lead" librarian is a role (it merges area plans), not a Lieutenant |
| Sergeant | no | a squad is a unit of planned work with files and an acceptance check. Its orders come from the Captain and one battle-brother at a time builds it, so there is nobody to lead it |
| Battle-Brother | yes | `battle-brother`, and `veteran` as a battle-brother of long service |
| Neophyte | yes | the `scout`, a Scout of the 10th Company |
| Aspirant | no | a candidate, not yet a Space Marine. No agent is a candidate |

No new agents are added to fill unused ranks.

## Departments

| Department | In the lore | In Strategium |
|---|---|---|
| Chapter Command | the Chapter Master and the officers around him | you and the Captain. No agent file |
| 1st Company | the Veterans, Battle-Brothers of long service | `veteran` rebuilds a squad that failed twice. Veteran status grants no Ancient or Venerable title (see Honorifics and posts) |
| Battle and reserve companies (2nd to 9th) | the fighting and reserve companies of Battle-Brothers | `battle-brother` builds a squad test-first |
| Librarius | the Librarians, psykers, who also keep the Chapter's archives | `librarian` writes the spec, the squads and the Merge bar. Spec writing borrows the archive-keeping side |
| Apothecarion | the Apothecaries, who tend the battle-brothers and the gene-seed | `apothecary` runs mutation tests and fuzzing on a squad's changed lines. Here it probes the tests' wounds. Gene-seed is not modelled |
| Armoury | the Techmarines under the Master of the Forge, who maintain the arms, the servitors and the Dreadnoughts | no agent. See Auxiliaries and other entities |
| Reclusiam | the Chaplains, who keep the Chapter's faith | no agent. The Chaplain is the Astartes counterpart of the confessor, and is not used because the id `confessor` is a contract |
| 10th Company | the Scouts, neophytes in training | the bundled `scout`, read-only code reconnaissance. It is not a Vanguard Space Marine: Vanguard are fully initiated Battle-Brothers. The bundled agent cannot be renamed |
| Chapter Serfs | the mortal staff of the Chapter | the omp `task` agent, general delegated work |
| Chapter Fleet | the Chapter's ships | the workflow infrastructure: omp, git branches, isolated checkouts, CI. It has no agent |

## External organisations

These belong to the wider Imperium, work with the Chapter and sit outside its chain of command. They are never shown inside it.

- Adeptus Mechanicus: `archmagos`, an Archmagos Dominus. Not an Astartes rank. It integrates the area plans, and only when a run is marked for it. A Master of the Forge would be the internal alternative; it is not used because ids are a contract.
- Inquisition: `inquisitor` and `security-reviewer`. An outside authority reviews the Chapter's work. The inquisitor reviews against the Merge bar. The security-reviewer is an Inquisitorial auditor, a thematic adaptation, called when auth, secrets, network or external input change. The bundled agent cannot be renamed.
- Ecclesiarchy (Adeptus Ministorum): `confessor`. A Ministorum title, not an Astartes rank. It does a second review with a model of another family.
- Adeptus Custodes: not used by any agent. Custodians belong to this organisation, not to the Chapter, so the name is kept free.

## Roster

One row per agent id.

| id | Lore identity | Rank | Department / organisation | Strategium role | Adaptation note |
|---|---|---|---|---|---|
| (the user) | Chapter Master | Chapter Master | Chapter Command | grants every seal | none |
| (main session) | Captain | Captain | Chapter Command | plans, delegates, runs stations and seals; never edits product code | none |
| `scout` (bundled omp) | Scout of the 10th Company | Neophyte | 10th Company | read-only code reconnaissance | not a Vanguard Space Marine (Vanguard are fully initiated Battle-Brothers); the bundled agent cannot be renamed |
| `librarian` | Librarian of the Librarius | Librarian (specialist) | Librarius | writes spec, squads, Merge bar | thematic adaptation: Librarians are psykers. The Librarius also keeps the Chapter's archives, and spec writing borrows that role. A Chapter Scribe identity was considered and not taken, because ids are a contract |
| `archmagos` | Archmagos Dominus | Mechanicus rank, not an Astartes rank | Adeptus Mechanicus (external) | integrates the area plans, only when marked | Thematic adaptation: an external specialist working with the Chapter, keeps the id. A Master of the Forge would be the internal alternative; it is not used because ids are a contract |
| `battle-brother` | Battle-Brother | Battle-Brother | battle company | builds one squad test-first | none |
| `veteran` | Veteran Battle-Brother | Battle-Brother (veteran) | 1st Company (Veterans) | rebuilds a squad that failed twice | veteran status grants no Ancient or Venerable title |
| `apothecary` | Apothecary | Apothecary (specialist) | Apothecarion | mutation tests and fuzzing of a squad's changed lines | thematic adaptation: Apothecaries tend battle-brothers and the gene-seed; here they probe the tests' wounds. Gene-seed is not modelled |
| `inquisitor` | Inquisitor | Inquisitorial authority, outside the Chapter | Inquisition (external) | independent review against the Merge bar | thematic adaptation: the review of the Chapter's work by an outside authority |
| `confessor` | Confessor | Ministorum title, not an Astartes rank | Ecclesiarchy (external) | second review by another model family | thematic adaptation: second-model review. The Chaplain (Reclusiam) is the Astartes counterpart, and it is not used because the id `confessor` is a contract |
| `security-reviewer` (bundled omp) | Inquisitorial auditor | none (not a Chapter rank) | Inquisition (external) | security review when auth, secrets, network or external input change | thematic adaptation: the Inquisition's auditor; the bundled agent cannot be renamed |
| `sonic` (bundled omp) | Servitor | none (auxiliary) | auxiliary maintained by the Armoury | runs the repo's predefined full checks | a servitor runs predefined tasks; the bundled agent cannot be renamed |
| `task` (omp) | Adept, a Chapter Serf | none (auxiliary) | Chapter Serfs | general delegated work | Thematic adaptation: "Adept" is an Administratum/Mechanicus term, used here for a serf of the Chapter's own staff, unrelated to the Adeptus Mechanicus. The cockpit box `ADEPTS` keeps its label |

## Auxiliaries and other entities

None of these is an agent unless the roster says so.

- Servitors: mind-scrubbed humans, cybernetically altered to run predefined tasks. `sonic` is the one servitor in Strategium.
- Servo-skulls: small floating monitoring devices. The booking timer is the servo-skull (`Timer (servo-skull, ticketing only)` in the strategium skill). It is a monitor, not an agent. It is not `sonic`.
- Techmarines and the Master of the Forge: the Armoury's engineers and their head. Documented for the Armoury, not used by any agent.
- Dreadnoughts: entombed heroes in walking war machines, the usual bearers of the honorific Venerable (see Honorifics and posts). Never used as a generic name for ordinary agents.
- Chapter Fleet: the workflow infrastructure described under Departments.

## Agent names

With `STRATEGIUM_NAMES` on, the plugin gives every agent a name for the run: a title plus a surname (`BrotherLorenzo`, `PenitentLorenzo`, `VeteranLorenzo`). This section is the single source of the terms. The `strategium name` action hands them out; the ids in the roster do not change.

| Agent | Title | Note |
|---|---|---|
| `battle-brother` | Brother, then Penitent | Brother is a squad's first builder; once one has spawned, the next builder of that squad (its penance) is Penitent. The squad keeps one surname for the run |
| `veteran` | Veteran | same surname as its squad |
| `librarian` | Librarian | |
| `archmagos` | Archmagos | |
| `scout` | Scout | |
| `inquisitor` | Inquisitor | |
| `confessor` | Confessor | |
| `apothecary` | Apothecary | |
| `security-reviewer` | Interrogator | an Inquisition rank, used here for the auditor's name |
| `sonic` | Servitor | the designation is two capital letters and a number, `ServitorKX7`: the only names with digits |
| `task` | Adept | the Chapter Serf above |

- Penitent: a Battle-Brother doing penance for a failed squad. It is not a rank.
- A surname belongs to one squad or one role in a run; a taken name gets an epithet (`InquisitorEisenhornSteadfast`). A name is at most 28 characters, so omp's `-N` suffix keeps the id within 32.
- A redraft retires the old builder names; the re-planned squads get new surnames.

## Service record and honours

With `STRATEGIUM_NAMES` on, each builder surname (the `Lorenzo` of `BrotherLorenzo`, `PenitentLorenzo` and `VeteranLorenzo`) is one Battle-Brother with a service record. Every builder of a squad serves under that squad's surname, so the squad's outcome goes to one record. Other roles (librarian, inquisitor and so on) keep no record. With names off nothing is recorded.

The record is filled only from what the plugin observes, and is written when the run ends:

| Event | Effect |
|---|---|
| Squad passes on the first build | +1 passed, Purity Seal |
| Squad passes after a penance | +1 passed, no honour |
| Squad saved by the veteran | +2 passed, Iron Halo |
| Each fix round | +1 penance |
| Squad ends failed (the veteran failed, or a builder failed with no later builder), or its latest builder is rated `corrupted` | +1 fall |
| Every squad with an outcome | +1 squad served |
| Run merged, every squad passed on the first build | Laurel Imperialis to every brother with an outcome in the run |
| 10 passed | Crux Terminatus |

- Reading: the plugin sees the agent's job status, not the reviewers' verdict, so a builder that returns `completed` counts as passed and only `failed` is a fall, unless the Captain rated that builder `corrupted` with the `rate` action: then the squad is a fall at `end`, whatever its job status (a corrupted builder is corrupted for the rest of the run). Only the squad's latest builder that a redraft has not retired decides: a corrupted first builder followed by a penance that is not corrupted stays a penance (round 1 failing is what a penance is), and a `redraft` retires the squads' builders, so their corruption no longer reaches the record. `proven` and `proven-regression` ratings change nothing, and neither does a rating on any agent that is not a builder. A builder that ends `aborted` or `cancelled` is neither: the squad is left with no outcome (and records nothing) until a later builder ends it. A veteran is an escalation, not a penance. A squad still running or never built records nothing.
- Laurel: the merge counts only when the Captain's own command succeeds and starts, after any `cd … &&` steps, with `gh pr merge` or `glab mr merge`. A command with `--auto`, `--help` or `-h`, one with a pipe, `;`, a newline or a lone `&` (the exit code would not be the merge's; `&&` and `2>&1` are fine), an `echo`, one a subagent ran, and one that went to the background (a result with an `async` detail, whatever started it) earn no Laurel. A merge done elsewhere (the web page, another tool) earns none. Limit: a merge that only schedules (glab auto-merge, a merge queue) still counts, because the plugin sees only that the command succeeded. A merge while a spawned builder has not finished earns none either.
- Honours are decorations, not ranks, titles or posts, and a name never changes with them. They are counters that only grow: nothing removes one, and Crux Terminatus is read from the passed count.
- Corrupted: a brother with 3 falls, or with more penances than passes after 5 squads served, is corrupted and kept in reserve. It is read from the counters, never stored, and it only decides who is sent: the honours stay.
- On campaign: a brother whose squad sits in another session's open run is on campaign. He is released when that run ends or is redrafted, when its claim is gone, or when the run has been silent for 24 h (neither its heartbeat nor its run file touched). A paused run may not beat, so a short pause keeps its brothers, but a run abandoned for a day does not hold them for ever.
- Allocation: a new squad's surname goes to the best available brother (most passed, then fewest falls, then fewest penances, then name order), skipping the corrupted and those on campaign. A name from the pool nobody has recorded is recruited only when no such brother is left. A ranked brother whose bare name was already issued in this omp process (an earlier run of the session) comes back with an epithet (`BrotherLorenzoUnbroken`), and the preference holds in the pool-exhausted second pass too. With every pool name skipped the run gets the usual "no free name" error. A reused brother (`strategium name` with `source`) keeps his surname in the squad he joins; the squad's outcome stays with its first brother.
- Roster: the records live in one file, `roster.json` in the state directory, shared by every omp session and guarded by a lock (`roster.lock`), so two sessions allocating or ending at once never take the same brother and lose no result. A file the plugin cannot read is left untouched, with a warning, and names come from the pool.
- Lock: the lock holds its owner's pid. A lock whose process is gone is taken at once; any other lock older than 10 s is taken as stale. A busy lock at allocation (waited 2 s) gives names from the pool with a `WARN roster busy`. The end waits 12 s, longer than the stale age, because it has no second chance: if the roster is still busy then, that run's record is lost, with a `WARN ROSTER not written`, and the end goes on. The record is written before the run's claim is released.
- Takeover: a `begin` takeover drops the old run, so its record is lost; end it with `end` plus takeover first if it should count.

Where it shows (names on; with names off none of it appears):

- Cockpit squad row: the builder's name, then the badges, then the squad: `† PenitentLorenzo ✠4 ☉1 ❦1 · squad alpha forging`. A counter shows only from 1 up, in the order Purity Seal `✠`, Iron Halo `☉`, Laurel Imperialis `❦` (each glyph then its count), then Crux Terminatus `✚` (no count). With `STRATEGIUM_GLYPHS=1` the glyphs are Nerd Font ones, written glyph, space, count. A recruit with no record shows no badge. A corrupted brother is not allocated, so he is normally not on a live row; one can still be there when the roster could not be read at allocation, and his detail then shows `corrupted: kept in reserve`.
- Cockpit detail of a squad: `brother:`, `record:` (passed, penances, falls, squads), `honours:` and, when it applies, `corrupted: kept in reserve`.
- Chronicle: a deployed agent is written by name (`† BrotherLorenzo deployed`, `✓ BrotherLorenzo returned`).
- `end` result and debrief: a `HONOURS …` line in the result and an `## Honours` section in the debrief, with who joins the roster, earns an honour, falls or is corrupted.
- When: the record only changes at `end`, so the honours lines are made then. They go to the debrief and the `end` result, not to the live chronicle, because the cockpit closes at the same `end`.

## Stations and the chronicle voice

Station names are unchanged. One line each:

- Muster: the run is gathered: the ticket is read, the options are chosen and the seals are asked for.
- Auspex: scouts survey the code and report back.
- Scriptorium: the librarian writes the spec, the squads and the Merge bar.
- Deployment: the squads are issued and the run is prepared for them.
- Skirmish: battle-brothers build the squads test-first, with retrials and escalation to a veteran.
- Inquisition: the independent reviews and the checks against the Merge bar.
- Extraction: the work is delivered and the pull request is prepared.
- Debrief: the run is summed up and its report is written.

The Inquisition station also hosts the confessor (in the same batch as the inquisitor), `sonic` and `task`; none of them is part of the Inquisition. The inquisitor and confessor return in Extraction for the Review & merge loop. Stations are workflow, not organisation. `STRATEGOS` is the project's own word, not Codex lore: it is the voice of the chronicle, the log of the Strategium, the command bridge. It is a label of the plugin, not a rank and not an agent.

## Cockpit themes

`blood-angels`, `ultramarines`, `dark-angels` and `cogitator` are colour schemes only. They change no rank, department, label or term. The default theme is `blood-angels`, a palette only. It carries no term specific to any one Chapter.

## Honorifics and posts

No agent holds either today. They are defined here so that a later use (#62) has a lawful path.

- Ancient: a post, not a rank. The Ancient is the standard-bearer of a company (the Chapter Ancient is of the 1st) and is a post held by a veteran. It is not earned by service, and a veteran does not become an Ancient by being a veteran.
- Venerable: an honorific, not a rank and not a post. In the lore it is given mostly to Dreadnoughts, the entombed heroes. It is never a promotion for an ordinary agent.
- Honours (Purity Seal, Iron Halo, Laurel Imperialis, Crux Terminatus; see Service record and honours) are none of the three: they are decorations on a brother's record. They change no name, rank, title or post.

## Using these terms

- Ranks, honorifics (Venerable) and posts (Ancient) never mix. A rank is a rank, an honorific is a title earned, a post is a job held (#62).
- A veteran stays a Battle-Brother (#32).
- Role titles follow the roster: `security-reviewer` is not a Custodian, `confessor` is not a Chaplain, and the `veteran` agent is not an Ancient.
- Tiers belong to squads, not to ranks (#33).
- A cockpit may show rank and department, kept apart from workflow (#13, #16).
- The Debrief may use these terms (#24).
- Lore never replaces plain technical text.

## Future Chapter profiles

Documentation of a future extension point only. Nothing here is implemented, and no default uses these terms. A profile would swap the organisation's names for those of one Chapter, without touching ids, commands, settings or stations.

- Ultramarines: the Codex organisation as described above, the baseline.
- Iron Hands: the Iron Fathers.
- Dark Angels: the Inner Circle.
- Space Wolves: the Great Companies and the Wolf Lords.
- Black Templars: the Marshals and the Castellans.
