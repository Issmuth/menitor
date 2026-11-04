// The deterministic part of a check (C-1, C-2, G-7): everything that doesn't need judgment.
// It runs before any AI review, so the review starts from facts and spends fewer tokens.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { git, headCommit } from './git.js';
import { BUILD_DIRS, classifyPath } from './guard.js';

/** Git's empty tree, the base when a task started before the first commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const DEFAULT_TIMEOUT_SECONDS = 180;
export const MAX_DIFF_CHARS = 40000;
const TAIL_LINES = 30;
const UNTRACKED_MAX_BYTES = 20000;
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'composer.lock', 'uv.lock'];
const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()\r\n]+\))?!?: \S/;
const DELEGATED_TRAILER = /^Menitor-Delegated:\s*true\s*$/im;

/**
 * @typedef {import('./plan.js').Plan} Plan
 * @typedef {import('./plan.js').TaskEntry} TaskEntry
 * @typedef {'pass' | 'fail' | 'timeout' | 'skipped'} RunStatus
 * @typedef {{ name: 'build' | 'lint' | 'test' | 'verify', command: string, status: RunStatus, exitCode: number | null, seconds: number, tail: string, reason?: string }} CommandResult
 * @typedef {{ url: string, raw: string, status: 'pass' | 'fail' | 'needs-url', httpStatus: number | null, expected: string, contains: string | null, error: string | null }} UrlResult
 * @typedef {{ sha: string, subject: string, conventional: boolean, delegatedTrailer: boolean }} CommitInfo
 * @typedef {{ path: string, change: 'M' | 'A' | 'D' | 'R' | 'T' | '?', added: number | null, deleted: number | null }} FileChange
 * @typedef {{ severity: 'blocking' | 'warning', area: 'checks' | 'deploy' | 'commits' | 'branch' | 'uncommitted' | 'agent' | 'repo', text: string }} Problem
 * @typedef {object} CheckReport
 * @property {{ id: string, goal: string, owner: 'learner' | 'delegated', skipped: boolean }} task
 * @property {boolean} repo
 * @property {string | null} startCommit
 * @property {string | null} head
 * @property {CommandResult[]} commands
 * @property {UrlResult[]} urls
 * @property {CommitInfo[]} commits
 * @property {{ current: string | null, expected: string | null }} branch
 * @property {string[]} uncommitted
 * @property {FileChange[]} files
 * @property {string} diff
 * @property {boolean} diffTruncated
 * @property {{ ticked: string[], unticked: string[] }} ticks
 * @property {{ at: string, tool: string, what: string, writes: string }[]} agent
 * @property {Problem[]} problems
 * @property {boolean} ok           no blocking problems
 * @property {boolean} ranCommands  false with --no-commands
 */

/**
 * Run git and return raw stdout (not trimmed), or null on failure.
 * @param {string} cwd
 * @param {string[]} args
 */
function gitRaw(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 50 * 1024 * 1024 });
  } catch {
    return null;
  }
}

const SCOPE = ['--', '.', ':(exclude).menitor'];
const NO_LOCKFILES = LOCKFILES.map((f) => `:(exclude,glob)**/${f}`);

/** @param {string} text */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * The last lines of a command's output, without colors, each cut to a sane width.
 * @param {string} text
 */
function tail(text) {
  // Drop blank runs and Node's own stack frames: they cost tokens and say nothing.
  const lines = stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/\(?node:internal\//.test(l))
    .filter((l, i, all) => l.trim() !== '' || (i > 0 && all[i - 1].trim() !== ''));
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines
    .slice(-TAIL_LINES)
    .map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l))
    .join('\n');
}

/**
 * Is the file binary? A NUL byte in the first 8000 bytes says yes.
 * @param {Buffer} buf
 */
function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/**
 * What changed from the base to the working tree, outside .menitor/ (C-1).
 * @param {string} root
 * @param {string | null} base
 */
