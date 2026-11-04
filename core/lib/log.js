// log.md: a dated, append-only history of checks, hints, skips and disputes.
//
// Each event is one Markdown list line so the file stays readable and the stats stay computable:
//
//   - 2026-11-04T16:20:00.000Z check task=t7 result=fail mustFix=2 nice=1
//
// Values with spaces or symbols are written as JSON strings: note="Asked about indexes".
// Lines are appended with O_APPEND rather than rewritten, so hooks and the CLI can both
// add events without losing each other's lines.

import fs from 'node:fs';
import { MenitorError, refused } from './errors.js';
import { RUNGS } from './learner.js';

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const RUNG_ENUM = RUNGS.join('|');

/**
 * Field specs: "id", "int", "text" or "a|b|c" (an enum). A trailing "?" marks the field optional.
 * Every event also accepts an optional note.
 * @type {Record<string, Record<string, string>>}
 */
export const EVENTS = {
  init: {},
  session: {},
  'plan-approved': { tasks: 'int' },
  'task-start': { task: 'id' },
  check: { task: 'id', result: 'pass|fail', mustFix: 'int?', nice: 'int?' },
  explain: { task: 'id', outcome: 'good|weak', try: 'int' },
  revisit: { task: 'id', concept: 'text' },
  hint: { task: 'id', rung: RUNG_ENUM },
  stuck: { task: 'id' },
  skip: { task: 'id', stage: 'requested|confirmed' },
  delegated: { task: 'id', skipped: 'true|false' },
  dispute: { task: 'id', outcome: 'upheld|withdrawn' },
  deploy: { url: 'text' },
  fix: { task: 'id', item: 'text' },
  pass: { task: 'id', by: 'learner|delegated' },
  level: { from: 'text', to: 'guided|standard|fast' },
  mode: { value: 'on|off' },
  note: { text: 'text' },
};

/** Events the agent may log by hand with `menitor log`. The rest are written by the commands that cause them. */
export const AGENT_EVENTS = new Set(['check', 'explain', 'stuck', 'dispute', 'deploy', 'note']);

/** Events only adapter hooks write, because they record what the learner typed. */
export const LEARNER_EVENTS = new Set(['skip', 'mode', 'session']);

export const LOG_HEADER =
  '# Menitor log\n\nOne line per event, oldest first. The menitor CLI writes this file; hand edits can break `menitor stats`.\n\n';

/**
 * @typedef {{ at: string, event: string, fields: Record<string, string> }} LogEvent
 */

/**
 * @param {string} spec
 * @param {string} value
 */
function matchesSpec(spec, value) {
  const base = spec.replace(/\?$/, '');
  if (base === 'id') return ID.test(value);
  if (base === 'int') return /^\d+$/.test(value);
  if (base === 'text') return value.length > 0 && value.length <= 1000;
  return base.split('|').includes(value);
}

/**
 * Check an event against its spec. Throws a MenitorError listing every problem.
 * @param {string} event
 * @param {Record<string, string>} fields
 */
export function validateEvent(event, fields) {
  const spec = EVENTS[event];
  if (!spec) {
    throw new MenitorError(`Unknown log event "${event}". Known events: ${Object.keys(EVENTS).join(', ')}`);
  }
  const problems = [];
  for (const [key, type] of Object.entries(spec)) {
    if (!(key in fields)) {
      if (!type.endsWith('?')) problems.push(`${key} is required`);
    } else if (!matchesSpec(type, fields[key])) {
      const base = type.replace(/\?$/, '');
      problems.push(`${key}=${fields[key]} must be ${base === 'id' ? 'a task ID' : base === 'int' ? 'a whole number' : base === 'text' ? 'non-empty text' : `one of ${base.split('|').join(', ')}`}`);
    }
  }
  for (const key of Object.keys(fields)) {
    if (!(key in spec) && key !== 'note') problems.push(`${key} is not a field of "${event}"`);
  }
  if ('note' in fields && !matchesSpec('text', fields.note)) problems.push('note must be non-empty text');
  if (problems.length) throw new MenitorError(`Invalid "${event}" event`, { details: problems });
}

/**
 * @param {string} value
 */
function formatValue(value) {
  return /^[A-Za-z0-9._:/#@+-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Format one event as a log line (without a trailing newline).
 * @param {string} event
 * @param {Record<string, string | number | boolean>} fields
 * @param {Date} [now]
 */
export function formatEvent(event, fields, now = new Date()) {
  const parts = [`- ${now.toISOString()}`, event];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${formatValue(String(value).replace(/[\r\n]+/g, ' '))}`);
  }
  return parts.join(' ');
}

const LINE = /^- (\d{4}-\d{2}-\d{2}T[\d:.]+Z) ([a-z][a-z-]*)((?: [A-Za-z]+=(?:"(?:[^"\\]|\\.)*"|\S+))*)\s*$/;
const FIELD = /([A-Za-z]+)=("(?:[^"\\]|\\.)*"|\S+)/g;

/**
 * Parse log.md. Lines that are not events (the header, blank lines) are skipped.
 * @param {string} text
 * @returns {LogEvent[]}
 */
export function parseLog(text) {
  /** @type {LogEvent[]} */
  const events = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    /** @type {Record<string, string>} */
    const fields = {};
    for (const f of m[3].matchAll(FIELD)) {
      let value = f[2];
      if (value.startsWith('"')) {
        try {
          value = JSON.parse(value);
        } catch {
          // Keep the raw value; a hand edit broke the quoting.
        }
      }
      fields[f[1]] = value;
    }
    events.push({ at: m[1], event: m[2], fields });
  }
  return events;
}

/**
 * Validate and append one event to log.md, creating the file with its header if needed.
 * @param {string} file
 * @param {string} event
 * @param {Record<string, string | number | boolean>} fields
 * @param {Date} [now]
 */
export function appendEvent(file, event, fields, now = new Date()) {
  /** @type {Record<string, string>} */
  const asText = {};
  for (const [k, v] of Object.entries(fields)) asText[k] = String(v);
  validateEvent(event, asText);
  const prefix = fs.existsSync(file) ? '' : LOG_HEADER;
  fs.appendFileSync(file, `${prefix}${formatEvent(event, fields, now)}\n`, 'utf8');
}

/**
 * Parse `key=value` arguments from the command line.
 * @param {string[]} args
 */
export function parseFieldArgs(args) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq <= 0) throw new MenitorError(`Expected key=value, got "${arg}"`);
    fields[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return fields;
}

/**
 * Append an event the agent asked for by hand, refusing events the CLI or the learner own.
 * @param {string} file
 * @param {string} event
 * @param {Record<string, string>} fields
 */
export function appendAgentEvent(file, event, fields) {
  if (!(event in EVENTS)) validateEvent(event, fields);
  if (LEARNER_EVENTS.has(event)) {
    throw refused(`"${event}" events record what the learner typed, so only the learner's own commands can log them.`);
  }
  if (!AGENT_EVENTS.has(event)) {
    throw refused(`"${event}" events are logged automatically by the command that causes them. You can log: ${[...AGENT_EVENTS].join(', ')}.`);
  }
  appendEvent(file, event, fields);
}
