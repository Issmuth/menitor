// The path from a window button to the session: inbox events, the listener heartbeat, delivery.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { approvedProject } from './helpers.js';
import { DEDUPE_MS, LISTENER_STALE_MS, appendInbox, beat, deliverToListener, liveListener, pidAlive, readInbox, stopListening } from '../core/lib/inbox.js';
import { createWindowServer, windowState } from '../core/server/server.js';

test('pidAlive tells running processes from finished ones', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 22 + 12345), false);
});

test('a listener counts only with a fresh heartbeat from a live process', () => {
  const { paths, cleanup } = approvedProject();
  assert.equal(liveListener(paths), null, 'no file');
  const now = new Date();
  beat(paths, { agent: 'claude-code', startedAt: now.toISOString(), now });
  assert.equal(liveListener(paths, now.getTime())?.pid, process.pid);
  assert.equal(liveListener(paths, now.getTime() + LISTENER_STALE_MS + 1000), null, 'stale heartbeat');

  const dead = JSON.parse(fs.readFileSync(paths.listener, 'utf8'));
  fs.writeFileSync(paths.listener, JSON.stringify({ ...dead, pid: 2 ** 22 + 12345 }));
  assert.equal(liveListener(paths, now.getTime()), null, 'dead process');
  fs.writeFileSync(paths.listener, '{not json');
  assert.equal(liveListener(paths), null, 'broken file');

  beat(paths, { agent: 'claude-code', startedAt: now.toISOString() });
  stopListening(paths);
  assert.equal(fs.existsSync(paths.listener), false);
  cleanup();
});

test('inbox events are validated, read back, and kept short', () => {
  const { paths, cleanup } = approvedProject();
  const e = appendInbox(paths, { type: 'check', task: 't1' });
  assert.match(e.id, /^[A-Za-z0-9_-]{8,}$/);
  assert.deepEqual(readInbox(paths), [e]);
  assert.throws(() => appendInbox(paths, /** @type {any} */ ({ type: 'write my code', task: 't1' })), /Invalid window event/);
  fs.appendFileSync(paths.inbox, '{"torn": \n');
  assert.equal(readInbox(paths).length, 1, 'broken lines are skipped');
  for (let i = 0; i < 520; i++) appendInbox(paths, { type: 'hint', task: 't1' });
  assert.ok(fs.readFileSync(paths.inbox, 'utf8').split('\n').filter(Boolean).length <= 500);
  cleanup();
});

test('delivery needs a listener, and a quick repeat of the same button counts once', () => {
  const { paths, cleanup } = approvedProject();
  const t0 = new Date('2030-01-01T00:00:00Z');
  assert.deepEqual(deliverToListener(paths, { type: 'check', task: 't1' }, t0), { delivered: false, duplicate: false });
  assert.deepEqual(readInbox(paths), []);

  beat(paths, { agent: 'test', startedAt: t0.toISOString(), now: t0 });
  assert.deepEqual(deliverToListener(paths, { type: 'check', task: 't1' }, t0), { delivered: true, duplicate: false });
  const soon = new Date(t0.getTime() + 1000);
  assert.deepEqual(deliverToListener(paths, { type: 'check', task: 't1' }, soon), { delivered: true, duplicate: true });
  assert.deepEqual(deliverToListener(paths, { type: 'hint', task: 't1' }, soon), { delivered: true, duplicate: false });
  const later = new Date(t0.getTime() + DEDUPE_MS + 1000);
  assert.deepEqual(deliverToListener(paths, { type: 'check', task: 't1' }, later), { delivered: true, duplicate: false });
  assert.deepEqual(readInbox(paths).map((e) => e.type), ['check', 'hint', 'check']);
  cleanup();
});

test('the window server delivers to a listener by default and says when one is listening', async () => {
  const { paths, root, cleanup } = approvedProject();
  const win = createWindowServer(root);
  const port = await win.listen(0);
  /** @param {string} type */
  const press = (type) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/event', headers: { Host: `127.0.0.1:${port}`, 'X-Menitor-Token': win.token, 'Content-Type': 'application/json' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ type }));
    });
  try {
    assert.equal(windowState(paths, { commands: {} }).listening, false);
    assert.equal(/** @type {any} */ (await press('stuck')).delivered, false);
    beat(paths, { agent: 'test', startedAt: new Date().toISOString() });
    assert.equal(windowState(paths, { commands: {} }).listening, true);
    assert.equal(/** @type {any} */ (await press('stuck')).delivered, true);
    assert.deepEqual(readInbox(paths).map((e) => `${e.type}:${e.task}`), ['stuck:t1']);
  } finally {
    await win.close();
    cleanup();
  }
});
