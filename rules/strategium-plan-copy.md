---
description: "Strategium run: fires when a bash command copies an agent output with cp; plan outputs are saved with cat."
condition: '(?:^|\\n|[\s;&|("])cp\s+(?:-\S+\s+(?:\S+\s+)?)*["'']?agent://'
scope: tool:bash
agents: [main]
---

While a Strategium run is open, never copy an agent's output with `cp`, and never retype it.

Save an agent's plan output byte-for-byte with `cat agent://<id> > local://<KEY>-plan.md` (or `local://<KEY>-plan-<area>.md`).
