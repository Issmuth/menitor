// The menitor CLI: the only way the agent changes Menitor state (G-4).

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT, MenitorError } from './errors.js';
import { requireRoot, statePaths } from './paths.js';
import { repoRoot } from './git.js';
import { parseJsonInput } from './fsx.js';
import { appendAgentEvent, parseFieldArgs, parseLog } from './log.js';
import { cardData, renderCard } from './card.js';
import { computeStats, renderStats } from './stats.js';
import { renderCheck } from './check.js';
import { openWindow, readWindowInfo, isAlive, stopWindow, windowUrl } from './window.js';
import { allTasks } from './plan.js';
import { loadLearner, loadProgress, loadSession, requirePlan } from './state.js';
import {
  approvePlan,
  briefData,
  checkTask,
  fixTask,
  importHints,
  importPlan,
  importSteps,
  initProject,
  learnerAdd,
  learnerNote,
  learnerRemove,
  learnerSet,
  lintPlan,
  passTask,
  resolveTask,
  revealHint,
  setDeployUrl,
  skipTask,
  statusData,
  validateAll,
} from './ops.js';

export const HELP = `menitor: state for a Menitor project. Every change to .menitor/ goes through here.

Setup
  menitor init                          Create .menitor/ in the project root
  menitor learner show                  Print the learner profile
  menitor learner set level <level>     guided, standard or fast
  menitor learner set <list> <a,b>      Replace a list: focusAreas, strengths, mistakes, revisit
  menitor learner add <list> <text>     Add one item to a list
  menitor learner remove <list> <text>  Remove one item from a list
  menitor learner note <text>           Add a dated note

Plan
  menitor plan lint <file|->            Check a draft plan without saving it
  menitor plan import <file|->          Save the plan (only before approval)
  menitor plan approve                  Lock the plan after the learner approves it; start task 1
  menitor plan show                     Outline of milestones and tasks
  menitor plan deploy-url <url>         Record the deployed URL
  menitor hints import <file|->         Store locked hints: {"t5": {concept, approach, pseudocode, snippet}}
  menitor steps import <file|->         Store type-along code per step:
                                        {"t5.c2": {"say": "...", "code": [{"where": "src/app.js", "text": "..."}]}}

Tasks (the ID defaults to the current task)
  menitor task show [id]                Print the task card
  menitor task brief [id]               Card, start commit, checks and the linked doc section
  menitor task hint [id]                Reveal the next hint rung
  menitor task fix <text>... [--id id]  Add fixes to the checklist as new items
  menitor task pass [id]                Mark the task done and start the next one. Needs a clean
                                        check run at the current commit, and for learner tasks an
                                        explain-back logged since then
        --note <text>                   A short note shown on the card (delegated work)
        --revisit <concept>             A concept to revisit (repeatable)
        --override <reason>             Pass without the gate, only when a check itself is broken;
                                        the reason is logged and shown on the card
  menitor task skip [id]                Hand a task to the agent (learner tasks need the learner's grant)

Checks
  menitor check run [id]                Run the deterministic checks: build, lint, test, verify
                                        steps, deploy URL, commits, ticks and agent activity, then
                                        print the diff since the task started
        --no-commands                   Skip build, lint, test and verify (doesn't count for a pass)
        --no-diff                       Leave the diff out
        --timeout <seconds>             Per command (default 180)

Window
  menitor window open                   Start the task window if it isn't running, and open it
        --command <name>=<text>         What the learner types for check, hint, stuck, go or start
                                        (repeatable); buttons copy it when they can't reach the session
        --no-browser                    Print the link without opening a browser
  menitor window status                 Whether the window is running, and its link
  menitor window stop                   Stop the window server

History
  menitor log <event> key=value...      Log check, explain, stuck, dispute, deploy or note
  menitor stats                         Success metrics from the plan and the log
  menitor status                        Where the project stands
  menitor validate                      Check every state file

Options
  --root <dir>   Project root (default: nearest folder with .menitor/, or MENITOR_ROOT)
  --json         Print JSON instead of text
  --ids          Show checklist IDs on cards
`;

