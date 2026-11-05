// Start, find and stop the task window server from the CLI (W-1).

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchSync } from './check.js';
import { readJsonOrNull } from './fsx.js';
import { validate } from './schema.js';
import { SCHEMAS } from './state.js';

const MAIN = fileURLToPath(new URL('../server/main.js', import.meta.url));
const START_TIMEOUT_MS = 8000;

/**
 * @typedef {import('./paths.js').StatePaths} StatePaths
 * @typedef {{ version: 1, pid: number, port: number, token: string, startedAt: string, commands: Record<string, string> }} WindowInfo
 */

/** @param {number} ms */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * What window.json says, if it's there and valid.
 * @param {StatePaths} paths
 * @returns {WindowInfo | null}
 */
export function readWindowInfo(paths) {
  try {
    const info = readJsonOrNull(paths.window);
    return info && validate(SCHEMAS.window, info).length === 0 ? /** @type {WindowInfo} */ (info) : null;
  } catch {
    return null;
  }
}

/**
 * Is a window server for this project answering at the address window.json gives?
 * @param {StatePaths} paths
 * @param {WindowInfo} info
 */
export function isAlive(paths, info) {
  const res = fetchSync(`http://127.0.0.1:${info.port}/api/ping`, 3000, { headers: { 'X-Menitor-Token': info.token } });
  if (res.status !== 200 || !res.body) return false;
  try {
    return JSON.parse(res.body).root === paths.root;
  } catch {
    return false;
  }
}

/**
 * The link that opens the window. Its token is swapped for a cookie on first load.
 * @param {WindowInfo} info
 */
export function windowUrl(info) {
  return `http://127.0.0.1:${info.port}/?t=${info.token}`;
}

/**
 * Open the page in the default browser. Returns false when there's no desktop to open it on.
 * @param {string} url
 * @param {NodeJS.ProcessEnv} [env]
 */
export function openBrowser(url, env = process.env) {
  if (env.MENITOR_NO_BROWSER) return false;
  /** @type {[string, string[]] | null} */
  let cmd = null;
  if (process.platform === 'darwin') cmd = ['open', [url]];
  else if (process.platform === 'win32') cmd = ['cmd', ['/c', 'start', '', url]];
  else if (env.DISPLAY || env.WAYLAND_DISPLAY) cmd = ['xdg-open', [url]];
  if (!cmd) return false;
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the window server if it isn't running, then return its link (W-1).
 * @param {StatePaths} paths
 * @param {{ commands?: Record<string, string>, browser?: boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ url: string, started: boolean, opened: boolean, info: WindowInfo }}
 */
export function openWindow(paths, options = {}) {
  let info = readWindowInfo(paths);
  let started = false;
  if (!info || !isAlive(paths, info)) {
    const before = info?.pid;
    const child = spawn(process.execPath, [MAIN, paths.root, JSON.stringify(options.commands ?? {})], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: options.env ?? process.env,
    });
    child.unref();
    const deadline = Date.now() + START_TIMEOUT_MS;
    info = null;
    while (Date.now() < deadline) {
      const next = readWindowInfo(paths);
      if (next && next.pid !== before && next.pid === child.pid) {
        info = next;
        break;
      }
      sleep(50);
    }
    if (!info) throw new Error('The window server did not start. Run it by hand to see why: node core/server/main.js <project root>');
    started = true;
  }
  const url = windowUrl(info);
  const opened = options.browser === false ? false : openBrowser(url, options.env);
  return { url, started, opened, info };
}

/**
 * Stop the window server, if one is running for this project.
 * @param {StatePaths} paths
 * @returns {boolean} whether a server was running
 */
export function stopWindow(paths) {
  const info = readWindowInfo(paths);
  if (!info) return false;
  const res = fetchSync(`http://127.0.0.1:${info.port}/api/shutdown`, 3000, {
    method: 'POST',
    headers: { 'X-Menitor-Token': info.token, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const deadline = Date.now() + 3000;
  while (fs.existsSync(paths.window) && Date.now() < deadline) sleep(50);
  if (fs.existsSync(paths.window)) {
    // It didn't answer: the process is gone or stuck. Clear the stale file only if its pid is dead.
    try {
      process.kill(info.pid, 0);
    } catch {
      fs.rmSync(paths.window, { force: true });
    }
  }
  return res.status === 200;
}
