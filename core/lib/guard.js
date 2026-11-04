// The guard (G-1 to G-5): decide whether the agent may write a file or run a command, and
// record the learner-only actions that change what it may do. Agent adapters call this from
// their hooks; it knows nothing about any one agent's hook format or command names.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRoot, statePaths } from './paths.js';
import { analyzeCommand } from './shell.js';
import { appendEvent } from './log.js';
import { findTask } from './plan.js';
import { validate } from './schema.js';
import { SCHEMAS, defaultGuard, loadGuard, loadPlan, loadSession, saveGuard } from './state.js';

/**
 * @typedef {import('./paths.js').StatePaths} StatePaths
 * @typedef {import('./shell.js').Dialect} Dialect
 * @typedef {'null' | 'outside' | 'docs' | 'menitor' | 'state' | 'build' | 'project' | 'unknown'} Area
 * @typedef {'no' | 'delegated' | 'granted' | 'mode-off' | 'inactive'} WritesBy
 * @typedef {'setup' | 'learner-task' | 'plan-done' | 'state-error' | null} Blocker
 * @typedef {object} GuardContext
 * @property {boolean} active        false when the project has no .menitor/ folder
 * @property {string | null} root
 * @property {StatePaths | null} paths
 * @property {'on' | 'off'} mode
 * @property {string | null} task    the current task ID
 * @property {WritesBy} writes       why project writes are allowed, or "no"
 * @property {Blocker} blocker       why project writes are blocked, when they are
 * @property {string | null} error   a state file that failed to load
 * @typedef {{ path: string, area: Area, kind: 'write' | 'delete' }} Target
 * @typedef {'state-file' | 'project-write' | 'git' | 'package' | 'script-write'} Rule
 * @typedef {{ allow: true, targets: Target[], effects: string[] } | { allow: false, rule: Rule, blocker: Blocker, target?: string, via?: string, targets: Target[], effects: string[] }} Decision
 */

/** Folders that only hold build output or caches, so deleting them never loses learner work. */
export const BUILD_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.netlify',
  'coverage', '.cache', '.parcel-cache', '.turbo', '.vite', 'target', '__pycache__', '.pytest_cache', '.venv',
]);

/** Files directly in .menitor/ that only their own writer may change (G-4). */
const STATE_FILES = new Set(['learner.md', 'log.md', '.gitignore']);
const NULL_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/fd/1', '/dev/fd/2', 'nul', '$null', '-']);
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Load what the guard needs for a project. Never throws: broken state blocks project writes
 * instead of breaking every tool call.
 * @param {string | null} root
 * @returns {GuardContext}
 */
export function loadGuardContext(root) {
  if (!root || !fs.existsSync(statePaths(root).dir)) {
    return { active: false, root: null, paths: null, mode: 'on', task: null, writes: 'inactive', blocker: null, error: null };
  }
  const paths = statePaths(root);
  /** @type {GuardContext} */
  const ctx = { active: true, root, paths, mode: 'on', task: null, writes: 'no', blocker: null, error: null };

  let guard;
  try {
    guard = loadGuard(paths);
  } catch (err) {
    return { ...ctx, blocker: 'state-error', error: /** @type {Error} */ (err).message };
  }
  ctx.mode = guard.mentorMode;
  if (guard.mentorMode === 'off') return { ...ctx, writes: 'mode-off' };

  try {
    const plan = loadPlan(paths);
    const session = loadSession(paths);
    if (!plan || !plan.approvedAt) return { ...ctx, blocker: 'setup' };
    if (!session.currentTask) return { ...ctx, blocker: 'plan-done' };
    const { task } = findTask(plan, session.currentTask);
    ctx.task = task.id;
    if (task.owner === 'delegated') return { ...ctx, writes: 'delegated' };
    if (guard.grants[task.id]) return { ...ctx, writes: 'granted' };
    return { ...ctx, blocker: 'learner-task' };
  } catch (err) {
    return { ...ctx, blocker: 'state-error', error: /** @type {Error} */ (err).message };
  }
}

/**
 * Find the project for a hook call: the nearest .menitor/ above the working folder, or above the
 * folder the session started in.
 * @param {string | undefined} cwd
 * @param {string | undefined} projectDir
 */
export function findProjectRoot(cwd, projectDir) {
  return (cwd && findRoot(cwd)) || (projectDir && findRoot(projectDir)) || null;
}

/**
 * @param {string} a
 * @param {string} b
 */
