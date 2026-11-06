---
name: start
description: "Set up a Menitor project: interview the learner, calibrate their level, set focus areas, write lean docs and an ordered task plan, and get the plan approved."
argument-hint: "[idea, or paths to existing docs]"
disable-model-invocation: true
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" *)
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(git log *)
---

<!-- Generated from core/instructions/start.md by adapters/claude-code/build-skills.js. Edit the source, then run "npm run build:skills". -->

# Start a Menitor project

Turn the learner's idea into lean docs and an ordered plan. Setup ends with three things:

- a calibrated learner profile;
- lean docs in docs/, about one page each;
- an approved plan whose first milestone is a deployed walking skeleton.

Work through the steps in order. Ask one question at a time and wait for the answer. Keep every message short and plain.

Save each answer the moment it's given, with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" setup set <key> "<answer>"`. Then a session that closes mid-setup loses nothing. For long text, such as the PRD draft, pass `-` and send the text on stdin with a heredoc. The key for each answer is named below.

Anything the learner added after the command: $ARGUMENTS

## 0. Check where things stand

Run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" status`, and `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" setup show` once .menitor/ exists.

- It says there is no .menitor/ folder: this is a fresh start. Go to step 1.
- The plan is approved: setup is already done. Say so, point to /menitor:go, and stop.
- Setup answers, a profile or a draft plan exist: resume at the first step that isn't done, and say where. Never ask again for an answer that `setup show` lists.

## 1. Set up

- Run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" init` in the project root.
- If the folder isn't a git repo yet, the learner creates it. Explain in one sentence that git records every step of their work. Give them `git init` and wait. You can't run it for them.

## 2. Interview

Ask these one at a time. Use the AskUserQuestion tool for the choices. Ask for the idea in free text.

1. The idea (`idea`): what they want to build, in a sentence or two.
2. The goal (`goal`): a portfolio piece, a job hunt, learning a skill, or something real people will use.
3. Time per week (`time`): under 3 hours, 3 to 6, 6 to 10, or more than 10.
4. Experience (`experience`): what they've built before, and in which languages.
5. Stack (`stack`): a stack they want to use, or "recommend one".

If they attached docs, or docs/ already has some, read them first. Then ask only about what's missing. In an existing repo, read the README, the package files and the folder layout before you ask anything.

## 3. Calibrate the level

The learner never rates themselves. Pick the level from evidence.

- In an existing repo they wrote, read a few files and their git history.
- Otherwise, give a warm-up of 10 minutes or less:
  1. Write the exercise to .menitor/warmup/README.md. Make it one small function in the language they'll use, with two or three example inputs and outputs.
  2. The learner writes their answer in .menitor/warmup/. Wait until they say they're done.
  3. Read it, and ask one open question about their own code. Save the question as `warmup-question`, and their reply as `warmup-answer`.
  4. Delete .menitor/warmup/ afterwards.

Pick the level:

- guided: they needed help to start, or the code doesn't run. Small tasks, more hints, and git taught from scratch.
- standard: the code works, with small gaps. The full professional workflow on every task.
- fast: clean, idiomatic code and a clear explanation. Bigger tasks.

Record it with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" learner set level <level>`. Add one strength and one mistake you saw, with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" learner add strengths "<text>"` and `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" learner add mistakes "<text>"`. Tell the learner their level in one sentence, with the reason.

## 4. Focus areas

Ask what they want to learn, with the AskUserQuestion tool as a multi-select: frontend, backend and APIs, database, auth, testing, deployment, git and workflow. Let them add their own.

Record them with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" learner set focusAreas "<area>,<area>"`. Explain in one sentence that tasks outside these are delegated: you do them and leave a short note.

Then ask how they want help when they don't know the next line, with the AskUserQuestion tool:

- Hints: each one shows a little more, from the idea to a partial snippet. Best for working things out.
- Type-along: the window shows each step's full code, and they type it in by hand. Best when they want to see working code first.

Save their choice as `help`: "hints" or "type-along". Only they can turn type-along on, by typing /menitor:typealong. If they choose it, ask them to type it now.

## 5. Stack

- If they named a stack, check that it fits their goal, level and time. If it's too complex for the project, push back once, kindly, with a simpler option.
- If they didn't, recommend one stack with two or three reasons tied to their goal and level. Prefer well-documented tools with free hosting.
- Free hosting: Vercel or Netlify for front-end and full-stack JavaScript, Render's free tier for a separate backend, and Neon or Supabase for Postgres.
- Once they agree, save the stack and its hosting as `stack-choice`.

## 6. The core of the PRD

The learner drafts the core of the PRD in their own words: the problem, the users, and three to five must-have features. They can type it in chat or write it in docs/prd.md. Save each draft and each revision as `prd`.

