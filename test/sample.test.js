// The sample project generator: each scenario builds, validates, and lands where it says.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cli } from './helpers.js';

const CREATE = path.resolve(import.meta.dirname, '..', 'examples', 'sample', 'create.js');

/**
 * @param {string} scenario
 * @param {string[]} [extra]
 */
function create(scenario, extra = []) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'menitor-sample-')));
  const root = path.join(parent, 'recipe-box');
  const out = execFileSync(process.execPath, [CREATE, root, '--scenario', scenario, ...extra], { encoding: 'utf8' });
  return { root, out, cleanup: () => fs.rmSync(parent, { recursive: true, force: true }) };
}

/** @param {string} root */
const check = (root) => JSON.parse(cli(root, ['check', 'run', '--json', '--no-diff']).out);

test('start: an approved plan on task 1, with nothing built yet', () => {
  const { root, out, cleanup } = create('start');
  assert.match(out, /Created the Menitor sample project \(scenario: start\)/);
  assert.match(out, /Check it loaded/);
  assert.match(cli(root, ['validate']).out, /All state files are valid/);
  const status = JSON.parse(cli(root, ['status', '--json']).out);
  assert.equal(status.approved, true);
  assert.equal(status.current.id, 't1');
  assert.deepEqual(status.focusAreas, ['backend', 'frontend', 'deployment']);
  const r = check(root);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((/** @type {any} */ p) => p.text.startsWith('test failed')), 'the starter test fails until the learner builds task 1');
  assert.match(cli(root, ['task', 'hint']).out, /Hint 1\/4 for t1 \(concept\)/, 'milestone 1 hints are stored');
  assert.match(cli(root, ['task', 'brief']).out, /Docs {7}docs\/flow\.md#home[\s\S]*\n\n### Home\n/);
  cleanup();
});

test('check: task 1 is built and committed, and the check is clean', () => {
  const { root, cleanup } = create('check');
  const r = check(root);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.deepEqual(r.commits.map((/** @type {any} */ c) => c.subject), ['feat(web): add home page']);
  assert.equal(r.ticks.unticked.length, 0);
  const pass = cli(root, ['task', 'pass']);
  assert.match(pass.err, /hasn't explained their code/, 'the explain-back is still the learner’s to give');
  cleanup();
});

test('delegated: task 1 passed through the real gate, and task 2 is Menitor’s', () => {
  const { root, cleanup } = create('delegated');
  const status = JSON.parse(cli(root, ['status', '--json']).out);
  assert.equal(status.current.id, 't2');
  assert.equal(status.current.owner, 'delegated');
  assert.equal(status.written.learner, 1);
  const log = fs.readFileSync(path.join(root, '.menitor', 'log.md'), 'utf8');
  assert.doesNotMatch(log, / override /, 'no override was needed');
  cleanup();
});

test('the sample tells Claude Code to load Menitor: locally by default, or from GitHub', () => {
  const MENITOR_ROOT = path.resolve(import.meta.dirname, '..');
  const local = create('start');
  const settings = JSON.parse(fs.readFileSync(path.join(local.root, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(settings, {
    extraKnownMarketplaces: { menitor: { source: { source: 'directory', path: MENITOR_ROOT } } },
    enabledPlugins: { 'menitor@menitor': true },
  });
  const ignored = execFileSync('git', ['check-ignore', '.claude/settings.local.json'], { cwd: local.root, encoding: 'utf8' });
  assert.equal(ignored.trim(), '.claude/settings.local.json', 'the machine-specific file stays out of git');
  assert.match(local.out, /Accept the prompt to trust the folder/);
  local.cleanup();

  const gh = create('start', ['--plugin', 'github', '--ref', 'main']);
  const committed = JSON.parse(fs.readFileSync(path.join(gh.root, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(committed.extraKnownMarketplaces.menitor.source, { source: 'github', repo: 'Issmuth/menitor', ref: 'main' });
  assert.equal(execFileSync('git', ['ls-files', '.claude/settings.json'], { cwd: gh.root, encoding: 'utf8' }).trim(), '.claude/settings.json');
  gh.cleanup();

  const none = create('start', ['--plugin', 'none']);
  assert.equal(fs.existsSync(path.join(none.root, '.claude')), false);
  assert.match(none.out, /claude --plugin-dir/);
  none.cleanup();
});

test('the generator refuses a folder that is not empty, and unknown scenarios', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'menitor-sample-'));
  fs.writeFileSync(path.join(parent, 'x'), 'x');
  assert.throws(() => execFileSync(process.execPath, [CREATE, parent], { stdio: 'pipe' }));
  assert.throws(() => execFileSync(process.execPath, [CREATE, path.join(parent, 'new'), '--scenario', 'nope'], { stdio: 'pipe' }));
  assert.throws(() => execFileSync(process.execPath, [CREATE, path.join(parent, 'new'), '--plugin', 'nope'], { stdio: 'pipe' }));
  fs.rmSync(parent, { recursive: true, force: true });
});
