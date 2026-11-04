# Menitor

A Claude Code plugin that runs a learner's project like a sprint. Read `docs/prd.md` for the product and `docs/implementation-decisions.md` for the choices already made; don't re-open those without a reason.

## Rules for this codebase

- `core/` is agent-neutral. No Claude Code names, hook formats or slash-command names in it. Those belong in the Claude Code adapter.
- No runtime dependencies. Node built-ins only, Node 22+. Dev dependencies are TypeScript and `@types/node`.
- Plain ESM JavaScript with JSDoc types. `npm run check` (tsc + node:test) must pass before every commit.
- Every write to `.menitor/` is schema-validated and atomic (`writeFileAtomic`); `log.md` is append-only.
- Each state file has one writer (see the README table). Don't add a second writer.
- User-facing text: plain words, sentences under 25 words, kind to the person.
- Commits use Conventional Commits.
