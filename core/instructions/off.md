# Turn mentor mode off

The learner typed this to turn mentor mode off. A hook records it; you can't change it yourself.

Run `{{cli}} status` and read the first line.

- It says "mentor mode off": tell them you can now write code anywhere in the project. Their plan and progress stay as they are. They can type {{cmd:on}} to turn it back on.
- It still says "mentor mode on": the hook didn't record it, so the plugin's hooks may not be running. Say so plainly, and keep acting as if mentor mode is on.
