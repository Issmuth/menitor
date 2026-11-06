import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { approvedProject, cli, makeProject, samplePlan } from './helpers.js';
import { EXIT } from '../core/lib/errors.js';
import { loadGuard, loadPlan, loadSession, saveGuard, saveProgress } from '../core/lib/state.js';
import { parseLog } from '../core/lib/log.js';
import { headCommit } from '../core/lib/git.js';

const BIN = path.resolve(import.meta.dirname, '..', 'core', 'bin', 'menitor.js');

/** @param {string} file */
const events = (file) => parseLog(fs.readFileSync(file, 'utf8'));

test('init creates the state folder once, at the repo root', () => {
  const { root, paths, cleanup } = makeProject();
  fs.mkdirSync(path.join(root, 'src'));
  const r = cli(path.join(root, 'src'), ['init']);
  assert.equal(r.code, 0, r.err);
  for (const f of ['session.json', 'learner.md', 'log.md', '.gitignore']) assert.ok(fs.existsSync(path.join(paths.dir, f)), f);
  assert.match(fs.readFileSync(paths.gitignore, 'utf8'), /^progress\.json$/m);
  assert.doesNotMatch(fs.readFileSync(paths.gitignore, 'utf8'), /^plan\.json$/m);
  assert.deepEqual(events(paths.log).map((e) => e.event), ['init']);
  assert.equal(cli(root, ['init']).code, EXIT.error);
  cleanup();
});

test('commands find .menitor/ from a subfolder and fail clearly without it', () => {
  const { root, cleanup } = makeProject();
  const missing = cli(root, ['status']);
  assert.equal(missing.code, EXIT.error);
  assert.match(missing.err, /No \.menitor\/ folder/);
  cli(root, ['init']);
  fs.mkdirSync(path.join(root, 'deep', 'er'), { recursive: true });
  assert.equal(cli(path.join(root, 'deep', 'er'), ['status']).code, 0);
  cleanup();
});

test('plan lint reports errors without saving; import saves; approve locks and starts task 1', () => {
  const { root, paths, cleanup } = makeProject();
  cli(root, ['init']);
  const bad = samplePlan();
  bad.milestones[0].tasks[0].checklist = [];
  const lint = cli(root, ['plan', 'lint', '-', '--json'], { stdin: JSON.stringify(bad) });
  assert.equal(lint.code, EXIT.error);
  assert.deepEqual(JSON.parse(lint.out).errors, ['$.milestones[0].tasks[0].checklist must have at least 1 item']);
  assert.equal(fs.existsSync(paths.plan), false);

  fs.writeFileSync(path.join(root, 'draft.json'), JSON.stringify(samplePlan()));
  assert.equal(cli(root, ['plan', 'import', 'draft.json']).code, 0);
  assert.equal(loadPlan(paths)?.approvedAt, null);
  assert.equal(cli(root, ['plan', 'import', 'draft.json']).code, 0, 'drafts can be replaced before approval');

  const approve = cli(root, ['plan', 'approve']);
  assert.equal(approve.code, 0, approve.err);
  assert.match(approve.out, /Task 1\/3 · Milestone 1: Walking skeleton/);
  assert.match(approve.out, /The learner has no level yet/);
  const session = loadSession(paths);
  assert.equal(session.currentTask, 't1');
  assert.equal(session.tasks.t1.startCommit, headCommit(root));

  const locked = cli(root, ['plan', 'import', 'draft.json']);
  assert.equal(locked.code, EXIT.refused);
  assert.match(locked.err, /locked/);
  assert.equal(cli(root, ['plan', 'approve']).code, EXIT.error);
  cleanup();
});

test('the card shows ticks from the window, fixes and hint state', () => {
  const { root, paths, cleanup } = approvedProject();
  saveProgress(paths, { version: 1, ticks: { 't1.c1': '2026-11-04T10:00:00Z' } });
  cli(root, ['task', 'fix', 'Use an h1 for the heading']);
  const card = cli(root, ['task', 'show']).out;
  assert.match(card, /^\[x\] Branch feat\/skeleton$/m);
  assert.match(card, /^\[ \] Render a heading on the home page$/m);
  assert.match(card, /^\[ \] Fix: Use an h1 for the heading$/m);
  assert.match(card, /^Hints {6}concept · approach · pseudocode · snippet \(not written yet\)$/m);
  assert.match(cli(root, ['task', 'show', '--ids']).out, /^\[ \] t1\.f1 Fix: Use an h1/m);
  const json = JSON.parse(cli(root, ['task', 'show', 't3', '--json']).out);
  assert.equal(json.number, 3);
  assert.deepEqual(json.hints.rungs.map((/** @type {{ text: unknown }} */ r) => r.text), [null, null, null, null], 'locked hint text never leaves the CLI');
  cleanup();
});

