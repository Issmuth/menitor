// Claude Code hook handlers. Each takes the hook's JSON input and returns the JSON to print.
// All rules live in core/; this file only translates between Claude Code and the core.

import path from 'node:path';
import {
  appendActivity,
  applyLearnerCommand,
  classifyPath,
  decideCommand,
  decideFileWrite,
  findProjectRoot,
  loadGuardContext,
  projectFiles,
  toPosix,
} from '../../core/lib/guard.js';
import { TURN_END } from '../../core/lib/inbox.js';
import { appendEvent } from '../../core/lib/log.js';
import { statusData } from '../../core/lib/ops.js';
import { cardData, renderCard } from '../../core/lib/card.js';
import { loadGuard, loadPlan, loadProgress } from '../../core/lib/state.js';
import { renderStatus } from '../../core/lib/cli.js';
import { CLI, COMMANDS, LEARNER_ONLY, TAKE_TASKS, denyMessage, learnerCommandContext, mentorRules } from './messages.js';
import { WINDOW_COMMANDS } from './skills.js';
import { openBrowser, openWindow } from '../../core/lib/window.js';

/**
 * @typedef {Record<string, any>} HookInput
 * @typedef {{ output?: Record<string, unknown> }} HookResult
 * @typedef {import('../../core/lib/guard.js').GuardContext} GuardContext
 */

export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** @type {Record<string, import('../../core/lib/shell.js').Dialect>} */
export const SHELL_TOOLS = { Bash: 'posix', PowerShell: 'powershell' };

/**
 * @param {HookInput} input
 * @param {NodeJS.ProcessEnv} env
 */
function contextFor(input, env) {
  return loadGuardContext(findProjectRoot(input.cwd, env.CLAUDE_PROJECT_DIR));
}

/**
 * @param {Record<string, any>} toolInput
 * @returns {string | null}
 */
function filePathOf(toolInput) {
  const file = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  return typeof file === 'string' ? file : null;
}

/**
 * @param {string} reason
 * @returns {HookResult}
 */
function deny(reason) {
  return { output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } };
}

/**
 * PreToolUse: deny agent writes the guard forbids. An allowed call gets no output, so Claude
 * Code's own permission rules still apply; the guard never approves anything by itself.
 * @param {HookInput} input
 * @param {NodeJS.ProcessEnv} env
 * @returns {HookResult}
 */
export function preToolUse(input, env) {
  const tool = String(input.tool_name ?? '');
  const toolInput = input.tool_input ?? {};

  if (tool === 'Skill' || tool === 'SlashCommand') {
    return /\bmenitor:(skip|off|on|typealong)\b/.test(JSON.stringify(toolInput)) ? deny(LEARNER_ONLY) : {};
  }

  const ctx = contextFor(input, env);
  if (!ctx.active) return {};

  if (WRITE_TOOLS.has(tool)) {
    const file = filePathOf(toolInput);
    if (!file) return {};
    const d = decideFileWrite(ctx, file, input.cwd);
    return d.allow ? {} : deny(denyMessage(d, ctx));
  }

  const dialect = SHELL_TOOLS[tool];
  if (dialect && typeof toolInput.command === 'string') {
    const d = decideCommand(ctx, toolInput.command, { cwd: input.cwd, dialect });
    return d.allow ? {} : deny(denyMessage(d, ctx));
  }
  return {};
}

/**
 * Files a Bash call changed, when Claude Code reports them (tool_response.bashEditDiff).
 * @param {unknown} response
 * @returns {string[]}
 */
