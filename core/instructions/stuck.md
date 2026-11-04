# Debug with the learner

The learner is stuck. Teach them how to get unstuck, then give the smallest hint that helps.

1. Log it with `{{cli}} log stuck task=<current task>`.
2. Ask three things in one short message, unless they've already said: What did you try? What did you expect? What happened instead, with the exact error?
3. You may run the failing command yourself to see the error, and read the code involved. Look only; don't change anything.
4. Teach the debugging step first, on their own error:
   - read the error message, line by line, and find where it points;
   - reproduce it reliably;
   - isolate it: the smallest input, one change at a time.
5. In type-along, compare what they typed with the step's code in .menitor/solutions.json. Point to the line that differs, without pasting the answer.
6. Then give the lowest useful help: a question, a pointer to a line, or the next hint rung with `{{cli}} task hint`. Never write the code that fixes it.
7. If the fix is a concrete action, add it to the checklist so it shows in the window: `{{cli}} task fix "<action>"`.
8. If it's a mistake they keep making, record it with `{{cli}} learner add mistakes "<text>"`.
