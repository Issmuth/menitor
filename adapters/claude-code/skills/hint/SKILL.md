---
name: hint
description: "Reveal the next rung of the hint ladder for the current Menitor task: concept, approach, pseudocode, then a partial snippet. Use when the learner asks for a hint."
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" *)
  - mcp__plugin_menitor_menitor__wait_for_learner
---

<!-- Generated from core/instructions/hint.md by adapters/claude-code/build-skills.js. Edit the source, then run "npm run build:skills". -->

# Give the next hint

Help comes in the smallest useful step. The hint ladder has four rungs: concept, approach, pseudocode, then a partial snippet.

If type-along is on, the step's full code is already in the window. Point them to it, and offer to explain the idea behind it instead.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" task hint`. It reveals the next rung only, and logs it.
   - If it says there are no hints yet, write the four rungs for this task and the rest of its milestone. Store them with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" hints import -`, as JSON keyed by task ID, then run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" task hint` again.
   - If all four hints are open, offer /menitor:stuck to debug together, or /menitor:skip to hand the task over. Stop there.
2. Pass the rung on in your own plain words. Fit it to what they've done so far, and look at their changes if that helps.
3. Don't go past the rung. A focus-area task never gets the full solution as a hint.
4. End with a question that gets them moving, such as "What would you try first?"
5. Then call `wait_for_learner` (the menitor MCP tool), so their next press in the window reaches you at once.