export function changedFiles(response) {
  const diff = /** @type {Record<string, any> | undefined} */ (response && typeof response === 'object' ? /** @type {any} */ (response).bashEditDiff : undefined);
  if (!diff || typeof diff !== 'object') return [];
  /** @type {string[]} */
  const out = [];
  for (const key of ['changedFiles', 'files']) {
    const list = diff[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === 'string') out.push(item);
      else if (item && typeof item === 'object') {
        const p = item.path ?? item.filePath ?? item.file ?? item.name;
        if (typeof p === 'string') out.push(p);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * PostToolUse: log every command and file write the agent ran, so the check can flag
 * project files the agent touched. Warn the agent when a command slipped past the guard.
 * @param {HookInput} input
 * @param {NodeJS.ProcessEnv} env
 * @returns {HookResult}
 */
export function postToolUse(input, env) {
  const ctx = contextFor(input, env);
  if (!ctx.active || !ctx.root) return {};
  const root = ctx.root;
  const tool = String(input.tool_name ?? '');
  const toolInput = input.tool_input ?? {};

  if (WRITE_TOOLS.has(tool)) {
    const file = filePathOf(toolInput);
    if (!file) return {};
    const abs = path.resolve(input.cwd ?? root, file);
    const rel = toPosix(path.relative(root, abs) || '.');
    appendActivity(ctx, { tool, file: rel, targets: [{ path: rel, area: classifyPath(root, root, abs), kind: 'write' }] });
    return {};
  }

  const dialect = SHELL_TOOLS[tool];
  if (!dialect || typeof toolInput.command !== 'string') return {};
  const d = decideCommand(ctx, toolInput.command, { cwd: input.cwd, dialect });
  const changed = changedFiles(input.tool_response);
  appendActivity(ctx, { tool, command: toolInput.command, targets: d.targets, effects: d.effects, changed });

  const touched = projectFiles(ctx, changed);
  if (ctx.writes === 'no' && touched.length) {
    const list = touched.slice(0, 5).join(', ') + (touched.length > 5 ? `, and ${touched.length - 5} more` : '');
    return {
      output: {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `Menitor: that command changed project files on the learner's task: ${list}. Tell the learner exactly what changed and why, so they can keep or undo it. Don't change their files again.`,
        },
      },
    };
  }
  return {};
}

/**
 * A note the IDE puts before the typed text, such as the file the learner has open. Greedy to the
 * last closing tag, so a selection that contains a command is skipped whole and never counts.
 */
const IDE_NOTE = /^\s*<(ide_opened_file|ide_selection)>[\s\S]*<\/\1>/;

/**
 * The part of a prompt the learner typed. In VS Code, Claude Code joins the IDE's notes and the
 * typed text with newlines, so a command right after a note still starts the typed text.
 * @param {string} prompt
 */
function typedText(prompt) {
  let text = prompt;
  for (let m = IDE_NOTE.exec(text); m; m = IDE_NOTE.exec(text)) text = text.slice(m[0].length);
  return text;
}

/**
 * Read a Menitor command the learner typed, such as "/menitor:skip --confirm".
 * @param {unknown} prompt
 * @returns {import('../../core/lib/guard.js').LearnerCommand | null}
 */
export function parseLearnerPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = /^\s*\/menitor:(skip|off|on|typealong)(?=\s|$)([\s\S]*)$/.exec(typedText(prompt));
  if (!m) return null;
  if (m[1] === 'skip') return { command: 'skip', confirm: /(^|\s)--confirm(?=\s|$)/.test(m[2]) };
  if (m[1] === 'typealong') return { command: 'typealong', on: !/^\s*off(\s|$)/.test(m[2]) };
  return { command: /** @type {'off' | 'on'} */ (m[1]) };
}

/**
 * UserPromptSubmit: the learner's own typing is the only source of skip grants and mode changes.
 * @param {HookInput} input
 * @param {NodeJS.ProcessEnv} env
 * @returns {HookResult}
 */
export function userPromptSubmit(input, env) {
  const cmd = parseLearnerPrompt(input.prompt);
  if (!cmd) return {};
  const result = applyLearnerCommand(findProjectRoot(input.cwd, env.CLAUDE_PROJECT_DIR), cmd);
  const text = learnerCommandContext(result);
  return text ? { output: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } } } : {};
}

/**
 * The context a session starts with: the rules, where things stand and the current card.
 * @param {GuardContext} ctx
 * @param {string | null} [windowLine] where the task window is, when the session opened it
 */
export function sessionContext(ctx, windowLine = null) {
  if (!ctx.paths) return '';
  const lines = [`Menitor is active in this project. Mentor mode is ${ctx.mode}.`];
  lines.push(`State CLI: ${CLI} <command>, written \`menitor\` below. It is the only way to change .menitor/. Its "help" command lists the rest.`);
  if (ctx.mode === 'off') {
    lines.push(`The learner turned mentor mode off, so help normally. ${TAKE_TASKS} They can type ${COMMANDS.on} to turn it back on.`);
  } else {
    lines.push('', mentorRules());
  }
  if (ctx.mode === 'on' && typeAlongOn(ctx)) {
    lines.push('', `Type-along is on: the window shows each step's instructions and full code, and the learner types it. Never paste step code into chat; point them to the window. You still never write their files. Steps without code yet need it: see "task brief" and "steps import".`);
  }
  lines.push('', 'A "Menitor window" notification is a button press in the task window: run the skill it names right away.');
  if (windowLine) lines.push(windowLine);
  try {
    const plan = loadPlan(ctx.paths);
    // The card below names the current task, and "plan show" lists the milestones: neither is repeated here.
    lines.push('', renderStatus(statusData(ctx.paths), { milestones: false, current: !(plan?.approvedAt && ctx.task) }));
    if (!plan) {
      lines.push('', `No plan yet. The learner sets one up with ${COMMANDS.start}.`);
    } else if (!plan.approvedAt) {
      lines.push('', `The plan is a draft. Setup (${COMMANDS.start}) ends when the learner approves it.`);
    } else if (ctx.task) {
      lines.push('', 'Current task card:', renderCard(cardData(plan, ctx.task, loadProgress(ctx.paths))));
      if (ctx.writes === 'delegated') lines.push('', 'This task is delegated, so it is yours to do.');
    }
  } catch (err) {
    lines.push('', `Menitor's state has a problem: ${/** @type {Error} */ (err).message}. Run ${CLI} validate.`);
  }
  return lines.join('\n');
}

