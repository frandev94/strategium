---
name: strategium-study
description: Use for the Strategium study notes (change walkthrough) of a finished ticket branch, so the user can understand and defend AI-generated changes in review; read-only.
---

# Strategium study notes

Act as a senior mentor and reviewer. Input: ticket key and title, diff range (e.g. `origin/main..HEAD`), output file (e.g. `local://<KEY>-study.md`). Goal: the user understands the change and can defend it in review, not only that it works.

1. **Summary:** what problem the change solves and how, in 5 lines.
2. **Commit walkthrough:** what each commit does, why this way, which alternative was dropped.
3. **Critical points:** the 3-5 hardest or riskiest parts (concurrency, API contracts, migrations, edge cases) with `file:line`.
4. **Check questions:** 5 questions the user should be able to answer in a review. Answers in a collapsed section at the end, so the user can try first.
5. **Risks and gaps:** what the tests do not cover, what could break in the real environment, what a demanding reviewer would ask.
6. **To learn:** one concept or technique from the change worth studying, with a short explanation and a minimal example. Mark it when it leads to general study unrelated to the ticket.

Read-only: change no code, post nothing, commit nothing. The theatre may add the language of the notes and a time-booking line.
