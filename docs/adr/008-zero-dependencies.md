# 8. Zero runtime dependencies, in plain JavaScript with JSDoc types

Date: 2026-11-04 · Status: accepted

## Context

The plugin is installed by cloning its repo, and no install step runs ([ADR 4](004-no-postinstall.md)). It must work on macOS, Linux and Windows with only Node on the PATH.

## Options

- **TypeScript with a committed `dist/`.** Typed, but generated code in the repo, and a build step to keep in sync.
- **Committed `node_modules`.** Libraries for validation, servers and parsing, but a large, hard-to-review repo.
- **Plain ESM JavaScript using Node built-ins only,** with JSDoc types checked by `tsc --checkJs`.

## Decision

Plain ESM JavaScript, Node 22 or newer, Node built-ins only. TypeScript and `@types/node` are dev dependencies for type checking in CI.

## Consequences

- Menitor carries small versions of a JSON Schema validator, a strict YAML-subset parser for `learner.md`, a shell tokenizer, and a Server-Sent Events server.
- What runs is exactly what's in the repo, which is easy to audit.
- `npm run check` type-checks and tests on every commit, on all three operating systems.
