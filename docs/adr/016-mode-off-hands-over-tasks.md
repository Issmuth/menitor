# 16. Mentor mode off hands over the learner's tasks

Date: 2026-11-05 · Status: accepted. Amends the decision of [ADR 11](011-learner-only-commands.md).

## Context

ADR 11 makes two things learner-only: handing over a task (G-3) and turning mentor mode off (G-5). In use, a learner who turns mentor mode off usually wants the agent to do their remaining tasks. They still had to type `/menitor:skip`, take the pushback, and type `/menitor:skip --confirm`, once per task.

Without the skip, the agent could still write the code, since mentor mode off lifts the write guard. But Menitor would record the task as the learner's work. The plan, the card and the stats would all say the wrong thing.

## Options

- **Keep the skip per task.** The record stays true, but the learner repeats three steps for every task, after already saying "I want help".
- **Let the agent pass learner tasks without an explain-back.** It saves typing, but records the agent's work as the learner's.
- **Mentor mode off counts as consent.** While it's off, `menitor task skip` hands the current task to the agent without a grant.

## Decision

While mentor mode is off, `menitor task skip` works on learner tasks with no grant. The task is marked delegated and skipped, as with a confirmed skip. Its log line says `via=mode-off`; a confirmed skip says `via=grant`.

The agent is told this when mentor mode turns off and at the start of each session while it stays off. It runs `menitor task skip` before it does a learner task, so the record shows who did the work.

## Consequences

- Only the learner can turn mentor mode off, so every handover still traces back to their own typing. The agent still can't grant itself anything while mentor mode is on.
- No grant is written. `guard.json` keeps one writer, the hook (ADR 9).
- Turning mentor mode back on ends it: the next learner task needs a confirmed skip again.
- With mentor mode off, there's no pushback before a task is handed over. Turning it off is the choice to give that up.
