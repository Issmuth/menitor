#!/usr/bin/env node
// Create the Menitor sample project, "Recipe box", with an approved plan, ready to test.
//
//   node examples/sample/create.js <folder> [--scenario start|check|delegated]
//
// Scenarios:
//   start      Task 1 is current and nothing is done. Try the guard, hints, the window and skip.
//   check      Task 1 is built and committed on its branch. Try /menitor:check end to end.
//   delegated  Task 1 has passed; task 2 belongs to Menitor. Try the agent doing delegated work.
//
// Everything goes through the real menitor CLI and git, the way a real setup would.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MENITOR_ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(MENITOR_ROOT, 'core', 'bin', 'menitor.js');
const SCENARIOS = ['start', 'check', 'delegated'];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { scenario: { type: 'string', default: 'start' }, help: { type: 'boolean', short: 'h' } },
});

if (values.help || !positionals[0]) {
  process.stdout.write(`Usage: node examples/sample/create.js <folder> [--scenario ${SCENARIOS.join('|')}]\n`);
  process.exit(values.help ? 0 : 1);
}
const scenario = values.scenario ?? 'start';
if (!SCENARIOS.includes(scenario)) {
  process.stderr.write(`Unknown scenario "${scenario}". Pick one of: ${SCENARIOS.join(', ')}\n`);
  process.exit(1);
}

const root = path.resolve(positionals[0]);
if (fs.existsSync(root) && fs.readdirSync(root).length) {
  process.stderr.write(`${root} already exists and isn't empty. Pick a new folder.\n`);
  process.exit(1);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ input?: string, env?: NodeJS.ProcessEnv }} [options]
 */
function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', input: options.input, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Commits made by the setup script, and by the pretend learner in the check scenario. */
const SETUP = ['-c', 'user.name=Menitor Sample', '-c', 'user.email=sample@menitor.invalid'];
const LEARNER = ['-c', 'user.name=Sample Learner', '-c', 'user.email=learner@menitor.invalid'];

/**
 * @param {string[]} who
 * @param {string} message
 */
function commit(who, message) {
  run('git', ['add', '-A']);
  run('git', [...who, 'commit', '-q', '-m', message]);
}

/** @param {string[]} args @param {string} [input] */
const menitor = (args, input) => run(process.execPath, [CLI, ...args], { input });

// 1. The starter project, in its own git repo.
fs.mkdirSync(root, { recursive: true });
fs.cpSync(path.join(HERE, 'template'), root, { recursive: true });
run('git', ['init', '-q']);
run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main']);

// 2. Setup, as /menitor:start would leave it: a calibrated learner, docs, an approved plan, hints.
menitor(['init']);
menitor(['learner', 'set', 'level', 'standard']);
menitor(['learner', 'set', 'focusAreas', 'backend,frontend,deployment']);
menitor(['learner', 'add', 'strengths', 'Reads error messages before asking for help']);
menitor(['learner', 'add', 'mistakes', 'Forgets to set the Content-Type header']);
menitor(['learner', 'note', 'Sample project created by examples/sample/create.js.']);
menitor(['plan', 'import', '-'], fs.readFileSync(path.join(HERE, 'plan.json'), 'utf8'));
menitor(['hints', 'import', '-'], fs.readFileSync(path.join(HERE, 'hints.json'), 'utf8'));
commit(SETUP, 'chore: set up Recipe box with Menitor');
menitor(['plan', 'approve']);

// 3. The scenario.
if (scenario === 'check' || scenario === 'delegated') {
  // The learner's own work for task 1: a branch, the home page, ticks and a commit.
  run('git', ['checkout', '-q', '-b', 'feat/skeleton']);
  fs.copyFileSync(path.join(HERE, 'solutions', 't1-app.js'), path.join(root, 'src', 'app.js'));
  commit(LEARNER, 'feat(web): add home page');
  const { statePaths } = await import('../../core/lib/paths.js');
  const { loadProgress, saveProgress } = await import('../../core/lib/state.js');
  const paths = statePaths(root);
  const progress = loadProgress(paths);
  const at = new Date().toISOString();
  for (const id of ['t1.c1', 't1.c2', 't1.c3', 't1.c4', 't1.c5']) progress.ticks[id] = at;
  // Ticks normally come from the task window; this setup script stands in for it.
  saveProgress(paths, progress);
}
if (scenario === 'delegated') {
  menitor(['check', 'run', '--no-diff']);
  menitor(['log', 'explain', 'task=t1', 'outcome=good', 'try=1', 'note=Sample setup: explained the status code and the Content-Type header.']);
  menitor(['log', 'check', 'task=t1', 'result=pass', 'mustFix=0', 'nice=0']);
  menitor(['task', 'pass']);
}

const status = menitor(['status']);
const next = {
  start: [
    'Ask Claude to "write the home page for me". The guard should refuse and offer to teach instead.',
    'Run /menitor:hint for the first rung, and /menitor:go to open the window.',
    'Build task 1 yourself in src/app.js, commit it, then press Check my work.',
  ],
  check: [
    'Run /menitor:go, then press Check my work in the window, or type /menitor:check.',
    'Answer the explain-back questions in your own words. Task 1 passes, and task 2 starts.',
  ],
  delegated: [
    'Run /menitor:go. Task 2 is delegated, so Claude builds the health check itself,',
    'commits it with the trailer "Menitor-Delegated: true", and passes it with a short note.',
  ],
}[scenario];

process.stdout.write(`Created the Menitor sample project (scenario: ${scenario}) in ${root}

${status.trim()}

Open it in Claude Code with this plugin loaded:

  cd "${root}"
  claude --plugin-dir "${MENITOR_ROOT}"

Then:
${next.map((l) => `  - ${l}`).join('\n')}

The full test script is in examples/sample/README.md.
`);
