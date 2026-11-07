import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { approvedProject, cli } from './helpers.js';
import { parseImports, parseSections, resolveImport } from '../core/lib/graph.js';
import { loadGraph } from '../core/lib/state.js';

test('sections come with their line range and the paths and links they name, outside code fences', () => {
  const md = ['# Guide', '', 'Start in `src/app.js` and see [the API](api.md#routes).', '', '## Setup', '', '```sh', '# not a heading', 'cat `src/secret.js`', '```', '', '## Setup', 'Again.', ''].join('\n');
  const sections = parseSections(md);
  assert.deepEqual(
    sections.map((s) => [s.anchor, s.level, s.start, s.end]),
    [
      ['guide', 1, 1, 14],
      ['setup', 2, 5, 11],
      ['setup-1', 2, 12, 14],
    ],
  );
  assert.deepEqual(sections[0].mentions, ['src/app.js'], 'a path in a code fence is not a mention');
  assert.deepEqual(sections[0].links, ['api.md#routes']);
  assert.deepEqual(sections[1].mentions, []);
});

test('imports resolve to project files: extensions, index files, TypeScript and Python', () => {
  const js = "import { a } from './a';\nimport b from '../lib/b.js';\nconst c = require('./c');\nimport x from 'express';\n// import fake from './commented';\n/** @type {import('./types.js').T} */\n";
  assert.deepEqual(parseImports('src/app.js', js), ['./a', '../lib/b.js', './c'], 'packages and comments are left out');
  const files = new Set(['src/a.ts', 'lib/b.ts', 'src/c/index.js', 'app/models.py', 'app/__init__.py', 'app/util/__init__.py']);
  assert.equal(resolveImport('src/app.js', './a', files), 'src/a.ts');
  assert.equal(resolveImport('src/app.js', '../lib/b.js', files), 'lib/b.ts', 'TypeScript imports "./b.js" for b.ts');
  assert.equal(resolveImport('src/app.js', './c', files), 'src/c/index.js');
  const py = 'from .models import User\nimport app.util\nimport os\n';
  assert.deepEqual(parseImports('app/views.py', py), ['.models', 'app.util', 'os']);
  assert.equal(resolveImport('app/views.py', '.models', files), 'app/models.py');
  assert.equal(resolveImport('app/views.py', 'app.util', files), 'app/util/__init__.py');
  assert.equal(resolveImport('app/views.py', 'os', files), null);
});

