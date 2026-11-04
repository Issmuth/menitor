// Load and save the files in .menitor/. Every save is schema-validated and atomic.
//
// Each file has one writer, so the window and the agent never overwrite each other:
//   plan.json, session.json, learner.md  -> the CLI (the agent goes through it)
//   progress.json                        -> the task window
//   guard.json                           -> agent-adapter hooks, from commands the learner typed
//   log.md                               -> appended by the CLI and adapter hooks
//   activity.jsonl                       -> appended by adapter hooks

import fs from 'node:fs';
import path from 'node:path';
import { validate, formatErrors } from './schema.js';
import { MenitorError } from './errors.js';
import { readJsonOrNull, readTextOrNull, writeFileAtomic, writeJsonAtomic } from './fsx.js';
import { defaultLearner, parseLearner, serializeLearner } from './learner.js';
import { planProblems } from './plan.js';

/**
 * @typedef {import('./paths.js').StatePaths} StatePaths
 * @typedef {import('./plan.js').Plan} Plan
 * @typedef {import('./learner.js').Learner} Learner
 * @typedef {{ at: string, ok: boolean, head: string | null, problems?: number }} LastCheck
 * @typedef {{ version: 1, currentTask: string | null, tasks: Record<string, { startCommit: string | null, startedAt: string, lastCheck?: LastCheck }> }} Session
 * @typedef {{ version: 1, ticks: Record<string, string> }} Progress
 * @typedef {{ version: 1, mentorMode: 'on' | 'off', modeChangedAt?: string | null, skipRequests: Record<string, string>, grants: Record<string, string> }} Guard
 */

/**
 * @param {string} name
 * @returns {Record<string, any>}
 */
function loadSchema(name) {
  return JSON.parse(fs.readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
}

export const SCHEMAS = {
  plan: loadSchema('plan'),
  session: loadSchema('session'),
  progress: loadSchema('progress'),
  guard: loadSchema('guard'),
  learner: loadSchema('learner'),
  activity: loadSchema('activity'),
};

/**
 * @param {keyof typeof SCHEMAS} name
 * @param {unknown} value
 * @param {string} label
 */
export function assertValid(name, value, label) {
  const errors = validate(SCHEMAS[name], value);
  if (errors.length) {
    throw new MenitorError(`${label} is invalid:\n${formatErrors(errors)}`, {
      details: errors.map((e) => `${e.path} ${e.message}`),
    });
  }
}

// plan.json

/**
 * @param {StatePaths} paths
 * @returns {Plan | null}
 */
export function loadPlan(paths) {
  const plan = readJsonOrNull(paths.plan);
  if (plan === null) return null;
  assertValid('plan', plan, 'plan.json');
  return /** @type {Plan} */ (plan);
}

/**
 * @param {StatePaths} paths
 * @returns {Plan}
 */
export function requirePlan(paths) {
  const plan = loadPlan(paths);
  if (!plan) throw new MenitorError('There is no plan yet. Import one with "menitor plan import".');
  return plan;
}

/**
 * Validate the plan fully, including the rules the schema cannot express, then write it.
 * @param {StatePaths} paths
 * @param {Plan} plan
 * @returns {string[]} warnings
 */
export function savePlan(paths, plan) {
  assertValid('plan', plan, 'The plan');
  const { errors, warnings } = planProblems(plan, loadLearner(paths).profile);
  if (errors.length) {
    throw new MenitorError(`The plan is invalid:\n${errors.map((e) => `  ${e}`).join('\n')}`, { details: errors });
  }
  writeJsonAtomic(paths.plan, plan);
  return warnings;
}

// session.json

/** @returns {Session} */
export function defaultSession() {
  return { version: 1, currentTask: null, tasks: {} };
}

/**
 * @param {StatePaths} paths
 * @returns {Session}
 */
export function loadSession(paths) {
  const session = readJsonOrNull(paths.session);
  if (session === null) return defaultSession();
  assertValid('session', session, 'session.json');
  return /** @type {Session} */ (session);
}

/**
 * @param {StatePaths} paths
 * @param {Session} session
 */
export function saveSession(paths, session) {
  assertValid('session', session, 'The session');
  writeJsonAtomic(paths.session, session);
}

// progress.json (the window writes it; the CLI only reads it)

/** @returns {Progress} */
export function defaultProgress() {
  return { version: 1, ticks: {} };
}

/**
 * @param {StatePaths} paths
 * @returns {Progress}
 */
export function loadProgress(paths) {
  const progress = readJsonOrNull(paths.progress);
  if (progress === null) return defaultProgress();
  assertValid('progress', progress, 'progress.json');
  return /** @type {Progress} */ (progress);
}

/**
 * For the task window only.
 * @param {StatePaths} paths
 * @param {Progress} progress
 */
export function saveProgress(paths, progress) {
  assertValid('progress', progress, 'The progress');
  writeJsonAtomic(paths.progress, progress);
}

// guard.json (adapter hooks write it; the CLI only reads it)

/** @returns {Guard} */
export function defaultGuard() {
  return { version: 1, mentorMode: 'on', modeChangedAt: null, skipRequests: {}, grants: {} };
}

/**
 * @param {StatePaths} paths
 * @returns {Guard}
 */
export function loadGuard(paths) {
  const guard = readJsonOrNull(paths.guard);
  if (guard === null) return defaultGuard();
  assertValid('guard', guard, 'guard.json');
  return /** @type {Guard} */ (guard);
}

/**
 * For agent-adapter hooks only, after the learner typed a command.
 * @param {StatePaths} paths
 * @param {Guard} guard
 */
export function saveGuard(paths, guard) {
  assertValid('guard', guard, 'The guard');
  writeJsonAtomic(paths.guard, guard);
}

// learner.md

/**
 * @param {StatePaths} paths
 * @returns {Learner}
 */
export function loadLearner(paths) {
  const text = readTextOrNull(paths.learner);
  if (text === null) return defaultLearner();
  const { profile, notes } = parseLearner(text);
  assertValid('learner', profile, 'learner.md frontmatter');
  return { profile: /** @type {Learner['profile']} */ (/** @type {unknown} */ (profile)), notes };
}

/**
 * @param {StatePaths} paths
 * @param {Learner} learner
 */
export function saveLearner(paths, learner) {
  assertValid('learner', learner.profile, 'The learner profile');
  writeFileAtomic(paths.learner, serializeLearner(learner));
}

/**
 * Whether .menitor/ already holds state.
 * @param {StatePaths} paths
 */
export function isInitialized(paths) {
  return fs.existsSync(paths.dir) && ['plan.json', 'session.json', 'learner.md', 'log.md'].some((f) => fs.existsSync(path.join(paths.dir, f)));
}
