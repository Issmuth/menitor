// The Claude Code skills: frontmatter for each command, and the renderer that fills the
// agent-neutral instructions in core/instructions/ with this adapter's names.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const INSTRUCTIONS_DIR = fileURLToPath(new URL('../../core/instructions/', import.meta.url));
export const SKILLS_DIR = fileURLToPath(new URL('./skills/', import.meta.url));

/** The CLI as skill content references it; Claude Code fills in the plugin root. */
export const SKILL_CLI = 'node "${CLAUDE_PLUGIN_ROOT}/core/bin/menitor.js"';
const CLI_RULE = `Bash(${SKILL_CLI} *)`;
const GIT_READ_RULES = ['Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)'];

export const COMMAND_NAMES = {
  start: '/menitor:start',
  go: '/menitor:go',
  check: '/menitor:check',
  hint: '/menitor:hint',
  stuck: '/menitor:stuck',
  skip: '/menitor:skip',
  confirm: '/menitor:skip --confirm',
  off: '/menitor:off',
  on: '/menitor:on',
};

/**
 * @typedef {object} SkillSpec
 * @property {string} description       what it does and when to use it
 * @property {boolean} learnerOnly      true: only the learner can run it, by typing it
 * @property {string} [argumentHint]
 * @property {string[]} allowedTools     tools that need no prompt while the skill runs
 */

/** @type {Record<string, SkillSpec>} */
export const SKILLS = {
  start: {
    description: 'Set up a Menitor project: interview the learner, calibrate their level, set focus areas, write lean docs and an ordered task plan, and get the plan approved.',
    learnerOnly: true,
    argumentHint: '[idea, or paths to existing docs]',
    allowedTools: [CLI_RULE, ...GIT_READ_RULES],
  },
  go: {
    description: "Show the current Menitor task card and pick up where the learner left off, even in a fresh session. Use when the learner wants to continue, asks what's next, or comes back to the project.",
    learnerOnly: false,
    allowedTools: [CLI_RULE, ...GIT_READ_RULES],
  },
  check: {
    description: "Check the learner's current Menitor task: deterministic checks first, then review against the checklist and done-when criteria, then explain-back questions. Passes the task or adds fixes. Use when the learner says they're done or asks for a review.",
    learnerOnly: false,
    allowedTools: [CLI_RULE, ...GIT_READ_RULES],
  },
  hint: {
    description: 'Reveal the next rung of the hint ladder for the current Menitor task: concept, approach, pseudocode, then a partial snippet. Use when the learner asks for a hint.',
    learnerOnly: false,
    allowedTools: [CLI_RULE],
  },
  stuck: {
    description: "Debug with the learner when they're stuck on the current Menitor task: what they tried, the error, the debugging step, then the smallest useful hint.",
    learnerOnly: false,
    allowedTools: [CLI_RULE, ...GIT_READ_RULES],
  },
  skip: {
    description: 'Hand the current Menitor task to the agent. Only the learner can run it, by typing it; the first time asks them to confirm.',
    learnerOnly: true,
    argumentHint: '[--confirm] [--explain]',
    allowedTools: [CLI_RULE, ...GIT_READ_RULES],
  },
  off: {
    description: 'Turn Menitor mentor mode off, so the agent may write code. Only the learner can run it, by typing it.',
    learnerOnly: true,
    allowedTools: [CLI_RULE],
  },
  on: {
    description: 'Turn Menitor mentor mode back on. Only the learner can run it, by typing it.',
    learnerOnly: true,
    allowedTools: [CLI_RULE],
  },
};

/**
 * Fill the placeholders in neutral instructions:
 * {{cli}}, {{cmd:<name>}}, {{window}}, {{ask}}, {{templates}} and {{args}}.
 * @param {string} text
 * @param {{ cli: string, templates: string, args: string }} vars
 */
export function renderInstructions(text, vars) {
  return text.replace(/\{\{([a-z]+)(?::([a-z]+))?\}\}/g, (match, key, arg) => {
    if (key === 'cmd') {
      const name = /** @type {Record<string, string>} */ (COMMAND_NAMES)[arg];
      if (!name) throw new Error(`Unknown command placeholder ${match}`);
      return name;
    }
    if (key === 'cli') return vars.cli;
    if (key === 'window') {
      const pairs = ['check', 'hint', 'stuck', 'go', 'start'].map((k) => `--command ${k}=${/** @type {Record<string, string>} */ (COMMAND_NAMES)[k]}`);
      return `${vars.cli} window open ${pairs.join(' ')}`;
    }
    if (key === 'templates') return vars.templates;
    if (key === 'args') return vars.args;
    if (key === 'ask') return 'the AskUserQuestion tool';
    throw new Error(`Unknown placeholder ${match}`);
  });
}

/**
 * The full SKILL.md text for one command.
 * @param {string} name
 */
export function buildSkill(name) {
  const spec = SKILLS[name];
  if (!spec) throw new Error(`No skill spec for "${name}"`);
  const source = fs.readFileSync(new URL(`../../core/instructions/${name}.md`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const body = renderInstructions(source, {
    cli: SKILL_CLI,
    templates: '${CLAUDE_PLUGIN_ROOT}/core/templates/docs',
    args: '$ARGUMENTS',
  }).trim();

  const front = ['---', `name: ${name}`, `description: ${JSON.stringify(spec.description)}`];
  if (spec.argumentHint) front.push(`argument-hint: ${JSON.stringify(spec.argumentHint)}`);
  if (spec.learnerOnly) front.push('disable-model-invocation: true');
  if (spec.allowedTools.length) {
    front.push('allowed-tools:');
    for (const tool of spec.allowedTools) front.push(`  - ${tool}`);
  }
  front.push('---');
  const note = `<!-- Generated from core/instructions/${name}.md by adapters/claude-code/build-skills.js. Edit the source, then run "npm run build:skills". -->`;
  return `${front.join('\n')}\n\n${note}\n\n${body}\n`;
}