test('the graph answers what a task touches, reads only changed files, and stays out of git', () => {
  const { root, paths, cleanup } = approvedProject();
  const git = (/** @type {string[]} */ ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, stdio: 'pipe' });
  try {
    fs.writeFileSync(path.join(root, 'docs', 'prd.md'), '# PRD\n\n## Skeleton\n\nA hello page in `src/app.js`.\n\n## Deploy\n\nShip `src/app.js`.\n');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'db.js'), 'export const db = {};\n');
    fs.writeFileSync(path.join(root, 'src', 'app.js'), "import { db } from './db.js';\nexport const app = db;\n");
    git('add', '-A');
    git('commit', '-q', '-m', 'feat: app');

    const first = JSON.parse(cli(root, ['graph', 'task', 't1', '--json']).out);
    assert.ok(first.read > 0, 'the first query builds the graph');
    assert.deepEqual(first.section, { link: 'docs/prd.md#skeleton', heading: 'Skeleton', lines: [3, 6], chars: first.section.chars });
    assert.deepEqual(first.named.map((/** @type {any} */ f) => f.path), ['src/app.js'], 'the section names the file');
    assert.deepEqual(first.touched.map((/** @type {any} */ f) => f.path), ['docs/prd.md', 'src/app.js', 'src/db.js'], 'the task in progress changed them');

    const again = JSON.parse(cli(root, ['graph', 'task', '--json']).out);
    assert.equal(again.task, 't1', 'the current task by default');
    assert.equal(again.read, 0, 'a fresh graph answers with no file reads');

    fs.writeFileSync(path.join(root, 'src', 'db.js'), 'export const db = { ready: true };\n');
    assert.equal(JSON.parse(cli(root, ['graph', '--json']).out).read, 1, 'only the changed file is read again');

    // The next task names app.js; db.js is one import away, and t1 changed both before.
    git('commit', '-q', '-am', 'feat: db ready');
    assert.equal(cli(root, ['task', 'pass', '--override', 'test']).code, 0);
    const t2 = JSON.parse(cli(root, ['graph', 'task', '--json']).out);
    assert.equal(t2.task, 't2');
    assert.deepEqual(t2.named.map((/** @type {any} */ f) => f.path), ['src/app.js']);
    assert.deepEqual(t2.touched, [], 'nothing changed on t2 yet');
    assert.deepEqual(t2.near, [{ path: 'src/db.js', via: 'imported by src/app.js', size: fs.statSync(path.join(root, 'src', 'db.js')).size }]);
    assert.deepEqual(t2.earlier, [{ task: 't1', files: ['src/app.js'] }]);

    const file = cli(root, ['graph', 'file', 'src/db.js']).out;
    assert.match(file, /Imported by src\/app\.js/);
    assert.match(file, /Changed by t1/);
    assert.match(cli(root, ['graph', 'file', 'docs/prd.md']).out, /Imports {4}none/);
    assert.notEqual(cli(root, ['graph', 'file', 'nope.js']).code, 0);
    assert.notEqual(cli(root, ['graph', 'task', 'nope']).code, 0);

    assert.match(fs.readFileSync(paths.gitignore, 'utf8'), /^graph\.json$/m, 'the graph stays out of git');
    assert.ok(loadGraph(paths), 'and it is valid against its schema');
    assert.equal(cli(root, ['validate']).code, 0);
  } finally {
    cleanup();
  }
});

test('a long doc section is folded for the brief: its opening, then an outline of the rest', () => {
  const { root, cleanup } = approvedProject();
  try {
    const para = (/** @type {string} */ word) => `${word} `.repeat(120).trim();
    const prd = ['# PRD', '', '## Skeleton', '', para('Opening'), '', '### Routes', '', para('Routes'), '', '### Tests', '', para('Tests'), '', '## Deploy', '', 'Ship it.', ''].join('\n');
    fs.writeFileSync(path.join(root, 'docs', 'prd.md'), prd);
    const brief = cli(root, ['task', 'brief', 't1']).out;
    assert.match(brief, /Opening Opening/, 'the opening stays');
    assert.doesNotMatch(brief, /Routes Routes/, 'the subsections are folded');
    assert.match(brief, /More, folded to keep the brief short/);
    assert.match(brief, /Routes · docs\/prd\.md#routes · lines 7-10 · \d+ chars/);
    assert.match(brief, /Tests · docs\/prd\.md#tests · lines 11-14 · \d+ chars/);
    assert.match(cli(root, ['graph', 'section', 'docs/prd.md#routes']).out, /^### Routes\n\nRoutes Routes/);
    assert.notEqual(cli(root, ['graph', 'section', 'docs/prd.md#nope']).code, 0);
    assert.doesNotMatch(cli(root, ['task', 'brief', 't2']).out, /folded/, 'a short section comes whole');
  } finally {
    cleanup();
  }
});

test('the check carries a review map: the changed lines, the importers and the docs naming each file', () => {
  const { root, cleanup } = approvedProject();
  try {
    fs.writeFileSync(path.join(root, 'docs', 'prd.md'), '# PRD\n\n## Skeleton\n\nThe page lives in `src/app.js`.\n');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'server.js'), "import { a } from './app.js';\nexport default a;\n");
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'feat: app'], { cwd: root });
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const a = 1;\nexport const b = 2;\n');
    const out = cli(root, ['check', 'run', '--no-commands', '--no-diff']).out;
    assert.match(out, /Review map: read these lines, not whole files/);
    assert.match(out, /src\/app\.js {2}lines 1-2 · imported by src\/server\.js · named in docs\/prd\.md#skeleton/);
  } finally {
    cleanup();
  }
});
