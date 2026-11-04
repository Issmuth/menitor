// File helpers: atomic writes and JSON reads.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MenitorError } from './errors.js';

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Sleep synchronously. Used only for short Windows rename retries.
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write a file atomically: write a temp file in the same folder, flush it, then rename it over the target.
 * Readers see either the old file or the new one, never a half-written file.
 * On Windows a rename can fail briefly while another process has the file open, so it retries.
 * @param {string} file
 * @param {string} data
 */
export function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? '';
      if (!RETRYABLE.has(code) || attempt >= 9) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // Leave the temp file; it is ignored by every reader.
        }
        throw err;
      }
      sleepSync(15 * (attempt + 1));
    }
  }
}

/**
 * Write JSON atomically with a trailing newline.
 * @param {string} file
 * @param {unknown} value
 */
export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read a text file, or return null when it does not exist.
 * @param {string} file
 * @returns {string | null}
 */
export function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Read and parse a JSON file, or return null when it does not exist.
 * @param {string} file
 * @returns {unknown}
 */
export function readJsonOrNull(file) {
  const text = readTextOrNull(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new MenitorError(`${path.basename(file)} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
}

/**
 * Read text from a file path, or from stdin when the path is "-".
 * @param {string} source
 */
export function readInput(source) {
  if (source === '-') return fs.readFileSync(0, 'utf8');
  const text = readTextOrNull(source);
  if (text === null) throw new MenitorError(`File not found: ${source}`);
  return text;
}

/**
 * Parse JSON input with a helpful error.
 * @param {string} text
 * @param {string} label
 * @returns {unknown}
 */
export function parseJsonInput(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new MenitorError(`${label} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
}
