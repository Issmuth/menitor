// What stands between the learner and the next task: explain-back in the window, what the agent
// is waiting on, a skip waiting for the learner's confirm, and a delegated task waiting to start.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { approvedProject, cli } from './helpers.js';
import { createWindowServer, windowState } from '../core/server/server.js';
import { applyLearnerCommand } from '../core/lib/guard.js';
import { appendInbox, beat, readInbox } from '../core/lib/inbox.js';
import { loadAnswers, loadSession } from '../core/lib/state.js';
import { parseLog } from '../core/lib/log.js';
import { EXIT } from '../core/lib/errors.js';

const MONITOR = path.resolve(import.meta.dirname, '..', 'adapters', 'claude-code', 'monitor.js');

/**
 * @param {number} port
 * @param {string} token
 * @param {string} p
 * @param {unknown} body
 * @returns {Promise<{ status: number, json: any }>}
 */
function post(port, token, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { Host: `127.0.0.1:${port}`, 'X-Menitor-Token': token, 'Content-Type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = text;
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('questions: one open at a time, follow-ups only after a weak answer, and judging logs the explain-back', () => {
  const { root, paths, cleanup } = approvedProject();
  assert.match(cli(root, ['question', 'show']).out, /No questions on this task yet/);
  assert.equal(cli(root, ['question', 'judge', 'good']).code, EXIT.error, 'nothing to judge yet');
  assert.match(cli(root, ['question', 'ask', 'Why', 'an', 'h1?', '--follow-up']).err, /only after a weak first answer/);

  assert.equal(cli(root, ['question', 'ask', 'Why does the page use an h1?']).code, 0);
  assert.match(cli(root, ['question', 'ask', 'Another?']).err, /t1\.q1 is still open/);
  assert.match(cli(root, ['question', 'judge', 'meh']).err, /good or weak/);
  const weak = cli(root, ['question', 'judge', 'weak', '--feedback', 'Close. The h1 names the page for screen readers too.']);
  assert.match(weak.out, /Ask one follow-up/);
  assert.equal(cli(root, ['question', 'ask', 'What would a screen reader announce first?', '--follow-up']).code, 0);
  cli(root, ['question', 'judge', 'good']);

  const qs = loadSession(paths).tasks.t1.questions ?? [];
  assert.deepEqual(qs.map((q) => `${q.id}:${q.try}:${q.outcome}`), ['t1.q1:1:weak', 't1.q2:2:good']);
  assert.equal(qs[0].feedback, 'Close. The h1 names the page for screen readers too.');
  const explains = parseLog(fs.readFileSync(paths.log, 'utf8')).filter((e) => e.event === 'explain').map((e) => `${e.fields.outcome}/${e.fields.try}`);
  assert.deepEqual(explains, ['weak/1', 'good/2']);
  cleanup();
});

test('a judged answer opens the pass gate, as a logged explain-back did', () => {
  const { root, cleanup } = approvedProject();
  cli(root, ['check', 'run', '--no-diff']);
  // The sample repo has no commit for t1, so the check is not clean; force a clean record to test the gate alone.
  const session = JSON.parse(fs.readFileSync(path.join(root, '.menitor', 'session.json'), 'utf8'));
  session.tasks.t1.lastCheck = { at: new Date(Date.now() - 1000).toISOString(), ok: true, head: session.tasks.t1.startCommit, problems: 0 };
  fs.writeFileSync(path.join(root, '.menitor', 'session.json'), JSON.stringify(session));
  assert.match(cli(root, ['task', 'pass']).err, /hasn't explained/);
  cli(root, ['question', 'ask', 'Why an h1?']);
  cli(root, ['question', 'judge', 'good']);
  assert.equal(cli(root, ['task', 'pass']).code, 0);
  assert.equal(cli(root, ['question', 'ask', 'x']).code, EXIT.refused, 'no explain-back on a delegated task');
  cleanup();
});

test('waiting notes show until cleared, and settle when their task passes', () => {
  const { root, paths, cleanup } = approvedProject();
  assert.equal(cli(root, ['waiting']).code, EXIT.error);
  cli(root, ['waiting', 'Sign in to Render, then tell me in your session.']);
  assert.equal(windowState(paths, { commands: {} }).waiting.text, 'Sign in to Render, then tell me in your session.');
  assert.match(cli(root, ['task', 'brief']).out, /Waiting {4}on the learner: Sign in to Render/);
  cli(root, ['waiting', '--done']);
  assert.equal(windowState(paths, { commands: {} }).waiting, null);
  cli(root, ['waiting', 'Push your branch.']);
  cli(root, ['task', 'pass', '--override', 'test']);
  assert.equal(loadSession(paths).waiting ?? null, null, 'cleared with the task it was about');
  cleanup();
});

test('the window shows a pending skip and a delegated task waiting to start', () => {
  const { root, paths, cleanup } = approvedProject();
  assert.equal(windowState(paths, { commands: {} }).skipRequested, false);
  applyLearnerCommand(root, { command: 'skip', confirm: false });
  assert.equal(windowState(paths, { commands: {} }).skipRequested, true);
  applyLearnerCommand(root, { command: 'skip', confirm: true });
  assert.equal(windowState(paths, { commands: {} }).skipRequested, false, 'a granted skip no longer waits');

  cli(root, ['task', 'skip']);
  cli(root, ['task', 'pass', '--override', 'test']);
  let s = windowState(paths, { commands: {} });
  assert.equal(s.card.owner, 'delegated');
  assert.equal(s.goAskedAt, null);
  appendInbox(paths, { type: 'go', task: 't2' }, new Date('2030-01-01T10:00:00Z'));
  s = windowState(paths, { commands: {} });
  assert.equal(s.goAskedAt, '2030-01-01T10:00:00.000Z');
  assert.deepEqual(s.questions, [], 'no questions on a delegated task');
  cleanup();
});

test('/api/answer saves the answer as data, only for the open question, and signals the session', async () => {
  const { root, paths, cleanup } = approvedProject();
  const win = createWindowServer(root, { commands: { check: '/menitor:check' } });
  const port = await win.listen(0);
  try {
    let r = await post(port, win.token, '/api/answer', { question: 't1.q1', text: 'Because.' });
    assert.equal(r.status, 409, 'no such question yet');
    cli(root, ['question', 'ask', 'Why an h1?']);
    for (const bad of [{ question: 't1.q1' }, { question: 't1.q1', text: '   ' }, { question: 't1.q1', text: 'x'.repeat(4001) }]) {
      assert.equal((await post(port, win.token, '/api/answer', bad)).status, 400, JSON.stringify(bad).slice(0, 40));
    }
    r = await post(port, win.token, '/api/answer', { question: 't1.q1', text: '  It names the page.  ' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.delivered, r.json.command], [false, '/menitor:check'], 'no listener: say which command reads it');
    assert.equal(r.json.state.questions[0].answer.text, 'It names the page.');
    assert.equal(loadAnswers(paths).answers['t1.q1'].text, 'It names the page.');
    assert.match(cli(root, ['question', 'show']).out, /A: It names the page\./);

    beat(paths, { agent: 'test', startedAt: new Date().toISOString() });
    r = await post(port, win.token, '/api/answer', { question: 't1.q1', text: 'It names the page, for readers and screen readers.' });
    assert.equal(r.json.delivered, true, 'a changed answer is sent again');
    assert.deepEqual(readInbox(paths).map((e) => `${e.type}:${e.task}`), ['answer:t1'], 'only a fixed event, never the text');
    assert.doesNotMatch(fs.readFileSync(paths.inbox, 'utf8'), /screen readers/);

    cli(root, ['question', 'judge', 'good']);
    assert.equal((await post(port, win.token, '/api/answer', { question: 't1.q1', text: 'Changed my mind.' })).status, 409, 'judged answers are final');
    assert.equal((await post(port, win.token, '/api/event', { type: 'go' })).status, 200, 'go is a fixed event a button can send');
  } finally {
    await win.close();
    cleanup();
  }
});

test('the monitor turns go and answer events into fixed notices', async () => {
  const { root, paths, cleanup } = approvedProject();
  const child = spawn(process.execPath, [MONITOR, root], { env: { ...process.env, MENITOR_MONITOR_POLL_MS: '100', MENITOR_MONITOR_WAIT_MS: '100' }, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => (out += c));
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(paths.listener) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    appendInbox(paths, { type: 'go', task: 't2' });
    appendInbox(paths, { type: 'answer', task: 't1' });
    while (out.split('\n').filter(Boolean).length < 2 && Date.now() < deadline + 3000) await new Promise((r) => setTimeout(r, 50));
    const lines = out.trim().split('\n');
    assert.match(lines[0], /pressed "Start it" on task t2, which is yours\. Run the menitor:go skill now/);
    assert.match(lines[1], /answered your explain-back question on task t1 in the window\. Run the menitor:check skill now/);
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
    cleanup();
  }
});
