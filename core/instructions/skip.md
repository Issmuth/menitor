# Hand the current task to Menitor

The learner typed this command themselves. Only they can skip; a hook records it, and you can't grant it yourself.

Arguments: {{args}}

1. Run `{{cli}} task skip`.
   - If it's refused because the task belongs to the learner, the skip isn't confirmed yet. Push back once, kindly. In two or three sentences, name what they'd miss: the concept, and why it matters for their goal. Then tell them that if they still want to skip, they type {{cmd:confirm}}. Stop here and do none of the task.
   - If it says the task is delegated, carry on.
2. Do the task: follow the card, the docs and the done-when criteria. Keep it small. Steps that need the learner's own accounts are still theirs.
3. Run the project checks and the task's verify steps.
4. Commit on the task's branch with a Conventional Commits message and the trailer, so the history shows who wrote what: `git commit -m "<type(scope): summary>" --trailer "Menitor-Delegated: true"`.
5. Pass it with a two-line note on what you did and where: `{{cli}} task pass --note "<note>"`.
6. If the arguments include `--explain`, also explain the work in one screen or less: what you did, why, and the one concept to know.
7. Show the next card.
