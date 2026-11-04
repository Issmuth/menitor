// Operations that change Menitor state. The CLI, adapter hooks and the window all go through here,
// so every rule lives in one place.

import fs from 'node:fs';
import path from 'node:path';
import { MenitorError, refused } from './errors.js';
import { statePaths } from './paths.js';
import { headCommit } from './git.js';
import { writeFileAtomic } from './fsx.js';
import { appendEvent, LOG_HEADER, parseLog } from './log.js';
import { defaultLearner, addNote, LEVELS, LEARNER_LISTS } from './learner.js';
import { allTasks, appendFixes, findTask, isFocusTask, nextTodo, normalizePlanInput, planProblems, revealNextHint, setHints } from './plan.js';
import { validate } from './schema.js';
import { cardData } from './card.js';
import { readDocLink } from './docs.js';
import {
  SCHEMAS,
  defaultSession,
  isInitialized,
  loadGuard,
  loadLearner,
  loadPlan,
  loadProgress,
  loadSession,
  requirePlan,
  savePlan,
  saveLearner,
  saveSession,
} from './state.js';

/**
 * @typedef {import('./paths.js').StatePaths} StatePaths
 * @typedef {import('./plan.js').Plan} Plan
 * @typedef {import('./plan.js').TaskEntry} TaskEntry
 * @typedef {import('./state.js').Session} Session
 */

export const STATE_GITIGNORE = `# Menitor keeps personal state out of your portfolio repo.
# plan.json is committed so the plan travels with the code.
progress.json
session.json
guard.json
learner.md
log.md
activity.jsonl
warmup/
*.tmp
`;

/**
 * Create .menitor/ with an empty session, a blank learner profile and the log.
 * @param {string} root
 * @param {{ now?: Date }} [options]
 */
export function initProject(root, options = {}) {
  const paths = statePaths(root);
  if (isInitialized(paths)) throw new MenitorError(`${paths.dir} already exists. Menitor is set up here.`);
  fs.mkdirSync(paths.dir, { recursive: true });
  writeFileAtomic(paths.gitignore, STATE_GITIGNORE);
  saveSession(paths, defaultSession());
  saveLearner(paths, defaultLearner());
  writeFileAtomic(paths.log, LOG_HEADER);
  appendEvent(paths.log, 'init', {}, options.now);
  return paths;
}

/**
 * Validate a draft plan without writing it.
 * @param {StatePaths} paths
 * @param {unknown} raw
 */
export function lintPlan(paths, raw) {
  const plan = normalizePlanInput(raw);
  const schemaErrors = validate(SCHEMAS.plan, plan).map((e) => `${e.path} ${e.message}`);
  if (schemaErrors.length) return { plan, errors: schemaErrors, warnings: [] };
  const { errors, warnings } = planProblems(plan, loadLearner(paths).profile);
  return { plan, errors, warnings };
}

/**
 * Replace the plan. Allowed only before the learner approves it.
 * @param {StatePaths} paths
 * @param {unknown} raw
 */
export function importPlan(paths, raw) {
  const existing = loadPlan(paths);
  if (existing?.approvedAt) {
    throw refused('The plan is locked because the learner approved it. Changing it mid-project is pivot, which arrives in v1.1.');
  }
  const { plan, errors } = lintPlan(paths, raw);
  if (errors.length) {
    throw new MenitorError(`The plan is invalid:\n${errors.map((e) => `  ${e}`).join('\n')}`, { details: errors });
  }
  const warnings = savePlan(paths, plan);
  return { plan, warnings };
}

/**
 * Make a task current and record where it started (C-8).
 * @param {StatePaths} paths
 * @param {Session} session
 * @param {TaskEntry} entry
 * @param {Date} now
 */
function startTask(paths, session, entry, now) {
  session.currentTask = entry.task.id;
  session.tasks[entry.task.id] = { startCommit: headCommit(paths.root), startedAt: now.toISOString() };
  saveSession(paths, session);
  appendEvent(paths.log, 'task-start', { task: entry.task.id }, now);
}

/**
 * Lock the plan and start the first task. The learner approves; the agent records it.
 * @param {StatePaths} paths
 * @param {{ now?: Date }} [options]
 */
