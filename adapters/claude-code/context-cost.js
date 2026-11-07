#!/usr/bin/env node
// What each Menitor command adds to the agent's context, measured the same way for all.
//
//   node adapters/claude-code/context-cost.js [--json]
//
// For each command it builds a fresh sample project (examples/sample/create.js), then adds up the
// text the agent receives on a typical run: the skill's body, any hook context the command
// triggers, and the output of the CLI calls the skill makes first. The text loaded into every
// session (the session-start context, the skill descriptions, the wait tool) is counted once, apart.
// Tokens are estimated as characters / 4, rounded up, the same estimate for every row; the
// characters are exact. Run it before and after a change to show what the change saved.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionStart, userPromptSubmit } from './handlers.js';
import { WINDOW_COMMANDS } from './skills.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'core', 'bin', 'menitor.js');
const CREATE = path.join(ROOT, 'examples', 'sample', 'create.js');
const SKILLS = path.join(HERE, 'skills');

/** The command names the go skill passes, so the CLI can name what the learner types. */
const GO_COMMANDS = Object.entries(WINDOW_COMMANDS).flatMap(([k, v]) => ['--command', `${k}=${v}`]);

/** @param {string} text */
export const tokens = (text) => Math.ceil(text.length / 4);

/**
 * A typical run of each command: the sample scenario it starts from, the learner's prompt when a
 * hook reads it (after any prompt typed before it, not counted), the CLI calls its skill makes
 * before the real work begins, and any clean-up after them, not counted.
 * @type {Record<string, { scenario: string, before?: string, prompt?: string, init?: boolean, calls: { args: string[], stdin?: string }[], after?: string[][] }>}
 */
export const RUNS = {
  start: { scenario: 'start', init: true, calls: [{ args: ['status'] }, { args: ['setup', 'show'] }] },
  go: { scenario: 'start', calls: [{ args: ['go', '--no-browser', ...GO_COMMANDS] }], after: [['window', 'stop']] },
  hint: { scenario: 'start', calls: [{ args: ['task', 'hint'] }] },
  stuck: { scenario: 'start', calls: [{ args: ['log', 'stuck', 'task=t1'] }, { args: ['task', 'hint'] }] },
  check: { scenario: 'check', calls: [{ args: ['task', 'brief'] }, { args: ['check', 'run'] }] },
  skip: { scenario: 'start', before: '/menitor:skip', prompt: '/menitor:skip --confirm', calls: [{ args: ['task', 'skip'] }] },
  on: { scenario: 'start', before: '/menitor:off', prompt: '/menitor:on', calls: [] },
  off: { scenario: 'start', prompt: '/menitor:off', calls: [] },
  typealong: { scenario: 'start', prompt: '/menitor:typealong', calls: [{ args: ['task', 'brief'] }] },
  add: {
    scenario: 'start',
    calls: [
      { args: ['plan', 'show'] },
      { args: ['task', 'brief'] },
      {
        args: ['plan', 'add', '-', '--dry-run'],
        stdin: JSON.stringify({ step: 'Show an empty state when there are no recipes', to: 't5' }),
      },
    ],
  },
};

/** @param {string} file The skill as it loads: everything after the frontmatter. */
function skillBody(file) {
  const text = fs.readFileSync(file, 'utf8');
  const end = text.indexOf('\n---', 4);
  return text.slice(end + 4).trim();
}

/** @param {string} file The description, which every session loads for every skill. */
function skillDescription(file) {
  const m = /^description:\s*"?(.*?)"?\s*$/m.exec(fs.readFileSync(file, 'utf8'));
  return m ? m[1] : '';
}

