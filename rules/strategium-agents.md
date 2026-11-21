---
description: "Strategium run: read before briefing, choosing or waiting on agents; reviewers, briefs, heavy checks and progress numbers."
agents: [main]
---

# Agents

These rules apply while a Strategium run is open.

- Never use agents with edit tools as reviewers (e.g. plugin `code-reviewer`, `test-engineer`, `security-auditor`).
- Custom agents autoload their skills. Every brief still names any extra skill to READ (`Read skill://<name> first and follow it`) and asks for a final `Skills used` section.
- Heavy checks (full test suites, e2e, builds) run in one worktree one agent at a time; the Captain serializes them. Before an agent waits on a lock, check who holds it: an agent waiting on a lock looks stalled in `proc://`.
- `proc://` progress percentages are self-reported by the agent, not measured. Judge progress by its reports and files, not the number.
