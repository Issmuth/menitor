// Adding to an approved plan: placement, IDs, the refusals, the CLI and the window's tag.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { insertMilestone, insertStep, insertTask, nextId, normalizePlanInput, planProblems } from '../core/lib/plan.js';
import { validate } from '../core/lib/schema.js';
import { SCHEMAS, loadPlan, loadSession } from '../core/lib/state.js';
import { EXIT } from '../core/lib/errors.js';
import { parseLog } from '../core/lib/log.js';
import { headCommit } from '../core/lib/git.js';
import { cardData, renderCard } from '../core/lib/card.js';
import { windowState } from '../core/server/server.js';
import { approvedProject, cli, samplePlan } from './helpers.js';

const NOW = new Date('2026-11-05T10:00:00.000Z');

/** @param {string | number} n */
const shortTask = (n) => ({
  goal: `Goal ${n}`,
  why: 'It matters to the project.',
  docs: 'docs/prd.md',
  checklist: ['Branch feat/x', 'Do the thing', 'Commit: feat: x'],
  doneWhen: 'It works',
});

/** An approved plan of t1 to t8: m1 holds t1 to t4, m2 holds t5 to t8. */
function eightTasks() {
  const plan = normalizePlanInput({
    project: { name: 'Eight' },
    milestones: [
      { title: 'A', tasks: [1, 2, 3, 4].map(shortTask) },
      { title: 'B', tasks: [5, 6, 7, 8].map(shortTask) },
    ],
  });
  plan.approvedAt = '2026-11-01T00:00:00.000Z';
  return plan;
}

/** @param {import('../core/lib/plan.js').Plan} plan */
const layout = (plan) => plan.milestones.map((m) => `${m.id}: ${m.tasks.map((t) => t.id).join(',')}`).join(' | ');

/** @param {import('../core/lib/plan.js').Plan} plan */
function assertValid(plan) {
  assert.deepEqual(validate(SCHEMAS.plan, plan), []);
  assert.deepEqual(planProblems(plan).errors, []);
}

/** @param {string} file */
const events = (file) => parseLog(fs.readFileSync(file, 'utf8'));

test('nextId takes the next free number and ignores IDs of other shapes', () => {
  assert.equal(nextId(['t1', 't8', 't3'], 't'), 't9');
  assert.equal(nextId([], 'm'), 'm1');
  assert.equal(nextId(['t1', 'next40', 't2-x'], 't'), 't2', 'a custom ID never inflates the count');
  assert.equal(nextId(['t5.c1', 't5.c3', 't5.f1'], 't5.c'), 't5.c4');
  assert.equal(nextId(['t5xc9'], 't5.c'), 't5.c1', 'the dot is literal');
});

test('a task added after t3 gets t9, and no other ID changes', () => {
  const plan = eightTasks();
  const before = JSON.stringify(plan);
  const r = insertTask(plan, shortTask('new'), { after: 't3', current: 't2', now: NOW });
  assert.equal(r.task.id, 't9');
  assert.equal(r.milestone.id, 'm1');
  assert.equal(layout(r.plan), 'm1: t1,t2,t3,t9,t4 | m2: t5,t6,t7,t8');
  assert.deepEqual(r.task.checklist.map((i) => i.id), ['t9.c1', 't9.c2', 't9.c3']);
  assert.equal(r.task.added, NOW.toISOString());
  assert.equal(r.task.status, 'todo');
  assert.equal(JSON.stringify(plan), before, 'the input plan stays as it is');
  assert.equal(JSON.stringify(r.plan.milestones[0].tasks[0]), JSON.stringify(plan.milestones[0].tasks[0]));
  assertValid(r.plan);
});

test('a milestone ID puts the task at the end of that milestone', () => {
  const r = insertTask(eightTasks(), shortTask('new'), { after: 'm2', current: 't2', now: NOW });
  assert.equal(layout(r.plan), 'm1: t1,t2,t3,t4 | m2: t5,t6,t7,t8,t9');
  assert.equal(r.milestone.id, 'm2');
});

