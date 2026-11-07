# What each command costs in context

This is the baseline for milestone 8. Later changes are measured against it the same way.

## How it is measured

`npm run context-cost` runs `adapters/claude-code/context-cost.js`. For each command, it builds a fresh sample project with `examples/sample/create.js`. Then it adds up the text the agent receives on a typical run:

- **Skill:** the skill body that loads when the command runs, without its frontmatter.
- **Hook:** the context a hook adds when the learner types the command (on, off, skip and type-along).
- **CLI output:** what the skill's first CLI calls print, before the real work starts. For example, `go` reads `status` and `task brief`.

Text that loads in every session is counted once, on its own: the session-start context, the description of every skill, and the wait tool with its instructions.

Tokens are estimated as characters divided by 4, rounded up. The estimate is the same for every row, so rows compare fairly. `--json` prints the same numbers as data.

Two rows are lower bounds. `start` counts only its opening reads; the interview then runs over many turns. `check` includes the diff of the sample task, so it grows with the learner's change.

## Baseline (November 2026, v1 at 0.1.0)

| Command | Skill | Hook | CLI output | Total |
| --- | ---: | ---: | ---: | ---: |
| /menitor:start | 3110 | 0 | 65 | 3175 |
| /menitor:go | 1051 | 0 | 344 | 1395 |
| /menitor:hint | 340 | 0 | 42 | 382 |
| /menitor:stuck | 413 | 0 | 45 | 458 |
| /menitor:check | 1537 | 0 | 623 | 2160 |
| /menitor:skip | 403 | 99 | 31 | 533 |
| /menitor:on | 171 | 9 | 244 | 424 |
| /menitor:off | 264 | 108 | 72 | 444 |
| /menitor:typealong | 697 | 124 | 295 | 1116 |
| /menitor:add | 1066 | 0 | 378 | 1444 |

| Every session | Tokens |
| --- | ---: |
| Session-start context | 883 |
| Skill descriptions | 430 |
| Wait tool and its instructions | 300 |
| Total | 1613 |

## What it shows

- **The skill text is most of every command.** Only `on` reads more from the CLI than from its skill.
- **`start` and `check` cost the most per run,** at about 3,200 and 2,200 tokens.
- **`go` is the command run most, at about 1,400 tokens.** Most of that is the skill, which covers cases a typical run never meets.
- **Every session starts at about 1,600 tokens,** over half of it the session-start context with the current card.

Task t29 makes on, off and go nearly free. Task t30 trims the session-start context and the CLI output read most.
