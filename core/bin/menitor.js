#!/usr/bin/env node
// Entry point for the menitor CLI. Run it as: node <plugin>/core/bin/menitor.js <command>

import { run } from '../lib/cli.js';

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  process.stderr.write(`menitor: Node.js 22 or newer is required; this is ${process.versions.node}.\n`);
  process.exit(1);
}

process.exitCode = run(process.argv.slice(2));
