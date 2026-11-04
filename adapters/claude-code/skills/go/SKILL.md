---
name: go
description: "Show the current Menitor task card and pick up where the learner left off, even in a fresh session. Use when the learner wants to continue, asks what's next, or comes back to the project."
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" *)
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(git log *)
---

<!-- Generated from core/instructions/go.md by adapters/claude-code/build-skills.js. Edit the source, then run "npm run build:skills". -->

# Show the current task

Pick up exactly where the learner left off, and show one task card. A fresh session knows nothing else, so rebuild everything from Menitor's files and git.

## 1. Where things stand

Run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" status`.

- No plan, or the plan isn't approved: setup isn't done. Point to /menitor:start and stop.
- Every task is done: congratulate them in one line and show `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" stats`. Suggest what's next, such as polishing the README and sharing the deployed link. Stop.

## 2. Open the window

Run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" window open --command check=/menitor:check --command hint=/menitor:hint --command stuck=/menitor:stuck --command go=/menitor:go --command start=/menitor:start`. It starts the task window if it isn't running, and opens it in the browser. If it couldn't open a browser, give the learner the link it printed. The link only works on this machine.

## 3. Rebuild the context

- Run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" task brief`. It prints the card with checklist IDs, the start commit, the checks, and only the doc section this task links to. Don't read other docs unless the task needs them.
- Run `git status --short` and `git log --oneline <start commit>..HEAD` to see what changed since the task started.
- Compare the current branch with the task's branch.

## 4. Hints for a new milestone

If the card says the hints are "not written yet", the milestone has just started. Write the four rungs for each of its tasks: concept, approach, pseudocode, and a partial snippet with gaps (never the full solution). Store them with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" hints import -`, as JSON keyed by task ID.

## 5. A delegated task is yours

If the brief says the owner is Menitor, do the task now:

1. Do the work the card describes, matching the docs. Keep it small.
2. Commit on the task's branch with a Conventional Commits message and the trailer: `git commit -m "<type(scope): summary>" --trailer "Menitor-Delegated: true"`.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" check run`, and fix anything it marks "MUST FIX".
4. Pass it with a two-line note on what you did and where: `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" task pass --note "<note>"`.
5. Go back to step 3 for the next task.

Steps that need the learner's own accounts, such as signing in to the host, are theirs. Ask them to do those, then carry on.

## 6. A learner task

Show the learner the card as `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" task show` prints it, without the IDs. Then say in a sentence or two where they left off. For example: "You have uncommitted changes in src/signup.ts." Or: "You're on main, and the card starts with a branch."

End with the two commands they'll need: /menitor:check when they're done, and /menitor:hint if they're stuck. Don't start explaining the solution.
