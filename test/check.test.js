// The deterministic check runner, on real git repos.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { cli, makeProject, samplePlan } from './helpers.js';
import { npmScriptOf } from '../core/lib/check.js';
import { loadSession } from '../core/lib/state.js';
import { EXIT } from '../core/lib/errors.js';
import { parseLog } from '../core/lib/log.js';

/**
 * @param {string} root
 * @param {string} message
 * @param {string[]} [extra]
 */
function commit(root, message, extra = []) {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Learner', '-c', 'user.email=l@example.com', 'commit', '-q', '-m', message, ...extra], { cwd: root });
}

/**
 * @param {string} root
 * @param {string} file
 * @param {string} text
 */
function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

/**
 * An approved project whose plan the test shapes first.
 * @param {(plan: any) => void} [shape]
 */
async function shapedProject(shape) {
  const project = makeProject();
  const plan = samplePlan();
  if (shape) shape(plan);
  for (const args of [['init'], ['learner', 'set', 'focusAreas', 'frontend,database'], ['plan', 'import', '-']]) {
    const r = cli(project.root, args, { stdin: JSON.stringify(plan) });
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
  }
  // Commit setup before approval, so the task's own work is all that shows up as new.
  commit(project.root, 'chore: add the menitor plan');
  const approve = cli(project.root, ['plan', 'approve']);
  assert.equal(approve.code, 0, approve.err);
  return project;
}

/**
 * Run `check run --json` and parse it.
 * @param {string} root
 * @param {string[]} [args]
 */
function check(root, args = []) {
  const r = cli(root, ['check', 'run', '--json', ...args]);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
}

const ok = (/** @type {number} */ code) => `node -e "process.exit(${code})"`;

test('npm scripts are recognized so missing ones can be skipped', () => {
  assert.equal(npmScriptOf('npm run build'), 'build');
  assert.equal(npmScriptOf('npm test'), 'test');
  assert.equal(npmScriptOf('npm t'), 'test');
  assert.equal(npmScriptOf('npm run lint -- --max-warnings 0'), 'lint');
  assert.equal(npmScriptOf('pnpm build'), 'build');
  assert.equal(npmScriptOf('yarn lint'), 'lint');
  assert.equal(npmScriptOf('bun run test'), 'test');
  assert.equal(npmScriptOf('npm ci'), null);
  assert.equal(npmScriptOf('npx tsc --noEmit'), null);
  assert.equal(npmScriptOf('node -e 1'), null);
});

test('project checks wait for package.json and their script; verify steps always run', async () => {
  const { root, cleanup } = await shapedProject((plan) => {
    plan.milestones[0].tasks[0].verify = [{ run: ok(0) }];
  });
  let r = check(root);
  assert.deepEqual(r.commands.map((/** @type {any} */ c) => `${c.name}:${c.status}`), ['build:skipped', 'lint:skipped', 'test:skipped', 'verify:pass']);
  assert.equal(r.commands[0].reason, 'no package.json yet');

  write(root, 'package.json', JSON.stringify({ name: 'x', private: true, scripts: { build: ok(0), test: ok(1) } }));
  r = check(root);
  assert.deepEqual(r.commands.map((/** @type {any} */ c) => `${c.name}:${c.status}`), ['build:pass', 'lint:skipped', 'test:fail', 'verify:pass']);
  assert.equal(r.commands[1].reason, 'no "lint" script in package.json yet');
  assert.ok(r.problems.some((/** @type {any} */ p) => p.severity === 'blocking' && p.text.startsWith('test failed: npm test exited with 1')));
  cleanup();
});

