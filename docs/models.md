# Models

Strategium agents pick their model through omp's role aliases. You choose the models once in `~/.omp/agent/config.yml` and Strategium follows; the effort each agent asks for lives in its own definition (`agents/*.md`).

## Recommended config (Anthropic account)

```yaml
modelRoles:
  default: anthropic/claude-opus-5-5:medium   # main session, the Captain
  slow: anthropic/claude-opus-5-5:high        # inquisitor, omp's bundled reviewer
  plan: "@slow:xhigh"                         # librarian, archmagos, plan mode
  task: anthropic/claude-sonnet-5-5:auto      # battle-brother, veteran, apothecary, confessor without Codex
  advisor: anthropic/claude-sonnet-5-5:medium
  vision: anthropic/claude-sonnet-5-5:medium
  commit: anthropic/claude-haiku-5-5:medium   # commit messages and changelogs
  smol: anthropic/claude-haiku-5-5:low        # scout, sonic, titles, memory
task:
  maxEffort: high                             # effort ceiling for subagents
  isolation:
    enabled: true
    merge: branch
```

Why these levels, from Anthropic's [effort guide](https://platform.claude.com/docs/en/build-with-claude/effort):

- **Opus 5.5 at `medium`** is its default, and matches or beats Opus 5 at `high`. `high` for `slow` is the level Anthropic gives for work where verification matters.
- **`xhigh` only for planning.** Anthropic aims `xhigh` at long agentic work; a plan is where extra thinking pays most, because a bad plan is redone downstream. `"@slow:xhigh"` follows `slow`'s model with its own effort.
- **Sonnet 5.5 for subagents:** `medium` for well-specified agentic tasks, `high` for long or hard ones; `auto` lets omp pick per task, capped by `task.maxEffort`.
- **Haiku 5.5:** `low` for short tool tasks, `medium` for writing (commits, changelogs).
- **No `max`, no Fable by default.** Anthropic reserves `max` for measuring a model's ceiling, "often for only a small gain"; Fable is the costliest model per token.

## What each agent uses

| Agent | Model | Effort |
|---|---|---|
| Captain | the session's model (`default`) | the session's |
| `scout`, `sonic` | `@smol` | medium |
| `librarian` | `@plan` | high |
| `archmagos` | `@plan` | xhigh |
| `battle-brother`, `apothecary` | `@task` | medium |
| `veteran` | `@task` | high |
| `inquisitor` | `@slow` | high |
| `confessor` | `openai-codex/gpt-6-astra`, else `@task` | high |
| `security-reviewer` (omp) | the session's model | not set |

The confessor wants a different model family from the inquisitor; without a Codex credential `@task` keeps it at least a different model.

## When a role is unset

| Role | omp falls back to |
|---|---|
| `slow` | a configured `default`, else omp's slow priority list, which puts Fable 5.2 before Opus 5.5 |
| `plan` | no list of its own; the session's model |
| `task` | the session's model |
| `smol` | a configured `default`, else omp's fast list (Haiku 5.5 first) |

Set at least `plan`, `slow` and `task`, or Strategium may run on models you did not pick.

## Overrides

- One agent on another model: `task.agentModelOverrides`, e.g. `inquisitor: anthropic/claude-sonnet-5-5`. It wins over the agent's `model` list.
- Cheaper planning: `plan: "@slow"` (Opus at `high`).

## Open questions

- Whether `task.maxEffort` also caps an agent's own `thinkingLevel`. If it does, `high` keeps the archmagos at `high`; set `xhigh` to let it reach `xhigh`.
- Which effort wins when an agent's `thinkingLevel` differs from its role's suffix (e.g. the librarian's `high` against `plan: "@slow:xhigh"`). Check the running agents in Agent Hub (`Alt+A`).