test('IDs and progress sent with a new task are ignored', () => {
  const input = {
    ...shortTask('new'),
    id: 't1',
    status: 'done',
    passedAt: '2026-01-01T00:00:00.000Z',
    hintsRevealed: 2,
    skipped: true,
    checklist: [{ id: 't1.c1', text: 'Do it', source: 'fix' }, 'Commit: feat: y'],
  };
  const { task, plan } = insertTask(eightTasks(), input, { after: 't8', current: 't1', now: NOW });
  assert.equal(task.id, 't9');
  assert.equal(task.status, 'todo');
  assert.equal(task.passedAt, null);
  assert.equal(task.hintsRevealed, 0);
  assert.equal(task.skipped, false);
  assert.deepEqual(task.checklist, [
    { id: 't9.c1', text: 'Do it', source: 'plan' },
    { id: 't9.c2', text: 'Commit: feat: y', source: 'plan' },
  ]);
  assertValid(plan);
});

test('nothing lands before the current task or a done task', () => {
  const plan = eightTasks();
  assert.throws(() => insertTask(plan, shortTask('x'), { after: 't2', current: 't3' }), {
    message: "A new task can't go before t3, which is the current task. Put it after t3 or later.",
  });
  assert.throws(() => insertTask(plan, shortTask('x'), { after: 'm1', current: 't5' }), /before t5, which is the current task/);
  assert.doesNotThrow(() => insertTask(plan, shortTask('x'), { after: 't3', current: 't3' }), 'right after the current task is fine');

  const done = eightTasks();
  for (const t of done.milestones[0].tasks) t.status = 'done';
  assert.throws(() => insertTask(done, shortTask('x'), { after: 't3', current: null }), {
    message: "A new task can't go before t4, which is done. Put it after t4 or later.",
  });
  // An out-of-order plan: a done task after a todo one still fixes everything before it.
  const odd = eightTasks();
  odd.milestones[1].tasks[1].status = 'done';
  assert.throws(() => insertTask(odd, shortTask('x'), { after: 'm1', current: 't1' }), /before t6, which is done/);

  try {
    insertTask(plan, shortTask('x'), { after: 't1', current: 't2' });
    assert.fail('expected a refusal');
  } catch (err) {
    assert.equal(/** @type {any} */ (err).exit, EXIT.refused);
  }
  assert.throws(() => insertTask(plan, shortTask('x'), { after: 'zzz', current: 't1' }), /No task or milestone "zzz"/);
  assert.throws(() => insertTask(plan, 'a string', { after: 't1', current: 't1' }), /must be a JSON object/);
});

test('a step joins a task not started yet, before its commit step', () => {
  const plan = eightTasks();
  const before = JSON.stringify(plan);
  const r = insertStep(plan, '  Add   an empty state ', { to: 't5', current: 't2' });
  assert.deepEqual(r.item, { id: 't5.c4', text: 'Add an empty state', source: 'plan' });
  assert.deepEqual(r.task.checklist.map((i) => i.text), ['Branch feat/x', 'Do the thing', 'Add an empty state', 'Commit: feat: x']);
  assert.equal(JSON.stringify(plan), before);
  assertValid(r.plan);

  const noCommit = eightTasks();
  noCommit.milestones[1].tasks[0].checklist.pop();
  assert.equal(insertStep(noCommit, 'Last', { to: 't5', current: 't1' }).task.checklist.at(-1)?.text, 'Last', 'without a commit step it goes last');
});

test('steps are refused on the current task, done tasks and full tasks', () => {
  const plan = eightTasks();
  assert.throws(() => insertStep(plan, 'x', { to: 't2', current: 't2' }), /t2 is the current task, and its card never changes under the learner\. Add a follow-up task after it instead\./);
  plan.milestones[0].tasks[0].status = 'done';
  assert.throws(() => insertStep(plan, 'x', { to: 't1', current: 't2' }), /t1 is done/);
  assert.throws(() => insertStep(plan, 'x', { to: 't9', current: 't2' }), /No task "t9"/);
  assert.throws(() => insertStep(plan, '   ', { to: 't5', current: 't2' }), /needs some text/);

  let full = plan;
  for (const text of ['One', 'Two', 'Three']) full = insertStep(full, text, { to: 't6', current: 't2' }).plan;
  assert.throws(() => insertStep(full, 'Seven', { to: 't6', current: 't2' }), /t6 already has 6 steps, and the limit is 6/);
  const withFix = eightTasks();
  withFix.milestones[1].tasks[1].checklist.push({ id: 't6.f1', text: 'A fix', source: 'fix' });
  assert.doesNotThrow(() => insertStep(withFix, 'Four', { to: 't6', current: 't2' }), 'fixes do not count toward the limit');
});