test('a clean learner task: committed, conventional, on its branch', async () => {
  const { root, paths, cleanup } = await shapedProject((plan) => {
    plan.checks = { build: ok(0), lint: null, test: ok(0) };
  });
  execFileSync('git', ['checkout', '-q', '-b', 'feat/skeleton'], { cwd: root });
  write(root, 'src/index.html', '<h1>Recipe box</h1>\n');
  let r = check(root);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((/** @type {any} */ p) => p.text.startsWith('No commit since the task started')));
  assert.ok(r.problems.some((/** @type {any} */ p) => p.area === 'uncommitted' && p.text.includes('src/index.html')));
  assert.match(r.diff, /new file \(untracked\)[\s\S]*\+<h1>Recipe box<\/h1>/);

  commit(root, 'feat(web): add home page');
  r = check(root);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.deepEqual(r.files, [{ path: 'src/index.html', change: 'A', added: 1, deleted: 0 }]);
  assert.match(r.diff, /\+<h1>Recipe box<\/h1>/);
  assert.doesNotMatch(r.diff, /\.menitor/);
  assert.equal(r.commits.length, 1);
  assert.equal(r.commits[0].conventional, true);
  assert.deepEqual(r.branch, { current: 'feat/skeleton', expected: 'feat/skeleton' });
  assert.deepEqual(r.ticks, { ticked: [], unticked: ['t1.c1', 't1.c2', 't1.c3'] });
  assert.equal(loadSession(paths).tasks.t1.lastCheck?.ok, true);
  cleanup();
});

test('a card with no commit step needs no new commit; one with a commit step still does', async () => {
  const { root, cleanup } = await shapedProject((plan) => {
    plan.checks = { build: ok(0), lint: null, test: ok(0) };
    plan.milestones[0].tasks[0].checklist = ['Run the checks', 'Push the branch to origin'];
  });
  execFileSync('git', ['checkout', '-q', '-b', 'feat/skeleton'], { cwd: root });
  let r = check(root);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.ok(!r.problems.some((/** @type {any} */ p) => p.area === 'commits'));
  cleanup();

  const withStep = await shapedProject((plan) => {
    plan.checks = { build: ok(0), lint: null, test: ok(0) };
    plan.milestones[0].tasks[0].checklist = ['Run the checks', 'commit the release notes'];
  });
  execFileSync('git', ['checkout', '-q', '-b', 'feat/skeleton'], { cwd: withStep.root });
  r = check(withStep.root);
  assert.ok(r.problems.some((/** @type {any} */ p) => p.text.startsWith('No commit since the task started')), 'a commit step in any case still counts');
  withStep.cleanup();
});

test('commit hygiene: messages, trailers and branches', async () => {
  const { root, cleanup } = await shapedProject((plan) => {
    plan.checks = {};
  });
  write(root, 'a.txt', 'a');
  commit(root, 'fixed stuff');
  let r = check(root);
  assert.ok(r.problems.some((/** @type {any} */ p) => p.severity === 'blocking' && p.text.startsWith('No commit message follows Conventional Commits')));
  assert.ok(r.problems.some((/** @type {any} */ p) => p.area === 'branch' && p.severity === 'warning'));

  write(root, 'b.txt', 'b');
  commit(root, 'feat: add b');
  r = check(root);
  assert.equal(r.ok, true, 'one valid commit is enough');
  assert.ok(r.problems.some((/** @type {any} */ p) => p.severity === 'warning' && p.text.startsWith('"fixed stuff"')));

  write(root, 'c.txt', 'c');
  commit(root, 'feat: add c', ['--trailer', 'Menitor-Delegated: true']);
  r = check(root);
  assert.ok(r.problems.some((/** @type {any} */ p) => p.severity === 'blocking' && p.text.includes("but this is the learner's task")));
  cleanup();
});

test('delegated work must carry the trailer, and needs no explain-back to pass', async () => {
  const { root, paths, cleanup } = await shapedProject((plan) => {
    plan.checks = {};
    plan.milestones[0].tasks[1].verify = [];
  });
  assert.equal(cli(root, ['task', 'pass', '--override', 'test: skip to the delegated task']).code, 0);
  write(root, 'vercel.json', '{}');
  commit(root, 'chore(deploy): add host config');
  let r = check(root);
  assert.ok(r.problems.some((/** @type {any} */ p) => p.text.includes('without the "Menitor-Delegated: true" trailer')));

  // Redo it properly: one delegated commit carrying the trailer.
  const start = loadSession(paths).tasks.t2.startCommit;
  execFileSync('git', ['reset', '-q', '--soft', String(start)], { cwd: root });
  commit(root, 'chore(deploy): add host config', ['--trailer', 'Menitor-Delegated: true']);
  r = check(root);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(cli(root, ['task', 'pass', '--note', 'Added vercel.json.']).code, 0, 'delegated tasks need no explain-back');
  cleanup();
});