test('tasks pass in order and record the next start commit', () => {
  const { root, paths, cleanup } = approvedProject();
  const outOfOrder = cli(root, ['task', 'pass', 't2']);
  assert.equal(outOfOrder.code, EXIT.refused);
  assert.match(outOfOrder.err, /not the current task \(t1 is\)/);

  fs.writeFileSync(path.join(root, 'index.html'), '<h1>Recipe box</h1>');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'feat(web): add home page'], { cwd: root });

  const gate = cli(root, ['task', 'pass']);
  assert.equal(gate.code, EXIT.refused);
  assert.match(gate.err, /No check has run for t1 yet/);
  assert.equal(cli(root, ['check', 'run', '--no-diff']).code, 0);
  assert.match(cli(root, ['task', 'pass']).err, /hasn't explained their code/);
  cli(root, ['log', 'explain', 'task=t1', 'outcome=good', 'try=1']);
  const pass = cli(root, ['task', 'pass', '--revisit', 'semantic HTML']);
  assert.equal(pass.code, 0, pass.err);
  assert.match(pass.out, /Passed t1 \(written by the learner\)/);
  assert.match(pass.out, /Task 2\/3/);
  const session = loadSession(paths);
  assert.equal(session.currentTask, 't2');
  assert.equal(session.tasks.t2.startCommit, headCommit(root));
  assert.notEqual(session.tasks.t2.startCommit, session.tasks.t1.startCommit);
  assert.match(fs.readFileSync(paths.learner, 'utf8'), /revisit:\n {2}- semantic HTML/);

  const delegated = cli(root, ['task', 'pass', '--note', 'Deployed main to Vercel.', '--override', 'test: no deploy here']);
  assert.match(delegated.out, /Passed t2 \(delegated\)/);
  assert.equal(loadPlan(paths)?.milestones[0].tasks[1].note, 'Deployed main to Vercel. Passed without a clean check: test: no deploy here');

  cli(root, ['task', 'pass', '--override', 'test']);
  assert.equal(loadSession(paths).currentTask, null);
  const done = cli(root, ['task', 'show']);
  assert.equal(done.code, EXIT.error);
  assert.match(done.err, /Every task is done/);

  const log = events(paths.log).map((e) => `${e.event}${e.fields.task ? ` ${e.fields.task}` : ''}`);
  assert.deepEqual(log.slice(-9), ['explain t1', 'pass t1', 'revisit t1', 'task-start t2', 'override t2', 'pass t2', 'task-start t3', 'override t3', 'pass t3']);
  cleanup();
});

test('setup answers are saved as they are given, and show what is left to ask', () => {
  const { root, paths, cleanup } = makeProject();
  try {
    cli(root, ['init']);
    const show = () => JSON.parse(cli(root, ['setup', 'show', '--json']).out);
    assert.deepEqual(show().answers, []);
    assert.deepEqual(
      show().missing.map((/** @type {any} */ m) => m.key),
      ['idea', 'goal', 'time', 'experience', 'stack', 'warmup-question', 'warmup-answer', 'focus', 'help', 'stack-choice', 'prd'],
      'every setup answer, in the order setup asks',
    );

    assert.equal(cli(root, ['setup', 'set', 'idea', 'A recipe box', 'for my family']).code, 0);
    const prd = 'Problem: recipes get lost.\nUsers: my family.\nMust-haves: add, list, search.';
    assert.equal(cli(root, ['setup', 'set', 'prd', '-'], { stdin: `${prd}\n` }).code, 0);
    const s = show();
    assert.deepEqual(s.answers.map((/** @type {any} */ a) => [a.key, a.value]), [['idea', 'A recipe box for my family'], ['prd', prd]]);
    assert.ok(!s.missing.some((/** @type {any} */ m) => m.key === 'idea'));
    assert.match(cli(root, ['setup', 'show']).out, /Idea\s+A recipe box for my family/);
    assert.match(cli(root, ['setup', 'show']).out, /Still to ask: Goal, Time per week/);

    // Answering again replaces the answer.
    cli(root, ['setup', 'set', 'idea', 'A recipe box for friends']);
    assert.equal(show().answers[0].value, 'A recipe box for friends');

    const bad = cli(root, ['setup', 'set', 'colour', 'blue']);
    assert.notEqual(bad.code, 0);
    assert.match(bad.err, /Unknown setup answer "colour"/);
    assert.notEqual(cli(root, ['setup', 'set', 'goal']).code, 0, 'an answer needs text');

    // Personal, so it stays out of git; and validate checks it.
    assert.match(fs.readFileSync(paths.gitignore, 'utf8'), /^setup\.json$/m);
    assert.equal(cli(root, ['validate']).code, 0);
  } finally {
    cleanup();
  }
});

