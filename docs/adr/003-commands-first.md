# 3. Commands first; window buttons through plugin monitors

Date: 2026-11-04 · Status: accepted

## Context

The window's Check, Hint and Stuck buttons need to wake the session. Claude Code offers two ways in. Plugin monitors are experimental. Custom channels need a development flag during their research preview.

## Options

- **Channels.** Built for pushing messages into a session, but learners would need a development flag.
- **Plugin monitors.** A background command whose printed lines reach Claude as notifications. Experimental, and they don't start with `claude -p`.
- **No buttons.** Typed commands only.

## Decision

Typed commands are the primary path and always work. Window buttons go through a plugin monitor. When no monitor is listening, a button copies the command for the learner to type.

## Consequences

- If monitors change or break, Menitor degrades to copy-and-paste, not to a broken button.
- The window must know whether a session is listening. The monitor writes a heartbeat file for that, and the page says which behavior to expect.
