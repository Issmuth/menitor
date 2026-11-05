// The task window server: auth, ticks, fixed events, live updates and its process lifecycle.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { approvedProject, cli, makeProject } from './helpers.js';
import { createWindowServer, cleanCommands, windowState } from '../core/server/server.js';
import { loadProgress } from '../core/lib/state.js';
import { readWindowInfo } from '../core/lib/window.js';
import { codeFingerprint } from '../core/lib/fingerprint.js';
import { claimEvent, readInbox } from '../core/lib/inbox.js';

/**
 * A raw HTTP request, so tests can set any Host or Origin header.
 * @param {number} port
 * @param {{ method?: string, path?: string, headers?: Record<string, string>, body?: string }} opts
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function request(port, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: { Host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/**
 * Start a server on a project and give back helpers.
 * @param {string} root
 */
async function serve(root) {
  const win = createWindowServer(root, { commands: { check: '/menitor:check', hint: '/menitor:hint', evil: '<script>' } });
  const port = await win.listen(0);
  const auth = { 'X-Menitor-Token': win.token };
  /** @param {string} path @param {unknown} body */
  const post = (path, body) => request(port, { method: 'POST', path, headers: { ...auth, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify(body) });
  return { win, port, auth, post };
}

test('only this server, on this host, with its token', async () => {
  const { root, cleanup } = approvedProject();
  const { win, port, auth } = await serve(root);
  try {
    assert.equal((await request(port, { path: '/api/state' })).status, 401, 'no token');
    assert.equal((await request(port, { path: '/api/state', headers: { 'X-Menitor-Token': 'nope' } })).status, 401, 'wrong token');
    assert.equal((await request(port, { path: '/api/state', headers: { ...auth, Host: 'evil.example:80' } })).status, 421, 'DNS rebinding: wrong Host');
    assert.equal((await request(port, { path: '/api/state', headers: { ...auth, Host: `localhost:${port}` } })).status, 200, 'localhost works too');

    const first = await request(port, { path: `/?t=${win.token}` });
    assert.equal(first.status, 303);
    assert.equal(first.headers.location, '/');
    const setCookie = String(first.headers['set-cookie']);
    assert.match(setCookie, new RegExp(`^menitor_${port}=${win.token}; HttpOnly; SameSite=Strict; Path=/`));

    const page = await request(port, { path: '/', headers: { Cookie: `other=1; menitor_${port}=${win.token}` } });
    assert.equal(page.status, 200);
    assert.match(page.body, /<script type="module" src="\/app\.js">/);
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'; script-src 'self'/);
    assert.match(String(page.headers['content-security-policy']), /font-src 'self';/, 'the bundled font loads from this server only');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.equal(page.headers['x-frame-options'], 'DENY');

    assert.equal((await request(port, { path: '/app.js', headers: auth })).headers['content-type'], 'text/javascript; charset=utf-8');
    const font = await request(port, { path: '/fonts/instrument-sans-latin.woff2', headers: auth });
    assert.equal(font.status, 200);
    assert.equal(font.headers['content-type'], 'font/woff2');
    assert.match(String(font.headers['cache-control']), /max-age=\d+/);
    assert.equal((await request(port, { path: '/fonts/instrument-sans-latin.woff2' })).status, 401, 'fonts need the token too');
    assert.equal((await request(port, { path: '/nope', headers: auth })).status, 404);
  } finally {
    await win.close();
    cleanup();
  }
});

test('POSTs need JSON from the same origin', async () => {
  const { root, cleanup } = approvedProject();
  const { win, port, auth } = await serve(root);
  try {
    const body = JSON.stringify({ type: 'check' });
    assert.equal((await request(port, { method: 'POST', path: '/api/event', headers: { ...auth, 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body })).status, 403);
    assert.equal((await request(port, { method: 'POST', path: '/api/event', headers: { ...auth, 'Content-Type': 'text/plain' }, body })).status, 415);
    assert.equal((await request(port, { method: 'POST', path: '/api/event', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
    assert.equal((await request(port, { method: 'POST', path: '/api/event', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'x'.repeat(20000) }) })).status, 413);
    assert.equal((await request(port, { method: 'PUT', path: '/api/event', headers: auth })).status, 405);
  } finally {
    await win.close();
    cleanup();
  }
});

test('buttons send fixed events only, and fall back to the command to type', async () => {
  const { root, cleanup } = approvedProject();
  const { win, post } = await serve(root);
  try {
    const r = await post('/api/event', { type: 'check' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { delivered: false, command: '/menitor:check' });
    assert.deepEqual(JSON.parse((await post('/api/event', { type: 'stuck' })).body).command, 'stuck', 'unset commands fall back to plain words');
    for (const type of ['skip', 'please write my code', 42]) {
      assert.equal((await post('/api/event', { type })).status, 400, String(type));
    }
    assert.deepEqual(cleanCommands({ check: '/x', evil: 'y', hint: '<b>', go: 'a\nb' }), { check: '/x', hint: 'hint', stuck: 'stuck' });
  } finally {
    await win.close();
    cleanup();
  }
});

test('a delivered event reaches the deliver hook with the current task', async () => {
  const { root, cleanup } = approvedProject();
  /** @type {{ type: string, task: string | null }[]} */
  const got = [];
  const win = createWindowServer(root, { deliver: (e) => (got.push(e), true) });
  const port = await win.listen(0);
  try {
    const r = await request(port, { method: 'POST', path: '/api/event', headers: { 'X-Menitor-Token': win.token, 'Content-Type': 'application/json' }, body: '{"type":"hint"}' });
    assert.equal(JSON.parse(r.body).delivered, true);
    assert.deepEqual(got, [{ type: 'hint', task: 't1' }]);
  } finally {
    await win.close();
    cleanup();
  }
});

test('ticks are saved to progress.json, only for the current card', async () => {
  const { root, paths, cleanup } = approvedProject();
  const { win, post } = await serve(root);
  try {
    const r = await post('/api/tick', { item: 't1.c2', ticked: true });
    assert.equal(r.status, 200, r.body);
    assert.equal(JSON.parse(r.body).card.checklist[1].ticked, true);
    assert.ok(loadProgress(paths).ticks['t1.c2']);
    await post('/api/tick', { item: 't1.c2', ticked: false });
    assert.deepEqual(loadProgress(paths).ticks, {});
    assert.equal((await post('/api/tick', { item: 't3.c1', ticked: true })).status, 409, 'another task');
    assert.equal((await post('/api/tick', { item: 't1.c2' })).status, 400, 'missing ticked');
    assert.equal((await post('/api/tick', { item: { x: 1 }, ticked: true })).status, 400);
  } finally {
    await win.close();
    cleanup();
  }
});

test('a passed explain-back stays on screen until Continue, and a reload remembers it', async () => {
  const { root, paths, cleanup } = approvedProject();
  const { win, post } = await serve(root);
  try {
    cli(root, ['question', 'ask', 'Why does the page need its own route?']);
    let s = windowState(paths, { commands: {} });
    assert.equal(s.result, null, 'nothing has passed yet');
    assert.equal((await post('/api/answer', { question: s.questions[0].id, text: 'So the home page has one place to grow.' })).status, 200);
    cli(root, ['question', 'judge', 'good', '--feedback', 'Right: one route per page keeps them apart.']);
    cli(root, ['task', 'pass', '--override', 'test']);

    s = windowState(paths, { commands: {} });
    assert.equal(s.card?.task, 't2', 'the plan has moved on');
    assert.equal(s.result?.task, 't1');
    assert.equal(s.result.number, 1);
    assert.equal(s.result.goal, 'Show a hello page');
    assert.deepEqual(
      s.result.questions.map((/** @type {any} */ q) => [q.text, q.answer?.text, q.outcome, q.feedback]),
      [['Why does the page need its own route?', 'So the home page has one place to grow.', 'good', 'Right: one route per page keeps them apart.']],
    );
    assert.deepEqual(s.result.next, { number: s.card?.number, goal: s.card?.goal });

    assert.equal((await post('/api/continue', {})).status, 400);
    assert.equal((await post('/api/continue', { task: 't2' })).status, 409, 'only the result on screen');
    const r = await post('/api/continue', { task: 't1' });
    assert.equal(r.status, 200, r.body);
    assert.equal(JSON.parse(r.body).result, null);
    assert.ok(loadProgress(paths).seen?.t1, 'kept in progress.json, which the window writes');
    assert.equal(windowState(paths, { commands: {} }).result, null, 'a reload does not bring it back');

    cli(root, ['task', 'pass', '--override', 'test']); // t2 is delegated: no explain-back
    assert.equal(windowState(paths, { commands: {} }).result, null, 'a pass with no explain-back shows no result');
  } finally {
    await win.close();
    cleanup();
  }
});

test('a finished plan gets its summary from real figures, and an added task brings the card back', () => {
  const { root, paths, cleanup } = approvedProject();
  try {
    assert.equal(windowState(paths, { commands: {} }).finish, null, 'not while tasks remain');
    cli(root, ['plan', 'deploy-url', 'https://recipes.example.app']);
    cli(root, ['task', 'pass', '--override', 't']);
    cli(root, ['task', 'pass', '--override', 't']);
    cli(root, ['task', 'hint']);
    cli(root, ['task', 'pass', '--override', 't']);

    const s = windowState(paths, { commands: {} });
    assert.equal(s.phase, 'done');
    const f = s.finish;
    assert.equal(f.deployUrl, 'https://recipes.example.app');
    assert.equal(f.hints, 1, 'hints opened, from the log');
    assert.match(f.explained, /explain-back|questions/i, 'the explain-back line from the stats');
    assert.ok(f.started && f.finished && f.started <= f.finished, 'from approval to the last pass');
    assert.deepEqual(s.written, { learner: 2, delegated: 1, skipped: 0, focusTasksDone: 2 });

    cli(root, ['plan', 'add', '-'], { stdin: JSON.stringify({ after: 'm2', task: { goal: 'Show a recipe count', why: 'It tells you how big the box is.', docs: 'docs/prd.md', checklist: ['Render the count'], doneWhen: 'The count shows', owner: 'delegated' } }) });
    const again = windowState(paths, { commands: {} });
    assert.equal(again.phase, 'task', 'the card is back');
    assert.equal(again.finish, null);
  } finally {
test('a press shows as sent, then working, then done; a second press meanwhile sends nothing', async () => {
  const { root, paths, cleanup } = approvedProject();
  const win = createWindowServer(root, { commands: { check: '/menitor:check' } });
  const port = await win.listen(0);
  const auth = { 'X-Menitor-Token': win.token };
  /** @param {string} path @param {unknown} body */
  const post = (path, body) => request(port, { method: 'POST', path, headers: { ...auth, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify(body) });
  /** A session listening for presses, which started listening at `startedAt`. */
  const listen = (/** @type {number} */ startedAt) => fs.writeFileSync(paths.listener, JSON.stringify({ version: 1, pid: process.pid, beatAt: new Date().toISOString(), startedAt: new Date(startedAt).toISOString(), agent: 'test' }));
  const state = () => windowState(paths, { commands: {} });
  try {
    listen(Date.now() - 60000);
    assert.equal(state().press, null, 'nothing pressed yet');
    assert.equal(JSON.parse((await post('/api/event', { type: 'check' })).body).delivered, true);
    assert.deepEqual([state().press?.type, state().press?.state], ['check', 'sent']);

    const [event] = readInbox(paths);
    assert.ok(claimEvent(paths, event.id), 'the session picks it up');
    assert.equal(state().press?.state, 'working');
    const again = JSON.parse((await post('/api/event', { type: 'hint' })).body);
    assert.equal(again.busy, true);
    assert.equal(readInbox(paths).length, 1, 'a second press while it works sends nothing');

    // The agent ends its turn: the adapter's hook records it in the activity log.
    const pause = () => new Promise((r) => setTimeout(r, 30));
    await pause();
    fs.appendFileSync(paths.activity, `${JSON.stringify({ at: new Date().toISOString(), tool: 'turn-end', task: 't1', writes: 'no' })}\n`);
    assert.equal(state().press?.state, 'done');
    await pause();

    // Listening again after the claim also means the agent is done with the press.
    assert.equal(JSON.parse((await post('/api/event', { type: 'stuck' })).body).delivered, true);
    claimEvent(paths, readInbox(paths).at(-1)?.id ?? '');
    assert.equal(state().press?.state, 'working');
    listen(Date.now() + 1000);
    assert.equal(state().press?.state, 'done');
  } finally {
    await win.close();
    cleanup();
  }
});

test('the event stream pushes new state when a state file changes', async () => {
  const { root, cleanup } = approvedProject();
  const { win, port, auth } = await serve(root);
  try {
    /** @type {any[]} */
    const states = [];
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { ...auth, Host: `127.0.0.1:${port}` } });
    const done = new Promise((resolve) => {
      req.on('response', (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = /^data: (.*)$/m.exec(block);
            if (data) states.push(JSON.parse(data[1]));
            if (states.length === 2) resolve(undefined);
          }
        });
      });
    });
    req.end();
    await new Promise((r) => setTimeout(r, 200));
    cli(root, ['task', 'fix', 'Name the heading clearly']);
    win.refresh();
    await done;
    assert.equal(states[0].card.checklist.length, 3);
    assert.equal(states[1].card.checklist.at(-1).text, 'Name the heading clearly');
    assert.equal(win.clients, 1);
    req.destroy();
  } finally {
    await win.close();
    cleanup();
  }
});

test('window state covers every phase, and never leaks locked hints', () => {
  const plain = makeProject();
  cli(plain.root, ['init']);
  const { paths: p0 } = plain;
  assert.equal(windowState(p0, { commands: {} }).phase, 'no-plan');
  plain.cleanup();

  const { root, paths, cleanup } = approvedProject();
  let s = windowState(paths, { commands: { check: '/menitor:check' } });
  assert.equal(s.phase, 'task');
  assert.equal(s.card?.task, 't1');
  assert.equal(s.milestones?.[0].current, true);
  assert.deepEqual(
    s.milestones?.map((m) => m.tasks.map((t) => `${t.number}:${t.id}${t.current ? '*' : ''}${t.done ? `:${t.by}` : ''}`)),
    [['1:t1*', '2:t2'], ['3:t3']],
    'every task, numbered in plan order, for the ledger',
  );
  assert.equal(s.milestones?.[0].tasks[0].goal, 'Show a hello page');
  cli(root, ['task', 'pass', '--override', 't']);
  cli(root, ['task', 'pass', '--override', 't']);
  s = windowState(paths, { commands: {} });
  assert.equal(s.card?.task, 't3');
  assert.deepEqual(
    s.milestones?.flatMap((m) => m.tasks.map((t) => `${t.id}${t.current ? '*' : ''}${t.done ? `:${t.by}` : ''}`)),
    ['t1:learner', 't2:delegated', 't3*'],
  );
  assert.deepEqual(s.card?.hints.rungs.map((r) => r.text), [null, null, null, null]);
  cli(root, ['task', 'hint']);
  s = windowState(paths, { commands: {} });
  assert.equal(s.card?.hints.rungs[0].text, 'A unique constraint lets the database refuse duplicates.');
  assert.equal(s.card?.hints.rungs[1].text, null);
  cli(root, ['task', 'pass', '--override', 't']);
  assert.equal(windowState(paths, { commands: {} }).phase, 'done');
  assert.deepEqual(windowState(paths, { commands: {} }).written, { learner: 2, delegated: 1, skipped: 0, focusTasksDone: 2 });
  fs.writeFileSync(paths.plan, 'broken');
  assert.equal(windowState(paths, { commands: {} }).ok, false);
  cleanup();
});

test('menitor window open starts one detached server, reuses it, and stops it', () => {
  const { root, paths, cleanup } = approvedProject();
  try {
    const first = cli(root, ['window', 'open', '--no-browser', '--json', '--command', 'check=/menitor:check']);
    assert.equal(first.code, 0, first.err);
    const opened = JSON.parse(first.out);
    assert.equal(opened.started, true);
    assert.equal(opened.opened, false);
    assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+$/);
    const info = readWindowInfo(paths);
    assert.equal(info?.commands.check, '/menitor:check');

    const again = JSON.parse(cli(root, ['window', 'open', '--no-browser', '--json']).out);
    assert.equal(again.started, false);
    assert.equal(again.url, opened.url);
    assert.match(cli(root, ['window', 'status']).out, /The task window is running/);

    assert.match(cli(root, ['window', 'stop']).out, /Stopped the task window/);
    assert.equal(fs.existsSync(paths.window), false);
    assert.match(cli(root, ['window', 'status']).out, /not running/);
    assert.match(cli(root, ['window', 'stop']).out, /was not running/);
  } finally {
    cli(root, ['window', 'stop']);
    cleanup();
  }
});

/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('window open restarts a server started from older code, and reuses a current one', async () => {
  const { root, paths, cleanup } = approvedProject();
  try {
    // A server that reports another fingerprint stands in for one started before an update.
    const old = JSON.parse(cli(root, ['window', 'open', '--no-browser', '--json'], { env: { MENITOR_CODE_FINGERPRINT: 'old-code' } }).out);
    assert.equal(old.started, true);
    const oldPid = readWindowInfo(paths)?.pid ?? 0;

    const fresh = JSON.parse(cli(root, ['window', 'open', '--no-browser', '--json']).out);
    assert.equal(fresh.started, true);
    assert.equal(fresh.restarted, true);
    assert.notEqual(fresh.url, old.url);
    assert.notEqual(readWindowInfo(paths)?.pid, oldPid);
    for (let i = 0; i < 60 && alive(oldPid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(oldPid), false, 'the old server has stopped');

    const same = JSON.parse(cli(root, ['window', 'open', '--no-browser', '--json']).out);
    assert.equal(same.started, false, 'a server running current code is reused');
    assert.equal(same.restarted, false);
    assert.match(cli(root, ['window', 'open', '--no-browser'], { env: { MENITOR_CODE_FINGERPRINT: 'x' } }).out, /already running/);
  } finally {
    cli(root, ['window', 'stop']);
    cleanup();
  }
});

test('a window older than the code says it is out of date, not that the state is broken', async () => {
  const { root, paths, cleanup } = approvedProject();
  const plan = JSON.parse(fs.readFileSync(paths.plan, 'utf8'));
  plan.milestones[0].tasks[0].fromNewerCode = true; // a field the running code doesn't know
  fs.writeFileSync(paths.plan, JSON.stringify(plan));
  try {
    for (const [code, stale] of /** @type {const} */ ([['old-code', true], [undefined, false]])) {
      const win = createWindowServer(root, { code });
      try {
        const port = await win.listen(0);
        const auth = { 'X-Menitor-Token': win.token };
        const s = JSON.parse((await request(port, { path: '/api/state', headers: auth })).body);
        assert.equal(s.ok, false);
        assert.equal(s.stale, stale);
        const ping = JSON.parse((await request(port, { path: '/api/ping', headers: auth })).body);
        assert.equal(ping.code === codeFingerprint(), !stale);
      } finally {
        await win.close();
      }
    }
  } finally {
    cleanup();
  }
});

test('a stale window.json is replaced by a fresh server', () => {
  const { root, paths, cleanup } = approvedProject();
  try {
    fs.writeFileSync(paths.window, JSON.stringify({ version: 1, pid: 999999, port: 1, token: 'a'.repeat(32), startedAt: 'x', commands: {} }));
    const r = JSON.parse(cli(root, ['window', 'open', '--no-browser', '--json']).out);
    assert.equal(r.started, true);
    assert.notEqual(readWindowInfo(paths)?.pid, 999999);
  } finally {
    cli(root, ['window', 'stop']);
    cleanup();
  }
});