export function collectChanges(root, base) {
  /** @type {FileChange[]} */
  const files = [];
  let diff = '';
  if (base) {
    const status = gitRaw(root, ['diff', '--name-status', '--no-renames', base, ...SCOPE]) ?? '';
    const numstat = gitRaw(root, ['diff', '--numstat', '--no-renames', base, ...SCOPE]) ?? '';
    /** @type {Map<string, { added: number | null, deleted: number | null }>} */
    const counts = new Map();
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [a, d, ...p] = line.split('\t');
      counts.set(p.join('\t'), { added: a === '-' ? null : Number(a), deleted: d === '-' ? null : Number(d) });
    }
    for (const line of status.split('\n').filter(Boolean)) {
      const [code, ...p] = line.split('\t');
      const file = p.join('\t');
      const n = counts.get(file) ?? { added: null, deleted: null };
      files.push({ path: file, change: /** @type {FileChange['change']} */ (code[0]), added: n.added, deleted: n.deleted });
    }
    diff = gitRaw(root, ['diff', '--no-renames', '--no-color', base, '--', '.', ':(exclude).menitor', ...NO_LOCKFILES]) ?? '';
  }

  const untracked = (gitRaw(root, ['ls-files', '--others', '--exclude-standard', ...SCOPE]) ?? '').split('\n').filter(Boolean);
  for (const file of untracked) {
    let added = null;
    let body = '';
    try {
      const buf = fs.readFileSync(path.join(root, file));
      if (!isBinary(buf)) {
        const text = buf.subarray(0, UNTRACKED_MAX_BYTES).toString('utf8');
        added = buf.toString('utf8').split('\n').length;
        if (!LOCKFILES.includes(path.basename(file))) {
          body = `diff --git a/${file} b/${file}\nnew file (untracked)\n--- /dev/null\n+++ b/${file}\n${text.split('\n').map((l) => `+${l}`).join('\n')}${buf.length > UNTRACKED_MAX_BYTES ? '\n[cut]' : ''}\n`;
        }
      }
    } catch {
      // A file that vanished or can't be read is listed without content.
    }
    files.push({ path: file, change: '?', added, deleted: 0 });
    diff += body;
  }

  const diffTruncated = diff.length > MAX_DIFF_CHARS;
  return { files, diff: diffTruncated ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff cut at ${MAX_DIFF_CHARS} characters]` : diff, diffTruncated };
}

/**
 * Commits from the base to HEAD, oldest first, without merges.
 * @param {string} root
 * @param {string | null} startCommit
 * @param {string | null} head
 * @returns {CommitInfo[]}
 */
export function collectCommits(root, startCommit, head) {
  if (!head) return [];
  const range = startCommit ? `${startCommit}..HEAD` : 'HEAD';
  const out = gitRaw(root, ['log', '--no-merges', '--reverse', '--format=%H%x1f%s%x1f%B%x1e', range]) ?? '';
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, body = ''] = r.split('\x1f');
      return { sha, subject, conventional: CONVENTIONAL.test(subject), delegatedTrailer: DELEGATED_TRAILER.test(body) };
    });
}

/**
 * The script a package-manager command runs, such as "build" for "npm run build".
 * @param {string} command
 * @returns {string | null}
 */
export function npmScriptOf(command) {
  const m = /^\s*(npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([^\s-][^\s]*)/.exec(command);
  if (!m) return null;
  const [, pm, word] = m;
  if (word === 't' || word === 'tst') return 'test';
  const builtins = new Set(['install', 'i', 'ci', 'add', 'remove', 'exec', 'x', 'dlx', 'create', 'init', 'publish', 'pack', 'audit', 'outdated', 'update', 'up', 'why', 'ls', 'list', 'link']);
  if (builtins.has(word)) return null;
  if (pm === 'npm' && !/\brun(-script)?\b/.test(command) && !['test', 'start', 'stop', 'restart'].includes(word)) return null;
  return word;
}

/**
 * Why a project-wide check can't run yet, such as a missing package.json or script.
 * Task verify steps never skip: the plan asked for them explicitly.
 * @param {string} root
 * @param {string} command
 */
function skipReason(root, command) {
  const script = npmScriptOf(command);
  if (!script) return null;
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) return 'no package.json yet';
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!pkg.scripts || typeof pkg.scripts[script] !== 'string') return `no "${script}" script in package.json yet`;
  } catch {
    return null; // Let the command itself report a broken package.json.
  }
  return null;
}

// Runs a command in a child Node process that owns it, so a timeout can kill the whole process
// tree (a shell plus whatever it started), not just the shell. Output keeps its real order.
const RUN_SCRIPT = `
import { spawn, spawnSync } from 'node:child_process';
const [command, ms] = process.argv.slice(1);
const windows = process.platform === 'win32';
const env = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' };
// A test runner around Menitor must not leak into the learner's own test runs.
delete env.NODE_TEST_CONTEXT;
const child = spawn(command, {
  shell: true,
  detached: !windows,
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
  windowsHide: true,
});
let out = '';
const take = (chunk) => {
  out += chunk;
  if (out.length > 4000000) out = out.slice(-2000000);
};
child.stdout.on('data', take);
child.stderr.on('data', take);
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}, Number(ms));
child.on('error', (err) => {
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({ code: null, timedOut: false, out: String(err.message) }));
});
child.on('close', (code) => {
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({ code, timedOut, out }));
});
`;

/**
 * Run one command through the shell, without color, with a timeout.
 * @param {string} root
 * @param {CommandResult['name']} name
 * @param {string} command
 * @param {number} timeoutSeconds
 * @returns {CommandResult}
 */
function runCommand(root, name, command, timeoutSeconds) {
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', RUN_SCRIPT, command, String(timeoutSeconds * 1000)], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutSeconds * 1000 + 15000,
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  /** @type {{ code: number | null, timedOut: boolean, out: string }} */
  let result;
  try {
    result = JSON.parse(r.stdout);
  } catch {
    result = { code: null, timedOut: true, out: r.stderr ?? '' };
  }
  return {
    name,
    command,
    status: result.timedOut ? 'timeout' : result.code === 0 ? 'pass' : 'fail',
    exitCode: result.code,
    seconds,
    tail: result.timedOut ? `${tail(result.out)}\n[stopped after ${timeoutSeconds} seconds]`.trim() : tail(result.out),
  };
}

const FETCH_SCRIPT = `
const [url, ms, init] = process.argv.slice(1);
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), Number(ms));
try {
  const res = await fetch(url, { ...JSON.parse(init || '{}'), signal: ctrl.signal, redirect: 'follow' });
  const body = await res.text();
  process.stdout.write(JSON.stringify({ status: res.status, body: body.slice(0, 500000) }));
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err.name === 'AbortError' ? 'timed out' : String(err.cause?.code ?? err.message) }));
} finally {
  clearTimeout(timer);
}
`;

/**
 * Fetch a URL in a child process, so the CLI itself stays synchronous.
 * @param {string} url
 * @param {number} [timeoutMs]
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [init]
 * @returns {{ status?: number, body?: string, error?: string }}
 */
export function fetchSync(url, timeoutMs = 15000, init = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', FETCH_SCRIPT, url, String(timeoutMs), JSON.stringify(init)], {
    encoding: 'utf8',
    timeout: timeoutMs + 5000,
    maxBuffer: 10 * 1024 * 1024,
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { error: r.error ? r.error.message : 'no response' };
  }
}

/**
 * @param {{ url: string, status?: number, contains?: string }} step
 * @param {string | null} deployUrl
 * @returns {UrlResult}
 */
function checkUrl(step, deployUrl) {
  const expected = step.status ? String(step.status) : '2xx or 3xx';
  const base = { raw: step.url, expected, contains: step.contains ?? null };
  if (step.url.startsWith('$deployUrl')) {
    if (!deployUrl) return { ...base, url: step.url, status: 'needs-url', httpStatus: null, error: null };
  }
  const url = step.url.replace(/^\$deployUrl/, (deployUrl ?? '').replace(/\/+$/, ''));
  const res = fetchSync(url);
  if (res.error || res.status === undefined) return { ...base, url, status: 'fail', httpStatus: null, error: res.error ?? 'no response' };
  const statusOk = step.status ? res.status === step.status : res.status >= 200 && res.status < 400;
  const containsOk = !step.contains || (res.body ?? '').includes(step.contains);
  return {
    ...base,
    url,
    status: statusOk && containsOk ? 'pass' : 'fail',
    httpStatus: res.status,
    error: !statusOk ? null : containsOk ? null : `the page doesn't contain "${step.contains}"`,
  };
}

