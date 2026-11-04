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

## Task window (milestone 5)

- **One server per project.** `menitor window open` starts `core/server/main.js` detached and records the port, pid and token in `.menitor/window.json`. A second `open` reuses a server that answers `/api/ping` for the same project root. A stale `window.json` is replaced.
- **Security.**
  - The server binds to 127.0.0.1 and picks a random port.
  - Every request needs the token: from a header, an HttpOnly SameSite=Strict cookie named per port, or the link's `?t=` on the first page load, which redirects to `/` with the cookie.
  - `Host` must be `127.0.0.1:<port>` or `localhost:<port>`. POSTs must send JSON, and their `Origin` must match.
  - The CSP allows only same-origin scripts, styles and requests, with no inline styles. `Referrer-Policy: no-referrer` keeps the token out of the referrer when the learner follows a docs link.
- **Fixed events only (W-7).** `/api/event` accepts `check`, `hint` or `stuck`, and nothing else. Until milestone 6 connects a monitor, it answers `delivered: false` with the command to type, and the page copies it (W-6).
- **Ticks (W-3).** `/api/tick` takes an item ID on the current card and a boolean. The window is the only writer of `progress.json`.
- **Live updates (W-2).** Server-Sent Events push the whole state on every change. Changes are found by `fs.watch` on `.menitor/` and by a 2-second poll, in case the watch misses one.
- **Command names stay out of core.** The server shows whatever command names the adapter passes with `--command name=text`. The generated `/menitor:go` skill passes the `/menitor:*` names.
- **Pop out (W-4).** Document Picture-in-Picture moves the live card into an always-on-top window and moves it back when that closes. Without the API, the button opens a small separate window.
- **Shutdown.** The server stops on `menitor window stop`, after 6 hours without visitors, or when `.menitor/` disappears.
- **Checked in a real browser.** The page was tested in Chromium at 320 and 560 px, in light and dark mode. The checks covered ticks, live updates, the copy fallback, pop-out, and refusal without a token.

## Window buttons (milestone 6)

- **How a press reaches the session.**
  1. The window server appends a fixed event (`check`, `hint` or `stuck`, plus the current task ID) to `.menitor/inbox.jsonl`.
  2. The Claude Code plugin monitor (`adapters/claude-code/monitor.js`) polls the inbox every second.
  3. For each new event, it prints one fixed sentence that names the skill to run. Claude Code delivers each printed line to Claude as a notification.
  4. The text Claude receives is written by the monitor, never taken from the page (W-7).
- **Is anyone listening?** The monitor writes `.menitor/listener.json` every 5 seconds. The window writes an event only when that heartbeat is under 15 seconds old and its process is alive. Otherwise the button copies the command (W-6). The page shows which of the two will happen.
- **Idempotent presses.** The same button pressed again within 5 seconds counts once. The monitor never replays events from before it started, and prints each event ID once.
- **One monitor per session.** It runs for the whole session (`when` defaults to `always`). In a folder without `.menitor/`, it waits quietly and starts once setup creates the folder. It removes its heartbeat when it stops. Where Windows ends it abruptly, a dead pid makes the heartbeat count as stale.
- **The monitor prints nothing else on stdout,** because every line becomes a notification. Diagnostics go to stderr.
- **The session context explains the notifications.** The session-start context tells Claude to run the named skill at once when a "Menitor window" notification arrives.
- **Limits.**
  - Monitors don't start with `claude -p`, and they are an experimental Claude Code feature, so typed commands remain the primary path.
  - If two sessions are open on one project, both receive every press.
  - `claude plugin validate` checks that the monitors file exists, but not its keys, so a test checks the keys.

## Task window design (after milestone 7)

The window was redesigned with the design-taste-frontend skill's app-screen rules, in its editorial-greeting style (seed 891914021).

- **The screen's question** is "What do I do next, and am I done?" The steps answer it, so they are the biggest block and come first after the title. The last check's result sits on the line under the title, the screen's one finding.
- **Three bands.**
  - Up to 640px (phones and the pop-out): one column, no frame, and the actions in a bar fixed to the bottom.
  - 641-1099px: the same column on a white sheet in a tinted frame.
  - 1100px and up: a centred 1100px column on a 12-column grid. The steps take 8 columns and the rail (before you code, the plan) takes 4. The hints run all 12 below them, with the ladder on the left and the open hints on the right.
- **Face and signature.** The panels are tinted one step toward Menitor's green instead of a neutral grey. The plan ledger draws every task as one cell, marked by who did it. Its legend counts come from the same cells.
- **Colour** goes on data only: your ticks, your tasks in the ledger, the open hint rungs and links. Red marks only the failing fact. The primary button is near-black in light mode and white in dark mode.
- **The typeface** is Instrument Sans, bundled as two woff2 subsets (41 KB) with its OFL license in `core/server/page/fonts/`. The CSP adds `font-src 'self'`, so the page still loads nothing from outside. Fonts are the only files the server lets the browser cache.
- **The state** now lists every task per milestone (ID, number, goal, done, owner, skipped, current) for the ledger. Locked hint text still never leaves the server.
- **Accessibility.**
  - A tick re-renders the card, and focus returns to the same control by a `data-key`.
  - A polite live region announces a new task, a new check result, an opened hint and added fixes, instead of reading the whole card on every update.

## Type-along mode

A second way to help: instead of hints that build up, each step shows the full code to type by hand.

- **Learner-only, like skip.** `/menitor:typealong` and `/menitor:typealong off` are recorded by the `UserPromptSubmit` hook in `guard.json` (`typeAlong`). The agent can't switch it on: it reveals full solutions. `/menitor:start` offers it, and a `typealong` log event records each change.
- **The guard doesn't change.** The agent still never writes the learner's files. The learner types every line, and the check still ends with explain-back.
- **Where the code lives.** The agent writes it per milestone, for every learner step, with `menitor steps import`. It goes into `.menitor/solutions.json`, keyed by checklist item ID. Each step has a plain `say`, and code blocks with a `where`: a file path, or Terminal by default.
- **Out of the repo.** The file is gitignored, because learner repos are public portfolios. Projects set up earlier get the entry appended on their first import. The CLI is its only writer, and the guard treats it as state.
- **What the window receives.** A step's code is sent only once the step is open: the first step, a ticked step, or the step after a tick. Later steps arrive as `{ locked: true }`, like locked hints.
- **The accordion.** The step after the last tick opens by itself; ticking it closes it and opens the next. Any open step can also be opened or closed by hand. A step's checkbox works only once the step before it is ticked.
- **Copying is refused, as friction rather than secrecy.**
  - The code is `user-select: none`.
  - Copy, cut, drag, the context menu and Ctrl or Cmd with C, X or A are cancelled inside it, with a short nudge.
  - A page-wide copy that would include it is cancelled too, in the pop-out as well.
  - The file on disk can still be opened; the point is the habit, not secrecy.
- **No hints in type-along.** The Hint button and the hint ladder are hidden. `/menitor:hint` points to the window, and `/menitor:stuck` compares what was typed with the step's code without pasting it.
- **Desktop layout.** In type-along the steps column grows and shrinks as steps open, so the rail stays sticky beside it and doesn't stretch. The inspector's `ragged-row` warning on that row is expected.

