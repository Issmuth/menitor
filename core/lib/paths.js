// Where a project's Menitor state lives.

import fs from 'node:fs';
import path from 'node:path';
import { MenitorError } from './errors.js';

export const STATE_DIR = '.menitor';

/**
 * @typedef {object} StatePaths
 * @property {string} root     the project root
 * @property {string} dir      .menitor/
 * @property {string} plan     plan.json, written by the CLI
 * @property {string} session  session.json, written by the CLI
 * @property {string} progress progress.json, written by the window
 * @property {string} guard    guard.json, written by adapter hooks
 * @property {string} learner  learner.md, written by the CLI
 * @property {string} log      log.md, appended by the CLI and adapter hooks
 * @property {string} activity activity.jsonl, appended by adapter hooks
 * @property {string} window   window.json, written by the window server while it runs
 * @property {string} inbox    inbox.jsonl, button presses appended by the window server
 * @property {string} listener listener.json, a heartbeat from the session that listens for them
 * @property {string} gitignore .menitor/.gitignore
 */

/**
 * @param {string} root
 * @returns {StatePaths}
 */
export function statePaths(root) {
  const dir = path.join(root, STATE_DIR);
  return {
    root,
    dir,
    plan: path.join(dir, 'plan.json'),
    session: path.join(dir, 'session.json'),
    progress: path.join(dir, 'progress.json'),
    guard: path.join(dir, 'guard.json'),
    learner: path.join(dir, 'learner.md'),
    log: path.join(dir, 'log.md'),
    activity: path.join(dir, 'activity.jsonl'),
    window: path.join(dir, 'window.json'),
    inbox: path.join(dir, 'inbox.jsonl'),
    listener: path.join(dir, 'listener.json'),
    gitignore: path.join(dir, '.gitignore'),
  };
}

/**
 * Find the nearest folder at or above `start` that holds a .menitor/ folder.
 * @param {string} start
 * @returns {string | null}
 */
export function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    try {
      if (fs.statSync(path.join(dir, STATE_DIR)).isDirectory()) return dir;
    } catch {
      // Keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the project root from an explicit option, MENITOR_ROOT, or the current folder.
 * @param {{ root?: string, cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string}
 */
export function requireRoot(options = {}) {
  const env = options.env ?? process.env;
  const explicit = options.root ?? env.MENITOR_ROOT;
  if (explicit) {
    const root = path.resolve(explicit);
    if (!fs.existsSync(path.join(root, STATE_DIR))) {
      throw new MenitorError(`No ${STATE_DIR}/ folder in ${root}. Run "menitor init" there first.`);
    }
    return root;
  }
  const found = findRoot(options.cwd ?? process.cwd());
  if (!found) throw new MenitorError(`No ${STATE_DIR}/ folder here or above. Run "menitor init" in the project root first.`);
  return found;
}
