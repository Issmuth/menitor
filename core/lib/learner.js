// learner.md: a validated frontmatter block followed by free-form notes.
//
// The frontmatter uses a small, strict YAML subset so the file stays readable and easy to
// edit by hand without a YAML dependency:
//
//   key: scalar          (null, true, false, an integer, a "quoted" or bare string)
//   key: []              (an empty list)
//   key:                 (a list, one "  - item" per line)
//     - item
//   key:                 (a map of scalars, one "  sub: scalar" per line)
//     sub: 1

import { MenitorError } from './errors.js';

export const RUNGS = /** @type {const} */ (['concept', 'approach', 'pseudocode', 'snippet']);
export const LEVELS = /** @type {const} */ (['guided', 'standard', 'fast']);
export const LEARNER_LISTS = /** @type {const} */ (['focusAreas', 'strengths', 'mistakes', 'revisit']);

/**
 * @typedef {'concept' | 'approach' | 'pseudocode' | 'snippet'} Rung
 * @typedef {'guided' | 'standard' | 'fast'} Level
 * @typedef {object} LearnerProfile
 * @property {Level | null} level
 * @property {string[]} focusAreas
 * @property {string[]} strengths
 * @property {string[]} mistakes
 * @property {string[]} revisit
 * @property {Record<Rung, number>} hintsUsed
 * @typedef {{ profile: LearnerProfile, notes: string }} Learner
 */

/** @returns {Learner} */
export function defaultLearner() {
  return {
    profile: {
      level: null,
      focusAreas: [],
      strengths: [],
      mistakes: [],
      revisit: [],
      hintsUsed: { concept: 0, approach: 0, pseudocode: 0, snippet: 0 },
    },
    notes: '# Learner notes\n\nDated observations from checks, hints and explain-back answers.\n',
  };
}

const RESERVED = new Set(['null', '~', 'true', 'false', '[]', '{}']);

/**
 * @param {string} raw
 * @param {number} lineNo
 * @returns {unknown}
 */
function parseScalar(raw, lineNo) {
  const text = raw.trim();
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new MenitorError(`learner.md line ${lineNo}: the quoted string is not closed properly`);
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) {
      throw new MenitorError(`learner.md line ${lineNo}: the quoted string is not closed properly`);
    }
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('[') || text.startsWith('{')) {
    throw new MenitorError(`learner.md line ${lineNo}: write lists one "- item" per line instead of [a, b]`);
  }
  return text;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  const plain = /^[A-Za-z][A-Za-z0-9 ._/()+,-]*$/.test(text) && !text.endsWith(' ') && !RESERVED.has(text);
  return plain ? text : JSON.stringify(text);
}

/**
 * Split learner.md into its frontmatter lines and the notes after it.
 * @param {string} text
 */
function splitFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new MenitorError('learner.md must start with a "---" frontmatter block');
  }
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) throw new MenitorError('learner.md frontmatter has no closing "---" line');
  const afterMarker = normalized.indexOf('\n', end + 1);
  return {
    front: normalized.slice(4, end).split('\n'),
    notes: afterMarker === -1 ? '' : normalized.slice(afterMarker + 1).replace(/^\n/, ''),
  };
}

/**
 * Parse learner.md. The caller validates the profile against the schema.
 * @param {string} text
 * @returns {{ profile: Record<string, unknown>, notes: string }}
 */
export function parseLearner(text) {
  const { front, notes } = splitFrontmatter(text);
  /** @type {Record<string, any>} */
  const profile = {};
  /** @type {string | null} */
  let openKey = null;

  front.forEach((line, i) => {
    const lineNo = i + 2;
    if (line.trim() === '' || line.trim().startsWith('#')) return;

    const top = /^([A-Za-z][A-Za-z0-9]*):(.*)$/.exec(line);
    if (top) {
      const [, key, rest] = top;
      if (key in profile) throw new MenitorError(`learner.md line ${lineNo}: "${key}" appears twice`);
      if (rest.trim() === '') {
        profile[key] = undefined;
        openKey = key;
      } else {
        profile[key] = parseScalar(rest, lineNo);
        openKey = null;
      }
      return;
    }

    if (!/^\s+/.test(line) || openKey === null) {
      throw new MenitorError(`learner.md line ${lineNo}: expected "key: value"`);
    }

    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      if (profile[openKey] === undefined) profile[openKey] = [];
      if (!Array.isArray(profile[openKey])) {
        throw new MenitorError(`learner.md line ${lineNo}: "${openKey}" mixes list items and fields`);
      }
      profile[openKey].push(parseScalar(item[1], lineNo));
      return;
    }

    const sub = /^\s+([A-Za-z][A-Za-z0-9]*):(.*)$/.exec(line);
    if (sub) {
      if (profile[openKey] === undefined) profile[openKey] = {};
      if (Array.isArray(profile[openKey])) {
        throw new MenitorError(`learner.md line ${lineNo}: "${openKey}" mixes list items and fields`);
      }
      profile[openKey][sub[1]] = parseScalar(sub[2], lineNo);
      return;
    }

    throw new MenitorError(`learner.md line ${lineNo}: expected "- item" or "field: value"`);
  });

  for (const [key, value] of Object.entries(profile)) {
    if (value === undefined) profile[key] = null;
  }
  return { profile, notes };
}

/**
 * Turn a learner back into learner.md text.
 * @param {Learner} learner
 */
export function serializeLearner(learner) {
  const p = learner.profile;
  const lines = ['---', `level: ${formatScalar(p.level)}`];
  for (const key of LEARNER_LISTS) {
    const list = p[key];
    if (list.length === 0) {
      lines.push(`${key}: []`);
    } else {
      lines.push(`${key}:`);
      for (const item of list) lines.push(`  - ${formatScalar(item)}`);
    }
  }
  lines.push('hintsUsed:');
  for (const rung of RUNGS) lines.push(`  ${rung}: ${p.hintsUsed[rung]}`);
  lines.push('---', '');
  const notes = learner.notes.endsWith('\n') ? learner.notes : `${learner.notes}\n`;
  return `${lines.join('\n')}\n${notes}`;
}

/**
 * Append a dated line to the notes.
 * @param {Learner} learner
 * @param {string} text
 * @param {Date} [now]
 */
export function addNote(learner, text, now = new Date()) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new MenitorError('A note needs some text');
  const base = learner.notes.endsWith('\n') ? learner.notes : `${learner.notes}\n`;
  learner.notes = `${base}- ${now.toISOString().slice(0, 10)}: ${clean}\n`;
}