test('a milestone of new tasks goes right after another milestone', () => {
  const plan = eightTasks();
  const before = JSON.stringify(plan);
  const r = insertMilestone(plan, { id: 'm1', title: 'Speed', skeleton: true, tasks: [shortTask('a'), shortTask('b')] }, { after: 'm1', current: 't2', now: NOW });
  assert.equal(r.milestone.id, 'm3');
  assert.equal(r.milestone.skeleton, false);
  assert.equal(layout(r.plan), 'm1: t1,t2,t3,t4 | m3: t9,t10 | m2: t5,t6,t7,t8');
  assert.deepEqual(r.milestone.tasks.map((t) => t.checklist[0].id), ['t9.c1', 't10.c1']);
  assert.ok(r.milestone.tasks.every((t) => t.added === NOW.toISOString()));
  assert.equal(JSON.stringify(plan), before);
  assertValid(r.plan);

  assert.throws(() => insertMilestone(plan, { title: 'x', tasks: [shortTask('a')] }, { after: 'm1', current: 't5' }), {
    message: "A new milestone can't go before t5, which is the current task. Put it after m2 or later.",
  });
  assert.throws(() => insertMilestone(plan, { title: 'x', tasks: [] }, { after: 'm1', current: 't1' }), /at least one task/);
  assert.throws(() => insertMilestone(plan, { title: 'x', tasks: [shortTask('a')] }, { after: 't1', current: 't1' }), /No milestone "t1"/);
});

/**
 * @param {string} root
 * @param {unknown} addition
 * @param {string[]} [flags]
 */
const add = (root, addition, flags = []) => cli(root, ['plan', 'add', '-', ...flags], { stdin: JSON.stringify(addition) });

const idea = {
  goal: 'Show a count of recipes on the home page',
  why: 'A number on the home page shows the list is growing.',
  docs: 'docs/prd.md#home',
  focus: ['frontend'],
  checklist: ['Branch feat/count', 'Render the count above the list', 'Commit: feat(web): show the recipe count'],
  doneWhen: 'The home page shows how many recipes there are',
};

