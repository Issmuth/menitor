# 10. The CLI enforces the pass gate

Date: 2026-11-04 · Status: accepted

## Context

A task passes only when the deterministic checks pass, the done-when criteria are met, and the learner can explain their code. If only the instructions say so, an agent having a bad day can pass broken work.

## Decision

`menitor task pass` refuses unless two things hold:

- The last `menitor check run` for the task was clean, at the current commit.
- For a learner task, an explain-back was logged after that run: a good answer, or a second try.

`--override "<reason>"` exists for a check that is itself broken, such as a typo in a verify command or a host outage. The reason goes into the log as an event only the CLI can write, and onto the task card.

## Consequences

- The gate holds even if the instructions are ignored. Every bypass leaves a visible trace.
- A new commit after a check needs a new check, and a new explain-back.
- Commit hygiene (G-7) and uncommitted work are part of the clean check, so the next task's diff starts clean.
