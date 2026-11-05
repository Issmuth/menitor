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
import { loadAnswers, loadGuard, loadPlan, loadProgress, loadSession, loadSolutions, saveAnswers, saveProgress } from '../lib/state.js';
import { deliverToListener, liveListener, pressState, readInbox } from '../lib/inbox.js';
import { codeFingerprint } from '../lib/fingerprint.js';

/** The only events a button can send (W-7). */
export const EVENTS = /** @type {const} */ (['check', 'hint', 'stuck', 'go']);
const COMMAND_KEYS = ['start', 'go', 'check', 'hint', 'stuck', 'skip'];
const MAX_BODY = 16384;
const MAX_ANSWER = 4000;
const HEARTBEAT_MS = 20000;
const POLL_MS = 2000;

const PAGE_DIR = new URL('./page/', import.meta.url);
const STATIC = /** @type {Record<string, { file: string, type: string, cache?: boolean }>} */ ({
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  // Instrument Sans, bundled under the SIL Open Font License (fonts/OFL.txt), so the page loads nothing from outside.
  '/fonts/instrument-sans-latin.woff2': { file: 'fonts/instrument-sans-latin.woff2', type: 'font/woff2', cache: true },
  '/fonts/instrument-sans-latin-ext.woff2': { file: 'fonts/instrument-sans-latin-ext.woff2', type: 'font/woff2', cache: true },
});

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
 * @returns {Record<string, any>} JSON for the page; it reads fields loosely, as the browser does
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
    // Every task, in plan order, with who did it: the window draws the whole plan as one ledger (W-8).
    let number = 0;
    const tasksOf = (/** @type {number} */ i) =>
      (plan?.milestones[i]?.tasks ?? []).map((t) => ({
        id: t.id,
        number: ++number,
        goal: t.goal,
        done: t.status === 'done',
        by: t.owner,
        skipped: t.skipped ?? false,
        added: Boolean(t.added),
        current: t.id === session.currentTask,
      }));
    return {
      ok: true,
      phase,
      project: status.project,
      mentorMode: status.mentorMode,
      typeAlong: status.typeAlong && card?.owner === 'learner' ? typeAlongSteps(paths, card) : null,
      ...turnOf(paths, session, current?.task ?? null),
      level: status.level,
      card,
      lastCheck: record?.lastCheck ?? null,
      result: lastResult(paths, plan, session, card),
      milestones: status.milestones.map((m, i) => ({ ...m, current: current?.milestone.id === m.id, tasks: tasksOf(i) })),
      done: status.done,
      total: status.total,
      written: status.written,
      commands: options.commands,
      listening: Boolean(liveListener(paths)),
      press: pressState(paths),
    };
  } catch (err) {
    return { ok: false, error: /** @type {Error} */ (err).message, commands: options.commands };
  }
}

/**
 * C-6: the explain-back of the task that passed last, with the answers and Menitor's feedback, so
 * the learner can read it before the next card. It stays until they press Continue. A pass with
 * no questions, such as a delegated task, has nothing to read.
 * @param {StatePaths} paths
 * @param {import('../lib/plan.js').Plan | null} plan
 * @param {import('../lib/state.js').Session} session
 * @param {{ number: number, goal: string } | null} card the next card, if there is one
 */
export function lastResult(paths, plan, session, card) {
  if (!plan) return null;
  /** @type {{ task: import('../lib/plan.js').Task, number: number } | null} */
  let last = null;
  let number = 0;
  for (const m of plan.milestones) {
    for (const t of m.tasks) {
      number += 1;
      if (t.status === 'done' && t.passedAt && (!last || t.passedAt > (last.task.passedAt ?? ''))) last = { task: t, number };
    }
  }
  if (!last || loadProgress(paths).seen?.[last.task.id]) return null;
  const questions = session.tasks[last.task.id]?.questions ?? [];
  if (!questions.length) return null;
  const answers = loadAnswers(paths).answers;
  return {
    task: last.task.id,
    number: last.number,
    goal: last.task.goal,
    passedAt: last.task.passedAt,
    questions: questions.map((q) => ({ ...q, answer: answers[q.id] ?? null })),
    next: card ? { number: card.number, goal: card.goal } : null,
  };
}

/**
 * What stands between the learner and the next task, besides the steps themselves: the agent's
 * questions and the answers typed here, anything the agent is waiting on, a skip that waits for
 * the learner's confirm, and a delegated task waiting for the session to pick it up.
 * @param {StatePaths} paths
 * @param {import('../lib/state.js').Session} session
 * @param {import('../lib/plan.js').Task | null} task
 */
export function turnOf(paths, session, task) {
  const waiting = session.waiting && (!session.waiting.task || session.waiting.task === task?.id) ? session.waiting : null;
  if (!task) return { waiting, questions: [], skipRequested: false, goAskedAt: null };
  const guard = loadGuard(paths);
  const answers = loadAnswers(paths).answers;
  const learner = task.owner === 'learner';
  const questions = learner ? (session.tasks[task.id]?.questions ?? []).map((q) => ({ ...q, answer: answers[q.id] ?? null })) : [];
  const goes = learner ? [] : readInbox(paths).filter((e) => e.type === 'go' && e.task === task.id);
  return {
    waiting,
    questions,
    skipRequested: learner && Boolean(guard.skipRequests[task.id]) && !guard.grants[task.id],
    goAskedAt: goes.length ? goes[goes.length - 1].at : null,
  };
}

