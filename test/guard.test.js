import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { approvedProject, cli, makeProject, samplePlan } from './helpers.js';
import { applyLearnerCommand, appendActivity, classifyPath, decideCommand, decideFileWrite, loadGuardContext } from '../core/lib/guard.js';
import { loadGuard, loadPlan } from '../core/lib/state.js';
import { parseLog } from '../core/lib/log.js';

test('path areas', () => {
  const root = path.resolve('/proj');
  /** @param {string} p @param {string | null} [cwd] */
  const area = (p, cwd = root) => classifyPath(root, cwd, p);
  assert.equal(area('src/app.js'), 'project');
  assert.equal(area('docs/prd.md'), 'docs');
  assert.equal(area('.menitor/warmup/ex.js'), 'menitor');
  assert.equal(area('.menitor/drafts/plan.json'), 'menitor');
  for (const s of ['.menitor/plan.json', '.menitor/guard.json', '.menitor/activity.jsonl', '.menitor/learner.md', '.menitor/log.md', '.menitor/.gitignore', '.menitor', '.menitor/*.json']) {
    assert.equal(area(s), 'state', s);
  }
  assert.equal(area('node_modules/x'), 'build');
  assert.equal(area('dist'), 'build');
  assert.equal(area('/dev/null'), 'null');
  assert.equal(area('/tmp/out.txt'), 'outside');
  assert.equal(area('../other/x.js'), 'outside');
  assert.equal(area('.'), 'project');
  assert.equal(area('a.js', path.join(root, 'docs')), 'docs');
  assert.equal(area('src/*.js'), 'project');
  assert.equal(area('*.md', path.join(root, 'docs')), 'docs');
  assert.equal(area('$OUT/x.js'), 'unknown');
  assert.equal(area('a.js', null), 'unknown');
  assert.equal(area(path.join(root, 'src', 'a.js'), null), 'project');
  assert.equal(area('src\\app.js'), 'project');
});

test('outside a Menitor project the guard does nothing', () => {
  const { root, cleanup } = makeProject();
  const ctx = loadGuardContext(root);
  assert.equal(ctx.active, false);
  assert.equal(decideFileWrite(ctx, path.join(root, 'src/a.js')).allow, true);
  assert.equal(decideCommand(ctx, 'git commit -m x').allow, true);
  cleanup();
});

test('during setup only docs/ and .menitor/ are writable', () => {
  const { root, cleanup } = makeProject();
  cli(root, ['init']);
  const ctx = loadGuardContext(root);
  assert.equal(ctx.blocker, 'setup');
  assert.equal(decideFileWrite(ctx, path.join(root, 'docs/prd.md')).allow, true);
  assert.equal(decideFileWrite(ctx, path.join(root, '.menitor/warmup/ex.md')).allow, true);
  const d = decideFileWrite(ctx, path.join(root, 'src/app.js'));
  assert.equal(d.allow, false);
  assert.equal(!d.allow && d.rule, 'project-write');
  cleanup();
});

test('state files are protected even when writes are allowed', () => {
  const { root, cleanup } = approvedProject();
  applyLearnerCommand(root, { command: 'off' });
  const ctx = loadGuardContext(root);
  assert.equal(ctx.writes, 'mode-off');
  assert.equal(decideFileWrite(ctx, path.join(root, 'src/app.js')).allow, true);
  for (const target of ['.menitor/plan.json', '.menitor/guard.json', '.menitor/log.md']) {
    const d = decideFileWrite(ctx, path.join(root, target));
    assert.equal(!d.allow && d.rule, 'state-file', target);
  }
  for (const cmd of ['echo {} > .menitor/guard.json', 'rm -rf .menitor', 'sed -i s/on/off/ .menitor/guard.json', 'cp x.json .menitor/plan.json']) {
    const d = decideCommand(ctx, cmd, { cwd: root });
    assert.equal(!d.allow && d.rule, 'state-file', cmd);
  }
  assert.equal(decideCommand(ctx, 'cat .menitor/plan.json', { cwd: root }).allow, true);
  const sneaky = decideCommand(ctx, `node -e "import('./core/lib/guard.js').then((g) => g.applyLearnerCommand('.', { command: 'off' }))"`, { cwd: root });
  assert.equal(!sneaky.allow && sneaky.rule, 'state-file');
  const python = decideCommand(ctx, `python3 -c "import json; json.load(open('.menitor/guard.json'))"`, { cwd: root });
  assert.equal(!python.allow && python.rule, 'state-file');
  cleanup();
});

