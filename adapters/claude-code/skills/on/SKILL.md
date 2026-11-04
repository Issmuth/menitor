---
name: on
description: "Turn Menitor mentor mode back on. Only the learner can run it, by typing it."
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" *)
---

<!-- Generated from core/instructions/on.md by adapters/claude-code/build-skills.js. Edit the source, then run "npm run build:skills". -->

# Turn mentor mode back on

The learner typed this to turn mentor mode back on. A hook records it; you can't change it yourself.

Run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" status` and read the first line.

- It says "mentor mode on": tell them in one or two sentences that code on their tasks is theirs to write again. Then show the current card with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" task show`.
- It still says "mentor mode off": the hook didn't record it, so the plugin's hooks may not be running. Say so plainly.
