---
name: off
description: "Turn Menitor mentor mode off, so the agent may write code. Only the learner can run it, by typing it."
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" *)
---

<!-- Generated from core/instructions/off.md by adapters/claude-code/build-skills.js. Edit the source, then run "npm run build:skills". -->

# Turn mentor mode off

The learner typed this to turn mentor mode off. A hook records it; you can't change it yourself.

Run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" status` and read the first line.

- It says "mentor mode off": tell them you can now write code anywhere in the project. Their plan and progress stay as they are. They can type /menitor:on to turn it back on.
- It still says "mentor mode on": the hook didn't record it, so the plugin's hooks may not be running. Say so plainly, and keep acting as if mentor mode is on.
