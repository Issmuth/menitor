import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, renderStats } from '../core/lib/stats.js';
import { normalizePlanInput } from '../core/lib/plan.js';
import { samplePlan } from './helpers.js';

/**
 * @param {string} at
 * @param {string} event
 * @param {Record<string, string>} [fields]
 */
const ev = (at, event, fields = {}) => ({ at: `2026-11-0${at}T00:00:00.000Z`, event, fields });

test('empty project: every metric is pending', () => {
  const stats = computeStats(null, []);
  for (const m of Object.values(stats)) assert.equal(m.met, null);
  assert.match(renderStats(stats), /Time to first deploy/);
});

test('time to first deploy counts sessions until the skeleton is done', () => {
  const plan = normalizePlanInput(samplePlan());
  plan.milestones[0].tasks.forEach((t) => (t.status = 'done'));
  const events = [ev('1', 'session'), ev('2', 'pass', { task: 't1' }), ev('3', 'session'), ev('4', 'pass', { task: 't2' }), ev('5', 'session')];
  const { firstDeploy } = computeStats(plan, events);
  assert.equal(firstDeploy.value, 2);
  assert.equal(firstDeploy.met, true);
});

test('independence counts focus-area tasks passed without a skip', () => {
  const plan = normalizePlanInput(samplePlan());
  const [t1, t2] = plan.milestones[0].tasks;
  const [t3] = plan.milestones[1].tasks;
  t1.status = 'done';
  t2.status = 'done'; // delegated by plan: not a focus-area task
  t3.status = 'done';
  t3.owner = 'delegated';
  t3.skipped = true;
  const { independence } = computeStats(plan, []);
  assert.equal(independence.value, 0.5);
  assert.equal(independence.met, false);
  assert.equal(independence.detail, '1 of 2 focus-area tasks passed without a skip');
});

test('explain-back pairs a weak first try with its second try', () => {
  const events = [
    ev('1', 'explain', { task: 't1', outcome: 'good', try: '1' }),
    ev('1', 'explain', { task: 't2', outcome: 'weak', try: '1' }),
    ev('1', 'explain', { task: 't2', outcome: 'good', try: '2' }),
    ev('1', 'explain', { task: 't3', outcome: 'weak', try: '1' }),
    ev('1', 'explain', { task: 't3', outcome: 'weak', try: '2' }),
    ev('1', 'explain', { task: 't3', outcome: 'good', try: '2' }),
  ];
  const { explainBack } = computeStats(null, events);
  assert.equal(explainBack.detail, '2 of 3 questions answered well within two tries');
});

test('check accuracy: withdrawn disputes over must-fix findings', () => {
  const events = [
    ev('1', 'check', { task: 't1', result: 'fail', mustFix: '6' }),
    ev('1', 'check', { task: 't1', result: 'fail', mustFix: '4' }),
    ev('1', 'dispute', { task: 't1', outcome: 'withdrawn' }),
    ev('1', 'dispute', { task: 't1', outcome: 'upheld' }),
  ];
  const { checkAccuracy } = computeStats(null, events);
  assert.equal(checkAccuracy.value, 0.1);
  assert.equal(checkAccuracy.met, false);
});

test('hint trend compares milestone 3 with milestone 1', () => {
  const raw = samplePlan();
  raw.milestones.push({ title: 'Recipes', tasks: [structuredClone(raw.milestones[1].tasks[0])] });
  const plan = normalizePlanInput(raw);
  for (const m of plan.milestones) for (const t of m.tasks) t.status = 'done';
  const events = [
    ev('1', 'hint', { task: 't1', rung: 'concept' }),
    ev('1', 'hint', { task: 't1', rung: 'approach' }),
    ev('1', 'hint', { task: 't2', rung: 'concept' }),
    ev('2', 'hint', { task: 't4', rung: 'concept' }),
  ];
  const { hintTrend } = computeStats(plan, events);
  assert.equal(hintTrend.met, true);
  assert.equal(hintTrend.detail, '1.5 per task in milestone 1, 1.0 in milestone 3');
});