export function approvePlan(paths, options = {}) {
  const now = options.now ?? new Date();
  const plan = requirePlan(paths);
  if (plan.approvedAt) throw new MenitorError(`The plan was already approved on ${plan.approvedAt.slice(0, 10)}`);

  const learner = loadLearner(paths).profile;
  const warnings = [];
  if (!learner.level) warnings.push('The learner has no level yet; run the warm-up and set it with "menitor learner set level"');
  if (!learner.focusAreas.length) warnings.push('The learner has no focus areas yet, so every task counts as theirs');
  for (const { task } of allTasks(plan)) {
    const file = task.docs.split('#')[0];
    if (!fs.existsSync(path.join(paths.root, file))) warnings.push(`${task.id} links to ${file}, which does not exist yet`);
  }

  plan.approvedAt = now.toISOString();
  warnings.push(...savePlan(paths, plan));
  const tasks = allTasks(plan);
  appendEvent(paths.log, 'plan-approved', { tasks: tasks.length }, now);

  const first = nextTodo(plan);
  if (first) startTask(paths, loadSession(paths), first, now);
  return { plan, first, warnings: [...new Set(warnings)] };
}

/**
 * @param {StatePaths} paths
 */
function requireApprovedPlan(paths) {
  const plan = requirePlan(paths);
  if (!plan.approvedAt) throw new MenitorError('The plan is not approved yet. The learner approves it at the end of setup.');
  return plan;
}

/**
 * The task an ID names, or the current task when no ID is given.
 * @param {Plan} plan
 * @param {Session} session
 * @param {string | undefined} id
 */
export function resolveTask(plan, session, id) {
  const taskId = id ?? session.currentTask;
  if (!taskId) throw new MenitorError(plan.approvedAt ? 'Every task is done.' : 'No task is current yet. The plan starts when the learner approves it.');
  return findTask(plan, taskId);
}

/**
 * @param {Session} session
 * @param {TaskEntry} entry
 */
function requireCurrent(session, entry) {
  if (session.currentTask !== entry.task.id) {
    throw refused(`${entry.task.id} is not the current task${session.currentTask ? ` (${session.currentTask} is)` : ''}. Tasks pass in order.`);
  }
}

/**
 * C-8: mark the current task done and start the next one.
 * @param {StatePaths} paths
 * @param {string | undefined} id
 * @param {{ note?: string, revisit?: string[], now?: Date }} [options]
 */
export function passTask(paths, id, options = {}) {
  const now = options.now ?? new Date();
  const plan = requireApprovedPlan(paths);
  const session = loadSession(paths);
  const entry = resolveTask(plan, session, id);
  requireCurrent(session, entry);

  const { task } = entry;
  task.status = 'done';
  task.passedAt = now.toISOString();
  if (options.note) task.note = options.note.trim();
  const warnings = savePlan(paths, plan);
  appendEvent(paths.log, 'pass', { task: task.id, by: task.owner }, now);

  if (options.revisit?.length) {
    const learner = loadLearner(paths);
    for (const concept of options.revisit) {
      const clean = concept.trim();
      if (!clean) continue;
      if (!learner.profile.revisit.includes(clean)) learner.profile.revisit.push(clean);
      appendEvent(paths.log, 'revisit', { task: task.id, concept: clean }, now);
    }
    saveLearner(paths, learner);
  }

  const next = nextTodo(plan);
  if (next) {
    startTask(paths, session, next, now);
  } else {
    session.currentTask = null;
    saveSession(paths, session);
  }
  return { passed: entry, next, plan, warnings };
}

/**
 * C-7: add fixes to a task's checklist.
 * @param {StatePaths} paths
 * @param {string | undefined} id
 * @param {string[]} texts
 * @param {{ now?: Date }} [options]
 */
export function fixTask(paths, id, texts, options = {}) {
  if (!texts.length) throw new MenitorError('Give at least one fix to add');
  const plan = requireApprovedPlan(paths);
  const entry = resolveTask(plan, loadSession(paths), id);
  const added = appendFixes(entry.task, texts);
  savePlan(paths, plan);
  for (const item of added) appendEvent(paths.log, 'fix', { task: entry.task.id, item: item.id }, options.now);
  return { entry, added };
}

/**
 * Store locked hint rungs for one or more tasks: { "t5": { concept, approach, pseudocode, snippet }, ... }.
 * @param {StatePaths} paths
 * @param {unknown} raw
 */
export function importHints(paths, raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MenitorError('Hints must be a JSON object keyed by task ID');
  }
  const plan = requirePlan(paths);
  const ids = Object.keys(raw);
  if (!ids.length) throw new MenitorError('No hints given');
  for (const id of ids) setHints(findTask(plan, id).task, /** @type {Record<string, unknown>} */ (raw)[id]);
  savePlan(paths, plan);
  return ids;
}

/**
 * H-2: reveal the next hint rung for a task and log it.
 * @param {StatePaths} paths
 * @param {string | undefined} id
 * @param {{ now?: Date }} [options]
 */
