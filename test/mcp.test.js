// The MCP server's wait_for_learner tool, spoken to over stdio the way Claude Code does.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { approvedProject, makeProject } from './helpers.js';
import { deliverToListener, liveListener, readInbox } from '../core/lib/inbox.js';
import { isAlive, readWindowInfo, stopWindow } from '../core/lib/window.js';
import { statePaths } from '../core/lib/paths.js';

const SERVER = path.resolve(import.meta.dirname, '..', 'adapters', 'claude-code', 'mcp.js');
const MONITOR = path.resolve(import.meta.dirname, '..', 'adapters', 'claude-code', 'monitor.js');
const MANIFEST = path.resolve(import.meta.dirname, '..', '.claude-plugin', 'plugin.json');

/**
 * Start the server and talk JSON-RPC to it. Stopping it also stops any window a wait opened.
 * @param {string} root
 * @param {Record<string, string>} [env]
 */
function startServer(root, env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, MENITOR_WAIT_MINUTE_MS: '400', MENITOR_WAIT_PROGRESS_MS: '100', MENITOR_NO_BROWSER: '1', ...env },
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  /** @type {any[]} */
  const messages = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      messages.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  let next = 1;
  /** @param {string} method @param {any} [params] */
  const request = (method, params) => {
    const id = next++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return id;
  };
  /** @param {string} method @param {any} [params] */
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  /** @param {(m: any) => boolean} match @param {number} [ms] */
  const waitFor = async (match, ms = 15000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = messages.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no matching message; got ${JSON.stringify(messages).slice(0, 400)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(undefined);
      child.once('exit', () => resolve(undefined));
      child.stdin.end();
    }).then(() => {
      stopWindow(statePaths(root));
    });
  return { child, messages, request, notify, waitFor, stop };
}

/**
 * Poll until a condition holds.
 * @param {() => boolean} ok
 * @param {number} [ms]
 */