/**
 * @typedef {object} IO
 * @property {string} cwd
 * @property {NodeJS.ProcessEnv} env
 * @property {(text: string) => void} out
 * @property {(text: string) => void} err
 * @property {() => string} readStdin
 */

/**
 * @param {string} source
 * @param {IO} io
 */
function readSource(source, io) {
  if (source === '-') return io.readStdin();
  const file = path.resolve(io.cwd, source);
  if (!fs.existsSync(file)) throw new MenitorError(`File not found: ${source}`);
  return fs.readFileSync(file, 'utf8');
}

/**
 * @param {string[]} warnings
 */
function formatWarnings(warnings) {
  return warnings.length ? `\nWarnings:\n${warnings.map((w) => `  - ${w}`).join('\n')}` : '';
}

/**
 * @param {ReturnType<typeof statusData>} s
 */
export function renderStatus(s) {
  const lines = [];
  lines.push(`${s.project ?? 'No plan yet'} · ${s.approved ? 'plan approved' : 'plan not approved'} · mentor mode ${s.mentorMode}${s.typeAlong ? ' · type-along on' : ''}`);
  lines.push(`Level ${s.level ?? 'not set'} · focus: ${s.focusAreas.length ? s.focusAreas.join(', ') : 'none set'}`);
  if (s.current) {
    lines.push(`Current  Task ${s.current.number}/${s.current.total} · Milestone ${s.current.milestone.number}: ${s.current.milestone.title} · ${s.current.goal}${s.current.owner === 'delegated' ? ' (delegated)' : ''}`);
  } else if (s.approved && s.total && s.done === s.total) {
    lines.push('Current  none: every task is done');
  }
  const width = Math.max(0, ...s.milestones.map((m) => m.title.length));
  for (const m of s.milestones) lines.push(`M${m.number} ${m.title.padEnd(width)}  ${m.done}/${m.total}`);
  if (s.total) {
    const skipped = s.written.skipped ? ` (${s.written.skipped} skipped)` : '';
    lines.push(`Done ${s.done}/${s.total} · ${s.written.learner} by the learner · ${s.written.delegated} delegated${skipped}`);
  }
  return lines.join('\n');
}

/**
 * @param {import('./plan.js').Plan} plan
 * @param {string | null} current
 */
function renderOutline(plan, current) {
  const lines = [`${plan.project.name} · ${plan.approvedAt ? `approved ${plan.approvedAt.slice(0, 10)}` : 'draft'}`];
  for (const entry of allTasks(plan)) {
    const { task, milestone } = entry;
    if (milestone.tasks[0] === task) {
      const done = milestone.tasks.filter((t) => t.status === 'done').length;
      lines.push(`M${entry.milestoneIndex + 1} ${milestone.title}${milestone.skeleton && !/skeleton/i.test(milestone.title) ? ' (walking skeleton)' : ''} · ${done}/${milestone.tasks.length}`);
    }
    const mark = task.status === 'done' ? '[x]' : task.id === current ? '[>]' : '[ ]';
    const owner = task.owner === 'delegated' ? (task.skipped ? ' · skipped' : ' · delegated') : '';
    lines.push(`  ${mark} ${task.id.padEnd(4)} ${task.goal}${owner}`);
  }
  return lines.join('\n');
}

/**
 * @param {ReturnType<typeof briefData>} b
 */
