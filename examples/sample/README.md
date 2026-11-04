# The Menitor sample project

`create.js` builds **Recipe box**, a tiny Node web app with no dependencies. Setup is already done: a learner profile, lean docs, an approved five-task plan, and hints for milestone 1. That lets you test Menitor without going through `/menitor:start` first.

## Set up

You need Node.js 22 or newer, git, and Claude Code.

1. Get Menitor. Until it's merged to `main`, use the `v1` branch:

   ```bash
   git clone -b v1 https://github.com/Issmuth/menitor
   ```

2. Create a sample project. Pick a scenario (below); the default is `start`:

   ```bash
   node menitor/examples/sample/create.js recipe-box --scenario start
   ```

3. Open it in Claude Code, with the plugin loaded from your clone:

   ```bash
   cd recipe-box
   ```

   ```bash
   claude --plugin-dir ../menitor
   ```

To start over, delete the folder and create it again. Each scenario is a fresh git repo.

## Scenarios

| Scenario | Where you start | Good for testing |
| --- | --- | --- |
| `start` | Task 1 is current, and nothing is built | The guard, hints, the window and its buttons, skip, mentor mode off and on, and the whole loop |
| `check` | Task 1 is built and committed on `feat/skeleton`, with every item ticked | `/menitor:check`, the explain-back, and the pass to the next task |
| `delegated` | Task 1 passed; task 2 belongs to Menitor | The agent doing delegated work, its commit trailer and its note |

The plan has two milestones. Milestone 1, "Walking skeleton", has three tasks: the home page (yours), a health check (delegated), and the deploy (yours). Milestone 2, "Recipes", has two tasks, both yours. Your focus areas are backend, frontend and deployment.

## Test script

Each row is something to try, and what should happen. Note anything that differs, with your `claude --version`.

### Scenario `start`

| # | Try | You should see |
| --- | --- | --- |
| 1 | Ask "What's my current task?" | Claude already knows: Task 1/5, the home page. The session-start hook loaded it |
| 2 | Ask "Write the home page for me." | Claude declines and offers to teach. If it tries anyway, the write is denied with "Menitor: you can't write src/app.js…" |
| 3 | Ask Claude to run `echo hi > src/app.js` | Denied: the shell guard catches the redirect |
| 4 | Ask Claude to run `npm test` | It runs. Read-only work is always allowed. The test fails, because you haven't built it yet |
| 5 | Type `/menitor:hint`, then once more | Hint 1 (concept), then hint 2 (approach), never more than one at a time |
| 6 | Type `/menitor:go` | The task window opens in your browser, or Claude prints its link. The card matches, with two hints open |
| 7 | Tick "Branch feat/skeleton" in the window | It stays ticked after a reload |
| 8 | Press **Hint** in the window | If the card says buttons send to your session, Claude gives hint 3 by itself. If it says no session is listening, the button copies `/menitor:hint` for you to paste |
| 9 | Type `/menitor:off`, then ask for the home page again | The window shows "Mentor mode is off", and Claude may now write code. Type `/menitor:on` to turn it back on |
| 10 | Build task 1 yourself: create the branch, write the code in `src/app.js`, run `npm test`, and commit with `feat(web): add home page` | `npm test` passes |
| 11 | Press **Check my work**, or type `/menitor:check` | The checks run: build passes, lint is skipped (no script yet), and the tests pass. Then a review against the card, and one or two questions about your code |
| 12 | Answer in your own words | Task 1 passes, and the card moves to task 2 (delegated). Claude may start building it |

Try skip in a fresh copy, because it hands your task over:

| # | Try | You should see |
| --- | --- | --- |
| 13 | Type `/menitor:skip` | One pushback naming what you'd miss. Nothing gets built |
| 14 | Type `/menitor:skip --confirm` | Claude builds task 1, commits with the trailer `Menitor-Delegated: true`, runs the check and passes it with a note. The window counts it as delegated, and skipped |

### Scenario `check`

| # | Try | You should see |
| --- | --- | --- |
| 1 | Type `/menitor:check` | A clean check run, a short review, and one or two questions about the code in `src/app.js` |
| 2 | Give a weak answer on purpose | A short explanation, then one follow-up question. After two tries the task passes, with the concept noted to revisit |
| 3 | If it raises a must-fix, dispute it | Claude must show a concrete failing case, or withdraw it |

### Scenario `delegated`

| # | Try | You should see |
| --- | --- | --- |
| 1 | Type `/menitor:go` | Claude sees task 2 is delegated and builds it: `GET /health` plus `test/health.test.js` |
| 2 | Run `git log -1 --format=%B` after it's done | The commit message ends with `Menitor-Delegated: true` |
| 3 | Look at the window | Task 2 shows Menitor's two-line note. The card moves on to task 3, the deploy, which is yours |

## Where to look afterwards

- `.menitor/log.md`: every session, check, hint, skip and pass, in order.
- `.menitor/activity.jsonl`: every command and file write the agent ran.
- `node ../menitor/core/bin/menitor.js stats`: the success metrics.
- `node ../menitor/core/bin/menitor.js status`: where the plan stands.

## What gets committed

`.menitor/plan.json` is committed with the project, and it changes as tasks pass. So after a pass, you'll see it as modified. Commit it with your next piece of work. Everything else in `.menitor/` is gitignored.
