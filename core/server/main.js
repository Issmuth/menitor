#!/usr/bin/env node
// The window server as its own process: node main.js <project root> [commands as JSON]
// Started detached by "menitor window open". It records where it listens in .menitor/window.json
// and removes that file when it stops.

import fs from 'node:fs';
import { createWindowServer } from './server.js';
import { statePaths } from '../lib/paths.js';
import { writeJsonAtomic, readJsonOrNull } from '../lib/fsx.js';
import { assertValid } from '../lib/state.js';

const IDLE_MS = Number(process.env.MENITOR_WINDOW_IDLE_MS ?? 6 * 60 * 60 * 1000);

const [root, commandsJson] = process.argv.slice(2);
if (!root) {
  process.stderr.write('usage: node main.js <project root> [commands JSON]\n');
  process.exit(1);
}
const paths = statePaths(root);
/** @type {Record<string, unknown>} */
let commands = {};
try {
  commands = commandsJson ? JSON.parse(commandsJson) : {};
} catch {
  commands = {};
}

// MENITOR_CODE_FINGERPRINT lets tests start a server that looks older than the code on disk.
const win = createWindowServer(root, { commands, code: process.env.MENITOR_CODE_FINGERPRINT || undefined });
const port = await win.listen(Number(process.env.MENITOR_WINDOW_PORT ?? 0));
const info = { version: 1, pid: process.pid, port, token: win.token, startedAt: new Date().toISOString(), commands: win.commands };
assertValid('window', info, 'window.json');
writeJsonAtomic(paths.window, info);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await win.close();
  // Remove window.json only if it is still ours: a newer server may have replaced it.
  const current = /** @type {{ pid?: number } | null} */ (readJsonOrNull(paths.window));
  if (current?.pid === process.pid) fs.rmSync(paths.window, { force: true });
  process.exit(0);
}

win.server.on('close', () => {
  stop();
});
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// Quit when nobody has looked for a long time, or when the project's state folder is gone.
setInterval(() => {
  if (!fs.existsSync(paths.dir)) stop();
  else if (win.clients === 0 && Date.now() - win.lastActivity > IDLE_MS) stop();
}, 60 * 1000).unref();