/**
 * Agent commands and writes that touched project files during this task.
 * @param {string} root
 * @param {string} activityFile
 * @param {string} taskId
 * @param {string | null} since
 */
function agentTouches(root, activityFile, taskId, since) {
  if (!fs.existsSync(activityFile)) return [];
  const out = [];
  for (const line of fs.readFileSync(activityFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.task !== taskId || (since && e.at < since)) continue;
    const targets = (e.targets ?? []).filter((/** @type {{ area: string }} */ t) => t.area === 'project' || t.area === 'unknown').map((/** @type {{ path: string }} */ t) => t.path);
    const changed = (e.changed ?? []).filter((/** @type {string} */ f) => ['project', 'unknown'].includes(classifyPath(root, root, f)));
    const touched = [...new Set([...targets, ...changed])];
    if (touched.length) out.push({ at: e.at, tool: e.tool, what: touched.join(', '), writes: e.writes });
  }
  return out;
}

/**
 * Run the deterministic check for a task.
 * @param {object} input
 * @param {string} input.root
 * @param {Plan} input.plan
 * @param {TaskEntry} input.entry
 * @param {string | null} input.startCommit
 * @param {string | null} input.startedAt
 * @param {Record<string, string>} input.ticks
 * @param {string} input.activityFile
 * @param {{ commands?: boolean, timeoutSeconds?: number }} [options]
 * @returns {CheckReport}
 */
