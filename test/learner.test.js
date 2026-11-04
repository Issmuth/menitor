import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultLearner, parseLearner, serializeLearner, addNote } from '../core/lib/learner.js';
import { validate } from '../core/lib/schema.js';
import { SCHEMAS } from '../core/lib/state.js';
import { MenitorError } from '../core/lib/errors.js';

test('the default learner round-trips and validates', () => {
  const learner = defaultLearner();
  const parsed = parseLearner(serializeLearner(learner));
  assert.deepEqual(parsed.profile, learner.profile);
  assert.equal(parsed.notes, learner.notes);
  assert.deepEqual(validate(SCHEMAS.learner, parsed.profile), []);
});

test('lists, quoting and notes round-trip', () => {
  const learner = defaultLearner();
  learner.profile.level = 'guided';
  learner.profile.focusAreas = ['frontend', 'database'];
  learner.profile.mistakes = ['Forgets to await: async calls', '"quoted" text', 'null', '42', ' padded'];
  learner.profile.hintsUsed.approach = 3;
  addNote(learner, 'Explained   joins well', new Date('2026-11-04T10:00:00Z'));
  const text = serializeLearner(learner);
  assert.match(text, /level: guided/);
  assert.match(text, /  - frontend/);
  assert.match(text, /- 2026-11-04: Explained joins well/);
  const parsed = parseLearner(text);
  assert.deepEqual(parsed.profile, learner.profile);
  assert.equal(parsed.notes, learner.notes);
});

test('hand-written frontmatter with comments, blank lines and CRLF parses', () => {
  const text = [
    '---',
    '# my profile',
    'level: fast',
    '',
    'focusAreas:',
    '  - Rust',
    "  - 'web, servers'",
    'strengths: []',
    'mistakes: []',
    'revisit: []',
    'hintsUsed:',
    '  concept: 0',
    '  approach: 1',
    '  pseudocode: 0',
    '  snippet: 0',
    '---',
    'notes',
  ].join('\r\n');
  const { profile, notes } = parseLearner(text);
  assert.equal(profile.level, 'fast');
  assert.deepEqual(profile.focusAreas, ['Rust', 'web, servers']);
  assert.equal(notes, 'notes');
  assert.deepEqual(validate(SCHEMAS.learner, profile), []);
});

test('bad frontmatter gives line-numbered errors', () => {
  assert.throws(() => parseLearner('no frontmatter'), MenitorError);
  assert.throws(() => parseLearner('---\nlevel: fast\n'), /no closing/);
  assert.throws(() => parseLearner('---\nfocusAreas: [a, b]\n---\n'), /line 2: write lists one/);
  assert.throws(() => parseLearner('---\n  - orphan\n---\n'), /line 2/);
  assert.throws(() => parseLearner('---\nlevel: fast\nlevel: guided\n---\n'), /appears twice/);
});
