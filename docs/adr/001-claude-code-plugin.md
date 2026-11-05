# 1. A Claude Code plugin, not a standalone app

Date: 2026-11-04 · Status: accepted

## Context

Menitor needs an agent that can read the learner's project, run commands and hold a conversation. Learners are beginners and bootcamp grads, and most already pay for a Claude plan. Menitor must also enforce the no-code rule, not just ask for it.

## Options

- **A standalone app on the Agent SDK.** Full control over the loop, but third-party products need paid API keys, which is a new cost for every learner.
- **A Claude Code plugin.** It runs on the learner's existing plan, and it gets hooks, skills and monitors for free. It's tied to Claude Code's extension points.

## Decision

Build Menitor as a Claude Code plugin.

## Consequences

- No accounts, keys or servers: install the plugin and start.
- Hooks let the guard deny writes even in bypass-permissions mode.
- Menitor depends on Claude Code features, some of them experimental (monitors). [ADR 5](005-agent-neutral-core.md) keeps that dependency thin.
