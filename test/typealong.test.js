// Type-along: the learner turns it on, the agent stores each step's code, and the window
// receives a step's code only once the step before it is ticked.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { approvedProject, cli } from './helpers.js';
import { applyLearnerCommand } from '../core/lib/guard.js';
import { loadGuard, loadSolutions, saveProgress } from '../core/lib/state.js';
import { parseLog } from '../core/lib/log.js';
import { windowState } from '../core/server/server.js';
import { parseLearnerPrompt } from '../adapters/claude-code/handlers.js';
import { EXIT } from '../core/lib/errors.js';

const HOOK = path.resolve(import.meta.dirname, '..', 'adapters', 'claude-code', 'hook.js');
const CREATE = path.resolve(import.meta.dirname, '..', 'examples', 'sample', 'create.js');

const STEPS = {
  't1.c1': { say: 'Create the branch from main.', code: [{ where: 'Terminal', text: 'git checkout -b feat/skeleton' }] },
  't1.c2': { say: 'Add the heading to the home page.', code: [{ where: 'src/index.html', text: '<h1>Recipe box</h1>' }] },
  't1.c3': { say: 'Commit it.', code: [{ text: 'git commit -am "feat(web): add home page"' }] },
};

/**
 * @param {string} event
 * @param {Record<string, unknown>} input
 */