export function revealHint(paths, id, options = {}) {
  const plan = requireApprovedPlan(paths);
  const entry = resolveTask(plan, loadSession(paths), id);
  const hint = revealNextHint(entry.task);
  savePlan(paths, plan);
  appendEvent(paths.log, 'hint', { task: entry.task.id, rung: hint.rung }, options.now);
  const learner = loadLearner(paths);
  learner.profile.hintsUsed[hint.rung] += 1;
  saveLearner(paths, learner);
  return { entry, hint, number: entry.task.hintsRevealed };
}

/**
 * G-3 and H-6: hand the current task to the agent. A learner-owned task needs a grant that an
 * adapter hook recorded when the learner confirmed the skip themselves.
 * @param {StatePaths} paths
 * @param {string | undefined} id
 * @param {{ now?: Date }} [options]
 */
export function skipTask(paths, id, options = {}) {
  const plan = requireApprovedPlan(paths);
  const session = loadSession(paths);
  const entry = resolveTask(plan, session, id);
  requireCurrent(session, entry);
  const { task } = entry;
  if (task.owner === 'delegated') return { entry, alreadyDelegated: true };

  const grant = loadGuard(paths).grants[task.id];
  if (!grant) {
    throw refused(`${task.id} belongs to the learner. Only the learner can hand it over, by confirming the skip themselves.`);
  }
  task.owner = 'delegated';
  task.skipped = true;
  savePlan(paths, plan);
  appendEvent(paths.log, 'delegated', { task: task.id, skipped: true }, options.now);
  return { entry, alreadyDelegated: false };
}

/**
 * @param {StatePaths} paths
 * @param {string} url
 */
export function setDeployUrl(paths, url) {
  const plan = requirePlan(paths);
  plan.project.deployUrl = url;
  savePlan(paths, plan);
  return plan;
}

// Learner profile

/**
 * @param {string} key
 * @returns {typeof LEARNER_LISTS[number]}
 */
function listKey(key) {
  const found = LEARNER_LISTS.find((k) => k === key);
  if (!found) throw new MenitorError(`"${key}" is not a learner list. Lists: ${LEARNER_LISTS.join(', ')}`);
  return found;
}

/**
 * @param {StatePaths} paths
 * @param {string} key   level, or a list name (comma-separated values replace the list)
 * @param {string} value
 * @param {{ now?: Date }} [options]
 */
export function learnerSet(paths, key, value, options = {}) {
  const learner = loadLearner(paths);
  if (key === 'level') {
    if (!(/** @type {readonly string[]} */ (LEVELS)).includes(value)) throw new MenitorError(`Level must be one of ${LEVELS.join(', ')}`);
    const from = learner.profile.level ?? 'none';
    learner.profile.level = /** @type {import('./learner.js').Level} */ (value);
    saveLearner(paths, learner);
    if (from !== value) appendEvent(paths.log, 'level', { from, to: value }, options.now);
    return learner;
  }
  const list = listKey(key);
  learner.profile[list] = [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))];
  saveLearner(paths, learner);
  return learner;
}

/**
 * @param {StatePaths} paths
 * @param {string} key
 * @param {string} item
 */
export function learnerAdd(paths, key, item) {
  const learner = loadLearner(paths);
  const list = learner.profile[listKey(key)];
  const clean = item.replace(/\s+/g, ' ').trim();
  if (!clean) throw new MenitorError('Give some text to add');
  if (!list.includes(clean)) list.push(clean);
  saveLearner(paths, learner);
  return learner;
}

/**
 * @param {StatePaths} paths
 * @param {string} key
 * @param {string} item
 */
export function learnerRemove(paths, key, item) {
  const learner = loadLearner(paths);
  const name = listKey(key);
  const before = learner.profile[name].length;
  learner.profile[name] = learner.profile[name].filter((x) => x !== item.trim());
  if (learner.profile[name].length === before) throw new MenitorError(`"${item}" is not in ${name}`);
  saveLearner(paths, learner);
  return learner;
}

/**
 * @param {StatePaths} paths
 * @param {string} text
 * @param {{ now?: Date }} [options]
 */
export function learnerNote(paths, text, options = {}) {
  const learner = loadLearner(paths);
  addNote(learner, text, options.now);
  saveLearner(paths, learner);
  return learner;
}

// Read-only views

/**
 * Everything the agent needs to work on or check one task, in one call: the card, where the task
 * started, the deterministic checks, and only the doc section the task links to (C-10).
 * @param {StatePaths} paths
 * @param {string | undefined} id
 */
