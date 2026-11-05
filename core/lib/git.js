// Read-only git helpers.

import { execFileSync } from 'node:child_process';

/**
 * Run git and return trimmed stdout, or null when git fails or is missing.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string | null}
 */
export function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * The commit HEAD points at, or null when the folder is not a repo or has no commits yet.
 * @param {string} cwd
 */
export function headCommit(cwd) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
}

/**
 * The top folder of the git repo that holds `cwd`, or null.
 * @param {string} cwd
 */
export function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}