export function runCheck(input, options = {}) {
  const { root, plan, entry, startCommit, startedAt } = input;
  const { task, milestone } = entry;
  const runCommands = options.commands !== false;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  /** @type {Problem[]} */
  const problems = [];

  const repo = git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  const head = repo ? headCommit(root) : null;
  const base = startCommit ?? (head ? EMPTY_TREE : null);

  // C-2: project checks first, then the task's own verify steps.
  /** @type {CommandResult[]} */
  const commands = [];
  /** @type {UrlResult[]} */
  const urls = [];
  if (runCommands) {
    for (const name of /** @type {const} */ (['build', 'lint', 'test'])) {
      const command = plan.checks?.[name];
      if (!command) continue;
      const reason = skipReason(root, command);
      if (reason) commands.push({ name, command, status: 'skipped', exitCode: null, seconds: 0, tail: '', reason });
      else commands.push(runCommand(root, name, command, timeoutSeconds));
    }
    for (const step of task.verify ?? []) {
      if ('run' in step) commands.push(runCommand(root, 'verify', step.run, timeoutSeconds));
      else urls.push(checkUrl(step, plan.project.deployUrl ?? null));
    }
  }
  for (const c of commands) {
    if (c.status === 'fail') problems.push({ severity: 'blocking', area: 'checks', text: `${c.name} failed: ${c.command} exited with ${c.exitCode}` });
    if (c.status === 'timeout') problems.push({ severity: 'blocking', area: 'checks', text: `${c.name} timed out after ${timeoutSeconds} seconds: ${c.command}` });
  }
  for (const u of urls) {
    if (u.status === 'needs-url') problems.push({ severity: 'blocking', area: 'deploy', text: 'No deployed URL is recorded yet. Ask the learner for it, then record it with "plan deploy-url <url>".' });
    if (u.status === 'fail') problems.push({ severity: 'blocking', area: 'deploy', text: `${u.url} ${u.httpStatus === null ? `failed: ${u.error}` : `returned ${u.httpStatus}${u.error ? `, and ${u.error}` : ''}`} (expected ${u.expected})` });
  }

  // G-6, G-7, H-8: commits, branch and honest trailers.
  const commits = repo ? collectCommits(root, startCommit, head) : [];
  const expectedBranch = task.branch ?? milestone.branch ?? null;
  const currentBranch = repo ? git(root, ['symbolic-ref', '--short', '-q', 'HEAD']) : null;
  /** @type {string[]} */
  let uncommitted = [];
  if (!repo) {
    problems.push({ severity: 'blocking', area: 'repo', text: 'This folder is not a git repo. The learner creates it with "git init".' });
  } else {
    if (!commits.length) problems.push({ severity: 'blocking', area: 'commits', text: 'No commit since the task started. The task ends with a commit.' });
    else if (!commits.some((c) => c.conventional)) problems.push({ severity: 'blocking', area: 'commits', text: 'No commit message follows Conventional Commits, such as "feat(auth): persist new users".' });
    for (const c of commits) {
      if (commits.some((x) => x.conventional) && !c.conventional) problems.push({ severity: 'warning', area: 'commits', text: `"${c.subject}" (${c.sha.slice(0, 7)}) doesn't follow Conventional Commits` });
      if (task.owner === 'learner' && c.delegatedTrailer) problems.push({ severity: 'blocking', area: 'commits', text: `${c.sha.slice(0, 7)} carries "Menitor-Delegated: true", but this is the learner's task` });
      if (task.owner === 'delegated' && !c.delegatedTrailer) problems.push({ severity: 'blocking', area: 'commits', text: `${c.sha.slice(0, 7)} is delegated work without the "Menitor-Delegated: true" trailer` });
    }
    if (expectedBranch && currentBranch !== expectedBranch) {
      problems.push({ severity: 'warning', area: 'branch', text: `On ${currentBranch ?? 'a detached HEAD'}, but the task's branch is ${expectedBranch}` });
    }
    uncommitted = (gitRaw(root, ['status', '--porcelain=v1', '--untracked-files=all', ...SCOPE]) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).replace(/^"(.*)"$/, '$1'))
      .filter((p) => !BUILD_DIRS.has(p.split('/')[0]));
    if (uncommitted.length) {
      const list = uncommitted.slice(0, 8).join(', ') + (uncommitted.length > 8 ? `, and ${uncommitted.length - 8} more` : '');
      problems.push({ severity: 'blocking', area: 'uncommitted', text: `${uncommitted.length} uncommitted change${uncommitted.length === 1 ? '' : 's'}: ${list}. Commit the work, or add build output to .gitignore.` });
    }
  }

  const { files, diff, diffTruncated } = repo && base ? collectChanges(root, base) : { files: [], diff: '', diffTruncated: false };

  const ids = task.checklist.map((i) => i.id);
  const ticks = { ticked: ids.filter((id) => input.ticks[id]), unticked: ids.filter((id) => !input.ticks[id]) };

  const agent = task.owner === 'learner' ? agentTouches(root, input.activityFile, task.id, startedAt) : [];
  for (const a of agent) {
    problems.push({ severity: 'warning', area: 'agent', text: `The agent touched ${a.what} (${a.tool}, writes: ${a.writes}). Tell the learner, and don't count it as their work.` });
  }

  return {
    task: { id: task.id, goal: task.goal, owner: task.owner, skipped: task.skipped ?? false },
    repo,
    startCommit,
    head,
    commands,
    urls,
    commits,
    branch: { current: currentBranch, expected: expectedBranch },
    uncommitted,
    files,
    diff,
    diffTruncated,
    ticks,
    agent,
    problems,
    ok: !problems.some((p) => p.severity === 'blocking'),
    ranCommands: runCommands,
  };
}