function hook(event, input) {
  const r = spawnSync(process.execPath, [HOOK, event], { input: JSON.stringify({ hook_event_name: event, ...input }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test('only the learner turns type-along on and off, and each change is logged once', () => {
  const { root, paths, cleanup } = approvedProject();
  assert.equal(loadGuard(paths).typeAlong ?? false, false);
  assert.equal(applyLearnerCommand(root, { command: 'typealong', on: true }).status, 'typealong-on');
  assert.equal(applyLearnerCommand(root, { command: 'typealong', on: true }).status, 'already-typealong-on');
  assert.equal(loadGuard(paths).typeAlong, true);
  assert.match(cli(root, ['status']).out, /mentor mode on · type-along on/);
  assert.equal(applyLearnerCommand(root, { command: 'typealong', on: false }).status, 'typealong-off');
  const values = parseLog(fs.readFileSync(paths.log, 'utf8')).filter((e) => e.event === 'typealong').map((e) => e.fields.value);
  assert.deepEqual(values, ['on', 'off']);
  assert.equal(cli(root, ['log', 'typealong', 'value=on']).code, EXIT.refused, 'the agent cannot log it by hand');
  cleanup();
});

test('steps import stores code by checklist ID and refuses what does not fit', () => {
  const { root, paths, cleanup } = approvedProject();
  const ok = cli(root, ['steps', 'import', '-'], { stdin: JSON.stringify(STEPS) });
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(Object.keys(loadSolutions(paths).steps), ['t1.c1', 't1.c2', 't1.c3']);

  const unknown = cli(root, ['steps', 'import', '-'], { stdin: JSON.stringify({ 't9.c1': STEPS['t1.c1'] }) });
  assert.equal(unknown.code, EXIT.error);
  assert.match(unknown.err, /No checklist item "t9.c1"/);
  const delegated = cli(root, ['steps', 'import', '-'], { stdin: JSON.stringify({ 't2.c1': STEPS['t1.c1'] }) });
  assert.match(delegated.err, /delegated tasks/);
  const bad = cli(root, ['steps', 'import', '-'], { stdin: JSON.stringify({ 't1.c1': { say: 'x', code: [{ where: 'a.js' }] } }) });
  assert.match(bad.err, /text is required/);

  const long = cli(root, ['steps', 'import', '-'], { stdin: JSON.stringify({ 't1.c1': { say: Array.from({ length: 30 }, () => 'word').join(' '), code: [] } }) });
  assert.match(long.out, /30-word sentence/, 'plain-language warnings come back');
  assert.match(cli(root, ['task', 'brief']).out, /^(?!.*Type-along)/s, 'the brief is quiet while type-along is off');
  applyLearnerCommand(root, { command: 'typealong', on: true });
  assert.match(cli(root, ['task', 'brief']).out, /Type-along on · code stored for 3 of 3 steps/);
  cleanup();
});

test('older projects get solutions.json added to their .menitor/.gitignore', () => {
  const { root, paths, cleanup } = approvedProject();
  fs.writeFileSync(paths.gitignore, 'progress.json\nsession.json\n');
  cli(root, ['steps', 'import', '-'], { stdin: JSON.stringify(STEPS) });
  assert.match(fs.readFileSync(paths.gitignore, 'utf8'), /^solutions\.json$/m);
  cli(root, ['steps', 'import', '-'], { stdin: JSON.stringify(STEPS) });
  assert.equal(fs.readFileSync(paths.gitignore, 'utf8').match(/solutions\.json/g)?.length, 1, 'added once');
  execFileSync('git', ['add', '-A'], { cwd: root });
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' });
  assert.doesNotMatch(staged, /solutions\.json/, 'step code never reaches the repo');
  cleanup();
});

test('the window gets a step’s code only once the step before it is ticked', () => {
  const { root, paths, cleanup } = approvedProject();
  cli(root, ['steps', 'import', '-'], { stdin: JSON.stringify(STEPS) });
  assert.equal(windowState(paths, { commands: {} }).typeAlong, null, 'nothing while type-along is off');

  applyLearnerCommand(root, { command: 'typealong', on: true });
  let steps = /** @type {any} */ (windowState(paths, { commands: {} }).typeAlong).steps;
  assert.deepEqual(steps['t1.c1'], STEPS['t1.c1']);
  assert.deepEqual(steps['t1.c2'], { locked: true });
  assert.deepEqual(steps['t1.c3'], { locked: true });
  assert.doesNotMatch(JSON.stringify(windowState(paths, { commands: {} })), /Recipe box<\/h1>|git commit -am/, 'locked code never leaves the server');

  saveProgress(paths, { version: 1, ticks: { 't1.c1': new Date().toISOString() } });
  steps = /** @type {any} */ (windowState(paths, { commands: {} }).typeAlong).steps;
  assert.deepEqual(steps['t1.c2'], STEPS['t1.c2']);
  assert.deepEqual(steps['t1.c3'], { locked: true });

  cli(root, ['task', 'fix', 'Use an h1, not a div']);
  saveProgress(paths, { version: 1, ticks: { 't1.c1': 'x', 't1.c2': 'x', 't1.c3': 'x' } });
  steps = /** @type {any} */ (windowState(paths, { commands: {} }).typeAlong).steps;
  assert.deepEqual(steps['t1.f1'], { missing: true }, 'an open step with no code yet says so');

  cli(root, ['task', 'pass', '--override', 'test']);
  assert.equal(windowState(paths, { commands: {} }).typeAlong, null, 'delegated tasks have no type-along');
  cleanup();
});

test('the hooks record /menitor:typealong from the learner and refuse it from the agent', () => {
  assert.deepEqual(parseLearnerPrompt('/menitor:typealong'), { command: 'typealong', on: true });
  assert.deepEqual(parseLearnerPrompt('/menitor:typealong off'), { command: 'typealong', on: false });
  assert.deepEqual(parseLearnerPrompt('/menitor:typealong on'), { command: 'typealong', on: true });
  assert.equal(parseLearnerPrompt('/menitor:typealongs'), null);

  const { root, paths, cleanup } = approvedProject();
  const skill = hook('PreToolUse', { cwd: root, tool_name: 'Skill', tool_input: { skill: 'menitor:typealong' } });
  assert.equal(skill.hookSpecificOutput.permissionDecision, 'deny');
  const on = hook('UserPromptSubmit', { cwd: root, prompt: '/menitor:typealong' });
  assert.match(on.hookSpecificOutput.additionalContext, /turned type-along on \(recorded\).*steps import.*Never paste step code into chat/);
  assert.equal(loadGuard(paths).typeAlong, true);
  const start = hook('SessionStart', { cwd: root, source: 'startup' });
  assert.match(start.hookSpecificOutput.additionalContext, /Type-along is on/);
  hook('UserPromptSubmit', { cwd: root, prompt: '/menitor:typealong off' });
  assert.equal(loadGuard(paths).typeAlong, false);
  cleanup();
});

test('the typealong sample scenario is ready to try', () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'menitor-sample-')));
  const root = path.join(parent, 'recipe-box');
  const out = execFileSync(process.execPath, [CREATE, root, '--scenario', 'typealong', '--plugin', 'none'], { encoding: 'utf8' });
  assert.match(out, /scenario: typealong/);
  assert.match(cli(root, ['status']).out, /type-along on/);
  assert.match(cli(root, ['task', 'brief']).out, /code stored for 5 of 5 steps/);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', '.menitor/solutions.json'], { cwd: root, encoding: 'utf8' }), '', 'ignored by git');
  fs.rmSync(parent, { recursive: true, force: true });
});