function same(a, b) {
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Which area of the project a path falls in.
 * @param {string} root
 * @param {string | null} cwd  the folder relative paths start from; null when unknown
 * @param {string} raw         the path as the command or tool wrote it
 * @returns {Area}
 */
export function classifyPath(root, cwd, raw) {
  let p = raw.trim();
  if (NULL_TARGETS.has(p.toLowerCase())) return 'null';
  p = p.replace(/\\/g, '/');
  if (process.platform === 'win32') p = p.replace(/^\/([a-zA-Z])\//, '$1:/');
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));

  // Variables and globs: judge by the folder before them. A pattern inside .menitor/ could
  // match a state file, so it counts as one.
  const dynamic = p.search(/[$`*?[{]/);
  if (dynamic !== -1) {
    if (dynamic === 0 && p[0] !== '*' && p[0] !== '?') return 'unknown';
    const prefix = p.slice(0, dynamic);
    const slash = prefix.lastIndexOf('/');
    const dir = slash === -1 ? '.' : prefix.slice(0, slash) || '/';
    const area = classifyPath(root, cwd, dir);
    return area === 'menitor' ? 'state' : area;
  }

  if (!path.isAbsolute(p) && cwd === null) return 'unknown';
  const abs = path.resolve(cwd ?? root, p);
  const rel = path.relative(root, abs);
  if (rel === '') return 'project';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'outside';

  const parts = rel.split(path.sep);
  const first = parts[0];
  if (same(first, '.menitor')) {
    if (parts.length === 1) return 'state';
    if (parts.length === 2 && (/\.jsonl?$/i.test(parts[1]) || [...STATE_FILES].some((f) => same(f, parts[1])))) return 'state';
    return 'menitor';
  }
  if (same(first, 'docs')) return 'docs';
  if ([...BUILD_DIRS].some((d) => same(d, first))) return 'build';
  return 'project';
}

/**
 * Writing or deleting here needs the agent to be allowed project writes.
 * @param {Area} area
 */
function needsWrites(area) {
  return area === 'project' || area === 'unknown';
}

/**
 * G-1 and G-4: may the agent write this file?
 * @param {GuardContext} ctx
 * @param {string} file  absolute, or relative to `cwd`
 * @param {string} [cwd]
 * @returns {Decision}
 */
export function decideFileWrite(ctx, file, cwd) {
  if (!ctx.active || !ctx.root) return { allow: true, targets: [], effects: [] };
  const area = classifyPath(ctx.root, cwd ?? ctx.root, file);
  /** @type {Target[]} */
  const targets = [{ path: file, area, kind: 'write' }];
  if (area === 'state') return { allow: false, rule: 'state-file', blocker: ctx.blocker, target: file, targets, effects: [] };
  if (needsWrites(area) && ctx.writes === 'no') {
    return { allow: false, rule: 'project-write', blocker: ctx.blocker, target: file, targets, effects: [] };
  }
  return { allow: true, targets, effects: [] };
}

/**
 * G-2 and G-4: may the agent run this shell command? Best effort, by pattern.
 * @param {GuardContext} ctx
 * @param {string} command
 * @param {{ cwd?: string, dialect?: Dialect }} [options]
 * @returns {Decision}
 */
export function decideCommand(ctx, command, options = {}) {
  if (!ctx.active || !ctx.root) return { allow: true, targets: [], effects: [] };
  const root = ctx.root;
  const effects = analyzeCommand(command, { dialect: options.dialect ?? 'posix', cwd: options.cwd ?? root });
  /** @type {Target[]} */
  const targets = [];
  const labels = [];
  /** @type {Decision | null} */
  let denied = null;
  const blocked = ctx.writes === 'no';

  for (const e of effects) {
    if (e.kind === 'write' || e.kind === 'delete') {
      const area = classifyPath(root, e.cwd ?? null, e.path ?? '.');
      targets.push({ path: e.path ?? '.', area, kind: e.kind });
      if (!denied && area === 'state') {
        denied = { allow: false, rule: 'state-file', blocker: ctx.blocker, target: e.path, via: e.via, targets, effects: labels };
      } else if (!denied && blocked && needsWrites(area)) {
        denied = { allow: false, rule: 'project-write', blocker: ctx.blocker, target: e.path, via: e.via, targets, effects: labels };
      }
    } else if (e.kind === 'state') {
      labels.push(e.via);
      if (!denied) denied = { allow: false, rule: 'state-file', blocker: ctx.blocker, target: '.menitor/', via: e.via, targets, effects: labels };
    } else {
      labels.push(e.via);
      if (denied || !blocked) continue;
      if (e.kind === 'git') {
        const repo = e.cwd ? classifyPath(root, e.cwd, '.') : 'project';
        if (repo !== 'outside') denied = { allow: false, rule: 'git', blocker: ctx.blocker, via: e.via, targets, effects: labels };
      } else if (e.kind === 'package') {
        denied = { allow: false, rule: 'package', blocker: ctx.blocker, via: e.via, targets, effects: labels };
      } else if (e.kind === 'script') {
        denied = { allow: false, rule: 'script-write', blocker: ctx.blocker, via: e.via, targets, effects: labels };
      }
    }
  }
  return denied ?? { allow: true, targets, effects: labels };
}

/**
 * @typedef {{ command: 'skip', confirm: boolean } | { command: 'off' } | { command: 'on' }} LearnerCommand
 * @typedef {object} LearnerCommandResult
 * @property {'inactive' | 'no-task' | 'already-delegated' | 'requested' | 'confirm-first' | 'already-requested' | 'granted' | 'already-granted' | 'mode-on' | 'mode-off' | 'already-on' | 'already-off'} status
 * @property {string | null} task
 */

/**
 * Record a command the learner typed themselves (G-3, G-5). Only adapter hooks that see the
 * learner's own input may call this; the agent never can.
 * @param {string | null} root
 * @param {LearnerCommand} cmd
 * @param {{ now?: Date }} [options]
 * @returns {LearnerCommandResult}
 */
export function applyLearnerCommand(root, cmd, options = {}) {
  const now = options.now ?? new Date();
  if (!root || !fs.existsSync(statePaths(root).dir)) return { status: 'inactive', task: null };
  const paths = statePaths(root);
  let guard;
  try {
    guard = loadGuard(paths);
  } catch {
    // A broken guard file must never lock the learner out: start again from the default.
    guard = defaultGuard();
  }

  if (cmd.command === 'off' || cmd.command === 'on') {
    const mode = cmd.command;
    if (guard.mentorMode === mode) return { status: mode === 'on' ? 'already-on' : 'already-off', task: null };
    guard.mentorMode = mode;
    guard.modeChangedAt = now.toISOString();
    saveGuard(paths, guard);
    appendEvent(paths.log, 'mode', { value: mode }, now);
    return { status: mode === 'on' ? 'mode-on' : 'mode-off', task: null };
  }

  // skip
  let taskId = null;
  let owner = null;
  try {
    const plan = loadPlan(paths);
    const session = loadSession(paths);
    if (plan?.approvedAt && session.currentTask) {
      taskId = session.currentTask;
      owner = findTask(plan, taskId).task.owner;
    }
  } catch {
    taskId = null;
  }
  if (!taskId) return { status: 'no-task', task: null };
  if (owner === 'delegated') return { status: 'already-delegated', task: taskId };
  if (guard.grants[taskId]) return { status: 'already-granted', task: taskId };

  // H-6: one pushback first. A confirm counts only after an earlier request for the same task.
  if (!cmd.confirm || !guard.skipRequests[taskId]) {
    const had = Boolean(guard.skipRequests[taskId]);
    if (!had) {
      guard.skipRequests[taskId] = now.toISOString();
      saveGuard(paths, guard);
      appendEvent(paths.log, 'skip', { task: taskId, stage: 'requested' }, now);
    }
    return { status: cmd.confirm ? 'confirm-first' : had ? 'already-requested' : 'requested', task: taskId };
  }
  guard.grants[taskId] = now.toISOString();
  saveGuard(paths, guard);
  appendEvent(paths.log, 'skip', { task: taskId, stage: 'confirmed' }, now);
  return { status: 'granted', task: taskId };
}

/**
 * @typedef {object} ActivityEntry
 * @property {string} tool
 * @property {string} [command]
 * @property {string} [file]
 * @property {Target[]} [targets]
 * @property {string[]} [effects]
 * @property {string[]} [changed]
 */

/**
 * Append one line to activity.jsonl: what the agent ran and what it touched. Adapter hooks only.
 * @param {GuardContext} ctx
 * @param {ActivityEntry} entry
 * @param {{ now?: Date }} [options]
 */
export function appendActivity(ctx, entry, options = {}) {
  if (!ctx.active || !ctx.paths) return null;
  const line = {
    at: (options.now ?? new Date()).toISOString(),
    tool: entry.tool.slice(0, 64),
    task: ctx.task,
    writes: ctx.writes,
    ...(entry.command !== undefined ? { command: entry.command.slice(0, 2000) } : {}),
    ...(entry.file !== undefined ? { file: entry.file.slice(0, 500) } : {}),
    ...(entry.targets?.length ? { targets: entry.targets.slice(0, 50).map((t) => ({ ...t, path: t.path.slice(0, 500) })) } : {}),
    ...(entry.effects?.length ? { effects: entry.effects.slice(0, 20).map((e) => e.slice(0, 200)) } : {}),
    ...(entry.changed?.length ? { changed: entry.changed.slice(0, 200).map((c) => c.slice(0, 500)) } : {}),
  };
  const errors = validate(SCHEMAS.activity, line);
  if (errors.length) throw new Error(`Invalid activity entry: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
  fs.appendFileSync(ctx.paths.activity, `${JSON.stringify(line)}\n`, 'utf8');
  return line;
}

/**
 * Project files among a list of changed paths, relative to the root.
 * @param {GuardContext} ctx
 * @param {string[]} files
 */
export function projectFiles(ctx, files) {
  if (!ctx.root) return [];
  const root = ctx.root;
  return files.filter((f) => ['project', 'unknown'].includes(classifyPath(root, root, f))).map((f) => toPosix(path.relative(root, path.resolve(root, f)) || f));
}

/**
 * Forward slashes on every platform, for text people and the check read.
 * @param {string} p
 */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}
