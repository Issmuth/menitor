// Text the Claude Code adapter shows the agent. Command names live here, not in core/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_NAMES, renderInstructions } from './skills.js';

export const COMMANDS = COMMAND_NAMES;

export const CLI_PATH = fileURLToPath(new URL('../../core/bin/menitor.js', import.meta.url));
export const CLI = `node "${CLI_PATH}"`;

/**
 * The agent-neutral mentor rules with this adapter's command names filled in.
 */
export function mentorRules() {
  const text = fs.readFileSync(new URL('../../core/instructions/mentor-rules.md', import.meta.url), 'utf8');
  return renderInstructions(text, {
    cli: CLI,
    templates: fileURLToPath(new URL('../../core/templates/docs', import.meta.url)),
    args: '',
  }).trim();
}

/**
 * @typedef {import('../../core/lib/guard.js').Decision} Decision
 * @typedef {import('../../core/lib/guard.js').GuardContext} GuardContext
 */

/**
 * Why a write or command was denied, and what to do instead.
 * @param {Extract<Decision, { allow: false }>} d
 * @param {GuardContext} ctx
 */
export function denyMessage(d, ctx) {
  const what = d.target ? displayPath(ctx.root, d.target) : d.via ?? 'that';
  if (d.rule === 'state-file') {
    return `Menitor: ${what} is Menitor state, so only its own writer may change it. Use the state CLI instead: ${CLI} help`;
  }

  const task = ctx.task ? `task ${ctx.task}` : 'this task';
  /** @type {Record<string, string>} */
  const blockers = {
    setup: 'Setup is still running, so you can write only docs/ and .menitor/. Project code comes later, one task at a time.',
    'learner-task': `${capitalize(task)} belongs to the learner, so they write the code themselves.`,
    'plan-done': `Every task in the plan is done, and mentor mode is still on. The learner can type ${COMMANDS.off} if they want you to write code.`,
    'state-error': `Menitor's state has a problem, so project writes are blocked until it's fixed: ${ctx.error ?? 'unknown error'}. Run ${CLI} validate to see it.`,
  };
  const why = blockers[ctx.blocker ?? 'learner-task'] ?? blockers['learner-task'];
  const teach = ctx.blocker === 'learner-task' ? ` Teach instead: ask what they tried, explain the idea, or offer the next hint (${COMMANDS.hint}). Only the learner can hand the task over, by typing ${COMMANDS.skip}.` : '';

  switch (d.rule) {
    case 'project-write':
      return `Menitor: you can't write ${what}${d.via ? ` (${d.via})` : ''}. ${why}${teach}`;
    case 'git':
      return `Menitor: "${d.via}" changes the repo. ${why} Git is part of their work: tell them the command and why, and let them run it.`;
    case 'package':
      return `Menitor: "${d.via}" adds dependencies or generates project files. ${why} Tell them the command and why, and let them run it.`;
    case 'script-write':
      return `Menitor: that command writes files from an inline script (${d.via}). ${why}${teach}`;
    default:
      return `Menitor: that is not allowed right now. ${why}`;
  }
}

/**
 * Show a path inside the project relative to its root.
 * @param {string | null} root
 * @param {string} p
 */
function displayPath(root, p) {
  if (!root || !path.isAbsolute(p)) return p;
  const rel = path.relative(root, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : p;
}

/** @param {string} s */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The fixed sentence Claude receives for each window event, from the monitor or the wait tool.
 * Nothing the page sends is ever passed through as text (W-7).
 * @param {string} type
 * @param {string} task
 */
export function windowEventText(type, task) {
  /** @type {Record<string, string>} */
  const say = {
    check: `Menitor window: the learner pressed "Check my work" on task ${task}. Run the menitor:check skill now, exactly as if they had typed /menitor:check.`,
    hint: `Menitor window: the learner pressed "Hint" on task ${task}. Run the menitor:hint skill now, exactly as if they had typed /menitor:hint.`,
    stuck: `Menitor window: the learner pressed "I'm stuck" on task ${task}. Run the menitor:stuck skill now, exactly as if they had typed /menitor:stuck.`,
    go: `Menitor window: the learner pressed "Start it" on task ${task}, which is yours. Run the menitor:go skill now, exactly as if they had typed /menitor:go.`,
    answer: `Menitor window: the learner answered your explain-back question on task ${task} in the window. Run the menitor:check skill now to read the answer with "question show" and judge it.`,
  };
  return say[type] ?? `Menitor window: an event of an unknown kind arrived on task ${task}. Run ${COMMANDS.go} to see where things stand.`;
}

export const LEARNER_ONLY = `Menitor: only the learner can run ${COMMANDS.skip}, ${COMMANDS.off}, ${COMMANDS.on} and ${COMMANDS.typealong}, by typing them. If they want to, ask them to type it.`;

/**
 * Context for the agent after the learner typed a Menitor command.
 * @param {import('../../core/lib/guard.js').LearnerCommandResult} r
 */
export function learnerCommandContext(r) {
  const t = r.task;
  switch (r.status) {
    case 'inactive':
      return `Menitor isn't set up in this project yet. The learner can start with ${COMMANDS.start}.`;
    case 'no-task':
      return 'Menitor: there is no current task to skip. The plan is not approved yet, or every task is done.';
    case 'already-delegated':
      return `Menitor: ${t} is already delegated, so it's yours to do. Do it, commit with the trailer "Menitor-Delegated: true", then pass it with ${CLI} task pass --note "<two lines>".`;
    case 'requested':
    case 'already-requested':
    case 'confirm-first':
      return [
        `Menitor: the learner asked to skip ${t}, which is theirs to write. This is the one pushback (recorded).`,
        'Name, in two or three plain sentences, what they would miss by skipping it. Be kind and brief.',
        `If they still want to skip, they type ${COMMANDS.confirm}. Don't do any of the task until they do.`,
        r.status === 'confirm-first' ? 'They typed --confirm before hearing the pushback, so it counts as the request.' : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'granted':
    case 'already-granted':
      return [
        `Menitor: the learner confirmed the skip for ${t} (recorded). You may now write project files for this task only.`,
        `First run ${CLI} task skip. Then do the task and commit with the trailer "Menitor-Delegated: true".`,
        `Then run ${CLI} task pass --note "<what you did, in two lines>".`,
      ].join(' ');
    case 'mode-off':
      return `Menitor: the learner turned mentor mode off (recorded). You may write project files. Menitor state still changes only through ${CLI}. They can type ${COMMANDS.on} to turn it back on.`;
    case 'already-off':
      return `Menitor: mentor mode is already off. The learner can type ${COMMANDS.on} to turn it back on.`;
    case 'mode-on':
      return `Menitor: the learner turned mentor mode back on (recorded). Project code on learner tasks is theirs to write again.`;
    case 'already-on':
      return 'Menitor: mentor mode is already on.';
    case 'typealong-on':
    case 'already-typealong-on':
      return [
        `Menitor: the learner turned type-along on${r.status === 'typealong-on' ? ' (recorded)' : ''}. The window now shows each step's instructions and full code, and they type it themselves.`,
        `Run ${CLI} task brief. If it lists steps with no code yet, write the code for every learner task in the current milestone and store it with ${CLI} steps import -.`,
        'Never paste step code into chat, and still never write their files.',
      ].join(' ');
    case 'typealong-off':
    case 'already-typealong-off':
      return `Menitor: type-along is off${r.status === 'typealong-off' ? ' (recorded)' : ''}. Back to hints: the window hides the step code, and help comes one rung at a time.`;
    default:
      return '';
  }
}