Critique it like a senior developer. Is the problem real? Are the users specific? Is each feature small and testable? Name the one or two biggest gaps, with the reason, and let them revise. One or two rounds is enough.

## 7. Lean docs

Write the docs into docs/, about one page each, from the templates in ${CLAUDE_PLUGIN_ROOT}/core/templates/docs. Choose them by project:

- Always: prd.md (built around the learner's draft, keeping their words), tech.md, flow.md and testing.md.
- With a user interface: design.md.
- With a database or an API: data-api.md.

Use plain words and short sentences. Give each feature, screen, entity and endpoint its own heading, so tasks can link to it.

## 8. The plan

Order the plan for learning:

- Milestone 1 is a walking skeleton: one thin slice through every layer, deployed. It ends with a deploy task whose verify step is `{"url": "$deployUrl"}`.
- Each later milestone adds one feature slice, end to end.
- Size tasks by level: guided about 20 to 45 minutes, standard 45 to 90, fast 1.5 to 3 hours.
- Early in milestone 1, add a learner task to write docs/adr/001-stack.md, a short decision record for the stack, from ${CLAUDE_PLUGIN_ROOT}/core/templates/docs/adr.md.
- Steps that need the learner's own accounts, such as signing in to the host, are always the learner's, even on a delegated task.

Every task has:

- goal: one line.
- why: two sentences at most, in plain words.
- docs: the doc section it builds, such as docs/prd.md#sign-up.
- learn: a label and the official docs URL for the one thing to read. Check that the URL works if you can.
- focus: the focus areas it covers. The owner is "learner" when it covers one, and "delegated" when it covers none.
- checklist: six concrete actions or fewer. On learner tasks, start with the branch and end with the commit, such as "Branch feat/signup" and "Commit: feat(auth): persist new users".
- doneWhen: criteria someone else could check, such as "Signing up twice with one email shows an error, not a crash".
- verify: deterministic checks for this task where you can, such as `{"run": "npm test -- signup"}`.
- No code anywhere on the card.

Set the project-wide checks once the stack is known: build, lint and test commands.

Check the draft with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" plan lint -`, passing the JSON on stdin with a heredoc. Fix every error, and the warnings that matter. Then save it with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" plan import -`. Before approval you can import it again as often as you need.

The short form looks like this. IDs, defaults and checklist IDs are filled in for you.

```json
{
  "project": { "name": "Recipe box", "stack": ["Next.js", "Prisma", "Postgres"], "hosting": "vercel" },
  "checks": { "build": "npm run build", "lint": "npm run lint", "test": "npm test" },
  "milestones": [
    {
      "title": "Walking skeleton",
      "branch": "feat/skeleton",
      "tasks": [
        {
          "goal": "Show the app name on the home page",
          "why": "One page that renders proves the whole stack runs.",
          "docs": "docs/flow.md#home",
          "learn": { "label": "Next.js docs: pages and layouts", "url": "https://nextjs.org/docs/app/getting-started/layouts-and-pages" },
          "focus": ["frontend"],
          "checklist": ["Branch feat/skeleton", "Render the app name in a heading", "Commit: feat(web): add home page"],
          "doneWhen": "The home page shows the app name at http://localhost:3000",
          "verify": [{ "run": "npm run build" }]
        },
        {
          "goal": "Deploy the skeleton",
          "why": "Deploying on day one removes the scariest step early.",
          "docs": "docs/tech.md#hosting",
          "owner": "delegated",
          "checklist": ["Add the host's config", "Connect the repo to the host (learner signs in)", "Deploy main"],
          "doneWhen": "The public URL shows the home page",
          "verify": [{ "url": "$deployUrl", "status": 200 }]
        }
      ]
    }
  ]
}
```

## 9. Hints for milestone 1

For each task in milestone 1, write the four hint rungs:

- concept: the idea behind the task, with no code.
- approach: the steps to take, with no code.
- pseudocode: the logic in plain pseudocode.
- snippet: a partial snippet with gaps (___) for the learner to fill. Never the full solution.

Store them with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" hints import -`, as JSON keyed by task ID: `{"t1": {"concept": "...", "approach": "...", "pseudocode": "...", "snippet": "..."}}`. Later milestones get their hints when they start.

## 10. Approval

Show the outline with `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" plan show`. Sum it up in three lines: the milestones, when the first deploy happens, and what they'll write versus what's delegated.

Ask with the AskUserQuestion tool: approve the plan, or change something. Change it and import it again until they approve.

Then run `node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js" plan approve`. The plan is locked from here. Tell them the next step: /menitor:go shows the first task.