function renderBrief(b) {
  const lines = [renderCard(b.card, { ids: true }), ''];
  lines.push(`Owner      ${b.card.owner === 'learner' ? 'the learner' : b.card.skipped ? 'Menitor (skipped by the learner)' : 'Menitor (delegated)'} · focus: ${b.focus.length ? b.focus.join(', ') : 'none'}`);
  if (b.card.branch) lines.push(`Branch     ${b.card.branch}`);
  lines.push(`Start      ${b.startCommit ? `${b.startCommit.slice(0, 12)} (${b.startedAt?.slice(0, 10)})` : b.startedAt ? 'no commit yet: review every file' : 'not started'}`);
  const checks = Object.entries(b.checks).filter(([, cmd]) => cmd).map(([name, cmd]) => `${name}: ${cmd}`);
  lines.push(`Checks     ${checks.length ? checks.join(' · ') : 'none set'}`);
  for (const [i, v] of b.verify.entries()) {
    const text = 'run' in v ? `run: ${v.run}` : `url: ${v.url}${v.status ? ` → ${v.status}` : ''}${v.contains ? ` containing "${v.contains}"` : ''}`;
    lines.push(`${i === 0 ? 'Verify' : ''}`.padEnd(11) + text);
  }
  if (b.verify.some((v) => 'url' in v && v.url.startsWith('$deployUrl'))) lines.push(`Deploy URL ${b.deployUrl ?? 'not recorded yet'}`);
  if (b.typeAlong && b.card.owner === 'learner') {
    const { stored, missing } = b.stepCode;
    lines.push(`Type-along on · code stored for ${stored.length} of ${stored.length + missing.length} steps${missing.length ? ` · missing: ${missing.join(', ')}` : ''}`);
  }
  lines.push('');
  const { doc } = b;
  const where = doc.anchor ? `${doc.file}#${doc.anchor}` : doc.file;
  if (doc.found === 'missing-file') lines.push(`Docs: ${where} (the file does not exist yet)`);
  else if (doc.found === 'missing-section') lines.push(`Docs: ${where} (no heading matches; showing the whole file)`, doc.text);
  else lines.push(`Docs: ${where}`, doc.text);
  if (doc.truncated) lines.push('[cut at 4000 characters]');
  return lines.join('\n');
}

/**
 * @param {import('./learner.js').Learner} learner
 */
function renderLearner(learner) {
  const p = learner.profile;
  /** @param {string[]} list */
  const show = (list) => (list.length ? list.join('; ') : '-');
  const used = Object.entries(p.hintsUsed).map(([r, n]) => `${r} ${n}`).join(', ');
  return [
    `Level       ${p.level ?? 'not set'}`,
    `Focus       ${show(p.focusAreas)}`,
    `Strengths   ${show(p.strengths)}`,
    `Mistakes    ${show(p.mistakes)}`,
    `Revisit     ${show(p.revisit)}`,
    `Hints used  ${used}`,
  ].join('\n');
}

/**
 * Run the CLI. Returns the exit code instead of exiting, so tests can call it in-process.
 * @param {string[]} argv
 * @param {Partial<IO>} [ioOverrides]
 */
