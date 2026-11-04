// The task window server (W-1 to W-8): a page on 127.0.0.1 that shows one task card, updates
// live, saves checklist ticks, and turns its buttons into fixed events. It never accepts free
// text, and it answers only requests that carry its token on the right host.

import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { statePaths } from '../lib/paths.js';
import { statusData } from '../lib/ops.js';
import { cardData } from '../lib/card.js';
import { findTask } from '../lib/plan.js';
import { loadPlan, loadProgress, loadSession, saveProgress } from '../lib/state.js';

/** The only events a button can send (W-7). */
export const EVENTS = /** @type {const} */ (['check', 'hint', 'stuck']);
const COMMAND_KEYS = ['start', 'go', 'check', 'hint', 'stuck', 'skip'];
const MAX_BODY = 2048;
const HEARTBEAT_MS = 20000;
const POLL_MS = 2000;

const PAGE_DIR = new URL('./page/', import.meta.url);
const STATIC = /** @type {Record<string, { file: string, type: string }>} */ ({
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
});

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * @typedef {import('../lib/paths.js').StatePaths} StatePaths
 * @typedef {Partial<Record<'start' | 'go' | 'check' | 'hint' | 'stuck' | 'skip', string>>} Commands
 */

export function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Everything the page shows, built fresh from the state files.
 * @param {StatePaths} paths
 * @param {{ commands: Commands }} options
 */
export function windowState(paths, options) {
  try {
    const status = statusData(paths);
    const plan = loadPlan(paths);
    const session = loadSession(paths);
    const current = plan && session.currentTask ? findTask(plan, session.currentTask) : null;
    const card = plan && current ? cardData(plan, current.task.id, loadProgress(paths)) : null;
    const record = current ? session.tasks[current.task.id] : undefined;
    const phase = !plan ? 'no-plan' : !plan.approvedAt ? 'draft' : card ? 'task' : 'done';
    return {
      ok: true,
      phase,
      project: status.project,
      mentorMode: status.mentorMode,
      level: status.level,
      card,
      lastCheck: record?.lastCheck ?? null,
      milestones: status.milestones.map((m) => ({ ...m, current: current?.milestone.id === m.id })),
      done: status.done,
      total: status.total,
      written: status.written,
      commands: options.commands,
    };
  } catch (err) {
    return { ok: false, error: /** @type {Error} */ (err).message, commands: options.commands };
  }
}

/**
 * @param {string | undefined} a
 * @param {string} b
 */
function safeEqual(a, b) {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {http.IncomingMessage} req
 * @param {string} name
 */
function cookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<unknown>}
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    // Past the limit, keep reading but drop the bytes, so the 413 reply still reaches the client.
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Keep only known command names with plain text values.
 * @param {Record<string, unknown> | undefined} raw
 * @returns {Commands}
 */
export function cleanCommands(raw) {
  /** @type {Record<string, string>} */
  const out = { check: 'check', hint: 'hint', stuck: 'stuck' };
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (COMMAND_KEYS.includes(k) && typeof v === 'string' && /^[^\n\r<>]{1,80}$/.test(v)) out[k] = v;
  }
  return out;
}

/**
 * Create the server. Call listen() to start it.
 * @param {string} root
 * @param {{ token?: string, commands?: Record<string, unknown>, deliver?: (event: { type: string, task: string | null }) => boolean }} [options]
 */
