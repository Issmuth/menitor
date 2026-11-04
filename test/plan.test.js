import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFixes, normalizePlanInput, planProblems, revealNextHint, setHints, allTasks, nextTodo } from '../core/lib/plan.js';
import { validate } from '../core/lib/schema.js';
import { SCHEMAS } from '../core/lib/state.js';
import { EXIT, MenitorError } from '../core/lib/errors.js';
import { languageWarnings } from '../core/lib/lint.js';
import { samplePlan } from './helpers.js';

test('the short form normalizes into a valid plan with stable IDs', () => {
  const plan = normalizePlanInput(samplePlan());
  assert.deepEqual(validate(SCHEMAS.plan, plan), []);
  assert.deepEqual(plan.milestones.map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(allTasks(plan).map((e) => e.task.id), ['t1', 't2', 't3']);
  assert.deepEqual(plan.milestones[0].tasks[0].checklist.map((i) => i.id), ['t1.c1', 't1.c2', 't1.c3']);
  assert.equal(plan.milestones[0].skeleton, true);
  assert.equal(plan.milestones[1].skeleton, false);
  assert.equal(plan.approvedAt, null);
  assert.deepEqual(plan.milestones[1].tasks[0].hints?.map((h) => h.rung), ['concept', 'approach', 'pseudocode', 'snippet']);
  assert.equal(plan.milestones[0].tasks[0].hints, null);
});

test('explicit IDs are kept and unknown fields still fail validation', () => {
  const raw = samplePlan();
  Object.assign(raw.milestones[0].tasks[0], { id: 'hello', title: 'not a field' });
  const plan = normalizePlanInput(raw);
  assert.equal(plan.milestones[0].tasks[0].id, 'hello');
  assert.equal(plan.milestones[0].tasks[0].checklist[0].id, 'hello.c1');
  const errors = validate(SCHEMAS.plan, plan);
  assert.deepEqual(errors, [{ path: '$.milestones[0].tasks[0].title', message: 'is not an allowed field' }]);
});

test('an import can never arrive approved', () => {
  const plan = normalizePlanInput({ ...samplePlan(), approvedAt: '2026-01-01T00:00:00Z' });
  assert.equal(plan.approvedAt, null);
});

test('semantic errors: duplicate IDs, too many checklist items, hint order', () => {
  const raw = samplePlan();
  raw.milestones[1].tasks[0].checklist.push('One more', 'And another');
  const plan = normalizePlanInput(raw);
  plan.milestones[0].tasks[1].id = 't1';
  plan.milestones[1].tasks[0].hints?.reverse();
  const { errors } = planProblems(plan);
  assert.ok(errors.includes('Task ID "t1" is used twice'));
  assert.ok(errors.some((e) => e.startsWith('t3 has 7 checklist items; the limit is 6')));
  assert.ok(errors.some((e) => e.startsWith('t3 hints must be in the order')));
  assert.ok(errors.some((e) => e.includes('must start with its task ID')));
});

test('warnings follow the PRD language and planning rules', () => {
  const raw = samplePlan();
  raw.milestones[0].tasks[0].why = 'One. Two. Three.';
  raw.milestones[0].tasks[0].checklist.push('Write const x = 1;');
  raw.milestones[0].tasks[1].focus = ['frontend'];
  const { errors, warnings } = planProblems(normalizePlanInput(raw), { focusAreas: ['frontend', 'database'] });
  assert.deepEqual(errors, []);
  assert.ok(warnings.includes('t1 why has 3 sentences; keep it to 2 or fewer'));
  assert.ok(warnings.some((w) => w.includes('looks like code')));
  assert.ok(warnings.includes('t2 covers focus area "frontend" but is delegated'));
});

test('a plan whose first milestone is not a skeleton gets a warning', () => {
  const raw = samplePlan();
  Object.assign(raw.milestones[0], { skeleton: false });
  raw.milestones[0].tasks[1].verify = [];
  const { warnings } = planProblems(normalizePlanInput(raw));
  assert.ok(warnings.some((w) => w.startsWith('Milestone 1 (m1) should be a walking skeleton')));
});

test('long sentences are flagged', () => {
  const long = Array.from({ length: 25 }, () => 'word').join(' ');
  assert.equal(languageWarnings('x', long).length, 1);
  assert.equal(languageWarnings('x', long.split(' ').slice(1).join(' ')).length, 0);
});

test('fixes get new IDs after existing ones and never reuse them', () => {
  const plan = normalizePlanInput(samplePlan());
  const task = plan.milestones[0].tasks[0];
  assert.deepEqual(appendFixes(task, ['First fix', '  Second   fix ']).map((i) => i.id), ['t1.f1', 't1.f2']);
  assert.deepEqual(appendFixes(task, ['Third']).map((i) => i.id), ['t1.f3']);
  assert.equal(task.checklist[4].text, 'Second fix');
  assert.deepEqual(task.checklist.slice(0, 3).map((i) => i.id), ['t1.c1', 't1.c2', 't1.c3']);
  assert.throws(() => appendFixes(task, ['  ']), MenitorError);
  const { errors } = planProblems(plan);
  assert.deepEqual(errors, [], 'fixes may take a checklist past six items');
});

test('hints reveal one rung at a time and lock once revealed', () => {
  const plan = normalizePlanInput(samplePlan());
  const task = plan.milestones[1].tasks[0];
  assert.equal(revealNextHint(task).rung, 'concept');
  assert.equal(revealNextHint(task).rung, 'approach');
  assert.throws(() => setHints(task, { concept: 'a', approach: 'b', pseudocode: 'c', snippet: 'd' }), (e) => e instanceof MenitorError && e.exit === EXIT.refused);
  revealNextHint(task);
  revealNextHint(task);
  assert.throws(() => revealNextHint(task), /All four hints/);
});

test('hints need all four rungs', () => {
  const plan = normalizePlanInput(samplePlan());
  const task = plan.milestones[0].tasks[0];
  assert.throws(() => setHints(task, { concept: 'a', approach: 'b' }), /missing pseudocode, snippet/);
  assert.throws(() => setHints(task, { concept: 'a', approach: 'b', pseudocode: 'c', snippet: 'd', bonus: 'e' }), /Unknown hint rung/);
  setHints(task, { concept: 'a', approach: 'b', pseudocode: 'c', snippet: 'd' });
  assert.equal(task.hints?.length, 4);
  assert.throws(() => revealNextHint(plan.milestones[0].tasks[1]), /no hints stored/);
});

test('nextTodo walks the plan in order', () => {
  const plan = normalizePlanInput(samplePlan());
  assert.equal(nextTodo(plan)?.task.id, 't1');
  plan.milestones[0].tasks[0].status = 'done';
  plan.milestones[0].tasks[1].status = 'done';
  assert.equal(nextTodo(plan)?.task.id, 't3');
  plan.milestones[1].tasks[0].status = 'done';
  assert.equal(nextTodo(plan), null);
});
