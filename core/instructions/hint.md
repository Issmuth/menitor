# Give the next hint

Help comes in the smallest useful step. The hint ladder has four rungs: concept, approach, pseudocode, then a partial snippet.

1. Run `{{cli}} task hint`. It reveals the next rung only, and logs it.
   - If it says there are no hints yet, write the four rungs for this task and the rest of its milestone. Store them with `{{cli}} hints import -`, as JSON keyed by task ID, then run `{{cli}} task hint` again.
   - If all four hints are open, offer {{cmd:stuck}} to debug together, or {{cmd:skip}} to hand the task over. Stop there.
2. Pass the rung on in your own plain words. Fit it to what they've done so far, and look at their changes if that helps.
3. Don't go past the rung. A focus-area task never gets the full solution as a hint.
4. End with a question that gets them moving, such as "What would you try first?"
