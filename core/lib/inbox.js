// The path from a window button to the agent session (W-6), with no free text anywhere (W-7).
//
//   window server  --appends fixed events-->  .menitor/inbox.jsonl  --read by-->  the adapter's listeners
//   a monitor      --writes a heartbeat---->  .menitor/listener.json --read by-->  the window server
//   a waiting tool --writes a heartbeat---->  .menitor/waiter.json   --read by-->  the window server
//
// Two kinds of listener exist. A monitor runs for the whole session and wakes it when idle; a
// waiter is an agent tool call that blocks until the next button press. Each event is handled
// once: a listener claims it first, by creating a file that can only be created once.
//
// The window writes an event only while a listener's heartbeat is fresh. Otherwise its buttons
// fall back to copying the command for the learner to type.

import fs from 'node:fs';
import path from 'node:path';
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
 * @typedef {'check' | 'hint' | 'stuck' | 'go' | 'answer'} InboxType
 * @typedef {{ id: string, at: string, type: InboxType, task: string | null }} InboxEvent
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
  return freshBeat(paths.waiter, now) ?? freshBeat(paths.listener, now);
}

/**
 * @param {string} file
 * @param {number} now
 * @returns {Listener | null}
 */
function freshBeat(file, now) {
  let info;
  try {
    info = readJsonOrNull(file);
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
 * Write a heartbeat. For the agent adapter's listeners only: the monitor (the default file) or a
 * waiting tool call (`file: paths.waiter`).
 * @param {StatePaths} paths
 * @param {{ agent: string, startedAt: string, now?: Date, file?: string }} options
 */
export function beat(paths, options) {
  /** @type {Listener} */
  const info = { version: 1, pid: process.pid, beatAt: (options.now ?? new Date()).toISOString(), startedAt: options.startedAt, agent: options.agent };
  writeJsonAtomic(options.file ?? paths.listener, info);
  return info;
}

/**
 * Remove a heartbeat, if it's still this process's.
 * @param {StatePaths} paths
 * @param {string} [file]
 */
export function stopListening(paths, file = paths.listener) {
  try {
    const info = /** @type {Listener | null} */ (readJsonOrNull(file));
    if (info?.pid === process.pid) fs.rmSync(file, { force: true });
  } catch {
    // Nothing to clean up.
  }
}

/**
 * Take an event so no other listener handles it too. Creating the claim file is atomic: exactly
 * one caller gets true.
 * @param {StatePaths} paths
 * @param {string} id
 */
export function claimEvent(paths, id) {
  try {
    fs.mkdirSync(paths.claims, { recursive: true });
    fs.closeSync(fs.openSync(path.join(paths.claims, id), 'wx'));
  } catch {
    return false;
  }
  pruneClaims(paths);
  return true;
}

/**
 * @param {StatePaths} paths
 * @param {string} id
 */
export function isClaimed(paths, id) {
  return fs.existsSync(path.join(paths.claims, id));
}

/**
 * Keep the claims folder small: drop claims for events the inbox no longer holds.
 * @param {StatePaths} paths
 */
function pruneClaims(paths) {
  let names;
  try {
    names = fs.readdirSync(paths.claims);
  } catch {
    return;
  }
  if (names.length <= KEEP_LINES) return;
  const live = new Set(readInbox(paths).map((e) => e.id));
  for (const name of names) if (!live.has(name)) fs.rmSync(path.join(paths.claims, name), { force: true });
}

/**
 * The oldest event no listener has taken yet, from the last `withinMs` milliseconds.
 * @param {StatePaths} paths
 * @param {{ now?: number, withinMs?: number }} [options]
 */
export function nextUnclaimed(paths, options = {}) {
  const now = options.now ?? Date.now();
  const within = options.withinMs ?? 10 * 60 * 1000;
  return readInbox(paths).find((e) => now - Date.parse(e.at) <= within && !isClaimed(paths, e.id)) ?? null;
}

/**
 * Wait for the learner's next button press in the window, as an agent tool call does. Returns the
 * claimed event, or null when the time runs out or the signal aborts. While it waits, a heartbeat
 * tells the window that buttons reach the session.
 * @param {StatePaths} paths
 * @param {{ timeoutMs: number, signal?: AbortSignal, pollMs?: number, agent?: string, onTick?: () => void }} options
 * @returns {Promise<InboxEvent | null>}
 */
export async function waitForEvent(paths, options) {
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + options.timeoutMs;
  const poll = options.pollMs ?? 300;
  let lastBeat = 0;
  try {
    while (!options.signal?.aborted && Date.now() < deadline) {
      if (Date.now() - lastBeat >= 2000) {
        beat(paths, { agent: options.agent ?? 'waiter', startedAt, file: paths.waiter });
        lastBeat = Date.now();
        options.onTick?.();
      }
      const event = nextUnclaimed(paths);
      if (event && claimEvent(paths, event.id)) return event;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, poll);
        options.signal?.addEventListener('abort', () => (clearTimeout(t), resolve(undefined)), { once: true });
      });
    }
    return null;
  } finally {
    stopListening(paths, paths.waiter);
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
 * @param {{ type: InboxType, task: string | null }} event
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

/** The activity log's mark for "the agent ended its turn", written by the adapter's stop hook. */
export const TURN_END = 'turn-end';
/** Button presses, as opposed to answers sent from the window. */
const BUTTONS = new Set(['check', 'hint', 'stuck', 'go']);
/** A press older than this is over, whatever happened to it. */
export const PRESS_WINDOW_MS = 30 * 60 * 1000;
/** How much of the end of the activity log to read for the last turn end. */
const ACTIVITY_TAIL = 64 * 1024;

/**
 * @typedef {{ type: InboxType, task: string | null, at: string, claimedAt: string | null, state: 'sent' | 'working' | 'done', doneAt: string | null }} Press
 */

/**
 * Where the last button press stands, so the window can show it: sent until a listener claims it,
 * working until the agent ends its turn or listens again, then done. Null when there is no recent
 * press, or when one was never picked up and nobody is listening any more.
 * @param {StatePaths} paths
 * @param {number} [now]
 * @returns {Press | null}
 */
export function pressState(paths, now = Date.now()) {
  const e = readInbox(paths).filter((x) => BUTTONS.has(x.type)).at(-1);
  if (!e || now - Date.parse(e.at) > PRESS_WINDOW_MS) return null;
  let claimedAt = null;
  try {
    claimedAt = fs.statSync(path.join(paths.claims, e.id)).mtime.toISOString();
  } catch {
    claimedAt = null;
  }
  const listener = liveListener(paths, now);
  const base = { type: e.type, task: e.task, at: e.at, claimedAt };
  if (!claimedAt) return listener ? { ...base, state: 'sent', doneAt: null } : null;
  const doneAt = lastTurnEnd(paths.activity, claimedAt) ?? (listener && listener.startedAt > claimedAt ? listener.startedAt : null);
  return { ...base, state: doneAt ? 'done' : 'working', doneAt };
}

/**
 * The time of the last turn end in the activity log after `after`, reading only the log's end.
 * @param {string} file
 * @param {string} after an ISO time
 */
function lastTurnEnd(file, after) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, ACTIVITY_TAIL);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(TURN_END)) continue;
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.tool === TURN_END && typeof entry.at === 'string') return entry.at > after ? entry.at : null;
    } catch {
      // A torn first line from reading mid-file.
    }
  }
  return null;
}

/**
 * Deliver a button press to a listening session, if there is one. Repeated presses of the same
 * button within a few seconds count once.
 * @param {StatePaths} paths
 * @param {{ type: InboxType, task: string | null }} event
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
