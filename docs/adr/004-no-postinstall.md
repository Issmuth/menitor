# 4. A marketplace plugin with no npm postinstall

Date: 2026-11-04 · Status: accepted

## Context

Menitor ships Node code: the state CLI, the hooks, the window server and the monitor. Learners' projects may not use Node at all.

## Options

- **An npm package with a postinstall script** that registers the plugin. pnpm 10 skips dependency install scripts by default. Writing into `~/.claude` from an install script also looks like an attack.
- **A plugin installed from a marketplace,** cloned as-is. Any dependencies would have to be committed or installed some other way.

## Decision

Distribute Menitor as a Claude Code marketplace plugin, with no install scripts. The repo is both the marketplace and the plugin.

## Consequences

- A learner's project stays clean: nothing goes into its `node_modules` or `package.json`.
- The plugin can't rely on `npm install` running, which leads to [ADR 8](008-zero-dependencies.md).
