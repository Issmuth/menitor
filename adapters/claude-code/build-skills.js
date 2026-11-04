#!/usr/bin/env node
// Write adapters/claude-code/skills/<name>/SKILL.md from core/instructions/<name>.md.
// Run with --check to fail when a generated file is out of date instead of writing it.

import fs from 'node:fs';
import path from 'node:path';
import { SKILLS, SKILLS_DIR, buildSkill } from './skills.js';

const check = process.argv.includes('--check');
const stale = [];

for (const name of Object.keys(SKILLS)) {
  const file = path.join(SKILLS_DIR, name, 'SKILL.md');
  const text = buildSkill(name);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
  if (current === text) continue;
  if (check) {
    stale.push(path.relative(process.cwd(), file));
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    process.stdout.write(`wrote ${path.relative(process.cwd(), file)}\n`);
  }
}

if (stale.length) {
  process.stderr.write(`These skills are out of date; run "npm run build:skills":\n${stale.map((f) => `  ${f}`).join('\n')}\n`);
  process.exitCode = 1;
}
