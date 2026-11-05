---
name: typealong
description: "Turn Menitor's type-along mode on or off. In type-along the window shows each step's instructions and full code, and the learner types it in by hand. Only the learner can run it, by typing it."
argument-hint: "[off]"
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" *)
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(git log *)
  - mcp__plugin_menitor_menitor__wait_for_learner
---

<!-- Generated from core/instructions/typealong.md by adapters/claude-code/build-skills.js. Edit the source, then run "npm run build:skills". -->

# Turn type-along on or off

The learner typed this themselves. A hook records it; you can't change it yourself.

Arguments: $ARGUMENTS

Run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" status` and read the first line. It ends with "type-along on" when type-along is on.

- The arguments say "off" but the line still says "type-along on", or the reverse: the hook didn't record it. The plugin's hooks may not be running. Say so plainly and stop.
- Type-along is off: tell them in one sentence that help comes as hints again, one rung at a time. Then show the card with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" task show`.
- Type-along is on: carry on below.

## Write the code for each step

In type-along, the window shows each step's instructions with the full code under it. The learner types it by hand; the window won't let them copy it. Typing it is how it sticks.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" task brief`. If the task is delegated, say that type-along starts on their next task of their own.
2. If the brief lists steps with no code, write it for every learner task in the current milestone that isn't done yet.
3. For each step, write two things:
   - say: what to do and where, in one to three plain sentences, with the reason when it isn't obvious;
   - code: the exact text to type, in blocks. Give each block a "where": the file path, or "Terminal" for commands.
4. A block is a whole new file, or the part to add. When it changes existing code, say where it goes, such as "inside handle, before the 404".
5. A step with nothing to type, such as a setting on a website, gets an empty code list and clear words.
6. The code must be complete and correct for the project as it is now. Match its style, names and imports, and leave no gaps.
7. Store it with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" steps import -`, passing the JSON on stdin with a heredoc. Key it by checklist item ID.

```json
{
  "t1.c1": { "say": "Create this milestone's branch from main.", "code": [{ "where": "Terminal", "text": "git checkout -b feat/skeleton" }] },
  "t1.c2": {
    "say": "Open src/app.js. At the top of handle, answer a GET for / with the page.",
    "code": [{ "where": "src/app.js", "text": "if (req.method === 'GET' && req.url === '/') {\n  res.writeHead(200, { 'Content-Type': 'text/html' });\n  res.end(HOME);\n  return;\n}" }]
  }
}
```

Then tell them in two sentences. Each step's code opens under it in the window once the step before is ticked. They type it themselves, and you check it as usual.

Never paste step code into chat. If they ask for it, point them to the window.
