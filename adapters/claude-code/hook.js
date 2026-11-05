#!/usr/bin/env node
// Entry point for every Menitor hook in Claude Code: node hook.js <HookEventName>
// Reads the hook input as JSON on stdin and prints the hook output as JSON on stdout.

import { handleHook, onHandlerError } from './handlers.js';

const event = process.argv[2] ?? '';

/** @returns {Promise<string>} */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** @type {Record<string, any>} */
let input = {};
try {
  const text = await readStdin();
  input = text.trim() ? JSON.parse(text) : {};
} catch (err) {
  process.stderr.write(`menitor hook: could not read the hook input: ${/** @type {Error} */ (err).message}\n`);
  process.exit(1);
}

let result;
try {
  result = handleHook(event, input);
} catch (err) {
  result = onHandlerError(event, input, err);
}
if (result.output) process.stdout.write(JSON.stringify(result.output));
