// Success metrics from the PRD, computed from plan.json and log.md. Nothing leaves the machine.

import { allTasks, isFocusTask } from './plan.js';

/**
 * @typedef {import('./plan.js').Plan} Plan
 * @typedef {import('./log.js').LogEvent} LogEvent
 * @typedef {{ value: number | null, target: string, met: boolean | null, detail: string }} Metric
 */

/**
 * @param {number} n
 */
function pct(n) {
  return `${Math.round(n * 100)}%`;
}

/**
 * @param {Plan | null} plan
 * @param {LogEvent[]} events
 * @returns {Record<string, Metric>}
 */
export function computeStats(plan, events) {
  const tasks = plan ? allTasks(plan) : [];

  // Time to first deploy: sessions until the walking skeleton milestone is done.
  /** @type {Metric} */
  let firstDeploy = { value: null, target: '2 sessions or fewer', met: null, detail: 'The walking skeleton is not done yet' };
  const skeleton = plan?.milestones[0];
  if (skeleton && skeleton.tasks.every((t) => t.status === 'done')) {
    const lastIds = new Set(skeleton.tasks.map((t) => t.id));
    const passes = events.filter((e) => e.event === 'pass' && lastIds.has(e.fields.task));
    const doneAt = passes.length ? passes[passes.length - 1].at : null;
    const sessions = doneAt ? events.filter((e) => e.event === 'session' && e.at <= doneAt).length : 0;
    firstDeploy = {
      value: sessions,
      target: '2 sessions or fewer',
      met: sessions > 0 ? sessions <= 2 : null,
      detail: sessions > 0 ? `Walking skeleton done in session ${sessions}` : 'Done, but no session starts were logged',
    };
  }

  // Independence: focus-area tasks passed without a skip.
  const focusDone = tasks.filter((e) => isFocusTask(e.task) && e.task.status === 'done');
  const independent = focusDone.filter((e) => !e.task.skipped).length;
  /** @type {Metric} */
  const independence = focusDone.length
    ? {
        value: independent / focusDone.length,
        target: '80% or more',
        met: independent / focusDone.length >= 0.8,
        detail: `${independent} of ${focusDone.length} focus-area tasks passed without a skip`,
      }
    : { value: null, target: '80% or more', met: null, detail: 'No focus-area tasks done yet' };

  // Hint trend: hint rungs per done task, milestone 3 against milestone 1.
  /** @param {number} mi */
  const hintsPerTask = (mi) => {
    const done = tasks.filter((e) => e.milestoneIndex === mi && e.task.status === 'done');
    if (!done.length) return null;
    const ids = new Set(done.map((e) => e.task.id));
    const hints = events.filter((e) => e.event === 'hint' && ids.has(e.fields.task)).length;
    return hints / done.length;
  };
  const m1 = hintsPerTask(0);
  const m3 = hintsPerTask(2);
  /** @type {Metric} */
  const hintTrend =
    m1 !== null && m3 !== null
      ? {
          value: m3 - m1,
          target: 'fewer per task in milestone 3 than in milestone 1',
          met: m3 < m1,
          detail: `${m1.toFixed(1)} per task in milestone 1, ${m3.toFixed(1)} in milestone 3`,
        }
      : {
          value: null,
          target: 'fewer per task in milestone 3 than in milestone 1',
          met: null,
          detail: m1 === null ? 'Milestone 1 has no done tasks yet' : `${m1.toFixed(1)} per task in milestone 1; milestone 3 not done yet`,
        };

  // Check accuracy: must-fix findings withdrawn after a dispute.
  const mustFix = events.filter((e) => e.event === 'check').reduce((n, e) => n + Number(e.fields.mustFix ?? 0), 0);
  const withdrawn = events.filter((e) => e.event === 'dispute' && e.fields.outcome === 'withdrawn').length;
  /** @type {Metric} */
  const checkAccuracy = mustFix
    ? {
        value: withdrawn / mustFix,
        target: 'under 10% withdrawn',
        met: withdrawn / mustFix < 0.1,
        detail: `${withdrawn} of ${mustFix} must-fix findings withdrawn after a dispute`,
      }
    : { value: null, target: 'under 10% withdrawn', met: null, detail: 'No must-fix findings yet' };

  // Explain-back: questions answered well within two tries.
  let questions = 0;
  let well = 0;
  /** @type {Map<string, boolean>} task -> a weak first try is waiting for its second try */
  const pending = new Map();
  for (const e of events) {
    if (e.event !== 'explain') continue;
    const task = e.fields.task;
    if (e.fields.try === '1') {
      questions += 1;
      if (e.fields.outcome === 'good') {
        well += 1;
        pending.delete(task);
      } else {
        pending.set(task, true);
      }
    } else if (pending.get(task)) {
      if (e.fields.outcome === 'good') well += 1;
      pending.delete(task);
    }
  }
  /** @type {Metric} */
  const explainBack = questions
    ? { value: well / questions, target: '90% or more', met: well / questions >= 0.9, detail: `${well} of ${questions} questions answered well within two tries` }
    : { value: null, target: '90% or more', met: null, detail: 'No explain-back questions yet' };

  // Shipped: any deploy recorded, and the whole plan done.
  const deployed = events.some((e) => e.event === 'deploy');
  const allDone = tasks.length > 0 && tasks.every((e) => e.task.status === 'done');
  /** @type {Metric} */
  const shipped = {
    value: allDone && deployed ? 1 : 0,
    target: 'a deployed app at the end of the plan',
    met: allDone ? deployed : null,
    detail: `${deployed ? 'Deployed' : 'Not deployed yet'}; ${tasks.filter((e) => e.task.status === 'done').length} of ${tasks.length} tasks done`,
  };

  return { firstDeploy, independence, hintTrend, checkAccuracy, explainBack, shipped };
}

const LABELS = /** @type {const} */ ({
  firstDeploy: 'Time to first deploy',
  independence: 'Independence',
  hintTrend: 'Hint trend',
  checkAccuracy: 'Check accuracy',
  explainBack: 'Explain-back',
  shipped: 'Shipped',
});

/**
 * @param {Record<string, Metric>} stats
 */
export function renderStats(stats) {
  const width = Math.max(...Object.values(LABELS).map((l) => l.length)) + 2;
  return Object.entries(stats)
    .map(([key, m]) => {
      const mark = m.met === null ? '·' : m.met ? '✓' : '✗';
      const value = m.value === null ? '' : key === 'independence' || key === 'explainBack' || key === 'checkAccuracy' ? ` ${pct(m.value)}` : '';
      return `${mark} ${/** @type {Record<string, string>} */ (LABELS)[key].padEnd(width)}${m.detail}${value ? ` (${value.trim()})` : ''} · target: ${m.target}`;
    })
    .join('\n');
}
