# 14. Window buttons through an MCP wait tool

Date: 2026-11-05 · Status: accepted. Supersedes the monitor-only approach of [ADR 3](003-commands-first.md).

## Context

ADR 3 sent window presses to the session through a plugin monitor. In use, monitors didn't start in the VS Code extension, which runs Claude Code in its SDK mode. So buttons fell back to copying commands, and the learner had to type them anyway.

## Options

- **Channels.** Still a research preview. Custom channels need a development flag that learners shouldn't have to pass.
- **MCP tasks.** Long-running tool calls in the protocol, but they need a newer protocol revision than VS Code supports.
- **A blocking MCP tool.** A plugin MCP server works in every Claude Code surface. A tool call that waits returns the moment the learner presses a button. After two minutes, Claude Code moves the call to the background, so the learner can still type, and the result wakes Claude when it arrives.
- **Monitors only.** Keep ADR 3 as it is, and accept copy-and-paste in VS Code.

## Decision

The plugin ships a zero-dependency stdio MCP server, `adapters/claude-code/mcp.js`, with one tool, `wait_for_learner`. When the learner's next move is in their editor or the window, the skills end their turn by calling it. The monitor stays as a second path where it runs. Typed commands still always work.

## Consequences

- Buttons drive the session in the terminal, the desktop app and VS Code.
- A press is handled once. The wait tool and the monitor both claim an event by creating a file in `.menitor/claims/` that can only be created once. The monitor waits two seconds before it claims, so a pending wait goes first.
- While a wait is still in the foreground, a message the learner types is delivered when it ends, within two minutes. Ctrl+Enter or Esc delivers it at once.
- The window counts a live wait as a listener, through its own heartbeat file, `.menitor/waiter.json`.
- The skills depend on Claude calling the tool at the end of a turn. The mentor rules and each skill say when.
