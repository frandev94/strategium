# Models

Strategium agents pick their model through omp's role aliases. You choose the models once in `~/.omp/agent/config.yml` and Strategium follows; each agent sets its own effort in its definition (`agents/*.md`, `thinkingLevel`).

## How omp picks the effort

For a subagent omp takes the first of:

1. the `effort` hint of the task call (only with `task.enableEffort`, off by default);
2. a `:level` suffix on the role the agent resolves through (`plan: anthropic/claude-opus-5-5:xhigh`);
3. the agent's own `thinkingLevel`.

So **a suffix on `plan`, `task` or `smol` overrides every agent that uses that role.** Leave those roles without a suffix and each agent runs at the level it was tuned for. `slow` can keep `:high`: it matches the inquisitor and is the only level omp's bundled `reviewer` gets (it declares none).

`task.maxEffort` does not cap an agent's `thinkingLevel` or a role suffix: it only bounds the per-call `effort` hint and per-call models. To cap `auto` thinking, use `providers.autoThinkingMaxEffort`.

## Recommended config (Anthropic account)

```yaml
modelRoles:
  default: anthropic/claude-opus-5-5:medium   # main session, the Captain
  slow: anthropic/claude-opus-5-5:high        # inquisitor, omp's bundled reviewer
  plan: anthropic/claude-opus-5-5             # librarian, archmagos, plan mode
  task: anthropic/claude-sonnet-5-5           # battle-brother, veteran, apothecary, confessor without Codex
  smol: anthropic/claude-haiku-5-5            # scout, sonic
  tiny: anthropic/claude-haiku-5-5:low        # session titles, memory
  widget: anthropic/claude-haiku-5-5:low      # background-job widgets
  commit: anthropic/claude-haiku-5-5:medium   # commit messages and changelogs
  advisor: anthropic/claude-sonnet-5-5:medium
  vision: anthropic/claude-sonnet-5-5:medium
task:
  isolation:
    enabled: true
    merge: branch
```

Why, from Anthropic's [effort guide](https://platform.claude.com/docs/en/build-with-claude/effort):

- **Opus 5.5 at `medium`** for the main session: it is the model's default.
- **Sonnet 5.5 for the implementers:** Anthropic suggests `medium` for well-specified agentic tasks and `high` for longer or harder ones, which is what `battle-brother` and `veteran` ask for.
- **Haiku 5.5:** `low` for short, high-volume requests (titles, widgets); `medium` for agent work, because at `low` Haiku is more likely to skip a search or a check in long agent prompts, so `scout` and `sonic` ask for `medium`.
- **`xhigh` only for the Archmagos:** Anthropic aims `xhigh` at long-running agentic work.
- **No `max`, no Fable by default:** Anthropic reserves `max` for measuring a model's ceiling, "often for only a small gain" over `xhigh`.

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

Effort as listed holds only while the role resolves without a suffix (see above); an unset `slow` or `smol` inherits `default` together with its suffix. The confessor wants a different model family from the inquisitor; without a Codex credential `@task` keeps it at least a different model.

## When a role is unset

| Role | omp falls back to |
|---|---|
| `slow` | your configured `default`, with its `:level` suffix (the recommended `default` would run the inquisitor at `medium`); with neither, omp's slow list: `gpt-5.6-sol` with a Codex login, else Fable 5.2 before Opus 5.5 |
| `plan` | no list of its own; the session's model |
| `task` | the session's model |
| `smol` | your configured `default`, with its `:level` suffix (scout and sonic would run on Opus); with neither, omp's fast list (Haiku 5.5 first) |

Set at least `plan`, `slow` and `task`, or Strategium may run on models you did not pick.

## Overrides

- One agent on another model: `task.agentModelOverrides`, e.g. `inquisitor: anthropic/claude-sonnet-5-5`. It wins over the agent's `model` list.
- Cheaper Archmagos: leave `STRATEGIUM_ARCHMAGOS` off (the default), or give it its own model in `task.agentModelOverrides`.

## Open questions

- Whether `openai-codex/gpt-6-astra` is still a valid id.