test('failures show the end of the output; slow commands time out', async () => {
  const { root, cleanup } = await shapedProject((plan) => {
    plan.checks = { build: `node -e "console.log('compiling'); console.error('src/app.ts:3 error: x is not defined'); process.exit(2)"`, test: 'node -e "setTimeout(() => {}, 20000)"' };
  });
  const r = check(root, ['--timeout', '1']);
  assert.equal(r.commands[0].status, 'fail');
  assert.equal(r.commands[0].exitCode, 2);
  assert.match(r.commands[0].tail, /compiling[\s\S]*src\/app\.ts:3 error: x is not defined/);
  assert.equal(r.commands[1].status, 'timeout');
  assert.ok(r.problems.some((/** @type {any} */ p) => p.text.startsWith('test timed out after 1 seconds')));
  const text = cli(root, ['check', 'run', '--timeout', '1']).out;
  assert.match(text, /✗ build {2}node -e/);
  assert.match(text, /MUST FIX {2}build failed/);
  cleanup();
});

test('a timeout kills the whole process tree, not just the shell', async () => {
  const { root, cleanup } = await shapedProject((plan) => {
    plan.checks = { test: 'node slow.js' };
  });
  // slow.js starts a grandchild that would write late.txt after 2.5 seconds.
  write(
    root,
    'slow.js',
    [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', \"setTimeout(() => require('node:fs').writeFileSync('late.txt', 'x'), 2500)\"], { stdio: 'inherit' });",
      'setTimeout(() => {}, 10000);',
    ].join('\n'),
  );
  const r = check(root, ['--timeout', '1']);
  assert.equal(r.commands[0].status, 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.equal(fs.existsSync(path.join(root, 'late.txt')), false, 'the grandchild was stopped');
  cleanup();
});

test('build output and lockfiles stay out of the way', async () => {
  const { root, cleanup } = await shapedProject((plan) => {
    plan.checks = {};
  });
  write(root, 'src/a.js', 'export const a = 1;\n');
  write(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': {} } }));
  write(root, 'node_modules/x/index.js', 'x');
  write(root, 'dist/out.js', 'x');
  commit(root, 'feat: add a');
  write(root, 'dist/again.js', 'x');
  const r = check(root);
  assert.deepEqual(r.uncommitted, [], 'build folders never count as uncommitted work');
  assert.ok(r.files.some((/** @type {any} */ f) => f.path === 'package-lock.json'), 'the lockfile is listed');
  assert.doesNotMatch(r.diff, /lockfileVersion/, 'but its content stays out of the diff');
  assert.match(r.diff, /export const a = 1/);
  cleanup();
});

test('the agent touching learner files is flagged', async () => {
  const { root, paths, cleanup } = await shapedProject();
  const at = new Date(Date.now() + 1000).toISOString();
  fs.appendFileSync(paths.activity, `${JSON.stringify({ at, tool: 'Bash', task: 't1', writes: 'no', command: 'node gen.js', changed: ['src/app.js'] })}\n`);
  fs.appendFileSync(paths.activity, `${JSON.stringify({ at, tool: 'Write', task: 't1', writes: 'no', file: 'docs/a.md', targets: [{ path: 'docs/a.md', area: 'docs', kind: 'write' }] })}\n`);
  const r = check(root, ['--no-commands']);
  assert.deepEqual(r.agent.map((/** @type {any} */ a) => a.what), ['src/app.js']);
  assert.ok(r.problems.some((/** @type {any} */ p) => p.area === 'agent' && p.severity === 'warning'));
  cleanup();
});

test('deploy URLs: missing, up, wrong content, down', async () => {
  const server = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const s = http.createServer((req, res) => {
      if (req.url === '/broken') { res.writeHead(500); res.end('oops'); return; }
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Recipe box</h1>');
    });
    s.listen(0, '127.0.0.1', () => console.log(String(s.address().port)));
  `]);
  const port = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(String(d).trim())));
  try {
    const { root, cleanup } = await shapedProject((plan) => {
      plan.checks = {};
      plan.milestones[0].tasks[0].verify = [
        { url: '$deployUrl', status: 200, contains: 'Recipe box' },
        { url: '$deployUrl/broken' },
        { url: '$deployUrl', contains: 'Not on the page' },
      ];
    });
    let r = check(root);
    assert.deepEqual(r.urls.map((/** @type {any} */ u) => u.status), ['needs-url', 'needs-url', 'needs-url']);
    assert.ok(r.problems.some((/** @type {any} */ p) => p.area === 'deploy' && p.text.startsWith('No deployed URL is recorded yet')));

    assert.equal(cli(root, ['plan', 'deploy-url', `http://127.0.0.1:${port}/`]).code, 0);
    r = check(root);
    assert.deepEqual(r.urls.map((/** @type {any} */ u) => `${u.status}:${u.httpStatus}`), ['pass:200', 'fail:500', 'fail:200']);
    assert.equal(r.urls[1].url, `http://127.0.0.1:${port}/broken`);
    assert.match(r.urls[2].error, /doesn't contain "Not on the page"/);

    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
    r = check(root);
    assert.equal(r.urls[0].status, 'fail');
    assert.equal(r.urls[0].httpStatus, null);
    cleanup();
  } finally {
    server.kill();
  }
});

test('the pass gate: clean check at HEAD, then an explain-back since that check', async () => {
  const { root, cleanup } = await shapedProject((plan) => {
    plan.checks = { test: ok(0) };
  });
  write(root, 'src/a.js', 'x');
  commit(root, 'feat: add a');
  check(root, ['--no-commands']);
  assert.match(cli(root, ['task', 'pass']).err, /No check has run/, '--no-commands never counts');

  check(root);
  cli(root, ['log', 'explain', 'task=t1', 'outcome=weak', 'try=1']);
  assert.match(cli(root, ['task', 'pass']).err, /hasn't explained/, 'a weak first try is not enough');

  check(root);
  cli(root, ['log', 'explain', 'task=t1', 'outcome=weak', 'try=2']);
  write(root, 'src/b.js', 'y');
  commit(root, 'feat: add b');
  const stale = cli(root, ['task', 'pass']);
  assert.equal(stale.code, EXIT.refused);
  assert.match(stale.err, /new commits since the last check run/);

  check(root);
  assert.match(cli(root, ['task', 'pass']).err, /hasn't explained/, 'a new commit needs a new explain-back');
  cli(root, ['log', 'explain', 'task=t1', 'outcome=good', 'try=1']);
  check(root);
  assert.equal(cli(root, ['task', 'pass']).code, 0, 'a clean re-run at the same commit keeps the explain-back');
  cleanup();
});

test('a failed check blocks the pass until an override with a reason', async () => {
  const { root, paths, cleanup } = await shapedProject((plan) => {
    plan.checks = { test: ok(1) };
  });
  check(root);
  assert.match(cli(root, ['task', 'pass']).err, /found must-fix problems/);
  assert.equal(cli(root, ['task', 'pass', '--override', '   ']).code, EXIT.error);
  const r = cli(root, ['task', 'pass', '--override', 'the test command points at a missing file']);
  assert.equal(r.code, 0, r.err);
  const events = parseLog(fs.readFileSync(paths.log, 'utf8'));
  assert.deepEqual(events.filter((e) => e.event === 'override').map((e) => e.fields.reason), ['the test command points at a missing file']);
  assert.equal(cli(root, ['log', 'override', 'task=t2', 'reason=x']).code, EXIT.refused, 'the agent cannot log an override by hand');
  cleanup();
});

test('no git repo: the check says so', () => {
  const { root, cleanup } = makeProject({ git: false });
  cli(root, ['init']);
  cli(root, ['plan', 'import', '-'], { stdin: JSON.stringify({ project: { name: 'x' }, milestones: [{ title: 'Skeleton', tasks: [{ goal: 'g', why: 'w.', docs: 'docs/prd.md', checklist: ['c'], doneWhen: 'd' }] }] }) });
  cli(root, ['plan', 'approve']);
  const r = check(root);
  assert.equal(r.repo, false);
  assert.ok(r.problems.some((/** @type {any} */ p) => p.area === 'repo'));
  cleanup();
});