test('plan add: a dry run saves nothing; a real add saves, logs one line and shows the tag', () => {
  const { root, paths, cleanup } = approvedProject();
  const planBefore = fs.readFileSync(paths.plan, 'utf8');
  const logBefore = fs.readFileSync(paths.log, 'utf8');

  const dry = add(root, { task: idea, after: 't1' }, ['--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /^Would add t4 after t1, in m1: Show a count of recipes on the home page\nNothing was saved: this was a dry run\./);
  assert.equal(fs.readFileSync(paths.plan, 'utf8'), planBefore, 'the plan file is unchanged');
  assert.equal(fs.readFileSync(paths.log, 'utf8'), logBefore, 'the log is unchanged');

  const real = add(root, { task: idea, after: 't1' });
  assert.equal(real.code, 0, real.err);
  assert.match(real.out, /^Added t4 after t1, in m1: Show a count/);
  assert.doesNotMatch(real.out, /dry run/);
  const added = events(paths.log).filter((e) => e.event === 'task-added');
  assert.deepEqual(added.map((e) => e.fields), [{ task: 't4', after: 't1' }]);
  assert.match(cli(root, ['plan', 'show']).out, /\[>\] t1 .*\n {2}\[ \] t4 {3}Show a count of recipes on the home page · added\n {2}\[ \] t2 /);
  assert.equal(loadSession(paths).currentTask, 't1', 'the current task stays current');

  const json = JSON.parse(add(root, { task: idea, after: 'm2' }, ['--json']).out);
  assert.equal(json.id, 't5');
  assert.equal(json.milestone, 'm2');
  assert.equal(json.saved, true);

  const locked = cli(root, ['plan', 'import', '-'], { stdin: JSON.stringify(samplePlan()) });
  assert.equal(locked.code, EXIT.refused, 'importing a whole new plan over a locked one is still refused');
  assert.match(locked.err, /locked/);
  assert.equal(cli(root, ['validate']).code, 0);
  cleanup();
});

test('plan add: steps, milestones and the refusals', () => {
  const { root, paths, cleanup } = approvedProject();

  const step = add(root, { step: 'Show an error under the form', to: 't3' });
  assert.equal(step.code, 0, step.err);
  assert.match(step.out, /^Added step t3\.c6 to t3: Show an error under the form/);
  const t3 = loadPlan(paths)?.milestones[1].tasks[0];
  assert.deepEqual(t3?.checklist.slice(-2).map((i) => i.id), ['t3.c6', 't3.c5'], 'it goes before the commit step');
  const full = add(root, { step: 'One more', to: 't3' });
  assert.equal(full.code, EXIT.refused);
  assert.match(full.err, /t3 already has 6 steps/);
  assert.match(add(root, { step: 'x', to: 't1' }).err, /t1 is the current task/);

  const ms = add(root, { milestone: { title: 'Search', tasks: [idea, { ...idea, goal: 'Search recipes by name' }] }, after: 'm1' });
  assert.equal(ms.code, 0, ms.err);
  assert.match(ms.out, /^Added m3 after m1, with tasks t4, t5: Search/);
  assert.deepEqual(loadPlan(paths)?.milestones.map((m) => m.id), ['m1', 'm3', 'm2']);

  const kinds = events(paths.log).filter((e) => e.event.endsWith('-added'));
  assert.deepEqual(kinds.map((e) => [e.event, e.fields]), [
    ['step-added', { task: 't3', item: 't3.c6' }],
    ['milestone-added', { milestone: 'm3', after: 'm1', tasks: '2' }],
  ]);

  const before = cli(root, ['plan', 'show']).out;
  assert.equal(add(root, { task: idea, after: 'zzz' }).code, EXIT.error);
  const invalid = add(root, { task: { ...idea, goal: undefined }, after: 'm2' });
  assert.equal(invalid.code, EXIT.error);
  assert.match(invalid.err, /The new task is invalid/);
  assert.match(add(root, { task: idea, step: 'x', after: 't1' }).err, /Add one thing at a time/);
  assert.match(add(root, { task: idea, after: 't1', where: 'here' }).err, /Unknown field "where"/);
  assert.match(add(root, { task: idea }).err, /Say where the task goes with "after"/);
  assert.match(add(root, { step: 'x' }).err, /Say which task the step joins with "to"/);
  assert.equal(cli(root, ['plan', 'show']).out, before, 'failed additions change nothing');
  cleanup();
});

test('an added task becomes current when every other task is done', () => {
  const { root, paths, cleanup } = approvedProject();
  for (let i = 0; i < 3; i++) assert.equal(cli(root, ['task', 'pass', '--override', 'test']).code, 0);
  assert.equal(loadSession(paths).currentTask, null);

  const dry = add(root, { task: idea, after: 'm2' }, ['--dry-run']);
  assert.doesNotMatch(dry.out, /current task now/, 'a dry run starts nothing');
  assert.equal(loadSession(paths).currentTask, null);

  const r = add(root, { task: idea, after: 'm2' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /t4 is the current task now, since every other task was done\./);
  const session = loadSession(paths);
  assert.equal(session.currentTask, 't4');
  assert.equal(session.tasks.t4.startCommit, headCommit(root));
  assert.ok(events(paths.log).some((e) => e.event === 'task-start' && e.fields.task === 't4'));
  cleanup();
});

test('the card and the window tag added tasks', () => {
  const { root, paths, cleanup } = approvedProject();
  add(root, { task: idea, after: 't1' });
  const plan = loadPlan(paths);
  assert.ok(plan);
  const card = cardData(plan, 't4', { version: 1, ticks: {} });
  assert.match(card.added ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.match(renderCard(card), /^Task 2\/4 · Milestone 1: Walking skeleton · added \d{4}-\d{2}-\d{2}\n/);
  assert.equal(cardData(plan, 't1', { version: 1, ticks: {} }).added, null);

  const s = windowState(paths, { commands: {} });
  assert.deepEqual(
    s.milestones?.map((m) => m.tasks.map((t) => `${t.id}${t.added ? '+' : ''}`)),
    [['t1', 't4+', 't2'], ['t3']],
  );
  cli(root, ['task', 'pass', '--override', 'test']);
  assert.equal(windowState(paths, { commands: {} }).card?.added, card.added, 'the current card carries the tag');
  cleanup();
});
