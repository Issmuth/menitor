// Start, find and stop the task window server from the CLI (W-1).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchSync } from './check.js';
import { readJsonOrNull } from './fsx.js';
import { codeFingerprint } from './fingerprint.js';
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
 * Ask the window server at the address window.json gives who it is. Null when nothing for this
 * project answers. `code` is the fingerprint of the code it runs; servers before it have none.
 * @param {StatePaths} paths
 * @param {WindowInfo} info
 * @returns {{ code: string | null } | null}
 */
export function pingWindow(paths, info) {
  const res = fetchSync(`http://127.0.0.1:${info.port}/api/ping`, 3000, { headers: { 'X-Menitor-Token': info.token } });
  if (res.status !== 200 || !res.body) return null;
  try {
    const body = JSON.parse(res.body);
    return body.root === paths.root ? { code: typeof body.code === 'string' ? body.code : null } : null;
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
  return pingWindow(paths, info) !== null;
}

/**
 * The link that opens the window. Its token is swapped for a cookie on first load.
 * @param {WindowInfo} info
 */
export function windowUrl(info) {
  return `http://127.0.0.1:${info.port}/?t=${info.token}`;
}

/**
 * An environment variable by name in any case: a copied Windows environment keeps names such as
 * "ProgramFiles" as they were.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 */
function envOf(env, name) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/**
 * The Chromium browser to open the window in as an app, with no tabs or address bar: Chrome, Edge,
 * Chromium or Brave, from the usual install places. Null when there's none, no desktop, or
 * MENITOR_WINDOW_APP=0, and the window opens in a tab instead.
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 * @param {(file: string) => boolean} [exists]
 * @returns {string | null}
 */
export function appBrowser(platform, env, exists = isFile) {
  if (envOf(env, 'MENITOR_WINDOW_APP') === '0') return null;
  /** @type {string[]} */
  let candidates = [];
  if (platform === 'win32') {
    const roots = ['LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)'].map((n) => envOf(env, n)).filter((r) => typeof r === 'string' && r);
    const apps = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'Chromium\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    candidates = apps.flatMap((app) => roots.map((root) => path.win32.join(/** @type {string} */ (root), app)));
  } else if (platform === 'darwin') {
    candidates = ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser'].map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`);
  } else if (envOf(env, 'DISPLAY') || envOf(env, 'WAYLAND_DISPLAY')) {
    const dirs = (envOf(env, 'PATH') ?? '').split(':').filter(Boolean);
    const names = ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'chromium', 'chromium-browser', 'brave-browser'];
    candidates = names.flatMap((n) => dirs.map((d) => path.posix.join(d, n)));
  }
  return candidates.find((c) => exists(c)) ?? null;
}

/**
 * How to start the app window: maximized, in a browser profile of its own. A browser that is
 * already running ignores start-up flags such as --start-maximized, so the window gets its own
 * profile, and with it a browser that starts fresh. MENITOR_WINDOW_MAXIMIZED=0 opens a normal-size
 * app window in the usual profile instead.
 * @param {string} url
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function appArgs(url, env) {
  if (envOf(env, 'MENITOR_WINDOW_MAXIMIZED') === '0') return [`--app=${url}`];
  return [`--app=${url}`, '--start-maximized', `--user-data-dir=${path.join(os.tmpdir(), 'menitor-browser')}`, '--no-first-run', '--no-default-browser-check'];
}

/** @param {string} file */
function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Start a program detached, so it outlives the CLI.
 * @param {string} command
 * @param {string[]} args
 */
function launch(command, args) {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the page as its own app window when a Chromium browser is installed, or else in the default
 * browser. Returns false when there's no desktop to open it on.
 * @param {string} url
 * @param {NodeJS.ProcessEnv} [env]
 */
export function openBrowser(url, env = process.env) {
  if (env.MENITOR_NO_BROWSER) return false;
  const app = appBrowser(process.platform, env);
  if (app && launch(app, appArgs(url, env))) return true;
  /** @type {[string, string[]] | null} */
  let cmd = null;
  if (process.platform === 'darwin') cmd = ['open', [url]];
  else if (process.platform === 'win32') cmd = ['cmd', ['/c', 'start', '', url]];
  else if (env.DISPLAY || env.WAYLAND_DISPLAY) cmd = ['xdg-open', [url]];
  if (!cmd) return false;
  return launch(cmd[0], cmd[1]);
}

/**
 * Start the window server if it isn't running, then return its link (W-1). A server started from
 * older code is stopped and started again, since it keeps the code and schemas it began with.
 * @param {StatePaths} paths
 * @param {{ commands?: Record<string, string>, browser?: boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ url: string, started: boolean, restarted: boolean, opened: boolean, info: WindowInfo }}
 */
export function openWindow(paths, options = {}) {
  let info = readWindowInfo(paths);
  let started = false;
  const ping = info ? pingWindow(paths, info) : null;
  const restarted = ping !== null && ping.code !== codeFingerprint();
  if (restarted) stopWindow(paths);
  if (!info || !ping || restarted) {
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
  return { url, started, restarted, opened, info };
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
