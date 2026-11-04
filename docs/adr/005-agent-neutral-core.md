# 5. An agent-neutral core plus a Claude Code adapter

Date: 2026-11-04 · Status: accepted

## Context

v1 targets Claude Code, but v2 should open Menitor to other coding agents without a rewrite.

## Options

- **Write everything for Claude Code.** Fastest now, a rewrite later.
- **Split a neutral core from a thin adapter.** A little more structure now, and reuse later.

## Decision

`core/` holds everything that isn't specific to one agent: the state CLI, schemas, the check runner, the guard's decisions, the window server, the doc templates, and the instructions in neutral words. `adapters/claude-code/` holds the hook formats, the monitor, the command names, and the generated skills.

## Consequences

- `core/` never mentions Claude Code, its hook formats or its command names. Instructions use placeholders such as `{{cmd:hint}}` (see [ADR 13](013-generated-skills.md)).
- A v2 adapter maps its agent's events onto the same core calls: write checks, command checks, learner commands and the listener heartbeat.
