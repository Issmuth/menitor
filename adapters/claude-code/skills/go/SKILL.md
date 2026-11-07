---
name: go
description: "Show the current Menitor task card and pick up where the learner left off, even in a fresh session. Use when the learner wants to continue, asks what's next, or comes back to the project."
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" *)
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(git log *)
  - mcp__plugin_menitor_menitor__wait_for_learner
---

<!-- Generated from core/instructions/go.md by adapters/claude-code/build-skills.js. Edit the source, then run "npm run build:skills". -->

# Show the current task

Pick up exactly where the learner left off. A fresh session knows nothing else, so Menitor's files and git rebuild it.

Run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" go --command check=/menitor:check --command hint=/menitor:hint --command stuck=/menitor:stuck --command go=/menitor:go --command start=/menitor:start --command skip=/menitor:skip --command add=/menitor:add`. It opens the task window and prints the card, with only the doc section it links to. It shows what changed in git since the task started, then says what to do next. Do that, and don't read other docs unless the task needs them. If it says setup isn't done, point the learner to /menitor:start.

When it says to wait for their press, call `wait_for_learner` (the menitor MCP tool), so it reaches you at once.
