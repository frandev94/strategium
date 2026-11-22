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
| Battle companies (2nd to 5th) | the fighting companies of Battle-Brothers | `battle-brother` builds a squad test-first |
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
| `archmagos` | Archmagos Dominus | Mechanicus rank, not an Astartes rank | Adeptus Mechanicus (external) | integrates the area plans, only when marked | external specialist working with the Chapter, keeps the id. A Master of the Forge would be the internal alternative; it is not used because ids are a contract |
| `battle-brother` | Battle-Brother | Battle-Brother | battle company | builds one squad test-first | none |
| `veteran` | Veteran Battle-Brother | Battle-Brother (veteran) | 1st Company (Veterans) | rebuilds a squad that failed twice | veteran status grants no Ancient or Venerable title |
| `apothecary` | Apothecary | Apothecary (specialist) | Apothecarion | mutation tests and fuzzing of a squad's changed lines | thematic adaptation: Apothecaries tend battle-brothers and the gene-seed; here they probe the tests' wounds. Gene-seed is not modelled |
| `inquisitor` | Inquisitor | Inquisitorial authority, outside the Chapter | Inquisition (external) | independent review against the Merge bar | thematic adaptation: the review of the Chapter's work by an outside authority |
| `confessor` | Confessor | Ministorum title, not an Astartes rank | Ecclesiarchy (external) | second review by another model family | thematic adaptation: second-model review. The Chaplain (Reclusiam) is the Astartes counterpart, and it is not used because the id `confessor` is a contract |
| `security-reviewer` (bundled omp) | Inquisitorial auditor | none (not a Chapter rank) | Inquisition (external) | security review when auth, secrets, network or external input change | thematic adaptation: the Inquisition's auditor; the bundled agent cannot be renamed |
| `sonic` (bundled omp) | Servitor | none (auxiliary) | auxiliary maintained by the Armoury | runs the repo's predefined full checks | a servitor runs predefined tasks; the bundled agent cannot be renamed |
| `task` (omp) | Adept, a Chapter Serf | none (auxiliary) | Chapter Serfs | general delegated work | "Adept" here means a serf of the Chapter's own staff, unrelated to the Adeptus Mechanicus. The cockpit box `ADEPTS` keeps its label |

## Auxiliaries and other entities

None of these is an agent unless the roster says so.

- Servitors: mindless machine-servants that run predefined tasks. `sonic` is the one servitor in Strategium.
- Servo-skulls: small floating monitoring devices. The booking timer is the servo-skull (`Timer (servo-skull, ticketing only)` in the strategium skill). It is a monitor, not an agent. It is not `sonic`.
- Techmarines and the Master of the Forge: the Armoury's engineers and their head. Documented for the Armoury, not used by any agent.
- Dreadnoughts: entombed heroes in walking war machines, the usual bearers of the honorific Venerable (see Honorifics and posts). Never used as a generic name for ordinary agents.
- Chapter Fleet: the workflow infrastructure described under Departments.

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

The Inquisition station also hosts the confessor and `sonic`, which are not in the Inquisition: stations are workflow, not organisation. `STRATEGOS` is the project's own word, not Codex lore: it is the voice of the chronicle, the log of the Strategium, the command bridge. It is not a rank and not an agent.

## Cockpit themes

`blood-angels`, `ultramarines`, `dark-angels` and `cogitator` are colour schemes only. They change no rank, department, label or term. The default carries no term specific to any one Chapter.

## Honorifics and posts

No agent holds either today. They are defined here so that a later use (#62) has a lawful path.

- Ancient: a post, not a rank. The Ancient is the standard-bearer of the 1st Company and is a veteran. The Captain assigns it to a veteran for a task; it is not earned by service, and a veteran does not become an Ancient by being a veteran.
- Venerable: an honorific, not a rank and not a post. In the lore it is given mostly to Dreadnoughts, the entombed heroes. It is never a promotion for an ordinary agent.

## Using these terms

- Ranks, honorifics (Venerable) and posts (Ancient) never mix. A rank is a rank, an honorific is a title earned, a post is a job held (#62).
- A veteran stays a Battle-Brother (#32).
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
