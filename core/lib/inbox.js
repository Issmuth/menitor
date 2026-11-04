// The path from a window button to the agent session (W-6), with no free text anywhere (W-7).
//
//   window server  --appends fixed events-->  .menitor/inbox.jsonl  --read by-->  the adapter's listener
//   the listener   --writes a heartbeat---->  .menitor/listener.json --read by-->  the window server
//
// The window writes an event only while a listener's heartbeat is fresh. Otherwise its buttons
// fall back to copying the command for the learner to type.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { readJsonOrNull, writeFileAtomic, writeJsonAtomic } from './fsx.js';
import { validate } from './schema.js';
import { SCHEMAS } from './state.js';

/** A heartbeat older than this means no session is listening. */
export const LISTENER_STALE_MS = 15000;
export const HEARTBEAT_MS = 5000;
/** The same button pressed again within this window counts once. */
export const DEDUPE_MS = 5000;
const KEEP_LINES = 200;
const MAX_LINES = 500;

/**
 * @typedef {import('./paths.js').StatePaths} StatePaths
 * @typedef {{ id: string, at: string, type: 'check' | 'hint' | 'stuck', task: string | null }} InboxEvent
 * @typedef {{ version: 1, pid: number, beatAt: string, startedAt: string, agent: string }} Listener
 */

/**
 * Is a process with this pid running?
 * @param {number} pid
 */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

/**
 * The listener, if its heartbeat is fresh and its process is alive.
 * @param {StatePaths} paths
 * @param {number} [now]
 * @returns {Listener | null}
 */
export function liveListener(paths, now = Date.now()) {
  let info;
  try {
    info = readJsonOrNull(paths.listener);
  } catch {
    return null;
  }
  if (!info || validate(SCHEMAS.listener, info).length) return null;
  const listener = /** @type {Listener} */ (info);
  const age = now - Date.parse(listener.beatAt);
  if (!(age >= -HEARTBEAT_MS && age <= LISTENER_STALE_MS)) return null;
  return pidAlive(listener.pid) ? listener : null;
}

/**
 * Write the listener's heartbeat. For the agent adapter's listener only.
 * @param {StatePaths} paths
 * @param {{ agent: string, startedAt: string, now?: Date }} options
 */
export function beat(paths, options) {
  /** @type {Listener} */
  const info = { version: 1, pid: process.pid, beatAt: (options.now ?? new Date()).toISOString(), startedAt: options.startedAt, agent: options.agent };
  writeJsonAtomic(paths.listener, info);
  return info;
}

/**
 * Remove the heartbeat, if it's still this process's.
 * @param {StatePaths} paths
 */
export function stopListening(paths) {
  try {
    const info = /** @type {Listener | null} */ (readJsonOrNull(paths.listener));
    if (info?.pid === process.pid) fs.rmSync(paths.listener, { force: true });
  } catch {
    // Nothing to clean up.
  }
}

/**
 * Every valid event in the inbox, oldest first. Broken lines are skipped.
 * @param {StatePaths} paths
 * @returns {InboxEvent[]}
 */
export function readInbox(paths) {
  let text;
  try {
    text = fs.readFileSync(paths.inbox, 'utf8');
  } catch {
    return [];
  }
  /** @type {InboxEvent[]} */
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (validate(SCHEMAS.inboxEvent, e).length === 0) events.push(e);
    } catch {
      // A torn or edited line is ignored.
    }
  }
  return events;
}

/**
 * Append one button press. For the window server only. Keeps the file short.
 * @param {StatePaths} paths
 * @param {{ type: 'check' | 'hint' | 'stuck', task: string | null }} event
 * @param {Date} [now]
 * @returns {InboxEvent}
 */
export function appendInbox(paths, event, now = new Date()) {
  /** @type {InboxEvent} */
  const e = { id: crypto.randomBytes(9).toString('base64url'), at: now.toISOString(), type: event.type, task: event.task };
  const errors = validate(SCHEMAS.inboxEvent, e);
  if (errors.length) throw new Error(`Invalid window event: ${errors.map((x) => `${x.path} ${x.message}`).join('; ')}`);
  fs.appendFileSync(paths.inbox, `${JSON.stringify(e)}\n`, 'utf8');
  const lines = fs.readFileSync(paths.inbox, 'utf8').split('\n').filter(Boolean);
  if (lines.length > MAX_LINES) writeFileAtomic(paths.inbox, `${lines.slice(-KEEP_LINES).join('\n')}\n`);
  return e;
}

/**
 * Deliver a button press to a listening session, if there is one. Repeated presses of the same
 * button within a few seconds count once.
 * @param {StatePaths} paths
 * @param {{ type: 'check' | 'hint' | 'stuck', task: string | null }} event
 * @param {Date} [now]
 * @returns {{ delivered: boolean, duplicate: boolean }}
 */
export function deliverToListener(paths, event, now = new Date()) {
  if (!liveListener(paths, now.getTime())) return { delivered: false, duplicate: false };
  const recent = readInbox(paths).filter((e) => e.type === event.type && now.getTime() - Date.parse(e.at) < DEDUPE_MS);
  if (recent.length) return { delivered: true, duplicate: true };
  appendInbox(paths, event, now);
  return { delivered: true, duplicate: false };
}