export function briefData(paths, id) {
  const plan = requirePlan(paths);
  const session = loadSession(paths);
  const entry = resolveTask(plan, session, id);
  const { task } = entry;
  const start = session.tasks[task.id] ?? null;
  return {
    card: cardData(plan, task.id, loadProgress(paths)),
    focus: task.focus ?? [],
    current: session.currentTask === task.id,
    startCommit: start?.startCommit ?? null,
    startedAt: start?.startedAt ?? null,
    checks: plan.checks ?? {},
    verify: task.verify ?? [],
    deployUrl: plan.project.deployUrl ?? null,
    doc: readDocLink(paths.root, task.docs),
  };
}

/**
 * A summary of where the project stands, for `menitor status` and the window.
 * @param {StatePaths} paths
 */
export function statusData(paths) {
  const plan = loadPlan(paths);
  const session = loadSession(paths);
  const learner = loadLearner(paths).profile;
  const guard = loadGuard(paths);
  const tasks = plan ? allTasks(plan) : [];
  const done = tasks.filter((e) => e.task.status === 'done');
  const current = plan && session.currentTask ? findTask(plan, session.currentTask) : null;

  return {
    project: plan?.project.name ?? null,
    approved: Boolean(plan?.approvedAt),
    mentorMode: guard.mentorMode,
    level: learner.level,
    focusAreas: learner.focusAreas,
    current: current
      ? {
          id: current.task.id,
          number: current.index + 1,
          total: current.total,
          goal: current.task.goal,
          owner: current.task.owner,
          milestone: { id: current.milestone.id, title: current.milestone.title, number: current.milestoneIndex + 1 },
          startCommit: session.tasks[current.task.id]?.startCommit ?? null,
        }
      : null,
    milestones: (plan?.milestones ?? []).map((m, i) => ({
      id: m.id,
      number: i + 1,
      title: m.title,
      done: m.tasks.filter((t) => t.status === 'done').length,
      total: m.tasks.length,
    })),
    done: done.length,
    total: tasks.length,
    written: {
      learner: done.filter((e) => e.task.owner === 'learner').length,
      delegated: done.filter((e) => e.task.owner === 'delegated').length,
      skipped: done.filter((e) => e.task.skipped).length,
      focusTasksDone: done.filter((e) => isFocusTask(e.task)).length,
    },
  };
}

/**
 * Check every state file and how they fit together.
 * @param {StatePaths} paths
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateAll(paths) {
  const errors = [];
  const warnings = [];
  /**
   * @template T
   * @param {string} label
   * @param {() => T} load
   * @returns {T | null}
   */
  const attempt = (label, load) => {
    try {
      return load();
    } catch (err) {
      errors.push(err instanceof MenitorError ? err.message : `${label}: ${/** @type {Error} */ (err).message}`);
      return null;
    }
  };

  const learner = attempt('learner.md', () => loadLearner(paths));
  const plan = attempt('plan.json', () => loadPlan(paths));
  const session = attempt('session.json', () => loadSession(paths));
  const progress = attempt('progress.json', () => loadProgress(paths));
  const guard = attempt('guard.json', () => loadGuard(paths));
  attempt('log.md', () => parseLog(fs.existsSync(paths.log) ? fs.readFileSync(paths.log, 'utf8') : ''));

  if (plan) {
    const problems = planProblems(plan, learner?.profile ?? {});
    errors.push(...problems.errors.map((e) => `plan.json: ${e}`));
    warnings.push(...problems.warnings.map((w) => `plan.json: ${w}`));
    const taskIds = new Set(allTasks(plan).map((e) => e.task.id));
    const itemIds = new Set(allTasks(plan).flatMap((e) => e.task.checklist.map((i) => i.id)));
    if (session?.currentTask && !taskIds.has(session.currentTask)) {
      errors.push(`session.json: the current task "${session.currentTask}" is not in the plan`);
    }
    if (session && plan.approvedAt && !session.currentTask && nextTodo(plan)) {
      errors.push('session.json: no task is current, but the plan still has tasks to do');
    }
    for (const id of Object.keys(progress?.ticks ?? {})) {
      if (!itemIds.has(id)) warnings.push(`progress.json: tick for "${id}", which is not in the plan`);
    }
    for (const id of Object.keys(guard?.grants ?? {})) {
      if (!taskIds.has(id)) warnings.push(`guard.json: skip grant for "${id}", which is not in the plan`);
    }
  } else if (session?.currentTask) {
    errors.push('session.json: a task is current but there is no plan');
  }
  return { errors, warnings };
}
