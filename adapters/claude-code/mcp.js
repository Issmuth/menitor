#!/usr/bin/env node
// Menitor's MCP server for Claude Code: one tool, wait_for_learner, that returns the learner's next
// button press in the task window. It works in every Claude Code surface, unlike plugin monitors,
// which don't start in the VS Code extension's mode. A call still waiting after two minutes moves
// to the background, so the learner can type; the press then wakes Claude.
//
// Stdio transport: one JSON-RPC message per line on stdin and stdout. Logs go to stderr only.

import fs from 'node:fs';
import { findRoot, statePaths } from '../../core/lib/paths.js';
import { waitForEvent } from '../../core/lib/inbox.js';
import { windowEventText } from './messages.js';

/** Protocol revisions this server speaks; it answers with the newest one the client asked for. */
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
/** A minute, shrunk in tests. */
const MINUTE_MS = Number(process.env.MENITOR_WAIT_MINUTE_MS ?? 60000);
const PROGRESS_MS = Number(process.env.MENITOR_WAIT_PROGRESS_MS ?? 60000);
const DEFAULT_MINUTES = 120;
const MAX_MINUTES = 240;
const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export const TOOL = {
  name: 'wait_for_learner',
  title: 'Wait for the learner',
  description:
    "Wait for the learner's next move in the Menitor task window: Check my work, Hint, I'm stuck, Start it, or a sent answer. Call it last in a turn whose next move is the learner's, in their editor or the window. It returns the press as soon as it happens. After two minutes Claude Code moves it to the background, so the learner can still type to you, and the press wakes you when it comes.",
  inputSchema: {
    type: 'object',
    properties: {
      minutes: { type: 'integer', minimum: 1, maximum: MAX_MINUTES, description: `How long to listen before giving up. Default ${DEFAULT_MINUTES}.` },
    },
    additionalProperties: false,
  },
  annotations: { title: 'Wait for the learner', readOnlyHint: true, openWorldHint: false },
};

const INSTRUCTIONS = [
  "Menitor's task window has buttons: Check my work, Hint, I'm stuck, Start it, and an answer box.",
  "When the learner's next move is in their editor or the window, end your turn by calling wait_for_learner.",
  'It returns their press, or moves to the background after two minutes and wakes you when they press.',
  'Then do what the press asks, as its text says. If they type to you instead, answer them as usual.',
].join(' ');

/** @param {unknown} msg */
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/** @param {string | number} id @param {unknown} result */
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

/** @param {string | number | null} id @param {number} code @param {string} message */
function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** @param {string} text */
function text(text) {
  return { content: [{ type: 'text', text }] };
}

/** Pending waits by request ID. A newer wait replaces older ones, so each press is handled once. */
const waits = /** @type {Map<string | number, { ac: AbortController, cancelled: boolean, superseded: boolean }>} */ (new Map());

/**
 * @param {string | number} id
 * @param {Record<string, any>} params
 */
function callTool(id, params) {
  if (params?.name !== TOOL.name) return fail(id, -32602, `Unknown tool: ${params?.name}`);
  const asked = params.arguments?.minutes;
  if (asked !== undefined && !(Number.isInteger(asked) && asked >= 1 && asked <= MAX_MINUTES)) {
    return reply(id, { ...text(`minutes must be a whole number from 1 to ${MAX_MINUTES}`), isError: true });
  }
  const minutes = asked ?? DEFAULT_MINUTES;
  // The project Claude Code names, and only that one: a fallback could listen on another project's window.
  const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) return reply(id, text('Menitor is not set up in this project, so there is no task window to wait on.'));

  for (const w of waits.values()) {
    w.superseded = true;
    w.ac.abort();
  }
  const wait = { ac: new AbortController(), cancelled: false, superseded: false };
  waits.set(id, wait);

  // Progress keeps a long wait from being cut off as idle.
  const token = params._meta?.progressToken;
  let n = 0;
  const timer = token === undefined ? null : setInterval(() => send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: 'Listening for the task window' } }), PROGRESS_MS);

  waitForEvent(statePaths(root), { timeoutMs: minutes * MINUTE_MS, signal: wait.ac.signal, agent: 'claude-code-wait' })
    .then((event) => {
      if (timer) clearInterval(timer);
      waits.delete(id);
      if (wait.cancelled) return; // The client cancelled: it expects no answer.
      if (wait.superseded) return reply(id, text('A newer wait_for_learner call took over listening.'));
      if (event) return reply(id, text(windowEventText(event.type, event.task ?? 'the current task')));
      return reply(id, text(`No button press in ${minutes} minute${minutes === 1 ? '' : 's'}. If the learner's next move is still in the window, call wait_for_learner again; otherwise end your turn.`));
    })
    .catch((err) => {
      if (timer) clearInterval(timer);
      waits.delete(id);
      if (!wait.cancelled) reply(id, { ...text(`Menitor could not listen to the window: ${err.message}`), isError: true });
    });
  return undefined;
}

/** @param {Record<string, any>} msg */
export function handle(msg) {
  if (typeof msg.method !== 'string') return; // A response to a request this server never sends.
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const wanted = params?.protocolVersion;
      reply(id, {
        protocolVersion: SUPPORTED.includes(wanted) ? wanted : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'menitor', title: 'Menitor', version: VERSION },
        instructions: INSTRUCTIONS,
      });
      return;
    }
    case 'notifications/initialized':
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: [TOOL] });
      return;
    case 'tools/call':
      callTool(id, params);
      return;
    case 'notifications/cancelled': {
      const w = waits.get(params?.requestId);
      if (w) {
        w.cancelled = true;
        w.ac.abort();
      }
      return;
    }
    default:
      if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
  }
}

function shutdown() {
  for (const w of waits.values()) {
    w.cancelled = true;
    w.ac.abort();
  }
  // Let each wait remove its heartbeat, then go.
  setTimeout(() => process.exit(0), 100);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(null, -32700, 'Parse error');
      continue;
    }
    try {
      handle(msg);
    } catch (err) {
      process.stderr.write(`menitor mcp: ${/** @type {Error} */ (err).message}\n`);
      if (msg?.id !== undefined) fail(msg.id, -32603, 'Internal error');
    }
  }
});
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
