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
import { allTasks, appendFixes, findTask, insertMilestone, insertStep, insertTask, isFocusTask, nextTodo, normalizePlanInput, planProblems, revealNextHint, setHints } from './plan.js';
import { validate } from './schema.js';
import { cardData } from './card.js';
import { readDocLink } from './docs.js';
import { languageWarnings } from './lint.js';
import { readTextOrNull } from './fsx.js';
import { runCheck } from './check.js';
import {
  SCHEMAS,
  defaultSession,
  isInitialized,
  loadAnswers,
  loadGuard,
  loadLearner,
  loadSolutions,
  loadPlan,
  loadProgress,
  loadSession,
  requirePlan,
  savePlan,
  saveLearner,
  saveSession,
  saveSolutions,
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
solutions.json
answers.json
waiter.json
claims/
window.json
inbox.jsonl
listener.json
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

const ADD_SHAPES = 'Send one of {"task": {...}, "after": "<task or milestone ID>"}, {"step": "<text>", "to": "<task ID>"} or {"milestone": {...}, "after": "<milestone ID>"}';

/**
 * @typedef {object} Addition
 * @property {'task' | 'step' | 'milestone'} kind
 * @property {string} id           the new task, checklist item or milestone
 * @property {string} text         its goal, text or title
 * @property {string} milestone    the milestone it's in
 * @property {string | null} after the task or milestone it follows (null for a step)
 * @property {string | null} task  the task a step joins (null otherwise)
 * @property {string[]} tasks      the new task IDs (none for a step)
 * @property {string[]} warnings   plan warnings the addition brings
 * @property {boolean} saved
 * @property {string | null} started  a new task that became current, because every other task was done
 */

/**
 * Add to the approved plan: one task, one step on a task not started yet, or a milestone of new
 * tasks. Done tasks, the current task and every existing ID stay as they are, and each addition
 * writes one log line. A dry run checks everything and saves nothing.
 * @param {StatePaths} paths
 * @param {unknown} raw  {"task": {...}, "after": "t3"}, {"step": "text", "to": "t5"} or {"milestone": {...}, "after": "m2"}
 * @param {{ dryRun?: boolean, now?: Date }} [options]
 * @returns {Addition}
 */
export function addToPlan(paths, raw, options = {}) {
  const now = options.now ?? new Date();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new MenitorError(`An addition must be a JSON object. ${ADD_SHAPES}.`);
  const input = /** @type {Record<string, any>} */ (raw);
  const kinds = /** @type {const} */ (['task', 'step', 'milestone']).filter((k) => k in input);
  if (kinds.length !== 1) throw new MenitorError(`Add one thing at a time. ${ADD_SHAPES}.`);
  const kind = kinds[0];
  const where = kind === 'step' ? 'to' : 'after';
  const extra = Object.keys(input).filter((k) => k !== kind && k !== where);
  if (extra.length) throw new MenitorError(`Unknown field ${extra.map((k) => `"${k}"`).join(', ')}. ${ADD_SHAPES}.`);
  if (typeof input[where] !== 'string') {
    throw new MenitorError(kind === 'step' ? 'Say which task the step joins with "to": a task ID' : `Say where the ${kind} goes with "after": ${kind === 'task' ? 'a task ID or a milestone ID' : 'a milestone ID'}`);
  }

  const plan = requireApprovedPlan(paths);
  const session = loadSession(paths);
  const current = session.currentTask;
  /** @type {Plan} */
  let next;
  /** @type {Omit<Addition, 'warnings' | 'saved' | 'started'>} */
  let added;
  if (kind === 'task') {
    const r = insertTask(plan, input.task, { after: input.after, current, now });
    next = r.plan;
    added = { kind, id: r.task.id, text: r.task.goal, milestone: r.milestone.id, after: input.after, task: null, tasks: [r.task.id] };
  } else if (kind === 'step') {
    const r = insertStep(plan, input.step, { to: input.to, current });
    next = r.plan;
    added = { kind, id: r.item.id, text: r.item.text, milestone: findTask(next, r.task.id).milestone.id, after: null, task: r.task.id, tasks: [] };
  } else {
    const r = insertMilestone(plan, input.milestone, { after: input.after, current, now });
    next = r.plan;
    added = { kind, id: r.milestone.id, text: r.milestone.title, milestone: r.milestone.id, after: input.after, task: null, tasks: r.milestone.tasks.map((t) => t.id) };
  }

  const profile = loadLearner(paths).profile;
  const schemaErrors = validate(SCHEMAS.plan, next).map((e) => `${e.path} ${e.message}`);
  const { errors, warnings } = schemaErrors.length ? { errors: schemaErrors, warnings: [] } : planProblems(next, profile);
  if (errors.length) throw new MenitorError(`The new ${kind} is invalid:\n${errors.map((e) => `  ${e}`).join('\n')}`, { details: errors });
  // Only the warnings this addition brings; the plan's old ones were seen at approval.
  const before = new Set(planProblems(plan, profile).warnings);
  const fresh = warnings.filter((w) => !before.has(w));
  if (options.dryRun) return { ...added, warnings: fresh, saved: false, started: null };

  savePlan(paths, next);
  if (kind === 'task') appendEvent(paths.log, 'task-added', { task: added.id, after: input.after }, now);
  else if (kind === 'step') appendEvent(paths.log, 'step-added', { task: input.to, item: added.id }, now);
  else appendEvent(paths.log, 'milestone-added', { milestone: added.id, after: input.after, tasks: added.tasks.length }, now);

  // Every other task was done, so the first new one becomes the current task.
  const first = current ? null : nextTodo(next);
  if (first) startTask(paths, session, first, now);
  return { ...added, warnings: fresh, saved: true, started: first?.task.id ?? null };
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
 * C-1, C-2, G-7: run the deterministic check for the current task and remember the result,
 * so a pass can require a clean run at the current commit.
 * @param {StatePaths} paths
 * @param {string | undefined} id
 * @param {{ commands?: boolean, timeoutSeconds?: number, now?: Date }} [options]
 */
export function checkTask(paths, id, options = {}) {
  const now = options.now ?? new Date();
  const plan = requireApprovedPlan(paths);
  const session = loadSession(paths);
  const entry = resolveTask(plan, session, id);
  requireCurrent(session, entry);
  const start = session.tasks[entry.task.id] ?? null;
  const report = runCheck(
    {
      root: paths.root,
      plan,
      entry,
      startCommit: start?.startCommit ?? null,
      startedAt: start?.startedAt ?? null,
      ticks: loadProgress(paths).ticks,
      activityFile: paths.activity,
    },
    options,
  );
  if (report.ranCommands && start) {
    // Read the session again: the checks may have run for minutes.
    const fresh = loadSession(paths);
    const record = fresh.tasks[entry.task.id];
    if (record) {
      // A clean re-run at the same commit keeps the first clean time, so an explain-back
      // given after it still counts.
      const prev = record.lastCheck;
      const at = report.ok && prev?.ok && prev.head === report.head ? prev.at : now.toISOString();
      record.lastCheck = { at, ok: report.ok, head: report.head, problems: report.problems.filter((p) => p.severity === 'blocking').length };
      saveSession(paths, fresh);
    }
  }
  return report;
}

/**
 * Has the learner explained their code since the last check run (C-5, C-6)?
 * A good answer counts, and so does a second try, which passes either way.
 * @param {StatePaths} paths
 * @param {string} taskId
 * @param {string} since
 */
function explainedSince(paths, taskId, since) {
  const text = fs.existsSync(paths.log) ? fs.readFileSync(paths.log, 'utf8') : '';
  return parseLog(text).some((e) => e.event === 'explain' && e.fields.task === taskId && e.at >= since && (e.fields.outcome === 'good' || e.fields.try === '2'));
}

/**
 * The three-part gate: a clean check run at the current commit, and for learner tasks an
 * explain-back. Returns why the task can't pass yet, or null.
 * @param {StatePaths} paths
 * @param {Session} session
 * @param {import('./plan.js').Task} task
 */
export function passBlocker(paths, session, task) {
  const last = session.tasks[task.id]?.lastCheck;
  if (!last) return `No check has run for ${task.id} yet. Run "menitor check run" first; a task passes only after its deterministic checks pass.`;
  if (!last.ok) return `The last check run for ${task.id} found must-fix problems. Fix them, then run "menitor check run" again.`;
  if (last.head !== headCommit(paths.root)) return `There are new commits since the last check run. Run "menitor check run" again.`;
  if (task.owner === 'learner' && !explainedSince(paths, task.id, last.at)) {
    return `The learner hasn't explained their code since the last check run. Ask the explain-back questions and log them with "menitor log explain" first.`;
  }
  return null;
}

/**
 * C-8: mark the current task done and start the next one.
 * @param {StatePaths} paths
 * @param {string | undefined} id
 * @param {{ note?: string, revisit?: string[], override?: string, now?: Date }} [options]
 */
export function passTask(paths, id, options = {}) {
  const now = options.now ?? new Date();
  const plan = requireApprovedPlan(paths);
  const session = loadSession(paths);
  const entry = resolveTask(plan, session, id);
  requireCurrent(session, entry);

  const { task } = entry;
  const override = options.override?.trim();
  if (options.override !== undefined && !override) throw new MenitorError('An override needs a reason');
  if (!override) {
    const blocker = passBlocker(paths, session, task);
    if (blocker) throw refused(blocker);
  }
  if (override) appendEvent(paths.log, 'override', { task: task.id, reason: override }, now);

  task.status = 'done';
  task.passedAt = now.toISOString();
  if (options.note) task.note = options.note.trim();
  if (override) task.note = [task.note, `Passed without a clean check: ${override}`].filter(Boolean).join(' ');
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

  // Whatever the agent was waiting on for this task is settled once it passes.
  if (session.waiting && (session.waiting.task ?? null) === task.id) session.waiting = null;
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
 * Projects set up before type-along keep their own .menitor/.gitignore; make sure step code stays out of git.
 * @param {StatePaths} paths
 */
function ignoreSolutions(paths) {
  const text = readTextOrNull(paths.gitignore) ?? '';
  if (/^solutions\.json$/m.test(text)) return;
  writeFileAtomic(paths.gitignore, `${text.replace(/\n*$/, '\n')}solutions.json\n`);
}

/**
 * Type-along: store each step's plain instructions and the exact code to type, keyed by checklist
 * item ID: { "t1.c2": { "say": "...", "code": [{ "where": "src/app.js", "text": "..." }] } }.
 * A block without "where" is typed in the terminal. Imported steps replace earlier ones.
 * @param {StatePaths} paths
 * @param {unknown} raw
 * @param {{ now?: Date }} [options]
 */
export function importSteps(paths, raw, options = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MenitorError('Step code must be a JSON object keyed by checklist item ID, such as "t1.c2"');
  }
  const plan = requirePlan(paths);
  const items = new Map(allTasks(plan).flatMap((e) => e.task.checklist.map((i) => [i.id, { task: e.task, item: i }])));
  const ids = Object.keys(raw);
  if (!ids.length) throw new MenitorError('No step code given');
  const unknown = ids.filter((id) => !items.has(id));
  if (unknown.length) throw new MenitorError(`No checklist item ${unknown.map((id) => `"${id}"`).join(', ')} in the plan`);
  const delegated = ids.filter((id) => items.get(id)?.task.owner === 'delegated');
  if (delegated.length) throw new MenitorError(`${delegated.join(', ')} belong${delegated.length === 1 ? 's' : ''} to delegated tasks, which Menitor does itself`);

  const solutions = loadSolutions(paths);
  /** @type {string[]} */
  const warnings = [];
  for (const id of ids) {
    const step = /** @type {Record<string, any>} */ (raw)[id];
    solutions.steps[id] = step;
    if (step && typeof step.say === 'string') warnings.push(...languageWarnings(`${id} say`, step.say).filter((w) => !w.includes('looks like code')));
  }
  saveSolutions(paths, solutions);
  ignoreSolutions(paths);
  appendEvent(paths.log, 'steps', { count: ids.length }, options.now);
  return { ids, warnings };
}

/**
 * The current learner task and its session record, for explain-back.
 * @param {StatePaths} paths
 */
function currentLearnerTask(paths) {
  const plan = requireApprovedPlan(paths);
  const session = loadSession(paths);
  const entry = resolveTask(plan, session, undefined);
  if (entry.task.owner !== 'learner') throw refused(`${entry.task.id} is delegated; explain-back is for the learner's own tasks`);
  const record = session.tasks[entry.task.id];
  if (!record) throw new MenitorError(`${entry.task.id} has no session record yet`);
  return { session, entry, record };
}

/**
 * C-5: ask an explain-back question. The window shows it with an answer box. One open question at
 * a time; a follow-up (the second try, C-6) comes only after a weak first answer.
 * @param {StatePaths} paths
 * @param {string} text
 * @param {{ followUp?: boolean, now?: Date }} [options]
 */
export function askQuestion(paths, text, options = {}) {
  const now = options.now ?? new Date();
  const { session, entry, record } = currentLearnerTask(paths);
  const questions = record.questions ?? [];
  const open = questions.find((q) => q.outcome === null);
  if (open) throw new MenitorError(`${open.id} is still open. Judge it with "menitor question judge" first.`);
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new MenitorError('A question needs some text');
  if (options.followUp && !questions.some((q) => q.try === 1 && q.outcome === 'weak')) {
    throw new MenitorError('A follow-up comes only after a weak first answer');
  }
  /** @type {import('./state.js').Question} */
  const question = { id: `${entry.task.id}.q${questions.length + 1}`, text: clean, try: options.followUp ? 2 : 1, askedAt: now.toISOString(), outcome: null, feedback: null, judgedAt: null };
  record.questions = [...questions, question];
  saveSession(paths, session);
  return { entry, question };
}

/**
 * The current task's questions with the answers typed in the window, as data.
 * @param {StatePaths} paths
 */
export function questionState(paths) {
  const plan = requireApprovedPlan(paths);
  const session = loadSession(paths);
  const entry = resolveTask(plan, session, undefined);
  const answers = loadAnswers(paths).answers;
  const questions = (session.tasks[entry.task.id]?.questions ?? []).map((q) => ({ ...q, answer: answers[q.id] ?? null }));
  return { task: entry.task.id, questions, open: questions.find((q) => q.outcome === null) ?? null };
}

/**
 * C-5, C-6: judge the open question. Logs the explain-back, which the pass gate reads. The
 * feedback shows in the window under the learner's answer.
 * @param {StatePaths} paths
 * @param {string} outcome
 * @param {{ feedback?: string, now?: Date }} [options]
 */
export function judgeQuestion(paths, outcome, options = {}) {
  const now = options.now ?? new Date();
  if (outcome !== 'good' && outcome !== 'weak') throw new MenitorError('Judge an answer as good or weak');
  const { session, entry, record } = currentLearnerTask(paths);
  const question = (record.questions ?? []).find((q) => q.outcome === null);
  if (!question) throw new MenitorError(`No open question on ${entry.task.id}. Ask one with "menitor question ask".`);
  question.outcome = outcome;
  question.feedback = options.feedback?.trim() || null;
  question.judgedAt = now.toISOString();
  saveSession(paths, session);
  appendEvent(paths.log, 'explain', { task: entry.task.id, outcome, try: question.try }, now);
  return { entry, question };
}

/**
 * Post what the agent needs from the learner outside the steps (an account sign-in, a deployed
 * URL, a decision), so the window shows it until it's done.
 * @param {StatePaths} paths
 * @param {string | null} text  null clears it
 * @param {{ now?: Date }} [options]
 */
export function setWaiting(paths, text, options = {}) {
  const session = loadSession(paths);
  if (text === null) {
    session.waiting = null;
  } else {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) throw new MenitorError('Say what you are waiting on');
    session.waiting = { text: clean, at: (options.now ?? new Date()).toISOString(), task: session.currentTask };
  }
  saveSession(paths, session);
  return session.waiting ?? null;
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
 * G-3 and H-6: hand the current task to the agent. A learner-owned task needs one of two things,
 * both recorded by an adapter hook from the learner's own typing: a grant from a confirmed skip,
 * or mentor mode off (ADR 16).
 * @param {StatePaths} paths
 * @param {string | undefined} id
 * @param {{ now?: Date }} [options]
 * @returns {{ entry: TaskEntry, alreadyDelegated: boolean, via?: 'grant' | 'mode-off' }}
 */
export function skipTask(paths, id, options = {}) {
  const plan = requireApprovedPlan(paths);
  const session = loadSession(paths);
  const entry = resolveTask(plan, session, id);
  requireCurrent(session, entry);
  const { task } = entry;
  if (task.owner === 'delegated') return { entry, alreadyDelegated: true };

  const guard = loadGuard(paths);
  const via = guard.grants[task.id] ? 'grant' : guard.mentorMode === 'off' ? 'mode-off' : null;
  if (!via) {
    throw refused(`${task.id} belongs to the learner. Only the learner can hand it over, by confirming the skip themselves or turning mentor mode off.`);
  }
  task.owner = 'delegated';
  task.skipped = true;
  savePlan(paths, plan);
  appendEvent(paths.log, 'delegated', { task: task.id, skipped: true, via }, options.now);
  return { entry, alreadyDelegated: false, via };
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
    typeAlong: Boolean(loadGuard(paths).typeAlong),
    questions: (start?.questions ?? []).map((q) => ({ ...q, answer: loadAnswers(paths).answers[q.id] ?? null })),
    waiting: session.waiting ?? null,
    stepCode: (() => {
      const steps = loadSolutions(paths).steps;
      const ids = task.checklist.map((i) => i.id);
      return { stored: ids.filter((id) => steps[id]), missing: ids.filter((id) => !steps[id]) };
    })(),
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
    typeAlong: Boolean(guard.typeAlong),
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
