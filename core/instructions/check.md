# Check the current task

A task passes only when three things hold: the deterministic checks pass, the done-when criteria are met, and the learner can explain their code. Be hard on the work and kind to the person. Never fix their code during a check, and never show the solution.

## 1. Gather the evidence

1. Run `{{cli}} task brief`. It gives the checklist with IDs and ticks, the start commit, the checks, the verify steps and the linked doc section. Load no other docs.
2. Review only the learner's work: the changes from the start commit to the working tree. Run `git diff <start commit>` and `git status --short`, and read any new files. With no start commit, every file is theirs.
3. Run the deterministic checks before any review, in this order: the project's build, lint and test commands, then the task's verify steps. Read only the end of long output. For a url step, fetch the URL; `$deployUrl` is the project's deployed URL. If none is recorded yet, ask the learner for it and record it with `{{cli}} plan deploy-url <url>`.
4. A failing check is a must-fix. Report it, and skip the deeper review until it passes.

## 2. Review against the card

- For each checklist item, decide: done, missing, or ticked but not found.
- For each done-when criterion, decide: met or not, with the evidence.
- Commit hygiene: there is at least one commit since the start, on the task's branch. Its message follows Conventional Commits (`type(scope): summary`). Learner work carries no "Menitor-Delegated" trailer.
- Read the lines in .menitor/activity.jsonl since the task started. If an agent command touched project files on this learner task, say so plainly.

Sort what you find:

- must-fix: a failing check, a missed done-when criterion, a checklist item not done, a missing commit, broken behavior, or a security hole. Only these block a pass.
- nice-to-have: naming, style, small refactors and other polish.

## 3. If anything is must-fix

1. Log it with `{{cli}} log check task=<id> result=fail mustFix=<n> nice=<n>`.
2. Add each must-fix as a fix item with `{{cli}} task fix "<short action>" "<short action>"`. They show up in the window, and existing ticks stay.
3. Tell the learner, briefly:
   - what already works, in one line;
   - each must-fix, with the reason and the better path, but no code;
   - the nice-to-haves, in a line or two.
4. End with: fix these, then run {{cmd:check}} again.

## 4. Explain-back

When nothing is must-fix, ask one or two open questions about their own code. Ask why they chose something, or what happens in a case they handled. Never use multiple choice. Ask one question at a time.

- A good answer: log `{{cli}} log explain task=<id> outcome=good try=1`.
- A weak answer: log `outcome=weak try=1`. Give a short explanation in three or four sentences, then ask one follow-up. Log the follow-up as `try=2`, good or weak.
- After two tries the task passes anyway. Name the concept to revisit when you pass it.

## 5. Pass

1. Log it with `{{cli}} log check task=<id> result=pass mustFix=0 nice=<n>`.
2. If a deploy check passed on this task, log `{{cli}} log deploy url=<url>`.
3. Run `{{cli}} task pass`, with `--revisit "<concept>"` for each concept that took two tries. It records the next task's start commit and prints its card.
4. If you saw a clear strength or a recurring mistake, record it with `{{cli}} learner add strengths "<text>"` or `{{cli}} learner add mistakes "<text>"`.
5. Give one line of praise that names something specific, then show the next card.

## Disputes

The learner may dispute a must-fix. Then you must show a concrete failing case, such as an input and its wrong result or a failing command. If you can't, withdraw it.

Log the outcome with `{{cli}} log dispute task=<id> outcome=upheld` or `outcome=withdrawn`. If you withdraw the only must-fix, go on to the explain-back.
