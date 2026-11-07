import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RUNS, measure, table, tokens } from '../adapters/claude-code/context-cost.js';

test('every command has a measured run, and tokens are counted the same way for all', () => {
  const skills = fs.readdirSync(new URL('../adapters/claude-code/skills/', import.meta.url)).sort();
  assert.deepEqual(Object.keys(RUNS).sort(), skills, 'a new skill needs a run in context-cost.js');
  assert.equal(tokens(''), 0);
  assert.equal(tokens('abcd'), 1);
  assert.equal(tokens('abcde'), 2);
});

test('a measured command adds up its skill, hook and CLI output, beside what every session loads', async () => {
  const m = await measure({ only: ['hint'] });
  assert.equal(m.rows.length, 1);
  const [row] = m.rows;
  assert.equal(row.command, 'hint');
  assert.ok(row.skill > 0 && row.cli > 0, 'the skill text and the hint it reveals are both counted');
  assert.equal(row.total, row.skill + row.hook + row.cli);
  assert.ok(m.always.session > 0 && m.always.descriptions > 0 && m.always.mcp > 0);
  assert.match(table(m), /\| \/menitor:hint \| \d+ \| 0 \| \d+ \| \d+ \|/);
});
