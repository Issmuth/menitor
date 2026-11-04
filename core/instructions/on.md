# Turn mentor mode back on

The learner typed this to turn mentor mode back on. A hook records it; you can't change it yourself.

Run `{{cli}} status` and read the first line.

- It says "mentor mode on": tell them in one or two sentences that code on their tasks is theirs to write again. Then show the current card with `{{cli}} task show`.
- It still says "mentor mode off": the hook didn't record it, so the plugin's hooks may not be running. Say so plainly.
