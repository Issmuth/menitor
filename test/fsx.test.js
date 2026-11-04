import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic, writeJsonAtomic, readJsonOrNull, readTextOrNull } from '../core/lib/fsx.js';
import { MenitorError } from '../core/lib/errors.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'menitor-fsx-'));
}

test('atomic writes replace the file and leave no temp files', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2 });
  assert.deepEqual(readJsonOrNull(file), { a: 2 });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atomic writes create missing folders', () => {
  const dir = tempDir();
  const file = path.join(dir, 'a', 'b', 'note.md');
  writeFileAtomic(file, 'hi');
  assert.equal(readTextOrNull(file), 'hi');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing files read as null; broken JSON is a MenitorError', () => {
  const dir = tempDir();
  assert.equal(readJsonOrNull(path.join(dir, 'nope.json')), null);
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{ nope');
  assert.throws(() => readJsonOrNull(file), MenitorError);
  fs.rmSync(dir, { recursive: true, force: true });
});
