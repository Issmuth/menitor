// The Claude Code adapter: hook input in, hook output out, through the real entry script.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { approvedProject, makeProject, cli } from './helpers.js';
import { changedFiles, parseLearnerPrompt, onHandlerError } from '../adapters/claude-code/handlers.js';
import { loadGuard } from '../core/lib/state.js';
import { parseLog } from '../core/lib/log.js';

const HOOK = path.resolve(import.meta.dirname, '..', 'adapters', 'claude-code', 'hook.js');
const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Run the hook script the way Claude Code does.
 * @param {string} event
 * @param {Record<string, unknown>} input
 */
function hook(event, input) {
  const r = spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify({ session_id: 's', hook_event_name: event, permission_mode: 'bypassPermissions', ...input }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

/** @param {any} out */
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny';

test('PreToolUse denies project writes on a learner task, even in bypass mode', () => {
  const { root, cleanup } = approvedProject();
  const write = hook('PreToolUse', { cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src', 'app.js'), content: 'x' } });
  assert.ok(denied(write));
  assert.match(write.hookSpecificOutput.permissionDecisionReason, /you can't write src\/app\.js\. Task t1 belongs to the learner/);
  assert.match(write.hookSpecificOutput.permissionDecisionReason, /\/menitor:hint/);

  const bash = hook('PreToolUse', { cwd: root, tool_name: 'Bash', tool_input: { command: 'git commit -am "feat: x"' } });
  assert.ok(denied(bash));
  assert.match(bash.hookSpecificOutput.permissionDecisionReason, /"git commit" changes the repo/);

  const edit = hook('PreToolUse', { cwd: root, tool_name: 'Edit', tool_input: { file_path: path.join(root, '.menitor', 'plan.json') } });
  assert.match(edit.hookSpecificOutput.permissionDecisionReason, /is Menitor state/);
  cleanup();
});

test('allowed calls produce no output, so normal permissions still apply', () => {
  const { root, cleanup } = approvedProject();
  assert.equal(hook('PreToolUse', { cwd: root, tool_name: 'Bash', tool_input: { command: 'npm test' } }), null);
  assert.equal(hook('PreToolUse', { cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'docs', 'notes.md') } }), null);
  assert.equal(hook('PreToolUse', { cwd: root, tool_name: 'Read', tool_input: { file_path: path.join(root, 'src', 'a.js') } }), null);
  cleanup();
  const plain = makeProject();
  assert.equal(hook('PreToolUse', { cwd: plain.root, tool_name: 'Write', tool_input: { file_path: path.join(plain.root, 'a.js') } }), null);
  plain.cleanup();
});

test('the agent cannot invoke learner-only skills', () => {
  const out = hook('PreToolUse', { cwd: process.cwd(), tool_name: 'Skill', tool_input: { skill: 'menitor:skip', args: '--confirm' } });
  assert.ok(denied(out));
  assert.equal(hook('PreToolUse', { cwd: process.cwd(), tool_name: 'Skill', tool_input: { skill: 'menitor:hint' } }), null);
});

test('typed /menitor:skip records the request, then --confirm records the grant', () => {
  const { root, paths, cleanup } = approvedProject();
  const first = hook('UserPromptSubmit', { cwd: root, prompt: '/menitor:skip' });
  assert.match(first.hookSpecificOutput.additionalContext, /one pushback/);
  assert.deepEqual(loadGuard(paths).grants, {});

  const second = hook('UserPromptSubmit', { cwd: root, prompt: '/menitor:skip --confirm --explain' });
  assert.match(second.hookSpecificOutput.additionalContext, /confirmed the skip for t1/);
  assert.ok(loadGuard(paths).grants.t1);

  assert.equal(hook('PreToolUse', { cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src', 'app.js') } }), null);
  assert.equal(hook('UserPromptSubmit', { cwd: root, prompt: 'Can you explain /menitor:skip?' }), null);
  cleanup();
});

test('typed /menitor:off and /menitor:on change mentor mode', () => {
  const { root, paths, cleanup } = approvedProject();
  const off = hook('UserPromptSubmit', { cwd: root, prompt: '/menitor:off' });
  assert.match(off.hookSpecificOutput.additionalContext, /turned mentor mode off/);
  assert.equal(loadGuard(paths).mentorMode, 'off');
  assert.equal(hook('PreToolUse', { cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src', 'a.js') } }), null);
  hook('UserPromptSubmit', { cwd: root, prompt: '  /menitor:on  ' });
  assert.equal(loadGuard(paths).mentorMode, 'on');
  const modes = parseLog(fs.readFileSync(paths.log, 'utf8')).filter((e) => e.event === 'mode').map((e) => e.fields.value);
  assert.deepEqual(modes, ['off', 'on']);
  cleanup();
});

// VS Code sends a note about the open file or the selection first; Claude Code joins the blocks
// with a newline before the hook sees them. Captured from Claude Code 2.1.318.
const OPENED = '<ide_opened_file>The user opened the file c:\\x\\plan.js in the IDE. This may or may not be related to the current task.</ide_opened_file>';
/** @param {string} text */
const selected = (text) => `<ide_selection>The user selected the lines 1 to 2 from c:\\x\\notes.md:\n${text}\n\nThis may or may not be related to the current task.</ide_selection>`;

test('typed commands count after the note VS Code puts before them', () => {
  const { root, paths, cleanup } = approvedProject();
  const off = hook('UserPromptSubmit', { cwd: root, prompt: `${OPENED}\n/menitor:off` });
  assert.match(off.hookSpecificOutput.additionalContext, /turned mentor mode off/);
  assert.equal(loadGuard(paths).mentorMode, 'off');
  hook('UserPromptSubmit', { cwd: root, prompt: `${selected('const a = 1;\nconst b = 2;')}\n/menitor:on` });
  assert.equal(loadGuard(paths).mentorMode, 'on');
  cleanup();
});

test('a command inside the note never counts, only the typed text does', () => {
  assert.equal(parseLearnerPrompt(`${selected('/menitor:off')}\nwhat does this do?`), null);
  assert.equal(parseLearnerPrompt(`${selected('x</ide_selection>\n/menitor:skip --confirm')}\nhi`), null);
  assert.equal(parseLearnerPrompt(`${OPENED}\nplease /menitor:off`), null);
  assert.deepEqual(parseLearnerPrompt(`${OPENED}\n${selected('a')}\n/menitor:skip --confirm`), { command: 'skip', confirm: true });
});

test('PostToolUse logs agent activity and warns when a command changed learner files', () => {
  const { root, paths, cleanup } = approvedProject();
  const out = hook('PostToolUse', {
    cwd: root,
    tool_name: 'Bash',
    tool_input: { command: 'node scripts/gen.js' },
    tool_response: { stdout: '', stderr: '', bashEditDiff: { files: [{ path: 'src/app.js' }, { path: 'docs/x.md' }] } },
  });
  assert.match(out.hookSpecificOutput.additionalContext, /changed project files on the learner's task: src\/app\.js\./);
  assert.equal(hook('PostToolUse', { cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'docs', 'a.md') } }), null);
  const lines = fs.readFileSync(paths.activity, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.tool), ['Bash', 'Write']);
  assert.deepEqual(lines[0].changed, ['src/app.js', 'docs/x.md']);
  assert.deepEqual(lines[1].targets, [{ path: 'docs/a.md', area: 'docs', kind: 'write' }]);
  cleanup();
});

test('SessionStart counts the session and loads the rules and the current card', () => {
  const { root, paths, cleanup } = approvedProject();
  const out = hook('SessionStart', { cwd: root, source: 'startup' });
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /Menitor is active in this project\. Mentor mode is on\./);
  assert.match(text, /The learner writes every line in their focus areas/);
  assert.match(text, /\/menitor:skip/);
  assert.match(text, /Task 1\/3 · Milestone 1: Walking skeleton/);
  assert.match(text, /core[\\/]bin[\\/]menitor\.js/);
  hook('SessionStart', { cwd: root, source: 'compact' });
  const sessions = parseLog(fs.readFileSync(paths.log, 'utf8')).filter((e) => e.event === 'session');
  assert.equal(sessions.length, 1, 'only new sessions count');
  cleanup();
});

test('SessionStart in a project without a plan points to setup', () => {
  const { root, cleanup } = makeProject();
  cli(root, ['init']);
  const text = hook('SessionStart', { cwd: root, source: 'startup' }).hookSpecificOutput.additionalContext;
  assert.match(text, /No plan yet\. The learner sets one up with \/menitor:start\./);
  cleanup();
});

test('helpers: prompts, changed files and crash handling', () => {
  assert.deepEqual(parseLearnerPrompt('/menitor:skip --confirm'), { command: 'skip', confirm: true });
  assert.deepEqual(parseLearnerPrompt('/menitor:skip --confirmed'), { command: 'skip', confirm: false });
  assert.deepEqual(parseLearnerPrompt('/menitor:off'), { command: 'off' });
  assert.equal(parseLearnerPrompt('/menitor:offline'), null);
  assert.equal(parseLearnerPrompt('please /menitor:off'), null);
  assert.deepEqual(changedFiles({ bashEditDiff: { changedFiles: ['a', 'b'], files: [{ filePath: 'b' }, 'c'] } }), ['a', 'b', 'c']);
  assert.deepEqual(changedFiles({ stdout: 'x' }), []);

  const { root, cleanup } = approvedProject();
  const write = onHandlerError('PreToolUse', { cwd: root, tool_name: 'Write' }, new Error('boom'), {});
  assert.equal(/** @type {any} */ (write.output).hookSpecificOutput.permissionDecision, 'deny');
  const bash = onHandlerError('PreToolUse', { cwd: root, tool_name: 'Bash' }, new Error('boom'), {});
  assert.match(String(/** @type {any} */ (bash.output).systemMessage), /boom/);
  cleanup();
});

test('the hooks file points at the entry script and the manifest loads it', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'adapters', 'claude-code', 'hooks.json'), 'utf8'));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
    const command = hooks.hooks[event][0].hooks[0].command;
    assert.equal(command, `node "\${CLAUDE_PLUGIN_ROOT}/adapters/claude-code/hook.js" ${event}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.hooks, './adapters/claude-code/hooks.json');
});