test('a learner task blocks project writes, git and installs; read-only work passes', () => {
  const { root, cleanup } = approvedProject();
  const ctx = loadGuardContext(root);
  assert.equal(ctx.task, 't1');
  assert.equal(ctx.blocker, 'learner-task');
  /** @param {string} cmd */
  const rule = (cmd) => {
    const d = decideCommand(ctx, cmd, { cwd: root });
    return d.allow ? 'allow' : d.rule;
  };
  assert.equal(rule('echo hi > src/app.js'), 'project-write');
  assert.equal(rule('cd src && touch x && echo hi > app.js'), 'project-write');
  assert.equal(rule('git commit -m "feat: x"'), 'git');
  assert.equal(rule('npm i express'), 'package');
  assert.equal(rule(`node -e "require('fs').writeFileSync('a', 'b')"`), 'script-write');
  for (const ok of ['npm test', 'npm run build 2>&1 | tail -20', 'git status && git diff', 'ls -la src', 'cat src/app.js', 'rm -rf node_modules .next', 'echo notes > /tmp/x.txt', 'echo draft > docs/notes.md', 'npm install']) {
    assert.equal(rule(ok), 'allow', ok);
  }
  assert.equal(decideFileWrite(ctx, path.join(root, 'src/app.js')).allow, false);
  assert.equal(decideFileWrite(ctx, path.join(os.tmpdir(), 'scratch.txt')).allow, true);
  cleanup();
});

test('delegated tasks open project writes', () => {
  const { root, cleanup } = approvedProject();
  cli(root, ['task', 'pass', '--override', 'test']);
  const ctx = loadGuardContext(root);
  assert.equal(ctx.task, 't2');
  assert.equal(ctx.writes, 'delegated');
  assert.equal(decideFileWrite(ctx, path.join(root, 'src/app.js')).allow, true);
  assert.equal(decideCommand(ctx, 'git commit -m x', { cwd: root }).allow, true);
  cleanup();
});

test('skip needs one pushback, then the learner confirm, and grants one task only', () => {
  const { root, paths, cleanup } = approvedProject();
  assert.equal(applyLearnerCommand(root, { command: 'skip', confirm: true }).status, 'confirm-first');
  assert.equal(loadGuard(paths).grants.t1, undefined);
  assert.equal(applyLearnerCommand(root, { command: 'skip', confirm: false }).status, 'already-requested');
  assert.equal(applyLearnerCommand(root, { command: 'skip', confirm: true }).status, 'granted');
  assert.equal(applyLearnerCommand(root, { command: 'skip', confirm: true }).status, 'already-granted');
  assert.equal(loadGuardContext(root).writes, 'granted');

  assert.equal(cli(root, ['task', 'skip']).code, 0);
  assert.equal(loadPlan(paths)?.milestones[0].tasks[0].owner, 'delegated');
  cli(root, ['task', 'pass', '--override', 'test']);
  cli(root, ['task', 'pass', '--override', 'test']);
  const ctx = loadGuardContext(root);
  assert.equal(ctx.task, 't3');
  assert.equal(ctx.writes, 'no', 'the grant does not carry over to the next task');

  const skips = parseLog(fs.readFileSync(paths.log, 'utf8')).filter((e) => e.event === 'skip').map((e) => e.fields.stage);
  assert.deepEqual(skips, ['requested', 'confirmed']);
  cleanup();
});

test('mentor mode toggles and survives a broken guard file', () => {
  const { root, paths, cleanup } = approvedProject();
  assert.equal(applyLearnerCommand(root, { command: 'on' }).status, 'already-on');
  assert.equal(applyLearnerCommand(root, { command: 'off' }).status, 'mode-off');
  assert.equal(applyLearnerCommand(root, { command: 'off' }).status, 'already-off');
  fs.writeFileSync(paths.guard, 'not json');
  const broken = loadGuardContext(root);
  assert.equal(broken.blocker, 'state-error');
  assert.equal(decideFileWrite(broken, path.join(root, 'src/a.js')).allow, false);
  assert.equal(decideCommand(broken, 'npm test', { cwd: root }).allow, true, 'read-only work still runs');
  assert.equal(applyLearnerCommand(root, { command: 'off' }).status, 'mode-off', 'the learner can always recover');
  assert.equal(loadGuardContext(root).writes, 'mode-off');
  cleanup();
});

test('skip with no approved plan reports no task', () => {
  const { root, cleanup } = makeProject();
  cli(root, ['init']);
  cli(root, ['plan', 'import', '-'], { stdin: JSON.stringify(samplePlan()) });
  assert.equal(applyLearnerCommand(root, { command: 'skip', confirm: false }).status, 'no-task');
  assert.equal(applyLearnerCommand(null, { command: 'off' }).status, 'inactive');
  cleanup();
});

test('activity lines are validated and appended', () => {
  const { root, paths, cleanup } = approvedProject();
  const ctx = loadGuardContext(root);
  appendActivity(ctx, { tool: 'Bash', command: 'npm test', effects: [] }, { now: new Date('2026-11-04T10:00:00Z') });
  appendActivity(ctx, { tool: 'Write', file: 'docs/a.md', targets: [{ path: 'docs/a.md', area: 'docs', kind: 'write' }] });
  const lines = fs.readFileSync(paths.activity, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { at: '2026-11-04T10:00:00.000Z', tool: 'Bash', task: 't1', writes: 'no', command: 'npm test' });
  assert.equal(lines[1].file, 'docs/a.md');
  assert.equal(appendActivity(loadGuardContext(null), { tool: 'Bash' }), null);
  cleanup();
});
