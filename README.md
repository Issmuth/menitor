# Menitor

> **Requires Node.js 22 or newer on your PATH.** The task window and the state CLI run on Node.

Menitor is an open-source Claude Code plugin: a senior dev who runs your project like a sprint and makes you do the work. It turns a project idea into lean docs and an ordered task plan. Then it shows one task at a time in a browser window and checks your work before moving on.

It is free (MIT), runs fully locally on your existing Claude plan, and has no accounts or telemetry.

**Status:** in development. v1 is being built in milestones; see [docs/prd.md](docs/prd.md) for the product requirements and [docs/implementation-decisions.md](docs/implementation-decisions.md) for the choices made before the build.

| Milestone | State |
| --- | --- |
| 1. State CLI and schemas | Done |
| 2. Guard hooks | Done |
| 3. Skills (`/menitor:start`, `go`, `check`, `hint`, `stuck`, `skip`) | Next |
| 4. Check runner | Planned |
| 5. Task window | Planned |
| 6. Window buttons through plugin monitors | Planned |
| 7. README, ADRs and doc templates | Planned |

## Install

Menitor isn't ready for learners yet. To try the work in progress, in Claude Code 2.1.275 or later:

```text
/plugin install menitor --marketplace Issmuth/menitor
```

On older versions, add the marketplace first, then install:

```text
/plugin marketplace add Issmuth/menitor
```

```text
/plugin install menitor@menitor
```

## How it works

Every task runs the same loop: read the card, build it yourself, check it, then fix or move on.

```mermaid
flowchart LR
  read["Read the task card"] --> build["Build it yourself"]
  build --> check["/menitor:check<br/>tests, then AI review"]
  check --> mustfix{"Any must-fix?"}
  mustfix -- "yes: fixes added" --> build
  mustfix -- no --> explain["Explain your code"]
  explain --> next["Next task"]
  next --> read
```

## The guard

While mentor mode is on, hooks keep the agent's hands off the learner's code:

- **File writes** outside `docs/` and `.menitor/` are denied on the learner's tasks. A deny holds even in bypass-permissions mode.
- **Shell commands** that would write project files are denied on a best-effort match. That covers redirects, `tee`, `sed -i`, copies, moves, deletes, downloads, inline scripts, git commands that change the repo, and installs or scaffolders.
- **Read-only work always runs:** builds, tests, linters, `git status`, `git diff` and `git log`.
- **State files** in `.menitor/` change only through the state CLI, even with mentor mode off.
- **Learner-only commands:** only the learner can hand a task over or turn mentor mode off, by typing `/menitor:skip --confirm` or `/menitor:off`. The guard reads the learner's typed prompt, so the agent can't fake either one.
- **Activity log:** every agent command and file write goes to `.menitor/activity.jsonl`, so the check can flag anything that slipped past.

Delegated tasks, and tasks the learner skipped, open project writes for that one task.

## Layout

```text
core/                     agent-neutral: works with any coding agent
  bin/menitor.js          the state CLI (the agent changes state only through it)
  lib/                    plan, learner, log, stats, card, shell analysis and guard
  schemas/                JSON Schemas for every file in .menitor/
  instructions/           mentor rules in neutral words
adapters/claude-code/     the thin Claude Code layer: hooks and command names
.claude-plugin/           plugin and marketplace manifests
test/                     node:test suites
docs/                     PRD and implementation decisions
```

A learner's project keeps its state in `.menitor/`, split by writer so nothing overwrites anything else:

| File | Written by | Holds | In git |
| --- | --- | --- | --- |
| `plan.json` | the CLI | milestones, tasks, checklists, done-when criteria, owners, hints | yes |
| `session.json` | the CLI | current task, start commits | no |
| `progress.json` | the window | checklist ticks | no |
| `guard.json` | hooks, from commands the learner typed | mentor mode, skip grants | no |
| `learner.md` | the CLI | level, focus areas, strengths, mistakes, hint use | no |
| `log.md` | the CLI and hooks | dated history of checks, hints, skips and disputes | no |
| `activity.jsonl` | hooks | every agent command and file write, for the check | no |

## The state CLI

```bash
node core/bin/menitor.js help
```

Common commands: `init`, `plan import`, `plan approve`, `task show`, `task hint`, `task fix`, `task pass`, `task skip`, `log`, `stats`, `status` and `validate`. Every write is schema-validated and atomic.

## Development

```bash
npm install
```

```bash
npm run check
```

`npm run check` runs the type checker and the tests. There is no build step.

## Prior art

Menitor borrows proven ideas and adds the project layer on top: product docs, a plan ordered for learning, a task window and checked gates between tasks.

- [Claude Code Learning style](https://code.claude.com/docs/en/output-styles): you write small pieces at `TODO(human)` markers
- [no-vibe](https://github.com/rizukirr/no-vibe): hook-guarded writes, graded hints, a learner profile
- [mentor-plugin](https://github.com/teonanacatl/mentor-plugin): edit blocking, a try-first gate, a hint ladder
- [mentor-mode](https://github.com/sefermavi4243-droid/mentor-mode): a hint ladder and an independence score
- [learn-while-build](https://github.com/Pranavraut033/learn-while-build): a concept log and spaced-repetition quizzes

## License

[MIT](LICENSE) © 2026 Ismael