export function run(argv, ioOverrides = {}) {
  /** @type {IO} */
  const io = {
    cwd: process.cwd(),
    env: process.env,
    out: (t) => process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
    err: (t) => process.stderr.write(t.endsWith('\n') ? t : `${t}\n`),
    readStdin: () => fs.readFileSync(0, 'utf8'),
    ...ioOverrides,
  };

  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        root: { type: 'string' },
        json: { type: 'boolean', default: false },
        ids: { type: 'boolean', default: false },
        note: { type: 'string' },
        revisit: { type: 'string', multiple: true },
        id: { type: 'string' },
        override: { type: 'string' },
        'no-commands': { type: 'boolean', default: false },
        'no-diff': { type: 'boolean', default: false },
        timeout: { type: 'string' },
        command: { type: 'string', multiple: true },
        'no-browser': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });

    const [command, sub, ...rest] = positionals;
    if (values.help || !command || command === 'help') {
      io.out(HELP);
      return EXIT.ok;
    }

    /** @param {unknown} value */
    const json = (value) => io.out(JSON.stringify(value, null, 2));
    const paths = () => statePaths(requireRoot({ root: values.root, cwd: io.cwd, env: io.env }));

    switch (command) {
      case 'init': {
        const root = path.resolve(values.root ?? repoRoot(io.cwd) ?? io.cwd);
        const p = initProject(root);
        if (values.json) json({ root, dir: p.dir });
        else io.out(`Created ${path.relative(io.cwd, p.dir) || '.menitor'}/ in ${root}.\nplan.json is committed with the project; the rest of .menitor/ is gitignored.`);
        return EXIT.ok;
      }

      case 'status': {
        const s = statusData(paths());
        if (values.json) json(s);
        else io.out(renderStatus(s));
        return EXIT.ok;
      }

      case 'validate': {
        const { errors, warnings } = validateAll(paths());
        if (values.json) json({ ok: errors.length === 0, errors, warnings });
        else if (errors.length) io.err(`Invalid state:\n${errors.map((e) => `  - ${e}`).join('\n')}${formatWarnings(warnings)}`);
        else io.out(`All state files are valid.${formatWarnings(warnings)}`);
        return errors.length ? EXIT.error : EXIT.ok;
      }

      case 'plan':
        return runPlan(sub, rest, values, io, paths, json);

      case 'hints': {
        if (sub !== 'import' || !rest[0]) throw new MenitorError('Usage: menitor hints import <file|->');
        const ids = importHints(paths(), parseJsonInput(readSource(rest[0], io), 'The hints'));
        if (values.json) json({ stored: ids });
        else io.out(`Stored locked hints for ${ids.join(', ')}.`);
        return EXIT.ok;
      }

      case 'task':
        return runTask(sub, rest, values, io, paths, json);

      case 'steps': {
        if (sub !== 'import' || !rest[0]) throw new MenitorError('Usage: menitor steps import <file|->');
        const { ids, warnings } = importSteps(paths(), parseJsonInput(readSource(rest[0], io), 'The step code'));
        if (values.json) json({ stored: ids, warnings });
        else io.out(`Stored type-along code for ${ids.join(', ')}. The window shows each step's code once the step before it is ticked.${formatWarnings(warnings)}`);
        return EXIT.ok;
      }

      case 'window': {
        const p = paths();
        if (sub === 'open') {
          /** @type {Record<string, string>} */
          const commands = {};
          for (const pair of values.command ?? []) {
            const eq = pair.indexOf('=');
            if (eq <= 0) throw new MenitorError(`--command takes name=text, got "${pair}"`);
            commands[pair.slice(0, eq)] = pair.slice(eq + 1);
          }
          let r;
          try {
            r = openWindow(p, { commands, browser: !values['no-browser'], env: io.env });
          } catch (err) {
            throw new MenitorError(/** @type {Error} */ (err).message);
          }
          if (values.json) json({ url: r.url, started: r.started, opened: r.opened });
          else io.out(`${r.started ? 'Started the task window' : 'The task window is already running'}: ${r.url}\n${r.opened ? 'Opened it in the browser.' : 'Open that link in a browser on this machine.'}`);
          return EXIT.ok;
        }
        if (sub === 'status') {
          const info = readWindowInfo(p);
          const alive = info ? isAlive(p, info) : false;
          if (values.json) json({ running: alive, url: alive && info ? windowUrl(info) : null });
          else io.out(alive && info ? `The task window is running: ${windowUrl(info)}` : 'The task window is not running. Start it with "menitor window open".');
          return EXIT.ok;
        }
        if (sub === 'stop') {
          const was = stopWindow(p);
          if (values.json) json({ stopped: was });
          else io.out(was ? 'Stopped the task window.' : 'The task window was not running.');
          return EXIT.ok;
        }
        throw new MenitorError('Usage: menitor window <open|status|stop>');
      }

      case 'check': {
        if (sub !== 'run') throw new MenitorError('Usage: menitor check run [id]');
        const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
        if (timeout !== undefined && !(timeout > 0)) throw new MenitorError('--timeout takes a number of seconds');
        const report = checkTask(paths(), rest[0], { commands: !values['no-commands'], timeoutSeconds: timeout });
        if (values.json) json(values['no-diff'] ? { ...report, diff: '' } : report);
        else io.out(renderCheck(report, { diff: !values['no-diff'] }));
        return EXIT.ok;
      }

      case 'learner':
        return runLearner(sub, rest, values, io, paths, json);

      case 'log': {
        if (!sub) throw new MenitorError('Usage: menitor log <event> key=value...');
        appendAgentEvent(paths().log, sub, parseFieldArgs(rest));
        if (values.json) json({ logged: sub });
        else io.out(`Logged ${sub}.`);
        return EXIT.ok;
      }

      case 'stats': {
        const p = paths();
        const plan = requirePlanOrNull(p);
        const events = parseLog(fs.existsSync(p.log) ? fs.readFileSync(p.log, 'utf8') : '');
        const stats = computeStats(plan, events);
        if (values.json) json(stats);
        else io.out(renderStats(stats));
        return EXIT.ok;
      }

      default:
        throw new MenitorError(`Unknown command "${command}". Run "menitor help".`);
    }
  } catch (err) {
    if (err instanceof MenitorError) {
      const details = err.details.length && !err.message.includes('\n') ? `\n${err.details.map((d) => `  - ${d}`).join('\n')}` : '';
      io.err(`menitor: ${err.message}${details}`);
      return err.exit;
    }
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' || e.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
      io.err(`menitor: ${e.message}`);
      return EXIT.error;
    }
    throw err;
  }
}

