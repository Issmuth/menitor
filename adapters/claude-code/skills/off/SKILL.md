---
name: off
description: "Turn Menitor mentor mode off, so the agent may write code. Only the learner can run it, by typing it."
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" *)
---

<!-- Generated from core/instructions/off.md by adapters/claude-code/build-skills.js. Edit the source, then run "npm run build:skills". -->

# Turn mentor mode off

The learner typed this, and a hook recorded it. Its Menitor note says what changed and what to tell them: do that in a sentence or two. If there is no Menitor note, the plugin's hooks may not be running. Say so plainly, and keep acting as if mentor mode is on.