/**
 * Type-along: each step's instructions and code, but only for steps that are open: ticked, the first,
 * or the one right after a tick. Later steps' code never leaves the server, like locked hints.
 * @param {StatePaths} paths
 * @param {import('../lib/card.js').CardData} card
 */
export function typeAlongSteps(paths, card) {
  const stored = loadSolutions(paths).steps;
  /** @type {Record<string, { locked: true } | { missing: true } | { say: string, code: { where?: string, text: string }[] }>} */
  const steps = {};
  card.checklist.forEach((item, i, all) => {
    const open = item.ticked || i === 0 || all[i - 1].ticked;
    const code = stored[item.id];
    steps[item.id] = !open ? { locked: true } : code ? { say: code.say, code: code.code } : { missing: true };
  });
  return { steps };
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
 * @param {{ token?: string, code?: string, commands?: Record<string, unknown>, deliver?: (event: { type: import('../lib/inbox.js').InboxType, task: string | null }) => boolean }} [options]
 *   code: the fingerprint of the code this server runs; tests pass an old one
 */
export function createWindowServer(root, options = {}) {
  const paths = statePaths(root);
  const token = options.token ?? randomToken();
  const code = options.code ?? codeFingerprint();
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
  const stateJson = () => {
    const s = windowState(paths, { commands });
    // State this server can't read may only be newer than its code. Hashing runs only on errors.
    if (!s.ok) s.stale = codeFingerprint() !== code;
    return JSON.stringify(s);
  };

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
      if (asset) {
        /** @type {Record<string, string>} */
        const headers = { 'Content-Type': asset.type };
        if (asset.cache) headers['Cache-Control'] = 'private, max-age=604800, immutable';
        return send(res, 200, /** @type {Buffer} */ (files.get(asset.file)), headers);
      }
      if (url.pathname === '/api/state') return send(res, 200, stateJson(), { 'Content-Type': 'application/json; charset=utf-8' });
      if (url.pathname === '/api/ping') return sendJson(res, 200, { ok: true, root, pid: process.pid, code });
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
      if (url.pathname === '/api/answer') return answer(res, body);
      if (url.pathname === '/api/continue') return dismiss(res, body);
      if (url.pathname === '/api/event') {
        const type = body.type;
        if (typeof type !== 'string' || !(/** @type {readonly string[]} */ (EVENTS)).includes(type)) return send(res, 400, 'Unknown event.');
        let task = null;
        try {
          task = loadSession(paths).currentTask;
        } catch {
          task = null;
        }
        // One press at a time: while the last one is still on its way or being worked on, send nothing.
        const pending = pressState(paths);
        if (pending && pending.state !== 'done') return sendJson(res, 200, { delivered: true, busy: true, command: /** @type {Record<string, string>} */ (commands)[type] });
        const event = { type: /** @type {'check' | 'hint' | 'stuck' | 'go'} */ (type), task };
        const delivered = options.deliver ? options.deliver(event) : deliverToListener(paths, event).delivered;
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

  /**
   * C-6: Continue on a passed task's result. It's remembered in progress.json, so a reload or the
   * pop-out shows the next card too. Only the result on screen can be dismissed.
   * @param {http.ServerResponse} res
   * @param {Record<string, unknown>} body
   */
  function dismiss(res, body) {
    const { task } = body;
    if (typeof task !== 'string') return send(res, 400, 'Send { task }.');
    try {
      const plan = loadPlan(paths);
      const session = loadSession(paths);
      const result = lastResult(paths, plan, session, null);
      if (result?.task !== task) return send(res, 409, 'That result is not on screen.');
      const progress = loadProgress(paths);
      progress.seen = { ...progress.seen, [task]: new Date().toISOString() };
      saveProgress(paths, progress);
      refresh();
      return send(res, 200, lastJson, { 'Content-Type': 'application/json; charset=utf-8' });
    } catch (err) {
      return send(res, 500, /** @type {Error} */ (err).message);
    }
  }

  /**
   * C-5: save the learner's answer to the open question, as data in answers.json. The session
   * gets only a fixed event; the agent reads the answer through the CLI.
   * @param {http.ServerResponse} res
   * @param {Record<string, unknown>} body
   */
  function answer(res, body) {
    const { question, text } = body;
    if (typeof question !== 'string' || typeof text !== 'string') return send(res, 400, 'Send { question, text }.');
    const clean = text.trim();
    if (!clean || clean.length > MAX_ANSWER) return send(res, 400, `An answer is 1 to ${MAX_ANSWER} characters.`);
    try {
      const session = loadSession(paths);
      const task = session.currentTask;
      const q = task ? (session.tasks[task]?.questions ?? []).find((x) => x.id === question) : undefined;
      if (!q) return send(res, 409, 'That question is not open on the current task.');
      if (q.outcome !== null) return send(res, 409, 'That answer has already been judged.');
      const answers = loadAnswers(paths);
      answers.answers[question] = { text: clean, at: new Date().toISOString() };
      saveAnswers(paths, answers);
      const event = { type: /** @type {const} */ ('answer'), task };
      const delivered = options.deliver ? options.deliver(event) : deliverToListener(paths, event).delivered;
      refresh();
      return sendJson(res, 200, { delivered, command: /** @type {Record<string, string>} */ (commands).check, state: JSON.parse(lastJson) });
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