/**
 * @param {import('./paths.js').StatePaths} p
 */
function requirePlanOrNull(p) {
  return fs.existsSync(p.plan) ? requirePlan(p) : null;
}

/**
 * @typedef {{ root?: string, json: boolean, ids: boolean, note?: string, revisit?: string[], id?: string, override?: string }} Values
 * @typedef {() => import('./paths.js').StatePaths} PathsFn
 * @typedef {(value: unknown) => void} JsonFn
 */

/**
 * @param {string | undefined} sub
 * @param {string[]} rest
 * @param {Values} values
 * @param {IO} io
 * @param {PathsFn} paths
 * @param {JsonFn} json
 */
function runPlan(sub, rest, values, io, paths, json) {
  switch (sub) {
    case 'lint': {
      if (!rest[0]) throw new MenitorError('Usage: menitor plan lint <file|->');
      const { plan, errors, warnings } = lintPlan(paths(), parseJsonInput(readSource(rest[0], io), 'The plan'));
      if (values.json) {
        json({ ok: errors.length === 0, errors, warnings });
      } else if (errors.length) {
        io.err(`The plan is invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}${formatWarnings(warnings)}`);
      } else {
        io.out(`The plan is valid: ${plan.milestones.length} milestones, ${allTasks(plan).length} tasks.${formatWarnings(warnings)}`);
      }
      return errors.length ? EXIT.error : EXIT.ok;
    }
    case 'import': {
      if (!rest[0]) throw new MenitorError('Usage: menitor plan import <file|->');
      const { plan, warnings } = importPlan(paths(), parseJsonInput(readSource(rest[0], io), 'The plan'));
      if (values.json) json({ milestones: plan.milestones.length, tasks: allTasks(plan).length, warnings });
      else io.out(`Saved the plan: ${plan.milestones.length} milestones, ${allTasks(plan).length} tasks. The learner approves it next.${formatWarnings(warnings)}`);
      return EXIT.ok;
    }
    case 'approve': {
      const p = paths();
      const { plan, first, warnings } = approvePlan(p);
      if (values.json) {
        json({ approvedAt: plan.approvedAt, current: first?.task.id ?? null, warnings });
      } else {
        const card = first ? `\n\n${renderCard(cardData(plan, first.task.id, loadProgress(p)), { ids: values.ids })}` : '';
        io.out(`The plan is approved and locked.${formatWarnings(warnings)}${card}`);
      }
      return EXIT.ok;
    }
    case 'show': {
      const p = paths();
      const plan = requirePlan(p);
      if (values.json) json(plan);
      else io.out(renderOutline(plan, loadSession(p).currentTask));
      return EXIT.ok;
    }
    case 'deploy-url': {
      if (!rest[0]) throw new MenitorError('Usage: menitor plan deploy-url <url>');
      setDeployUrl(paths(), rest[0]);
      if (values.json) json({ deployUrl: rest[0] });
      else io.out(`Recorded the deployed URL: ${rest[0]}`);
      return EXIT.ok;
    }
    default:
      throw new MenitorError('Usage: menitor plan <lint|import|approve|show|deploy-url>');
  }
}

