# 15. Adding to a locked plan

Date: 2026-11-05 · Status: accepted. Amends the consequences of [ADR 6](006-pivot-in-v1-1.md).

## Context

ADR 6 locks the plan once the learner approves it, and leaves changing course to `/menitor:pivot` in v1.1. In use, learners have ideas mid-project that change nothing already planned. Examples: a follow-up from a review, a performance pass, or one more feature. With no way to add them, they get lost or wait until the plan is done.

Hints, type-along steps, ticks, start commits, explain-back questions and the log all name tasks and checklist items by ID. So any change must keep every existing ID where it is.

## Options

- **Unlock `plan import` after approval.** Simple, but a re-import can renumber tasks and drop done ones. Every file that names an ID would then point at the wrong thing.
- **Edit `plan.json` by hand.** It breaks the one-writer rule ([ADR 9](009-one-writer-per-file.md)) and skips validation.
- **Wait for pivot.** It keeps v1 simple, but leaves the ideas nowhere to go.
- **Additions only, through the CLI.** New steps, tasks and milestones get new IDs, and nothing that exists changes.

## Decision

`menitor plan add` takes one addition as JSON:

- a task after a task, or at the end of a milestone;
- a step on a task that hasn't started, within the six-step limit;
- a milestone of new tasks after another milestone.

Nothing may land before a done task or the current task, and the current card never changes. New IDs take the next free number, so no ID is reused or renumbered. Each addition writes one log line, and `--dry-run` runs every check without saving.

`/menitor:add` puts a conversation in front of it. The agent asks about the idea, picks its size, and proposes a spot with a reason. It adds the idea only after the learner says yes, even when the idea is the agent's own.

## Consequences

- ADR 6's list of exceptions to "IDs never change after approval" gains a third: additions. They only ever add.
- Added tasks carry an `added` time. The window tags them on the card and marks their cells in the plan ledger, and `plan show` marks them too.
- When every task is done, an added task becomes the current task, so a finished project can keep growing.
- Changing, reordering or removing planned tasks is still pivot, in v1.1.