test('setup options for the stack and focus areas are posted through the CLI', () => {
  const { root, cleanup } = makeProject();
  try {
    cli(root, ['init']);
    assert.equal(cli(root, ['setup', 'options', 'focus', 'frontend, backend and APIs,database']).code, 0);
    const stacks = [
      { name: 'Next.js and Postgres', reasons: ['One language front to back', 'Free hosting on Vercel'], hosting: 'Vercel and Neon' },
      { name: 'Express and SQLite', reasons: ['Fewer moving parts'] },
    ];
    assert.equal(cli(root, ['setup', 'options', 'stack', '-'], { stdin: JSON.stringify(stacks) }).code, 0);
    const shown = JSON.parse(cli(root, ['setup', 'show', '--json']).out);
    assert.deepEqual(shown.options.focus, ['frontend', 'backend and APIs', 'database']);
    assert.deepEqual(shown.options.stack, stacks);

    assert.notEqual(cli(root, ['setup', 'options', 'stack', '-'], { stdin: '[]' }).code, 0, 'one to three stacks');
    assert.notEqual(cli(root, ['setup', 'options', 'stack', '-'], { stdin: '[{"name":"x"}]' }).code, 0, 'each with its reasons');
    assert.notEqual(cli(root, ['setup', 'options', 'colour', 'red']).code, 0);
    assert.match(cli(root, ['setup', 'options', 'stack', '-'], { stdin: 'not json' }).err, /JSON/);
  } finally {
    cleanup();
  }
});

test('a learner task can be skipped only with a grant the learner gave', () => {
  const { root, paths, cleanup } = approvedProject();
  const denied = cli(root, ['task', 'skip']);
  assert.equal(denied.code, EXIT.refused);
  assert.match(denied.err, /Only the learner can hand it over/);

  // An adapter hook writes this after the learner confirms the skip themselves.
  const guard = loadGuard(paths);
  guard.grants.t1 = new Date().toISOString();
  saveGuard(paths, guard);

  const ok = cli(root, ['task', 'skip']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /Menitor-Delegated: true/);
  const task = loadPlan(paths)?.milestones[0].tasks[0];
  assert.equal(task?.owner, 'delegated');
  assert.equal(task?.skipped, true);
  assert.equal(events(paths.log).at(-1)?.event, 'delegated');

  cli(root, ['task', 'pass', '--override', 'test']);
  const status = JSON.parse(cli(root, ['status', '--json']).out);
  assert.deepEqual(status.written, { learner: 0, delegated: 1, skipped: 1, focusTasksDone: 1 });
  cleanup();
});

test('with mentor mode off, the agent hands the learner task to itself without a grant', () => {
  const { root, paths, cleanup } = approvedProject();
  // An adapter hook writes this after the learner types the command to turn mentor mode off.
  const guard = loadGuard(paths);
  guard.mentorMode = 'off';
  saveGuard(paths, guard);

  const ok = cli(root, ['task', 'skip']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /t1 is now delegated because mentor mode is off\. .*Menitor-Delegated: true/);
  const task = loadPlan(paths)?.milestones[0].tasks[0];
  assert.equal(task?.owner, 'delegated');
  assert.equal(task?.skipped, true, 'it still counts as skipped in the stats');
  assert.deepEqual(events(paths.log).at(-1)?.fields, { task: 't1', skipped: 'true', via: 'mode-off' });
  assert.deepEqual(loadGuard(paths).grants, {}, 'no grant is written; the guard file keeps one writer');

  cli(root, ['task', 'pass', '--override', 'test']);
  cli(root, ['task', 'pass', '--override', 'test']); // t2 is planned as delegated
  const back = loadGuard(paths);
  back.mentorMode = 'on';
  saveGuard(paths, back);
  assert.equal(loadPlan(paths)?.milestones[1].tasks[0].owner, 'learner', 't3 is the next learner task');
  const denied = cli(root, ['task', 'skip']);
  assert.equal(denied.code, EXIT.refused, 'with mentor mode back on, the next learner task needs a grant again');
  assert.match(denied.err, /Only the learner can hand it over/);
  cleanup();
});