async function until(ok, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** @param {any} m */
const textOf = (m) => m.result?.content?.[0]?.text ?? '';

test('the handshake, the tool list, and unknown methods', async () => {
  const { root, cleanup } = approvedProject();
  const s = startServer(root);
  try {
    const init = s.request('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const r = await s.waitFor((m) => m.id === init);
    assert.equal(r.result.protocolVersion, '2025-06-18', 'a newer revision falls back to the earlier handshake');
    assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
    assert.equal(r.result.serverInfo.name, 'menitor');
    assert.match(r.result.instructions, /end your turn by calling wait_for_learner/);
    s.notify('notifications/initialized');

    const again = s.request('initialize', { protocolVersion: '2025-03-26' });
    assert.equal((await s.waitFor((m) => m.id === again)).result.protocolVersion, '2025-03-26');

    const list = s.request('tools/list');
    const tools = (await s.waitFor((m) => m.id === list)).result.tools;
    assert.deepEqual(tools.map((/** @type {any} */ t) => t.name), ['wait_for_learner']);
    assert.equal(tools[0].inputSchema.properties.minutes.maximum, 240);

    const nope = s.request('resources/list');
    assert.equal((await s.waitFor((m) => m.id === nope)).error.code, -32601);
    const bad = s.request('tools/call', { name: 'wait_for_learner', arguments: { minutes: 0 } });
    assert.equal((await s.waitFor((m) => m.id === bad)).result.isError, true);
  } finally {
    await s.stop();
    cleanup();
  }
});

test('a press in the window ends the wait with a fixed instruction, and is handled once', async () => {
  const { root, paths, cleanup } = approvedProject();
  const s = startServer(root);
  try {
    assert.equal(liveListener(paths), null, 'nobody listens before the wait');
    const call = s.request('tools/call', { name: 'wait_for_learner', arguments: {}, _meta: { progressToken: 'p1' } });
    await until(() => fs.existsSync(paths.waiter));
    assert.equal(liveListener(paths)?.agent, 'claude-code-wait', 'the window sees a listener while the tool waits');
    await s.waitFor((m) => m.method === 'notifications/progress' && m.params.progressToken === 'p1');

    assert.deepEqual(deliverToListener(paths, { type: 'check', task: 't1' }), { delivered: true, duplicate: false });
    const r = await s.waitFor((m) => m.id === call);
    assert.equal(textOf(r), 'Menitor window: the learner pressed "Check my work" on task t1. Run the menitor:check skill now, exactly as if they had typed /menitor:check.');
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(fs.existsSync(paths.waiter), false, 'the heartbeat goes when the wait ends');
    const [event] = readInbox(paths);
    assert.ok(fs.existsSync(path.join(paths.claims, event.id)), 'the press is claimed');

    // A press made while no wait is pending, but a listener was live, waits for the next call.
    fs.writeFileSync(paths.listener, JSON.stringify({ version: 1, pid: process.pid, beatAt: new Date().toISOString(), startedAt: new Date().toISOString(), agent: 'test' }));
    deliverToListener(paths, { type: 'hint', task: 't1' }, new Date(Date.now() + 6000));
    fs.rmSync(paths.listener);
    const queued = s.request('tools/call', { name: 'wait_for_learner', arguments: {} });
    assert.match(textOf(await s.waitFor((m) => m.id === queued)), /pressed "Hint"/, 'a queued press returns at once');
  } finally {
    await s.stop();
    cleanup();
  }
});

test('with no window running, the wait opens one before it listens', async () => {
  const { root, paths, cleanup } = approvedProject();
  const s = startServer(root);
  try {
    assert.equal(readWindowInfo(paths), null, 'no window before the wait');
    const call = s.request('tools/call', { name: 'wait_for_learner', arguments: {} });
    await until(() => fs.existsSync(paths.waiter));
    const info = readWindowInfo(paths);
    assert.ok(info && isAlive(paths, info), 'the window is running while the tool listens');
    assert.equal(info.commands.check, '/menitor:check', 'it has the same button commands as /menitor:go');

    deliverToListener(paths, { type: 'check', task: 't1' });
    assert.match(textOf(await s.waitFor((m) => m.id === call)), /pressed "Check my work"/);
  } finally {
    await s.stop();
    cleanup();
  }
});

test('when the window cannot start, the wait returns at once and says why', async () => {
  const { root, paths, cleanup } = approvedProject();
  const s = startServer(root, { MENITOR_WINDOW_PORT: '-1' });
  try {
    const call = s.request('tools/call', { name: 'wait_for_learner', arguments: {} });
    const r = await s.waitFor((m) => m.id === call, 20000);
    assert.equal(r.result.isError, true);
    assert.match(textOf(r), /The task window isn't running, and Menitor couldn't start it/);
    assert.match(textOf(r), /\/menitor:go/);
    assert.equal(fs.existsSync(paths.waiter), false, 'it never listened');
  } finally {
    await s.stop();
    cleanup();
  }
});

test('a newer wait takes over, a cancelled wait stays silent, and a wait times out', async () => {
  const { root, paths, cleanup } = approvedProject();
  const s = startServer(root);
  try {
    const first = s.request('tools/call', { name: 'wait_for_learner', arguments: {} });
    await until(() => fs.existsSync(paths.waiter));
    const second = s.request('tools/call', { name: 'wait_for_learner', arguments: {} });
    assert.match(textOf(await s.waitFor((m) => m.id === first)), /A newer wait_for_learner call took over/);

    s.notify('notifications/cancelled', { requestId: second, reason: 'user pressed Esc' });
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(s.messages.some((m) => m.id === second), false, 'no answer to a cancelled call');
    assert.equal(fs.existsSync(paths.waiter), false);

    const timed = s.request('tools/call', { name: 'wait_for_learner', arguments: { minutes: 1 } });
    assert.match(textOf(await s.waitFor((m) => m.id === timed)), /No button press in 1 minute\. If the learner's next move is still in the window, call wait_for_learner again/);
  } finally {
    await s.stop();
    cleanup();
  }
  const plain = makeProject();
  const p = startServer(plain.root);
  try {
    const call = p.request('tools/call', { name: 'wait_for_learner', arguments: {} });
    assert.match(textOf(await p.waitFor((m) => m.id === call)), /not set up in this project/);
  } finally {
    await p.stop();
    plain.cleanup();
  }
});

test('with a monitor running too, a press reaches the session exactly once', async () => {
  const { root, paths, cleanup } = approvedProject();
  const monitor = spawn(process.execPath, [MONITOR, root], { env: { ...process.env, MENITOR_MONITOR_POLL_MS: '100', MENITOR_MONITOR_WAIT_MS: '100', MENITOR_MONITOR_DEFER_MS: '600' }, stdio: ['ignore', 'pipe', 'ignore'] });
  let printed = '';
  monitor.stdout.setEncoding('utf8');
  monitor.stdout.on('data', (c) => (printed += c));
  const s = startServer(root);
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(paths.listener) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const call = s.request('tools/call', { name: 'wait_for_learner', arguments: {} });
    await until(() => fs.existsSync(paths.waiter));
    deliverToListener(paths, { type: 'stuck', task: 't1' });
    assert.match(textOf(await s.waitFor((m) => m.id === call)), /pressed "I'm stuck"/);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(printed, '', 'the monitor leaves a press the wait already took');

    // With no wait pending, the monitor takes the press after its grace period.
    deliverToListener(paths, { type: 'go', task: 't2' });
    const stopAt = Date.now() + 4000;
    while (!printed && Date.now() < stopAt) await new Promise((r) => setTimeout(r, 50));
    assert.match(printed, /pressed "Start it" on task t2/);
  } finally {
    monitor.kill();
    await new Promise((r) => monitor.once('exit', r));
    await s.stop();
    cleanup();
  }
});

test('the plugin registers the server, and the skills may call the wait tool without a prompt', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.deepEqual(manifest.mcpServers.menitor, { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/adapters/claude-code/mcp.js'] });
  for (const name of ['go', 'check', 'hint', 'stuck', 'skip']) {
    const skill = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'adapters', 'claude-code', 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(skill, /- mcp__plugin_menitor_menitor__wait_for_learner/, name);
    assert.match(skill, /`wait_for_learner` \(the menitor MCP tool\)/, `${name} tells Claude when to wait`);
  }
});
