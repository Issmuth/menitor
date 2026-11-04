# 9. One writer per state file

Date: 2026-11-04 · Status: accepted

## Context

The agent (through the CLI), the window server, the hooks and the monitor all touch `.menitor/`. The PRD's `progress.json` mixed the window's ticks with the agent's current task and start commits, so two processes would write it.

## Decision

Every state file has exactly one writer:

| File | Writer |
| --- | --- |
| `plan.json`, `session.json`, `learner.md` | the CLI |
| `progress.json`, `window.json`, `inbox.jsonl` | the window server |
| `guard.json`, `activity.jsonl` | the adapter's hooks |
| `listener.json` | the adapter's monitor |
| `log.md` | the CLI and the hooks, append-only |

The current task and start commits moved to a new `session.json`.

## Consequences

- No locks are needed. JSON files are schema-validated and written atomically (temp file, flush, rename, with retries on Windows).
- `log.md` and the `.jsonl` files are appended with `O_APPEND`, so two appenders never lose each other's lines.
- The guard denies agent edits to any of these files ([G-4](../prd.md#guardrails-git-and-state)).