export function createWindowServer(root, options = {}) {
  const paths = statePaths(root);
  const token = options.token ?? randomToken();
  const commands = cleanCommands(options.commands);
  /** @type {Set<http.ServerResponse>} */
  const clients = new Set();
  let port = 0;
  let lastJson = '';
  let lastActivity = Date.now();
  /** @type {NodeJS.Timeout | null} */
  let debounce = null;
  /** @type {fs.FSWatcher | null} */
  let watcher = null;
  /** @type {NodeJS.Timeout[]} */
  const timers = [];
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  for (const { file } of Object.values(STATIC)) files.set(file, fs.readFileSync(new URL(file, PAGE_DIR)));

  const cookieName = () => `menitor_${port}`;
  const stateJson = () => JSON.stringify(windowState(paths, { commands }));

  /** @param {string} json */
  function broadcast(json) {
    for (const res of clients) res.write(`event: state\ndata: ${json}\n\n`);
  }

  function refresh() {
    const json = stateJson();
    if (json !== lastJson) {
      lastJson = json;
      broadcast(json);
    }
  }

  function scheduleRefresh() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(refresh, 120);
  }

  /**
   * @param {http.ServerResponse} res
   * @param {number} status
   * @param {string | Buffer} body
   * @param {Record<string, string>} [headers]
   */
  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    res.end(body);
  }

  /**
   * @param {http.ServerResponse} res
   * @param {number} status
   * @param {unknown} value
   */
  function sendJson(res, status, value) {
    send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' });
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handle(req, res) {
    lastActivity = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Only this machine, by this server's own name: blocks DNS rebinding from other sites.
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 421, 'Wrong host.');

    const fromQuery = req.method === 'GET' && url.pathname === '/' ? url.searchParams.get('t') ?? undefined : undefined;
    const presented = /** @type {string | undefined} */ (req.headers['x-menitor-token']) ?? cookie(req, cookieName()) ?? fromQuery;
    if (!safeEqual(presented, token)) {
      return send(res, 401, 'This window needs the link from your coding session. Ask for the current task again to get a fresh link.');
    }
    if (fromQuery) {
      // Swap the link's token for a cookie, so the token leaves the address bar.
      return send(res, 303, '', { Location: '/', 'Set-Cookie': `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/` });
    }

    if (req.method === 'GET') {
      const asset = STATIC[url.pathname];
      if (asset) return send(res, 200, /** @type {Buffer} */ (files.get(asset.file)), { 'Content-Type': asset.type });
      if (url.pathname === '/api/state') return send(res, 200, stateJson(), { 'Content-Type': 'application/json; charset=utf-8' });
      if (url.pathname === '/api/ping') return sendJson(res, 200, { ok: true, root, pid: process.pid });
      if (url.pathname === '/api/events') {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        lastJson = stateJson();
        res.write(`event: state\ndata: ${lastJson}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return undefined;
      }
      return send(res, 404, 'Not found.');
    }

    if (req.method === 'POST') {
      // A cross-site page can't send JSON without a preflight we never answer, and its Origin differs.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) return send(res, 403, 'Wrong origin.');
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, 'JSON only.');
      /** @type {Record<string, unknown>} */
      let body;
      try {
        body = /** @type {Record<string, unknown>} */ (await readJson(req));
      } catch (err) {
        return send(res, /** @type {{ status?: number }} */ (err).status ?? 400, /** @type {Error} */ (err).message);
      }

      if (url.pathname === '/api/tick') return tick(res, body);
      if (url.pathname === '/api/event') {
        const type = body.type;
        if (typeof type !== 'string' || !(/** @type {readonly string[]} */ (EVENTS)).includes(type)) return send(res, 400, 'Unknown event.');
        let task = null;
        try {
          task = loadSession(paths).currentTask;
        } catch {
          task = null;
        }
        const delivered = options.deliver ? options.deliver({ type, task }) : false;
        return sendJson(res, 200, { delivered, command: /** @type {Record<string, string>} */ (commands)[type] });
      }
      if (url.pathname === '/api/shutdown') {
        sendJson(res, 200, { ok: true });
        setImmediate(() => api.close());
        return undefined;
      }
      return send(res, 404, 'Not found.');
    }
    return send(res, 405, 'Method not allowed.');
  }

  /**
   * W-3: save a tick for an item on the current task's checklist.
   * @param {http.ServerResponse} res
   * @param {Record<string, unknown>} body
   */
  function tick(res, body) {
    const { item, ticked } = body;
    if (typeof item !== 'string' || typeof ticked !== 'boolean') return send(res, 400, 'Send { item, ticked }.');
    try {
      const plan = loadPlan(paths);
      const session = loadSession(paths);
      if (!plan || !session.currentTask) return send(res, 409, 'There is no current task.');
      const { task } = findTask(plan, session.currentTask);
      if (!task.checklist.some((i) => i.id === item)) return send(res, 409, 'That item is not on the current card.');
      const progress = loadProgress(paths);
      if (ticked) progress.ticks[item] = new Date().toISOString();
      else delete progress.ticks[item];
      saveProgress(paths, progress);
      refresh();
      return send(res, 200, lastJson, { 'Content-Type': 'application/json; charset=utf-8' });
    } catch (err) {
      return send(res, 500, /** @type {Error} */ (err).message);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, String(err?.message ?? err));
    });
  });

  const api = {
    token,
    commands,
    server,
    get port() {
      return port;
    },
    get clients() {
      return clients.size;
    },
    get lastActivity() {
      return lastActivity;
    },
    /**
     * Start listening on 127.0.0.1 only (W-1).
     * @param {number} [wanted]
     * @returns {Promise<number>}
     */
    listen(wanted = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wanted, '127.0.0.1', () => {
          port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
          lastJson = stateJson();
          try {
            watcher = fs.watch(paths.dir, scheduleRefresh);
            watcher.on('error', () => {
              watcher = null;
            });
          } catch {
            watcher = null; // Polling below still keeps the page live.
          }
          timers.push(setInterval(refresh, POLL_MS));
          timers.push(setInterval(() => {
            for (const res of clients) res.write(': ping\n\n');
          }, HEARTBEAT_MS));
          resolve(port);
        });
      });
    },
    /** Stop the server and every open stream. */
    close() {
      for (const t of timers) clearInterval(t);
      if (debounce) clearTimeout(debounce);
      watcher?.close();
      for (const res of clients) res.end();
      clients.clear();
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
    /** Push fresh state now, for tests and the monitor. */
    refresh,
  };
  return api;
}
