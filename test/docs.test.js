import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractSection, readDocLink, slugify, MAX_SECTION_CHARS } from '../core/lib/docs.js';
import { approvedProject, cli } from './helpers.js';

const DOC = `# Recipe box

Intro.

## Sign-up

Users sign up with an email.

### Errors

Duplicate emails show an error.

## Recipes

\`\`\`md
## Not a heading
\`\`\`

Recipes have a title.

## Setup

First.

## Setup

Second.
`;

test('slugs match GitHub anchors', () => {
  assert.equal(slugify('Sign-up'), 'sign-up');
  assert.equal(slugify('Data & API contract'), 'data--api-contract');
  assert.equal(slugify('  POST /api/signup  '), 'post-apisignup');
  assert.equal(slugify('Café menu'), 'café-menu');
});

test('a section runs to the next heading at its level or above', () => {
  const s = extractSection(DOC, 'sign-up');
  assert.equal(s?.heading, 'Sign-up');
  assert.match(s?.text ?? '', /^## Sign-up\n\nUsers sign up/);
  assert.match(s?.text ?? '', /### Errors/);
  assert.doesNotMatch(s?.text ?? '', /## Recipes/);
  assert.equal(extractSection(DOC, '#errors')?.text, '### Errors\n\nDuplicate emails show an error.');
});

test('headings inside code fences are ignored, and repeats get numbered', () => {
  assert.match(extractSection(DOC, 'recipes')?.text ?? '', /Recipes have a title/);
  assert.equal(extractSection(DOC, 'not-a-heading'), null);
  assert.match(extractSection(DOC, 'setup')?.text ?? '', /First/);
  assert.match(extractSection(DOC, 'setup-1')?.text ?? '', /Second/);
  assert.equal(extractSection(DOC, 'missing'), null);
});

test('readDocLink reads a section, a whole file, or reports what is missing', () => {
  const { root, cleanup } = approvedProject();
  fs.writeFileSync(path.join(root, 'docs', 'prd.md'), DOC);
  assert.equal(readDocLink(root, 'docs/prd.md#recipes').found, 'section');
  assert.equal(readDocLink(root, 'docs/prd.md').found, 'file');
  assert.equal(readDocLink(root, 'docs/prd.md#nope').found, 'missing-section');
  assert.equal(readDocLink(root, 'docs/none.md#x').found, 'missing-file');
  assert.equal(readDocLink(root, '../../etc/passwd').found, 'missing-file', 'links stay inside the project');
  fs.writeFileSync(path.join(root, 'docs', 'big.md'), `## Big\n\n${'x'.repeat(MAX_SECTION_CHARS + 100)}`);
  const big = readDocLink(root, 'docs/big.md#big');
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, MAX_SECTION_CHARS);
  cleanup();
});

test('task brief prints the card, start commit, checks and only the linked section', () => {
  const { root, cleanup } = approvedProject();
  fs.writeFileSync(path.join(root, 'docs', 'prd.md'), `# PRD\n\n## Skeleton\n\nA hello page.\n\n## Signup\n\nNot this.\n`);
  const r = cli(root, ['task', 'brief']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Task 1\/3 · Milestone 1: Walking skeleton/);
  assert.match(r.out, /\[ \] t1\.c1 Branch feat\/skeleton/);
  assert.match(r.out, /Owner {6}the learner · focus: frontend/);
  assert.match(r.out, /Branch {5}feat\/skeleton/);
  assert.match(r.out, /Start {6}[0-9a-f]{12} \(\d{4}-\d{2}-\d{2}\)/);
  assert.match(r.out, /Checks {5}build: npm run build · lint: npm run lint · test: npm test/);
  assert.match(r.out, /Docs: docs\/prd\.md#skeleton\n## Skeleton\n\nA hello page\./);
  assert.doesNotMatch(r.out, /Not this/);

  const deploy = cli(root, ['task', 'brief', 't2']).out;
  assert.match(deploy, /Verify {5}url: \$deployUrl → 200/);
  assert.match(deploy, /Deploy URL not recorded yet/);
  assert.match(deploy, /Start {6}not started/);
  assert.match(deploy, /the file does not exist yet|no heading matches/);

  const json = JSON.parse(cli(root, ['task', 'brief', '--json']).out);
  assert.equal(json.card.task, 't1');
  assert.equal(json.current, true);
  assert.equal(json.doc.found, 'section');
  cleanup();
});