/**
 * @param {string | undefined} sub
 * @param {string[]} rest
 * @param {Values} values
 * @param {IO} io
 * @param {PathsFn} paths
 * @param {JsonFn} json
 */
function runTask(sub, rest, values, io, paths, json) {
  const p = paths();
  switch (sub) {
    case 'show': {
      const plan = requirePlan(p);
      const entry = resolveTask(plan, loadSession(p), rest[0]);
      const card = cardData(plan, entry.task.id, loadProgress(p));
      if (values.json) json(card);
      else io.out(renderCard(card, { ids: values.ids }));
      return EXIT.ok;
    }
    case 'brief': {
      const brief = briefData(p, rest[0]);
      if (values.json) json(brief);
      else io.out(renderBrief(brief));
      return EXIT.ok;
    }
    case 'hint': {
      const { entry, hint, number } = revealHint(p, rest[0]);
      if (values.json) json({ task: entry.task.id, number, rung: hint.rung, text: hint.text });
      else io.out(`Hint ${number}/4 for ${entry.task.id} (${hint.rung}):\n${hint.text}`);
      return EXIT.ok;
    }
    case 'fix': {
      const { entry, added } = fixTask(p, values.id, rest);
      if (values.json) json({ task: entry.task.id, added });
      else io.out(`Added ${added.length} fix${added.length === 1 ? '' : 'es'} to ${entry.task.id}: ${added.map((i) => i.id).join(', ')}`);
      return EXIT.ok;
    }
    case 'pass': {
      const { passed, next, plan } = passTask(p, rest[0], { note: values.note, revisit: values.revisit, override: values.override });
      if (values.json) {
        json({ passed: passed.task.id, by: passed.task.owner, next: next?.task.id ?? null });
      } else {
        const head = `Passed ${passed.task.id} (${passed.task.owner === 'learner' ? 'written by the learner' : 'delegated'}).`;
        const tail = next ? `\n\n${renderCard(cardData(plan, next.task.id, loadProgress(p)), { ids: values.ids })}` : '\nEvery task in the plan is done.';
        io.out(`${head}${tail}`);
      }
      return EXIT.ok;
    }
    case 'skip': {
      const { entry, alreadyDelegated } = skipTask(p, rest[0]);
      if (values.json) json({ task: entry.task.id, owner: 'delegated', alreadyDelegated });
      else if (alreadyDelegated) io.out(`${entry.task.id} is already delegated. Do the work, then commit it with the trailer "Menitor-Delegated: true".`);
      else io.out(`${entry.task.id} is now delegated because the learner skipped it. Do the work, then commit it with the trailer "Menitor-Delegated: true".`);
      return EXIT.ok;
    }
    default:
      throw new MenitorError('Usage: menitor task <show|brief|hint|fix|pass|skip> [id]');
  }
}

/**
 * @param {string | undefined} sub
 * @param {string[]} rest
 * @param {Values} values
 * @param {IO} io
 * @param {PathsFn} paths
 * @param {JsonFn} json
 */
function runLearner(sub, rest, values, io, paths, json) {
  const p = paths();
  const [key, ...words] = rest;
  const value = words.join(' ');
  /** @type {import('./learner.js').Learner} */
  let learner;
  switch (sub) {
    case 'show':
      learner = loadLearner(p);
      break;
    case 'set':
      if (!key || !value) throw new MenitorError('Usage: menitor learner set <level|list> <value>');
      learner = learnerSet(p, key, value);
      break;
    case 'add':
      if (!key || !value) throw new MenitorError('Usage: menitor learner add <list> <text>');
      learner = learnerAdd(p, key, value);
      break;
    case 'remove':
      if (!key || !value) throw new MenitorError('Usage: menitor learner remove <list> <text>');
      learner = learnerRemove(p, key, value);
      break;
    case 'note':
      if (!rest.length) throw new MenitorError('Usage: menitor learner note <text>');
      learner = learnerNote(p, rest.join(' '));
      break;
    default:
      throw new MenitorError('Usage: menitor learner <show|set|add|remove|note>');
  }
  if (values.json) json(learner.profile);
  else io.out(renderLearner(learner));
  return EXIT.ok;
}
