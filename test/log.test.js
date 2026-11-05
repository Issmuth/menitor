import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, appendAgentEvent, formatEvent, parseFieldArgs, parseLog, validateEvent, LOG_HEADER } from '../core/lib/log.js';
import { EXIT, MenitorError } from '../core/lib/errors.js';

const at = new Date('2026-11-04T16:20:00.000Z');

test('events format as one readable line and parse back', () => {
  const line = formatEvent('check', { task: 't7', result: 'fail', mustFix: 2, note: 'Missed the "unique" case\nagain' }, at);
  assert.equal(line, '- 2026-11-04T16:20:00.000Z check task=t7 result=fail mustFix=2 note="Missed the \\"unique\\" case again"');
  const [event] = parseLog(`${LOG_HEADER}${line}\n`);
  assert.deepEqual(event, {
    at: '2026-11-04T16:20:00.000Z',
    event: 'check',
    fields: { task: 't7', result: 'fail', mustFix: '2', note: 'Missed the "unique" case again' },
  });
});

test('the header and stray lines are skipped', () => {
  const events = parseLog(`${LOG_HEADER}some hand-written line\n- not an event\n- 2026-11-04T16:20:00.000Z session\n`);
  assert.deepEqual(events.map((e) => e.event), ['session']);
});

test('events are validated against their spec', () => {
  validateEvent('hint', { task: 't1', rung: 'concept' });
  assert.throws(() => validateEvent('hint', { task: 't1', rung: 'everything' }), MenitorError);
  assert.throws(() => validateEvent('hint', { task: 't1' }), /Invalid "hint"/);
  assert.throws(() => validateEvent('hint', { task: 't1', rung: 'concept', extra: 'x' }), MenitorError);
  assert.throws(() => validateEvent('nope', {}), /Unknown log event/);
  try {
    validateEvent('check', { task: 'T 1', result: 'maybe' });
    assert.fail('expected an error');
  } catch (err) {
    assert.ok(err instanceof MenitorError);
    assert.deepEqual(err.details, ['task=T 1 must be a task ID', 'result=maybe must be one of pass, fail']);
  }
});

test('appendEvent creates the file with its header and appends', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menitor-log-'));
  const file = path.join(dir, 'log.md');
  appendEvent(file, 'init', {}, at);
  appendEvent(file, 'stuck', { task: 't2' }, at);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith(LOG_HEADER));
  assert.deepEqual(parseLog(text).map((e) => e.event), ['init', 'stuck']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the agent can log only its own events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menitor-log-'));
  const file = path.join(dir, 'log.md');
  appendAgentEvent(file, 'dispute', { task: 't1', outcome: 'withdrawn' });
  for (const event of ['skip', 'mode', 'session', 'pass', 'hint']) {
    assert.throws(
      () => appendAgentEvent(file, event, { task: 't1' }),
      (err) => err instanceof MenitorError && err.exit === EXIT.refused,
    );
  }
  assert.equal(parseLog(fs.readFileSync(file, 'utf8')).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('key=value arguments', () => {
  assert.deepEqual(parseFieldArgs(['task=t1', 'note=a=b']), { task: 't1', note: 'a=b' });
  assert.throws(() => parseFieldArgs(['oops']), MenitorError);
});