test('hints are stored per milestone and revealed one at a time', () => {
  const { root, paths, cleanup } = approvedProject();
  const none = cli(root, ['task', 'hint']);
  assert.equal(none.code, EXIT.error);
  assert.match(none.err, /no hints stored yet/);

  const hints = { t1: { concept: 'A page is HTML the server sends.', approach: 'Edit the home route.', pseudocode: 'return heading', snippet: '<h1>…</h1>' } };
  assert.equal(cli(root, ['hints', 'import', '-'], { stdin: JSON.stringify(hints) }).code, 0);
  const first = cli(root, ['task', 'hint']);
  assert.match(first.out, /^Hint 1\/4 for t1 \(concept\):\nA page is HTML the server sends\./);
  assert.match(cli(root, ['task', 'show']).out, /concept: A page is HTML the server sends\./);
  assert.match(cli(root, ['task', 'show']).out, /\(1 open, 3 locked\)/);
  assert.equal(cli(root, ['hints', 'import', '-'], { stdin: JSON.stringify(hints) }).code, EXIT.refused);
  assert.match(fs.readFileSync(paths.learner, 'utf8'), /concept: 1/);
  assert.equal(events(paths.log).at(-1)?.event, 'hint');
  cleanup();
});

test('the agent logs its own events; learner and automatic events are refused', () => {
  const { root, paths, cleanup } = approvedProject();
  assert.equal(cli(root, ['log', 'check', 'task=t1', 'result=fail', 'mustFix=2']).code, 0);
  const bad = cli(root, ['log', 'check', 'task=t1', 'result=maybe']);
  assert.equal(bad.code, EXIT.error);
  assert.match(bad.err, /result=maybe must be one of pass, fail/);
  assert.equal(cli(root, ['log', 'mode', 'value=off']).code, EXIT.refused);
  assert.equal(cli(root, ['log', 'pass', 'task=t1', 'by=learner']).code, EXIT.refused);
  assert.equal(events(paths.log).filter((e) => e.event === 'check').length, 1);
  cleanup();
});

test('validate catches broken and inconsistent state', () => {
  const { root, paths, cleanup } = approvedProject();
  assert.equal(cli(root, ['validate']).code, 0);

  const session = JSON.parse(fs.readFileSync(paths.session, 'utf8'));
  session.currentTask = 't99';
  fs.writeFileSync(paths.session, JSON.stringify(session));
  const r = cli(root, ['validate', '--json']);
  assert.equal(r.code, EXIT.error);
  assert.deepEqual(JSON.parse(r.out).errors, ['session.json: the current task "t99" is not in the plan']);

  fs.writeFileSync(paths.plan, '{"version": 2}');
  const broken = JSON.parse(cli(root, ['validate', '--json']).out);
  assert.ok(broken.errors.some((/** @type {string} */ e) => e.startsWith('plan.json is invalid')));
  cleanup();
});

test('learner commands edit the profile and log level changes', () => {
  const { root, paths, cleanup } = makeProject();
  cli(root, ['init']);
  assert.equal(cli(root, ['learner', 'set', 'level', 'expert']).code, EXIT.error);
  cli(root, ['learner', 'set', 'level', 'guided']);
  cli(root, ['learner', 'set', 'level', 'standard']);
  cli(root, ['learner', 'add', 'mistakes', 'Forgets', 'to', 'await']);
  cli(root, ['learner', 'add', 'mistakes', 'Forgets to await']);
  cli(root, ['learner', 'note', 'Explained', 'joins', 'well']);
  const profile = JSON.parse(cli(root, ['learner', 'show', '--json']).out);
  assert.equal(profile.level, 'standard');
  assert.deepEqual(profile.mistakes, ['Forgets to await']);
  assert.equal(cli(root, ['learner', 'remove', 'mistakes', 'not there']).code, EXIT.error);
  assert.equal(cli(root, ['learner', 'add', 'hobbies', 'chess']).code, EXIT.error);
  assert.deepEqual(
    events(paths.log).filter((e) => e.event === 'level').map((e) => `${e.fields.from}->${e.fields.to}`),
    ['none->guided', 'guided->standard'],
  );
  assert.match(fs.readFileSync(paths.learner, 'utf8'), /: Explained joins well\n$/);
  cleanup();
});

test('works without git: start commits are null', () => {
  const { root, paths, cleanup } = makeProject({ git: false });
  cli(root, ['init']);
  cli(root, ['plan', 'import', '-'], { stdin: JSON.stringify(samplePlan()) });
  assert.equal(cli(root, ['plan', 'approve']).code, 0);
  assert.equal(loadSession(paths).tasks.t1.startCommit, null);
  cleanup();
});

test('the bin script runs, prints help and sets exit codes', () => {
  const help = execFileSync(process.execPath, [BIN, 'help'], { encoding: 'utf8' });
  assert.match(help, /menitor plan import/);
  try {
    execFileSync(process.execPath, [BIN, 'nope'], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('expected a non-zero exit');
  } catch (err) {
    const e = /** @type {{ status: number, stderr: string }} */ (err);
    assert.equal(e.status, 1);
    assert.match(e.stderr, /Unknown command "nope"/);
  }
  assert.equal(cli(process.cwd(), ['status', '--bogus']).code, EXIT.error);
});
