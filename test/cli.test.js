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

  const pass = cli(root, ['task', 'pass', '--revisit', 'semantic HTML']);
  assert.equal(pass.code, 0, pass.err);
  assert.match(pass.out, /Passed t1 \(written by the learner\)/);
  assert.match(pass.out, /Task 2\/3/);
  const session = loadSession(paths);
  assert.equal(session.currentTask, 't2');
  assert.equal(session.tasks.t2.startCommit, headCommit(root));
  assert.notEqual(session.tasks.t2.startCommit, session.tasks.t1.startCommit);
  assert.match(fs.readFileSync(paths.learner, 'utf8'), /revisit:\n {2}- semantic HTML/);

  const delegated = cli(root, ['task', 'pass', '--note', 'Deployed main to Vercel.']);
  assert.match(delegated.out, /Passed t2 \(delegated\)/);
  assert.equal(loadPlan(paths)?.milestones[0].tasks[1].note, 'Deployed main to Vercel.');

  cli(root, ['task', 'pass']);
  assert.equal(loadSession(paths).currentTask, null);
  const done = cli(root, ['task', 'show']);
  assert.equal(done.code, EXIT.error);
  assert.match(done.err, /Every task is done/);

  const log = events(paths.log).map((e) => `${e.event}${e.fields.task ? ` ${e.fields.task}` : ''}`);
  assert.deepEqual(log.slice(-8), ['plan-approved', 'task-start t1', 'pass t1', 'revisit t1', 'task-start t2', 'pass t2', 'task-start t3', 'pass t3']);
  cleanup();
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

  cli(root, ['task', 'pass']);
  const status = JSON.parse(cli(root, ['status', '--json']).out);
  assert.deepEqual(status.written, { learner: 0, delegated: 1, skipped: 1, focusTasksDone: 1 });
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
