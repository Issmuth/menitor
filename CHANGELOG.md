# Changelog

All notable changes to Menitor. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **Type-along mode** (`/menitor:typealong`, learner-only):
  - each step in the window opens to plain instructions and the full code for that step, with line numbers;
  - the code can't be selected or copied there, so the learner types it by hand;
  - a step opens when the one before it is ticked, and closes when it is ticked;
  - the agent writes the code per milestone with `menitor steps import`, into a gitignored `.menitor/solutions.json`;
  - the window receives a step's code only once that step is open.
- A `typealong` scenario in the sample project.
- **Explain-back in the window.** The agent asks with `menitor question ask` and judges with `menitor question judge`. The learner answers in the window or in chat, and the reply and any follow-up show under the answer. Answers are saved as data in `.menitor/answers.json`.
- **Whose turn it is, in the window.** A banner shows anything holding up the next task:
  - a delegated task, with a **Start it** button that runs `/menitor:go`;
  - a skip waiting for the learner's confirm;
  - anything the agent is waiting on, posted with `menitor waiting`.
- **The window opens as its own app window** in Chrome, Edge, Chromium or Brave, with no tabs or address bar. Without one, or with `MENITOR_WINDOW_APP=0`, it opens in a tab as before.
- On phones and tablets, **Before you code** now comes before the steps.
- **A finish screen for a finished plan.** When every task passes, the window celebrates it with real figures: how many tasks you wrote, what Menitor did, hints opened and your explain-back record. Below that, every task and who did it, and a button to open your live app. Adding a task brings the card back.
- **See that Menitor is working after a button press.** The pressed button says what's happening ("Checking…"), the line beside the buttons says it in words, and the other buttons wait, so a second press sends nothing. When Menitor is done, the line says what comes next. A new `Stop` hook records when the agent ends its turn.
- **Read the feedback before moving on.** When a task passes after an explain-back, the window keeps the questions, your answers and Menitor's replies on screen, beside the plan. **Continue** shows the next card, and the window remembers it after a reload.
- **Window buttons drive the session in every Claude Code surface,** including VS Code. The plugin ships an MCP server with one tool, `wait_for_learner`. Claude calls it when the next move is the learner's, and it returns the moment a button is pressed. A press is claimed once, so the wait tool and the monitor never both handle it (ADR 14).
- **Add ideas to an approved plan** with `/menitor:add <idea>` (ADR 15):
  - Menitor asks one to three questions, picks the size, and proposes a spot with a reason. It adds nothing until the learner says yes;
  - a step joins a task not started yet, a task goes after a task or at the end of a milestone, and a milestone goes after a milestone;
  - nothing lands before a done task or the current task, and no ID is reused or renumbered;
  - `menitor plan add <file|-> [--dry-run]` does the adding, with one log line per addition;
  - added tasks carry an "Added" tag on the card and a dot in the plan ledger;
  - when every task is done, an added task becomes the current task.

### Changed

- **The task window, redesigned** for phones, the pop-out, tablets and desktops:
  - one column with the actions in a bar fixed to the bottom on narrow screens, and a 12-column layout with the actions beside the title on wide ones;
  - the last check's result under the title, where it's read first;
  - a plan ledger: one cell per task, marked by who did it;
  - a hint ladder, with pseudocode and snippets set as code;
  - quieter, read-only steps on delegated tasks;
  - Instrument Sans, bundled under the SIL Open Font License, so the page still loads nothing from outside.
- Ticking a step with the keyboard keeps focus on it, and screen readers hear when the task, the check result or the hints change.
- **Mentor mode off hands over your tasks** (ADR 16). While it's off, the agent takes a learner task with `menitor task skip`, with no `/menitor:skip` from the learner. The task still counts as skipped, and its log line says `via=mode-off`. With mentor mode on, a skip still needs the learner's confirm.

### Fixed

- **Plain words on a card no longer count as code.** The plan check flagged steps like "let the learner revise" and "return at once" because they start with a keyword. Now a keyword counts only in a code shape, such as `let x =` or `return {`, so real warnings stand out.
- **The wait tool no longer waits on a window that isn't open.** It opens the window before it listens, or returns at once with the reason if the window can't start. Before, a session could sit stuck waiting for a press that couldn't come.
- **No commit asked for on cards without a commit step.** A task that only deploys or pushes, such as the sample's deploy task, used to fail its check with "No commit since the task started". Now a commit is required only when the card has a step that starts with "Commit".
- **Learner-only commands work on the first try in VS Code.** After the learner switched files, VS Code put a note about the open file before the typed text. The hook missed `/menitor:off`, `/menitor:on`, `/menitor:skip` and `/menitor:typealong`, so a second try was needed. The hook now skips that note and the selection note, and a command inside a selection never counts.
- **A window started before an update no longer calls a healthy plan broken.** It kept checking the plan with the rules it started with. Now `menitor window open` restarts a window that's older than Menitor's code. An old window that can't read the plan says it's out of date.
- **A check sees only the task's own work with a branch per task.** When the previous task was on another branch, the check listed that task's files as deleted, or counted work merged in from other tasks as this one's. Now it measures from where the current branch starts.

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
