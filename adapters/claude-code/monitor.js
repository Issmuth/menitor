#!/usr/bin/env node
// The Claude Code plugin monitor for Menitor's window buttons (W-6).
// Claude Code runs it in the background for the whole session; every line it prints reaches
// Claude as a notification. It prints only fixed sentences for fixed events: nothing the page
// sends is ever passed through as text (W-7). Diagnostics go to stderr, never stdout.
//
//   node monitor.js [project dir]

import fs from 'node:fs';
import { findRoot, statePaths } from '../../core/lib/paths.js';
import { HEARTBEAT_MS, beat, readInbox, stopListening } from '../../core/lib/inbox.js';

const POLL_MS = Number(process.env.MENITOR_MONITOR_POLL_MS ?? 1000);
const WAIT_MS = Number(process.env.MENITOR_MONITOR_WAIT_MS ?? 5000);
const startedAt = new Date().toISOString();
const start = process.argv[2] && !process.argv[2].includes('${') ? process.argv[2] : process.cwd();

/** The sentence Claude receives for each button. */
export const NOTIFICATIONS = {
  check: (/** @type {string} */ task) => `Menitor window: the learner pressed "Check my work" on task ${task}. Run the menitor:check skill now, exactly as if they had typed /menitor:check.`,
  hint: (/** @type {string} */ task) => `Menitor window: the learner pressed "Hint" on task ${task}. Run the menitor:hint skill now, exactly as if they had typed /menitor:hint.`,
  stuck: (/** @type {string} */ task) => `Menitor window: the learner pressed "I'm stuck" on task ${task}. Run the menitor:stuck skill now, exactly as if they had typed /menitor:stuck.`,
};

/** @type {import('../../core/lib/paths.js').StatePaths | null} */
let paths = null;
/** Events already printed, by id. */
const seen = new Set();
let lastBeat = 0;

/** @param {string} line */
function say(line) {
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    shutdown();
  }
}

function shutdown() {
  if (paths) stopListening(paths);
  process.exit(0);
}

function tick() {
  if (!paths) {
    const root = findRoot(start);
    if (!root) return;
    paths = statePaths(root);
  }
  if (!fs.existsSync(paths.dir)) {
    // The project's Menitor state went away; wait for it to come back.
    paths = null;
    return;
  }
  const now = Date.now();
  if (now - lastBeat >= HEARTBEAT_MS) {
    try {
      beat(paths, { agent: 'claude-code', startedAt });
      lastBeat = now;
    } catch (err) {
      process.stderr.write(`menitor monitor: could not write the heartbeat: ${/** @type {Error} */ (err).message}\n`);
    }
  }
  for (const e of readInbox(paths)) {
    if (e.at < startedAt || seen.has(e.id)) continue;
    seen.add(e.id);
    const make = NOTIFICATIONS[e.type];
    if (make) say(make(e.task ?? 'the current task'));
  }
  if (seen.size > 1000) {
    // Old ids can't come back: they are older than anything still in the inbox's short tail.
    const keep = new Set(readInbox(paths).map((e) => e.id));
    for (const id of seen) if (!keep.has(id)) seen.delete(id);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGHUP', shutdown);
process.stdout.on('error', shutdown);

tick();
// Poll quickly once a project is found, and gently while waiting for one.
const loop = () => {
  try {
    tick();
  } catch (err) {
    process.stderr.write(`menitor monitor: ${/** @type {Error} */ (err).message}\n`);
  }
  setTimeout(loop, paths ? POLL_MS : WAIT_MS);
};
setTimeout(loop, paths ? POLL_MS : WAIT_MS);

