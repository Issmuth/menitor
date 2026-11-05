// The plan: milestones of ordered tasks. Pure functions; state.js does the reading and writing.

import { MenitorError, refused } from './errors.js';
import { RUNGS } from './learner.js';
import { languageWarnings, MAX_WHY_SENTENCES } from './lint.js';

/** S-9: a task's planned checklist has 6 items or fewer. Fixes added by checks may go past it. */
export const MAX_PLAN_ITEMS = 6;

/**
 * @typedef {import('./learner.js').Rung} Rung
 * @typedef {{ id: string, text: string, source: 'plan' | 'fix' }} ChecklistItem
 * @typedef {{ rung: Rung, text: string }} Hint
 * @typedef {{ run: string, label?: string } | { url: string, status?: number, contains?: string, label?: string }} VerifyStep
 * @typedef {object} Task
 * @property {string} id
 * @property {string} goal
 * @property {string} why
 * @property {string} docs
 * @property {{ label: string, url?: string | null }} [learn]
 * @property {string[]} [focus]
 * @property {'learner' | 'delegated'} owner
 * @property {boolean} [skipped]
 * @property {string | null} [branch]
 * @property {ChecklistItem[]} checklist
 * @property {string[]} doneWhen
 * @property {VerifyStep[]} [verify]
 * @property {Hint[] | null} hints
 * @property {number} hintsRevealed
 * @property {'todo' | 'done'} status
 * @property {string | null} [passedAt]
 * @property {string | null} [note]
 * @typedef {object} Milestone
 * @property {string} id
 * @property {string} title
 * @property {string} [goal]
 * @property {boolean} [skeleton]
 * @property {string | null} [branch]
 * @property {Task[]} tasks
 * @typedef {object} Plan
 * @property {1} version
 * @property {{ name: string, type: 'web', summary?: string, stack?: string[], hosting?: string | null, deployUrl?: string | null }} project
 * @property {{ build?: string | null, lint?: string | null, test?: string | null }} [checks]
 * @property {string | null} approvedAt
 * @property {Milestone[]} milestones
 * @typedef {{ task: Task, milestone: Milestone, index: number, total: number, milestoneIndex: number }} TaskEntry
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accept hints as { concept, approach, pseudocode, snippet }, as four strings, or as four { rung, text } objects.
 * @param {unknown} input
 * @returns {Hint[] | null}
 */
export function normalizeHints(input) {
  if (input === undefined || input === null) return null;
  if (Array.isArray(input)) {
    return input.map((h, i) => (typeof h === 'string' ? { rung: RUNGS[i] ?? 'snippet', text: h } : h));
  }
  if (isObject(input)) {
    const extra = Object.keys(input).filter((k) => !(/** @type {readonly string[]} */ (RUNGS)).includes(k));
    if (extra.length) throw new MenitorError(`Unknown hint rung ${extra.map((k) => `"${k}"`).join(', ')}. Use ${RUNGS.join(', ')}.`);
    const missing = RUNGS.filter((r) => typeof input[r] !== 'string' || !input[r].trim());
    if (missing.length) throw new MenitorError(`Hints need all four rungs; missing ${missing.join(', ')}`);
    return RUNGS.map((rung) => ({ rung, text: input[rung] }));
  }
  throw new MenitorError('Hints must be an object with concept, approach, pseudocode and snippet');
}

/**
 * Fill in defaults and IDs on a draft plan so the agent can write the short form.
 * Unknown fields pass through untouched so validation can name them.
 * @param {unknown} raw
 * @returns {Plan}
 */