/**
 * Render a report for the agent to read: facts first, the diff last.
 * @param {CheckReport} r
 * @param {{ diff?: boolean }} [options]
 */
export function renderCheck(r, options = {}) {
  const short = (/** @type {string | null} */ sha) => (sha ? sha.slice(0, 7) : 'none');
  const lines = [`Check ${r.task.id} · ${r.task.goal}${r.task.owner === 'delegated' ? ' · delegated' : ''}`];
  lines.push(`Start ${short(r.startCommit)} → HEAD ${short(r.head)} · ${r.commits.length} commit${r.commits.length === 1 ? '' : 's'} · ${r.uncommitted.length} uncommitted`);

  lines.push('', 'Checks');
  if (!r.ranCommands) lines.push('  not run (--no-commands)');
  else if (!r.commands.length && !r.urls.length) lines.push('  none set for this project or task');
  const mark = { pass: '✓', fail: '✗', timeout: '✗', skipped: '-' };
  for (const c of r.commands) {
    const detail = c.status === 'skipped' ? `skipped: ${c.reason}` : c.status === 'pass' ? `(${c.seconds}s)` : c.status === 'timeout' ? 'timed out' : `exit ${c.exitCode} (${c.seconds}s)`;
    lines.push(`  ${mark[c.status]} ${c.name.padEnd(6)} ${c.command}  ${detail}`);
    if (c.status === 'fail' || c.status === 'timeout') lines.push(...c.tail.split('\n').map((l) => `      ${l}`));
  }
  for (const u of r.urls) {
    const detail = u.status === 'needs-url' ? 'no deployed URL recorded' : u.httpStatus === null ? `failed: ${u.error}` : `${u.httpStatus}${u.error ? `; ${u.error}` : ''}`;
    lines.push(`  ${u.status === 'pass' ? '✓' : '✗'} url    GET ${u.url}  ${detail}`);
  }

  lines.push('', 'Commits');
  if (!r.commits.length) lines.push('  none since the task started');
  for (const c of r.commits) lines.push(`  ${c.conventional ? '✓' : '✗'} ${c.subject} (${short(c.sha)})${c.delegatedTrailer ? ' [Menitor-Delegated]' : ''}`);
  if (r.branch.expected) lines.push(`  ${r.branch.current === r.branch.expected ? '✓' : '✗'} branch ${r.branch.current ?? 'detached'} (task: ${r.branch.expected})`);

  lines.push('', `Ticks ${r.ticks.ticked.length}/${r.ticks.ticked.length + r.ticks.unticked.length}${r.ticks.unticked.length ? ` · unticked: ${r.ticks.unticked.join(', ')}` : ''}`);
  if (r.task.owner === 'learner') lines.push(r.agent.length ? `Agent touched: ${r.agent.map((a) => a.what).join('; ')}` : 'Agent touched no project files on this task');

  lines.push('', `Changed files (${r.files.length})`);
  for (const f of r.files.slice(0, 60)) {
    const n = f.added === null ? 'binary' : `+${f.added} -${f.deleted ?? 0}`;
    lines.push(`  ${f.change} ${f.path}  ${n}`);
  }
  if (r.files.length > 60) lines.push(`  …and ${r.files.length - 60} more`);

  lines.push('');
  const blocking = r.problems.filter((p) => p.severity === 'blocking');
  const warnings = r.problems.filter((p) => p.severity === 'warning');
  for (const p of blocking) lines.push(`MUST FIX  ${p.text}`);
  for (const p of warnings) lines.push(`NOTE      ${p.text}`);
  lines.push(
    r.ok
      ? 'Result: the deterministic checks pass. Now review the diff against the checklist and done-when criteria.'
      : `Result: ${blocking.length} deterministic problem${blocking.length === 1 ? '' : 's'}. These are must-fix; the task can't pass until a check run is clean.`,
  );

  if (options.diff !== false && r.diff) lines.push('', 'Diff since the task started:', r.diff.trimEnd());
  return lines.join('\n');
}
