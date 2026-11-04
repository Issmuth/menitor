# 13. Skills are generated from neutral instructions

Date: 2026-11-04 · Status: accepted

## Context

The heart of each command is its instructions. They should be reusable by a v2 adapter ([ADR 5](005-agent-neutral-core.md)), but Claude Code needs `SKILL.md` files with its own frontmatter and command names.

## Decision

The instructions live in `core/instructions/<command>.md`, with placeholders: `{{cli}}`, `{{cmd:<name>}}`, `{{window}}`, `{{ask}}`, `{{templates}}` and `{{args}}`. `adapters/claude-code/build-skills.js` renders them into `adapters/claude-code/skills/<name>/SKILL.md`, adding frontmatter. The generated files are committed.

## Consequences

- The plugin works straight from a clone, with no build step for learners.
- `npm run check` fails if a generated skill is stale.
- Tests check that the instructions use only real CLI commands, and that their sentences stay under 25 words.
