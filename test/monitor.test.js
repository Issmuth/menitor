// The Claude Code monitor, run as its own process the way Claude Code runs it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { approvedProject, cli, makeProject } from './helpers.js';
import { appendInbox } from '../core/lib/inbox.js';

const MONITOR = path.resolve(import.meta.dirname, '..', 'adapters', 'claude-code', 'monitor.js');
const MONITORS_JSON = path.resolve(import.meta.dirname, '..', 'adapters', 'claude-code', 'monitors.json');

/**
 * @param {string} dir
 */
function startMonitor(dir) {
  const child = spawn(process.execPath, [MONITOR, dir], {
    env: { ...process.env, MENITOR_MONITOR_POLL_MS: '100', MENITOR_MONITOR_WAIT_MS: '100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  /** @type {string[]} */
  const lines = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(undefined);
      child.once('exit', () => resolve(undefined));
      child.kill('SIGTERM');
    });
  return { child, lines, stop };
}

/**
 * @param {() => boolean} condition
 * @param {number} [ms]
 */
async function waitFor(condition, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('the monitor beats, prints one fixed line per new press, and nothing else', async () => {
  const { root, paths, cleanup } = approvedProject();
  appendInbox(paths, { type: 'check', task: 't1' }, new Date(Date.now() - 60000));
  const m = startMonitor(root);
  try {
    await waitFor(() => fs.existsSync(paths.listener));
    assert.equal(JSON.parse(fs.readFileSync(paths.listener, 'utf8')).agent, 'claude-code');

    appendInbox(paths, { type: 'hint', task: 't1' });
    appendInbox(paths, { type: 'stuck', task: 't1' });
    await waitFor(() => m.lines.length >= 2);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(m.lines, [
      'Menitor window: the learner pressed "Hint" on task t1. Run the menitor:hint skill now, exactly as if they had typed /menitor:hint.',
      `Menitor window: the learner pressed "I'm stuck" on task t1. Run the menitor:stuck skill now, exactly as if they had typed /menitor:stuck.`,
    ], 'old presses from before the session are not replayed, and each press prints once');
  } finally {
    await m.stop();
  }
  if (process.platform !== 'win32') assert.equal(fs.existsSync(paths.listener), false, 'the heartbeat is removed on exit');
  cleanup();
});

test('in a folder without Menitor the monitor waits quietly, then starts when it appears', async () => {
  const { root, paths, cleanup } = makeProject();
  const m = startMonitor(root);
  try {
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(fs.existsSync(paths.listener), false);
    assert.deepEqual(m.lines, []);
    cli(root, ['init']);
    await waitFor(() => fs.existsSync(paths.listener));
  } finally {
    await m.stop();
    cleanup();
  }
});

test('monitors.json uses only the documented keys and passes the project folder', () => {
  const entries = JSON.parse(fs.readFileSync(MONITORS_JSON, 'utf8'));
  assert.equal(entries.length, 1);
  for (const e of entries) {
    assert.deepEqual(Object.keys(e).filter((k) => !['name', 'command', 'description', 'when'].includes(k)), []);
    assert.equal(e.command, 'node "${CLAUDE_PLUGIN_ROOT}/adapters/claude-code/monitor.js" "${CLAUDE_PROJECT_DIR}"');
  }
  const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.experimental.monitors, './adapters/claude-code/monitors.json');
});
