// A fingerprint of Menitor's own code: the state CLI, the schemas and the window server with its
// page. A window server keeps the code it started with, so comparing its fingerprint with a fresh
// one tells a server started before an update from a current one.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['lib', 'schemas', 'server'];

/**
 * Every file under a folder, as absolute paths.
 * @param {string} dir
 * @returns {string[]}
 */
function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return filesUnder(full);
    return e.isFile() ? [full] : [];
  });
}

/**
 * A short hash of the code and schema files, in a stable order. It changes when any of them does.
 * @param {string} [core] the core folder, for tests
 */
export function codeFingerprint(core = CORE) {
  const hash = crypto.createHash('sha256');
  for (const dir of DIRS) {
    const base = path.join(core, dir);
    if (!fs.existsSync(base)) continue;
    const files = filesUnder(base).map((f) => ({ f, rel: path.relative(core, f).split(path.sep).join('/') }));
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    for (const { f, rel } of files) hash.update(rel).update('\0').update(fs.readFileSync(f)).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