/**
 * @param {GuardContext} ctx
 */
function typeAlongOn(ctx) {
  try {
    return ctx.paths ? Boolean(loadGuard(ctx.paths).typeAlong) : false;
  } catch {
    return false;
  }
}

/**
 * SessionStart: count the session and load the context.
 * @param {HookInput} input
 * @param {NodeJS.ProcessEnv} env
 * @returns {HookResult}
 */
export function sessionStart(input, env) {
  const ctx = contextFor(input, env);
  if (!ctx.active || !ctx.paths) return {};
  if (input.source === 'startup' || input.source === undefined) {
    try {
      appendEvent(ctx.paths.log, 'session', {});
    } catch {
      // Counting sessions is for the stats; never block a session over it.
    }
  }
  const windowLine = autostartWindow(ctx, input, env);
  return { output: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: sessionContext(ctx, windowLine) } } };
}

/**
 * Open the task window when a session starts on a task, so the card is there without a command.
 * A browser opens only on a fresh start and only if the server had to start; a resume or a
 * compaction just gets the link. MENITOR_WINDOW_AUTOSTART=0 turns it off.
 * @param {GuardContext} ctx
 * @param {HookInput} input
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null} the line for the session context
 */
function autostartWindow(ctx, input, env) {
  if (!ctx.paths || !ctx.task || env.MENITOR_WINDOW_AUTOSTART === '0') return null;
  try {
    const r = openWindow(ctx.paths, { commands: WINDOW_COMMANDS, browser: false, env });
    const fresh = input.source === 'startup' || input.source === 'clear' || input.source === undefined;
    if (r.started && fresh) openBrowser(r.url, env);
    return `The task window is ${r.started ? 'open' : 'running'}: ${r.url}`;
  } catch (err) {
    return `The task window couldn't start: ${/** @type {Error} */ (err).message}`;
  }
}

/**
 * Stop: the agent ended its turn. The window reads this as the answer to a button press, so it
 * can stop showing that Menitor is working. It says nothing to the session.
 * @param {HookInput} input
 * @param {NodeJS.ProcessEnv} env
 * @returns {HookResult}
 */
export function stop(input, env) {
  const ctx = contextFor(input, env);
  if (ctx.active) appendActivity(ctx, { tool: TURN_END });
  return {};
}

const HANDLERS = /** @type {Record<string, (input: HookInput, env: NodeJS.ProcessEnv) => HookResult>} */ ({
  PreToolUse: preToolUse,
  PostToolUse: postToolUse,
  Stop: stop,
  UserPromptSubmit: userPromptSubmit,
  SessionStart: sessionStart,
});

/**
 * @param {string} event
 * @param {HookInput} input
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {HookResult}
 */
export function handleHook(event, input, env = process.env) {
  const handler = HANDLERS[event];
  if (!handler) throw new Error(`Unknown hook event "${event}"`);
  return handler(input, env);
}

/**
 * When a handler crashes: block file writes in a Menitor project (fail closed), but let shell
 * commands run so a bug can never lock the learner out of their session.
 * @param {string} event
 * @param {HookInput} input
 * @param {unknown} err
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {HookResult}
 */
export function onHandlerError(event, input, err, env = process.env) {
  const message = err instanceof Error ? err.message : String(err);
  if (event === 'PreToolUse' && WRITE_TOOLS.has(String(input?.tool_name)) && findProjectRoot(input?.cwd, env.CLAUDE_PROJECT_DIR)) {
    return deny(`Menitor's guard hit an error, so file writes are blocked: ${message}. Run ${CLI} validate, and tell the learner.`);
  }
  return { output: { systemMessage: `Menitor hook error (${event}): ${message}` } };
}