export function normalizePlanInput(raw) {
  if (!isObject(raw)) throw new MenitorError('A plan must be a JSON object');
  if (!Array.isArray(raw.milestones)) throw new MenitorError('A plan needs a "milestones" array');

  let taskNumber = 0;
  const milestones = raw.milestones.map((m, mi) => {
    if (!isObject(m)) return m;
    const tasks = Array.isArray(m.tasks)
      ? m.tasks.map((t) => {
          if (!isObject(t)) return t;
          taskNumber += 1;
          const id = typeof t.id === 'string' ? t.id : `t${taskNumber}`;
          let itemNumber = 0;
          const checklist = Array.isArray(t.checklist)
            ? t.checklist.map((item) => {
                itemNumber += 1;
                const it = typeof item === 'string' ? { text: item } : item;
                if (!isObject(it)) return it;
                return { id: `${id}.c${itemNumber}`, text: it.text, source: 'plan', ...it };
              })
            : t.checklist;
          return {
            ...t,
            id,
            learn: typeof t.learn === 'string' ? { label: t.learn } : t.learn,
            focus: t.focus ?? [],
            owner: t.owner ?? 'learner',
            skipped: t.skipped ?? false,
            checklist,
            doneWhen: typeof t.doneWhen === 'string' ? [t.doneWhen] : t.doneWhen,
            verify: t.verify ?? [],
            hints: normalizeHints(t.hints),
            hintsRevealed: t.hintsRevealed ?? 0,
            status: t.status ?? 'todo',
            passedAt: t.passedAt ?? null,
            note: t.note ?? null,
          };
        })
      : m.tasks;
    return {
      ...m,
      id: typeof m.id === 'string' ? m.id : `m${mi + 1}`,
      skeleton: m.skeleton ?? mi === 0,
      tasks,
    };
  });

  const project = typeof raw.project === 'string' ? { name: raw.project } : raw.project;
  return /** @type {Plan} */ ({
    ...raw,
    version: raw.version ?? 1,
    project: isObject(project) ? { type: 'web', ...project } : project,
    approvedAt: null,
    milestones,
  });
}

/**
 * Every task in plan order.
 * @param {Plan} plan
 * @returns {TaskEntry[]}
 */
export function allTasks(plan) {
  const total = plan.milestones.reduce((n, m) => n + m.tasks.length, 0);
  /** @type {TaskEntry[]} */
  const entries = [];
  plan.milestones.forEach((milestone, milestoneIndex) => {
    for (const task of milestone.tasks) {
      entries.push({ task, milestone, index: entries.length, total, milestoneIndex });
    }
  });
  return entries;
}

/**
 * @param {Plan} plan
 * @param {string} id
 * @returns {TaskEntry}
 */
export function findTask(plan, id) {
  const entry = allTasks(plan).find((e) => e.task.id === id);
  if (!entry) throw new MenitorError(`No task "${id}" in the plan`);
  return entry;
}

/**
 * The first task not done yet, in plan order.
 * @param {Plan} plan
 */
export function nextTodo(plan) {
  return allTasks(plan).find((e) => e.task.status !== 'done') ?? null;
}

