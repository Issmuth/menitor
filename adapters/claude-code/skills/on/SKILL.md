---
name: on
description: "Turn Menitor mentor mode back on. Only the learner can run it, by typing it."
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" *)
  - mcp__plugin_menitor_menitor__wait_for_learner
---

<!-- Generated from core/instructions/on.md by adapters/claude-code/build-skills.js. Edit the source, then run "npm run build:skills". -->

# Turn mentor mode back on

The learner typed this, and a hook recorded it. Its Menitor note says what to tell them: do that in a sentence or two. If there is no Menitor note, the plugin's hooks may not be running. Say so plainly.
