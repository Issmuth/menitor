# Implementation decisions (v1)

These settle the ambiguities and open questions in [prd.md](prd.md) before the build. They were agreed on Nov 4, 2026. Each lasting choice also becomes an ADR in [adr/](adr/) as the code lands.

## Build

| # | Topic | Decision |
| --- | --- | --- |
| 1 | Repo | One repo, `Issmuth/menitor`, is both the marketplace and the plugin. |
| 2 | Order | Milestones, with a check-in after each: state CLI and schemas → guard hooks → skills → check runner → window → monitors → README, ADRs and doc templates. |
| 3 | Author | Ismael ([@issmuth](https://github.com/issmuth)). |
| 5 | Language | Plain ESM JavaScript with JSDoc types, checked by `tsc --checkJs` in CI. No build step and nothing compiled to commit. |
| 6 | Dependencies | None at runtime: Node built-ins only. TypeScript and `@types/node` are dev-only. |
| 7 | Versions | Node 22 or newer. The README names the first Claude Code version with plugin monitors. |

## Contradictions and gaps in the PRD

| # | Topic | Decision |
| --- | --- | --- |
| 8 | Who writes progress | `progress.json` holds ticks only and is written by the window. A new `session.json` holds the current task and start commits and is written by the CLI. |
| 9 | Validating Markdown | `learner.md` has a strict YAML-subset frontmatter validated by `learner.schema.json`, then free notes. `log.md` has one structured line per event, so `menitor stats` can compute the success metrics. |
| 10 | Skip confirmation | The first `/menitor:skip` on a learner task only triggers the pushback. `/menitor:skip --confirm` is the grant, recorded by a hook in `guard.json`. |
| 11 | Locked owners | The learner approves the plan at the end of `/menitor:start`. After that, the CLI refuses any plan import, and an owner moves from learner to delegated only with a skip grant. |
| 12 | Agent shell commands | Allowed: read-only commands, build, lint, test, `git status`, `git diff` and `git log`. Only on delegated or granted tasks: commands that write project files (installs, scaffolders, `git checkout`, `git commit`). |
| 13 | Delegated commits | The agent commits delegated work on the learner's branch with a `Menitor-Delegated: true` trailer. |
| 14 | When hints are written | Per milestone, when it starts, through `menitor hints import`. Revealed rungs can't be rewritten. |
| 15 | Docs link | Two fields: `docs` (a section of the project's docs, such as `docs/prd.md#signup`) and `learn` (a label plus an external URL). |

## The PRD's open questions

| # | Question | Decision |
| --- | --- | --- |
| 16 | Project types | Web apps only in v1 (`project.type` is `"web"`). `/menitor:start` works in new folders and existing repos. |
| 17 | What is committed | `docs/` and `.menitor/plan.json` are committed. `.menitor/.gitignore` keeps `progress.json`, `session.json`, `guard.json`, `learner.md`, `log.md` and `warmup/` out of the portfolio repo. |
| 18 | Free hosting | Vercel or Netlify for front-end and full-stack JS. Render's free tier for a separate backend. Neon or Supabase for Postgres. |
| 19 | Fast level hints | No special case: every level starts at the concept rung. |
| 20 | Mentor mode toggle | `/menitor:off` and `/menitor:on`, typed only and recorded by a hook in `guard.json`. The setting persists across sessions and the window shows a banner when it's off. |

## Behaviour

| # | Topic | Decision |
| --- | --- | --- |
| 21 | Levels | Task size is about 20–45 min (guided), 45–90 min (standard) and 1.5–3 h (fast). The level never changes on its own; the mentor may suggest a change. The warm-up is agent-written, lives in `.menitor/warmup/` and is deleted afterwards. |
| 22 | Learner ADRs | The learner writes one ADR for the stack choice in milestone 1, and more when a task involves a real choice. |
| 23 | Git remote and deploy | v1 checks local branches and commits. Pushing and opening PRs is the learner's habit, not a Menitor check, because PR review is in v2. "Deployed" passes when the check runner fetches the deployed URL and it matches the task's verify step. |
| 24 | Testing | Unit and integration tests run in CI on Linux, macOS and Windows with Node 22 and 24. The shell guard covers PowerShell too. Live Claude Code behaviour (hooks, monitors) is checked by dogfooding. |

## Assumptions

- **Window security.** The window server checks a random token and the `Host` and `Origin` headers on every request. Binding to 127.0.0.1 alone doesn't stop other sites in the browser from sending it requests.
- **Mentor rules in every session.** A session-start hook loads the mentor rules and the current task, so plain questions get mentor-style answers too.
- **Commands are skills.** Each command is a skill. `skip`, `off` and `on` are typed-only, so the agent can't invoke them.
- **Menitor stays out of the way elsewhere.** Hooks do nothing in a project without a `.menitor/` folder.
- **Log writes.** `log.md` is appended with `O_APPEND`, not rewritten through temp-and-rename, so hooks and the CLI can both add lines without losing each other's. Every other state file is written atomically.

## Guard details (milestone 2)

- **Learner commands come from `UserPromptSubmit`.** That hook receives the line exactly as typed, such as `/menitor:skip --confirm`. Only `/menitor:skip`, `/menitor:off` and `/menitor:on` change the guard, and a `Skill` call naming them is denied.
- **A confirm counts only after a request.** `/menitor:skip --confirm` with no earlier `/menitor:skip` for that task counts as the request, so the pushback (H-6) always happens once.
- **Protected state files.** These are any `.json` or `.jsonl` file directly in `.menitor/`, plus `learner.md`, `log.md` and `.gitignore`. Subfolders such as `.menitor/warmup/` stay writable.
- **Write areas.** Paths outside the project, `/dev/null`, `docs/` and `.menitor/` subfolders are always fine. Deleting build output (`node_modules`, `dist`, `.next` and similar) is fine. A path with a variable at its start, or with an unknown working folder, counts as project code.
- **Installs.** Restoring dependencies (`npm install` with no package, `npm ci`) is allowed. Adding, removing or upgrading packages, and scaffolders (`create-*`, `init`, `add`, `generate`, `migrate`), are the learner's on their tasks.
- **Activity log.** `.menitor/activity.jsonl` is a new state file, appended only by hooks. When Claude Code reports the files a shell command changed (`bashEditDiff`), the hook logs them and warns the agent if it touched the learner's files.
- **Failure handling.** Broken state blocks project writes but never read-only work. A crash in the guard blocks file writes but not shell commands, so a bug can't lock the learner out. `/menitor:off` always works, even with a broken `guard.json`.
- **The guard never approves anything.** An allowed call gets no hook output, so Claude Code's own permission rules still apply.
- **Inactive elsewhere.** In a project without `.menitor/`, every hook does nothing.

## Skills (milestone 3)

- **One source for instructions.** What each command does lives in `core/instructions/<command>.md`, in neutral words with placeholders such as `{{cli}}` and `{{cmd:hint}}`. `adapters/claude-code/build-skills.js` turns them into `SKILL.md` files, and `npm run check` fails if a generated file is stale. A v2 adapter renders the same sources its own way.
- **Who can invoke what.** `start`, `skip`, `off` and `on` set `disable-model-invocation`, so only the learner can run them, by typing them. `go`, `check`, `hint` and `stuck` stay model-invocable. That lets the window buttons (milestone 6) and plain requests like "check my work" reach them.
- **Fewer prompts.** Each skill pre-approves the state CLI and, where it needs them, `git status`, `git diff` and `git log`. Nothing that writes is pre-approved.
- **Doc templates moved up.** `/menitor:start` needs them, so `core/templates/docs/` landed in this milestone instead of milestone 7.
- **One call per task context (C-10).** `menitor task brief` prints the card with IDs, the start commit, the checks, the verify steps and only the doc section the task links to.
- **Check before the runner.** In milestone 3, `/menitor:check` gathered the diff and ran the checks with plain git. Milestone 4 replaced that with `menitor check run`.

## Check runner (milestone 4)

- **The CLI enforces the gate.** `task pass` refuses unless the last `check run` was clean at the current commit. A learner task also needs an explain-back logged since then: a good answer, or a second try. A clean re-run at the same commit keeps the first clean time, so an earlier explain-back still counts. `--no-commands` runs never count.
- **Override with a reason.** `task pass --override "<reason>"` exists for a check that is broken itself, such as a typo in a verify command or a host outage. It logs an `override` event that only the CLI can write, and adds the reason to the card's note.
- **What blocks.** A failing or timed-out command, a failing or missing deploy URL, no git repo, no commit since the start, and no Conventional Commits message all block. So do a `Menitor-Delegated` trailer on learner work, a missing trailer on delegated work, and uncommitted changes outside build folders.
- **What only warns.** Extra commits with other messages, the wrong branch, and project files the agent touched on a learner task. The branch is already a checklist item, and agent touches need a human conversation, not a block.
- **Skipping project checks.** An `npm`, `pnpm`, `yarn` or `bun` script check is skipped while package.json or that script doesn't exist yet. Task verify steps never skip.
- **Running commands.** Commands run through the shell from the project root, with `CI=1` and colors off, and a 180-second timeout each. Only the last 30 lines of output are kept, with blank runs removed.
- **Fetching URLs.** URLs are fetched in a child Node process, so the CLI stays synchronous. `$deployUrl` comes from `plan deploy-url`.
- **The diff.** It's capped at 40,000 characters. Untracked text files are shown in full up to 20 KB each.

