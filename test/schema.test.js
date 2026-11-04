import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../core/lib/schema.js';
import { SCHEMAS } from '../core/lib/state.js';

test('type, required and additionalProperties', () => {
  const schema = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string' } } };
  assert.deepEqual(validate(schema, { a: 'x' }), []);
  assert.deepEqual(validate(schema, {}), [{ path: '$.a', message: 'is required' }]);
  assert.deepEqual(validate(schema, { a: 'x', b: 1 }), [{ path: '$.b', message: 'is not an allowed field' }]);
  assert.deepEqual(validate(schema, { a: 1 }), [{ path: '$.a', message: 'must be string, got integer' }]);
});

test('undefined fields count as absent', () => {
  const schema = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string' } } };
  assert.deepEqual(validate(schema, { a: 'x', b: undefined }), []);
  assert.deepEqual(validate(schema, { a: undefined }), [{ path: '$.a', message: 'is required' }]);
});

test('integers are numbers, numbers are not integers', () => {
  assert.deepEqual(validate({ type: 'number' }, 3), []);
  assert.equal(validate({ type: 'integer' }, 3.5).length, 1);
});

test('strings: length and pattern', () => {
  const schema = { type: 'string', minLength: 1, maxLength: 3, pattern: '^[a-z]+$' };
  assert.deepEqual(validate(schema, 'abc'), []);
  assert.deepEqual(validate(schema, ''), [
    { path: '$', message: 'must not be empty' },
    { path: '$', message: 'must match ^[a-z]+$' },
  ]);
  assert.equal(validate(schema, 'abcd').length, 1);
});

test('arrays: size, items and uniqueness', () => {
  const schema = { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'integer' } };
  assert.deepEqual(validate(schema, [1, 2]), []);
  assert.equal(validate(schema, []).length, 1);
  assert.equal(validate(schema, [1, 2, 3]).length, 1);
  assert.deepEqual(validate(schema, [1, 1]), [{ path: '$[1]', message: 'duplicates an earlier item' }]);
  assert.deepEqual(validate(schema, [1, 'x']), [{ path: '$[1]', message: 'must be integer, got string' }]);
});

test('enum, const, anyOf and $ref', () => {
  const schema = {
    type: 'object',
    properties: {
      kind: { enum: ['a', 'b'] },
      v: { const: 1 },
      either: { anyOf: [{ type: 'null' }, { $ref: '#/$defs/word' }] },
    },
    $defs: { word: { type: 'string', pattern: '^\\w+$' } },
  };
  assert.deepEqual(validate(schema, { kind: 'a', v: 1, either: null }), []);
  assert.deepEqual(validate(schema, { either: 'word' }), []);
  assert.equal(validate(schema, { kind: 'c' }).length, 1);
  assert.equal(validate(schema, { v: 2 }).length, 1);
  assert.deepEqual(validate(schema, { either: 'two words' }), [{ path: '$.either', message: 'must match ^\\w+$' }]);
});

test('propertyNames and additionalProperties schemas for maps', () => {
  const schema = { type: 'object', propertyNames: { pattern: '^t\\d+$' }, additionalProperties: { type: 'string' } };
  assert.deepEqual(validate(schema, { t1: 'x' }), []);
  assert.deepEqual(validate(schema, { x: 'y' }), [{ path: '$.x', message: 'key must match ^t\\d+$' }]);
  assert.deepEqual(validate(schema, { t1: 2 }), [{ path: '$.t1', message: 'must be string, got integer' }]);
});

test('the shipped schemas accept their defaults', () => {
  assert.deepEqual(validate(SCHEMAS.session, { version: 1, currentTask: null, tasks: {} }), []);
  assert.deepEqual(validate(SCHEMAS.progress, { version: 1, ticks: { 't1.c1': '2026-11-04T00:00:00Z' } }), []);
  assert.deepEqual(validate(SCHEMAS.guard, { version: 1, mentorMode: 'on', skipRequests: {}, grants: {} }), []);
  assert.equal(validate(SCHEMAS.progress, { version: 1, ticks: { bad: 'x' } }).length, 1);
});

test('card text may not contain backticks or line breaks', () => {
  const line = SCHEMAS.plan.$defs.line;
  assert.deepEqual(validate({ ...line, $defs: SCHEMAS.plan.$defs }, 'Add a User model'), []);
  assert.equal(validate(line, 'Run `npm test`').length, 1);
  assert.equal(validate(line, 'two\nlines').length, 1);
});
