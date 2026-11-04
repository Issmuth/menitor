// Shared test helpers: throwaway projects and an in-process CLI runner.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../core/lib/cli.js';
import { statePaths } from '../core/lib/paths.js';

/**
 * A temp folder with a git repo, one commit and a docs/prd.md.
 * @param {{ git?: boolean }} [options]
 */
export function makeProject(options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'menitor-test-')));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'prd.md'), '# PRD\n');
  if (options.git !== false) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'chore: init'], { cwd: root });
  }
  return { root, paths: statePaths(root), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * Run the CLI in-process and capture its output.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ stdin?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function cli(cwd, args, options = {}) {
  let out = '';
  let err = '';
  const code = run(args, {
    cwd,
    env: options.env ?? {},
    out: (t) => {
      out += `${t}\n`;
    },
    err: (t) => {
      err += `${t}\n`;
    },
    readStdin: () => options.stdin ?? '',
  });
  return { code, out, err };
}

/**
 * A small valid draft plan in the short form the agent writes.
 * @returns {any}
 */
export function samplePlan() {
  return {
    project: { name: 'Recipe box', stack: ['Next.js', 'Prisma'], hosting: 'vercel' },
    checks: { build: 'npm run build', lint: 'npm run lint', test: 'npm test' },
    milestones: [
      {
        title: 'Walking skeleton',
        branch: 'feat/skeleton',
        tasks: [
          {
            goal: 'Show a hello page',
            why: 'A page proves the app runs end to end.',
            docs: 'docs/prd.md#skeleton',
            focus: ['frontend'],
            checklist: ['Branch feat/skeleton', 'Render a heading on the home page', 'Commit: feat(web): add home page'],
            doneWhen: 'The home page shows the app name',
          },
          {
            goal: 'Deploy the skeleton',
            why: 'Deploying early removes the scariest step.',
            docs: 'docs/prd.md#deploy',
            owner: 'delegated',
            checklist: ['Connect the repo to the host', 'Deploy main'],
            doneWhen: 'The public URL shows the home page',
            verify: [{ url: '$deployUrl', status: 200 }],
          },
        ],
      },
      {
        title: 'Sign-up',
        tasks: [
          {
            goal: 'Save new users to the database',
            why: 'Sign-ups vanish on restart; a users table makes accounts permanent',
            docs: 'docs/prd.md#signup',
            learn: { label: 'Prisma docs → CRUD: create', url: 'https://www.prisma.io/docs' },
            focus: ['database'],
            checklist: [
              'Branch feat/signup-persist',
              'Add a User model (unique email, passwordHash)',
              'Run the migration',
              'Create the user in POST /api/signup',
              'Commit: feat(auth): persist new users',
            ],
            doneWhen: 'Signing up twice with one email shows an error, not a crash',
            hints: {
              concept: 'A unique constraint lets the database refuse duplicates.',
              approach: 'Mark email unique, then catch the error the create call throws.',
              pseudocode: 'try create user; on unique error return 409',
              snippet: "catch (e) { if (e.code === 'P2002') ... }",
            },
          },
        ],
      },
    ],
  };
}

/**
 * Set up a project with a learner profile and an approved sample plan.
 */
export function approvedProject() {
  const project = makeProject();
  const { root } = project;
  for (const args of [
    ['init'],
    ['learner', 'set', 'level', 'standard'],
    ['learner', 'set', 'focusAreas', 'frontend,database'],
    ['plan', 'import', '-'],
    ['plan', 'approve'],
  ]) {
    const r = cli(root, args, { stdin: JSON.stringify(samplePlan()) });
    if (r.code !== 0) throw new Error(`setup failed at ${args.join(' ')}: ${r.err}`);
  }
  return project;
}