/**
 * Problems beyond what the JSON Schema can express.
 * @param {Plan} plan
 * @param {{ focusAreas?: string[] }} [learner]
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function planProblems(plan, learner = {}) {
  const errors = [];
  const warnings = [];
  const focusAreas = learner.focusAreas ?? [];
  const milestoneIds = new Set();
  const taskIds = new Set();
  const itemIds = new Set();

  plan.milestones.forEach((m, mi) => {
    if (milestoneIds.has(m.id)) errors.push(`Milestone ID "${m.id}" is used twice`);
    milestoneIds.add(m.id);

    if (mi === 0 && m.skeleton !== true) {
      warnings.push(`Milestone 1 (${m.id}) should be a walking skeleton: one thin slice, deployed (S-8)`);
    }
    if (m.skeleton) {
      const deployCheck = m.tasks.some((t) => (t.verify ?? []).some((v) => 'url' in v));
      if (!deployCheck) warnings.push(`Walking skeleton ${m.id} has no deploy check; add a verify step with a url`);
    }

    for (const t of m.tasks) {
      if (taskIds.has(t.id)) errors.push(`Task ID "${t.id}" is used twice`);
      taskIds.add(t.id);

      let planItems = 0;
      for (const item of t.checklist) {
        if (itemIds.has(item.id)) errors.push(`Checklist ID "${item.id}" is used twice`);
        itemIds.add(item.id);
        if (!item.id.startsWith(`${t.id}.`)) errors.push(`Checklist ID "${item.id}" must start with its task ID "${t.id}."`);
        if (item.source === 'plan') planItems += 1;
        warnings.push(...languageWarnings(`${t.id} checklist "${item.text}"`, item.text));
      }
      if (planItems > MAX_PLAN_ITEMS) {
        errors.push(`${t.id} has ${planItems} checklist items; the limit is ${MAX_PLAN_ITEMS}, so split the task (S-9)`);
      }

      if (t.hints) {
        const order = t.hints.map((h) => h.rung).join(',');
        if (order !== RUNGS.join(',')) errors.push(`${t.id} hints must be in the order ${RUNGS.join(', ')}`);
      } else if (t.hintsRevealed > 0) {
        errors.push(`${t.id} shows ${t.hintsRevealed} hints revealed but has no hints`);
      }

      warnings.push(...languageWarnings(`${t.id} goal`, t.goal));
      warnings.push(...languageWarnings(`${t.id} why`, t.why, { maxSentences: MAX_WHY_SENTENCES }));
      t.doneWhen.forEach((d, i) => warnings.push(...languageWarnings(`${t.id} done-when ${i + 1}`, d)));

      if (!t.docs.startsWith('docs/')) warnings.push(`${t.id} docs link should point into docs/ (got "${t.docs}")`);

      const focus = t.focus ?? [];
      if (focusAreas.length) {
        for (const f of focus) {
          if (!focusAreas.includes(f)) warnings.push(`${t.id} names focus area "${f}", which is not in the learner's focus areas`);
        }
        if (t.owner === 'delegated' && focus.length && !t.skipped) {
          warnings.push(`${t.id} covers focus area ${focus.map((f) => `"${f}"`).join(', ')} but is delegated`);
        }
        if (t.owner === 'learner' && focus.length === 0) {
          warnings.push(`${t.id} is outside every focus area; tasks outside them are delegated by default (H-5)`);
        }
      }
    }
  });

  const checks = plan.checks ?? {};
  if (!checks.build && !checks.lint && !checks.test) {
    warnings.push('No build, lint or test command yet; deterministic checks run before AI review (C-2)');
  }

  return { errors, warnings: [...new Set(warnings)] };
}

/**
 * C-7: append fixes as new checklist items with new IDs. Existing items and their ticks stay.
 * @param {Task} task
 * @param {string[]} texts
 * @returns {ChecklistItem[]} the new items
 */
export function appendFixes(task, texts) {
  if (task.status === 'done') throw new MenitorError(`${task.id} is already done`);
  let n = task.checklist.reduce((max, item) => {
    const m = /\.f(\d+)$/.exec(item.id);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  /** @type {ChecklistItem[]} */
  const added = [];
  for (const raw of texts) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) throw new MenitorError('A fix needs some text');
    n += 1;
    const item = /** @type {ChecklistItem} */ ({ id: `${task.id}.f${n}`, text, source: 'fix' });
    task.checklist.push(item);
    added.push(item);
  }
  return added;
}

/**
 * Store the four locked rungs for a task. Rungs already revealed cannot be rewritten.
 * @param {Task} task
 * @param {unknown} input
 */
export function setHints(task, input) {
  if (task.status === 'done') throw new MenitorError(`${task.id} is already done`);
  if (task.hintsRevealed > 0) {
    throw refused(`${task.id} already has ${task.hintsRevealed} hint${task.hintsRevealed === 1 ? '' : 's'} revealed, so its hints are fixed`);
  }
  task.hints = normalizeHints(input);
}

/**
 * H-2: reveal the next rung only.
 * @param {Task} task
 * @returns {Hint}
 */
export function revealNextHint(task) {
  if (task.status === 'done') throw new MenitorError(`${task.id} is already done`);
  if (!task.hints) throw new MenitorError(`${task.id} has no hints stored yet. Store them first with "menitor hints import".`);
  if (task.hintsRevealed >= RUNGS.length) {
    throw refused(`All four hints for ${task.id} are open. The next steps are stuck (debug together) or skip.`);
  }
  const hint = task.hints[task.hintsRevealed];
  task.hintsRevealed += 1;
  return hint;
}

/**
 * Tasks that were in the learner's hands: owned by the learner, or skipped away from them.
 * @param {Task} task
 */
export function isFocusTask(task) {
  return task.owner === 'learner' || task.skipped === true;
}
