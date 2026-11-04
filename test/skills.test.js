// The skills: generated from core/instructions, current, and consistent with the CLI.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS, SKILLS_DIR, INSTRUCTIONS_DIR, buildSkill, renderInstructions } from '../adapters/claude-code/skills.js';
import { HELP } from '../core/lib/cli.js';
import { AGENT_EVENTS } from '../core/lib/log.js';
import { normalizePlanInput, planProblems } from '../core/lib/plan.js';
import { validate } from '../core/lib/schema.js';
import { SCHEMAS } from '../core/lib/state.js';
import { languageWarnings } from '../core/lib/lint.js';

const TEMPLATES = path.resolve(import.meta.dirname, '..', 'core', 'templates', 'docs');
const instructionFiles = fs.readdirSync(INSTRUCTIONS_DIR).filter((f) => f.endsWith('.md'));

/** @param {string} name */
const instructions = (name) => fs.readFileSync(path.join(INSTRUCTIONS_DIR, name), 'utf8').replace(/\r\n/g, '\n');
/** @param {string} file */
const readLf = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

test('every generated SKILL.md is up to date', () => {
  for (const name of Object.keys(SKILLS)) {
    const file = path.join(SKILLS_DIR, name, 'SKILL.md');
    assert.ok(fs.existsSync(file), `${name} is missing; run npm run build:skills`);
    assert.equal(readLf(file), buildSkill(name), `${name} is stale; run npm run build:skills`);
  }
  const dirs = fs.readdirSync(SKILLS_DIR).sort();
  assert.deepEqual(dirs, Object.keys(SKILLS).sort(), 'no stray skill folders');
});

test('every command has instructions, and every instruction file is used', () => {
  for (const name of Object.keys(SKILLS)) assert.ok(instructionFiles.includes(`${name}.md`), name);
  for (const file of instructionFiles) {
    const name = file.replace(/\.md$/, '');
    assert.ok(name in SKILLS || name === 'mentor-rules', `${file} has no skill`);
  }
});

test('frontmatter: names, descriptions and learner-only commands', () => {
  for (const [name, spec] of Object.entries(SKILLS)) {
    const text = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    const front = text.split('---')[1];
    assert.match(front, new RegExp(`^name: ${name}$`, 'm'));
    assert.match(front, /^description: ".+"$/m);
    assert.ok(spec.description.length <= 1536, `${name} description is too long`);
    assert.equal(/^disable-model-invocation: true$/m.test(front), spec.learnerOnly, name);
    assert.match(front, /- Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/core\/bin\/menitor\.js" \*\)/);
  }
  for (const name of ['start', 'skip', 'off', 'on']) assert.equal(SKILLS[name].learnerOnly, true, `${name} is typed by the learner only`);
  for (const name of ['go', 'check', 'hint', 'stuck']) assert.equal(SKILLS[name].learnerOnly, false, `${name} is reachable from window buttons`);
});

test('placeholders are all known, and none survive in the skills', () => {
  const vars = { cli: 'menitor', templates: 't', args: 'a' };
  for (const file of instructionFiles) renderInstructions(instructions(file), vars);
  assert.throws(() => renderInstructions('{{cmd:nope}}', vars), /Unknown command placeholder/);
  assert.throws(() => renderInstructions('{{nope}}', vars), /Unknown placeholder/);
  for (const name of Object.keys(SKILLS)) {
    const text = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(text, /\{\{/, name);
  }
  assert.match(fs.readFileSync(path.join(SKILLS_DIR, 'skip', 'SKILL.md'), 'utf8'), /Arguments: \$ARGUMENTS/);
});

test('every CLI command the instructions use exists', () => {
  const used = new Set();
  for (const file of instructionFiles) {
    for (const m of instructions(file).matchAll(/\{\{cli\}\} ([a-z-]+)(?: ([a-z-]+))?/g)) {
      const [, cmd, sub] = m;
      if (cmd === 'log') {
        assert.ok(AGENT_EVENTS.has(sub), `${file}: "log ${sub}" is not an event the agent may log`);
        continue;
      }
      const withSub = sub && HELP.includes(`menitor ${cmd} ${sub}`);
      assert.ok(withSub || HELP.includes(`menitor ${cmd}`), `${file}: "menitor ${cmd}${sub ? ` ${sub}` : ''}" is not a CLI command`);
      used.add(withSub ? `${cmd} ${sub}` : cmd);
    }
  }
  for (const needed of ['init', 'status', 'plan lint', 'plan import', 'plan approve', 'hints import', 'task brief', 'task hint', 'task fix', 'task pass', 'task skip']) {
    assert.ok(used.has(needed), `no instruction uses "menitor ${needed}"`);
  }
});

test('every doc template that start names exists', () => {
  const start = instructions('start.md');
  for (const doc of ['prd.md', 'tech.md', 'flow.md', 'testing.md', 'design.md', 'data-api.md', 'adr.md']) {
    assert.ok(start.includes(doc), `start.md doesn't mention ${doc}`);
    assert.ok(fs.existsSync(path.join(TEMPLATES, doc)), `template ${doc} is missing`);
  }
});

test('the plan example in start.md is a valid plan', () => {
  const json = /```json\n([\s\S]*?)\n```/.exec(instructions('start.md'));
  assert.ok(json, 'start.md has a JSON example');
  const plan = normalizePlanInput(JSON.parse(json[1]));
  assert.deepEqual(validate(SCHEMAS.plan, plan), []);
  const { errors, warnings } = planProblems(plan, { focusAreas: ['frontend'] });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('instructions follow the language rules: sentences under 25 words', () => {
  for (const file of instructionFiles) {
    const prose = instructions(file)
      .replace(/```[\s\S]*?```/g, '')
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .map((l) => l.replace(/`[^`]*`/g, 'code'));
    const long = prose.flatMap((line) => languageWarnings(file, line).filter((w) => w.includes('-word sentence')));
    assert.deepEqual(long, [], file);
  }
});
