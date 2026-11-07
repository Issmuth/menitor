# Architecture decision records

Short records of decisions that shape Menitor. ADRs 1 to 7 were settled in the [PRD](../prd.md#decisions-and-open-questions). ADRs 8 to 16 were made during the v1 build, and ADR 17 for v2. Smaller choices are in [implementation-decisions.md](../implementation-decisions.md).

| ADR | Decision |
| --- | --- |
| [1](001-claude-code-plugin.md) | A Claude Code plugin, not a standalone app |
| [2](002-localhost-web-page.md) | A localhost web page, not Electron |
| [3](003-commands-first.md) | Commands first; window buttons through plugin monitors |
| [4](004-no-postinstall.md) | A marketplace plugin with no npm postinstall |
| [5](005-agent-neutral-core.md) | An agent-neutral core plus a Claude Code adapter |
| [6](006-pivot-in-v1-1.md) | /menitor:pivot moves to v1.1 |
| [7](007-primary-users.md) | Beginners and bootcamp grads are the primary users |
| [8](008-zero-dependencies.md) | Zero runtime dependencies, in plain JavaScript with JSDoc types |
| [9](009-one-writer-per-file.md) | One writer per state file |
| [10](010-cli-enforces-the-pass-gate.md) | The CLI enforces the pass gate |
| [11](011-learner-only-commands.md) | Learner-only commands come from the learner's own typing |
| [12](012-window-security.md) | Window security: token, cookie, Host and Origin |
| [13](013-generated-skills.md) | Skills are generated from neutral instructions |
| [14](014-wait-tool-for-window-buttons.md) | Window buttons through an MCP wait tool |
| [15](015-adding-to-a-locked-plan.md) | Adding to a locked plan |
| [16](016-mode-off-hands-over-tasks.md) | Mentor mode off hands over the learner's tasks |
| [17](017-context-graph.md) | A file-level context graph, built in core with no dependencies |

New ADRs copy the format of these files. Number them in order, and never rewrite an accepted one: supersede it with a new ADR instead.