/** @param {string} scenario */
function sampleProject(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menitor-cost-'));
  const root = path.join(dir, 'recipe-box');
  execFileSync(process.execPath, [CREATE, root, '--scenario', scenario, '--plugin', 'none'], { stdio: 'pipe' });
  return { root, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** @param {string} root */
function hookEnv(root) {
  return { ...process.env, CLAUDE_PROJECT_DIR: root, MENITOR_WINDOW_AUTOSTART: '0', MENITOR_NO_BROWSER: '1' };
}

/**
 * Run one CLI call and return what the agent reads: stdout and stderr, as a shell tool shows them.
 * @param {string} root
 * @param {{ args: string[], stdin?: string }} call
 */
function cliOutput(root, call) {
  try {
    return execFileSync(process.execPath, [CLI, '--root', root, ...call.args], { input: call.stdin ?? '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: hookEnv(root) });
  } catch (err) {
    const e = /** @type {{ stdout?: string, stderr?: string }} */ (err);
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

/** @param {any} result A hook's result: the context it adds, if any. */
function hookText(result) {
  return result?.output?.hookSpecificOutput?.additionalContext ?? '';
}

/** What the wait tool adds to every session: the server's instructions and the tool's definition. */
async function mcpText() {
  const child = spawn(process.execPath, [path.join(HERE, 'mcp.js')], { stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  const lines = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.split('\n').filter(Boolean).length >= 2) resolve(out);
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'context-cost', version: '1' } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  const text = /** @type {string} */ (await Promise.race([lines, new Promise((resolve) => setTimeout(() => resolve(out), 5000))]));
  child.kill();
  const [init, list] = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return `${init?.result?.instructions ?? ''}\n${JSON.stringify(list?.result?.tools ?? [])}`;
}

/**
 * @typedef {{ command: string, skill: number, hook: number, cli: number, total: number }} Row
 */

/**
 * Measure every command (or only some), and what every session loads.
 * @param {{ only?: string[] }} [options]
 */
export async function measure(options = {}) {
  /** @type {Row[]} */
  const rows = [];
  for (const [command, run] of Object.entries(RUNS)) {
    if (options.only && !options.only.includes(command)) continue;
    const project = sampleProject(run.scenario);
    try {
      if (run.init) fs.rmSync(path.join(project.root, '.menitor'), { recursive: true, force: true });
      const skill = skillBody(path.join(SKILLS, command, 'SKILL.md'));
      if (run.before) userPromptSubmit({ prompt: run.before, cwd: project.root }, hookEnv(project.root));
      const hook = run.prompt ? hookText(userPromptSubmit({ prompt: run.prompt, cwd: project.root }, hookEnv(project.root))) : '';
      const cli = run.calls.map((call) => cliOutput(project.root, call)).join('');
      for (const args of run.after ?? []) cliOutput(project.root, { args });
      rows.push({ command, skill: tokens(skill), hook: tokens(hook), cli: tokens(cli), total: tokens(skill) + tokens(hook) + tokens(cli) });
    } finally {
      project.cleanup();
    }
  }
  const project = sampleProject('start');
  let session = '';
  try {
    session = hookText(sessionStart({ source: 'startup', cwd: project.root }, hookEnv(project.root)));
  } finally {
    project.cleanup();
  }
  const descriptions = fs
    .readdirSync(SKILLS)
    .map((name) => `${name}: ${skillDescription(path.join(SKILLS, name, 'SKILL.md'))}`)
    .join('\n');
  const always = { session: tokens(session), descriptions: tokens(descriptions), mcp: tokens(await mcpText()) };
  return { rows, always };
}

/** @param {Awaited<ReturnType<typeof measure>>} m */
export function table(m) {
  const lines = ['| Command | Skill | Hook | CLI output | Total |', '| --- | ---: | ---: | ---: | ---: |'];
  for (const r of m.rows) lines.push(`| /menitor:${r.command} | ${r.skill} | ${r.hook} | ${r.cli} | ${r.total} |`);
  const a = m.always;
  lines.push('', '| Every session | Tokens |', '| --- | ---: |');
  lines.push(`| Session-start context | ${a.session} |`, `| Skill descriptions | ${a.descriptions} |`, `| Wait tool and its instructions | ${a.mcp} |`, `| Total | ${a.session + a.descriptions + a.mcp} |`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = await measure();
  process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(m, null, 2)}\n` : `${table(m)}\n`);
}
