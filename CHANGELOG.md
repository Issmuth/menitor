# Changelog

All notable changes to Menitor. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.0 (2026-11-04)

The first build of v1, ready for its first testers. It covers the v1 scope in the [PRD](docs/prd.md).

### Added

- **Setup** (`/menitor:start`): an interview one question at a time, a warm-up to set the level, focus areas, a stack recommendation, a PRD core drafted by the learner, lean docs from templates, a plan ordered for learning with a deployed walking skeleton first, and learner approval.
- **The task loop:**
  - `/menitor:go` resumes from Menitor's files and git, even in a fresh session.
  - `/menitor:check` runs deterministic checks first, then the review, then explain-back questions.
  - `/menitor:hint` reveals a four-rung hint ladder, one rung at a time.
  - `/menitor:stuck` debugs with the learner.
  - `/menitor:skip` gives one pushback, then hands the task over once the learner confirms.
- **The guard:**
  - Hooks deny agent writes to the learner's code on their tasks, even in bypass-permissions mode.
  - A best-effort shell analyzer, for bash and PowerShell, catches commands that would write their files.
  - State files in `.menitor/` change only through the CLI.
  - Skip grants and mentor mode come only from what the learner types.
  - Every agent command is logged.
- **The check runner** (`menitor check run`):
  - the diff since the task started;
  - build, lint and test, then the task's verify steps, each with a timeout that kills the whole process tree;
  - deploy URL checks;
  - commit hygiene and honest `Menitor-Delegated` trailers;
  - files the agent touched.
- **The pass gate:** `menitor task pass` requires a clean check at the current commit and, for learner tasks, an explain-back since then. A logged override exists for broken checks.
- **The task window:**
  - a live page on 127.0.0.1, protected by a token, a cookie, Host and Origin checks, and a strict CSP;
  - checklist ticks, milestone progress, and learner-written versus delegated counts;
  - a Document Picture-in-Picture pop-out;
  - a layout that works from 320 px.
- **Window buttons:** Check, Hint and Stuck reach the session through a Claude Code plugin monitor, and copy the command when no session is listening.
- **The state CLI:** schema-validated, atomic writes; `menitor stats` for the success metrics.
- **A sample project:** `examples/sample/create.js` builds "Recipe box" with an approved plan, in three scenarios (`start`, `check`, `delegated`), plus a test script.
- **Docs:** 13 decision records in [docs/adr](docs/adr/README.md), and the [implementation decisions](docs/implementation-decisions.md).
