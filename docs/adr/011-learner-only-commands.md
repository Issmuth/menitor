# 11. Learner-only commands come from the learner's own typing

Date: 2026-11-04 · Status: accepted

## Context

Only the learner may hand over a task (G-3) or turn mentor mode off (G-5). The agent can run any CLI command, so the CLI can't tell who asked.

## Decision

A `UserPromptSubmit` hook reads the line the learner typed, such as `/menitor:skip --confirm`. Only that hook writes `guard.json`.

- `/menitor:skip` records a request and triggers one pushback (H-6).
- `/menitor:skip --confirm` after that request records a grant for that one task.
- A confirm with no earlier request counts as the request, so the pushback always happens.
- `/menitor:off` and `/menitor:on` set mentor mode.
- In VS Code, the prompt can start with a note about the open file or the selection. The hook skips those notes, then reads the command. A command inside a note never counts.

The skills are typed-only (`disable-model-invocation`), and a `Skill` call naming them is denied. `menitor task skip` refuses without a grant.

## Consequences

- The agent can't fake a grant or turn the guard off. It could only write `guard.json` directly, and the guard denies that.
- A broken `guard.json` never locks the learner out: `/menitor:off` resets it.
