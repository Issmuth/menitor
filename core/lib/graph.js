// The context graph (ADR 17): doc sections, tasks and project files, and the links between them.
//
// It is built from what Menitor already has: Markdown headings give the sections, the plan gives
// each task its section, git gives the files each task changed, and paths and import lines give the
// rest. It lives in .menitor/graph.json, written only by the CLI, and can always be rebuilt. A query
// first refreshes it: files whose size and modified time are unchanged are not read again, so a
// fresh graph answers without opening a single project file.

import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.js';
import { slugify } from './docs.js';

export const GRAPH_VERSION = 1;
/** Source files larger than this are listed but not read for links. */
const MAX_READ_BYTES = 200_000;
const CODE = /\.(m?js|cjs|jsx|ts|tsx|mts|cts|py)$/;
const SKIP_DIRS = new Set(['.git', '.menitor', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next']);
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'composer.lock', 'uv.lock']);
const JS_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.json'];

/**
 * @typedef {import('./paths.js').StatePaths} StatePaths
 * @typedef {import('./plan.js').Plan} Plan
 * @typedef {import('./state.js').Session} Session
 * @typedef {{ anchor: string, heading: string, level: number, start: number, end: number, chars: number, mentions: string[], links: string[] }} Section
 * @typedef {{ key: string, size: number, sections?: Section[], imports?: string[] }} FileNode
 * @typedef {{ section: string | null, range: string | null, touched: string[] }} TaskNode
 * @typedef {{ version: 1, files: Record<string, FileNode>, tasks: Record<string, TaskNode> }} Graph
 */

/** @returns {Graph} */
export function emptyGraph() {
  return { version: GRAPH_VERSION, files: {}, tasks: {} };
}

/**
 * The project's files, as paths from the root with forward slashes: what git tracks or would track,
 * or a walk of the folder outside a repo. Menitor's state and lockfiles are left out.
 * @param {string} root
 * @returns {string[]}
 */
export function projectFiles(root) {
  const listed = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  /** @type {string[]} */
  let files;
  if (listed !== null) {
    files = listed.split('\0').filter(Boolean);
  } else {
    files = [];
    /** @param {string} dir */
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(rel);
        } else if (entry.isFile()) files.push(rel);
      }
    };
    walk('');
  }
  return files.filter((f) => !f.startsWith('.menitor/') && !LOCKFILES.has(path.posix.basename(f))).sort();
}

/**
 * Every section of a Markdown file, with its line range and what it names: code-formatted paths and
 * Markdown links. Headings inside code fences don't count, and neither do paths inside them.
 * @param {string} markdown
 * @returns {Section[]}
 */
export function parseSections(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  /** @type {{ anchor: string, heading: string, level: number, start: number }[]} */
  const heads = [];
  /** @type {Map<string, number>} */
  const seen = new Map();
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    // GitHub numbers repeated headings: setup, setup-1, setup-2.
    const base = slugify(m[2]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    heads.push({ anchor: count ? `${base}-${count}` : base, heading: m[2], level: m[1].length, start: i + 1 });
  }
  return heads.map((h, i) => {
    const next = heads.slice(i + 1).find((x) => x.level <= h.level);
    const end = next ? next.start - 1 : lines.length;
    const body = lines.slice(h.start - 1, end);
    return { ...h, end, chars: body.join('\n').length, ...namesIn(body) };
  });
}

/**
 * What a section names, outside code fences: inline code that looks like a path, and link targets.
 * @param {string[]} lines
 */
function namesIn(lines) {
  /** @type {Set<string>} */
  const mentions = new Set();
  /** @type {Set<string>} */
  const links = new Set();
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const text = m[1].trim().replace(/^\.\//, '');
      if (/^[\w@.\-/]+$/.test(text) && (text.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(text)) && !/^\.+$/.test(text)) mentions.add(text);
    }
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(m[1])) links.add(m[1]);
    }
  }
  return { mentions: [...mentions], links: [...links] };
}

/**
 * The import lines of a JavaScript, TypeScript or Python file, as written. Only relative imports in
 * JavaScript and TypeScript can be project files; Python keeps its module paths.
 * @param {string} file
 * @param {string} source
 * @returns {string[]}
 */
export function parseImports(file, source) {
  /** @type {Set<string>} */
  const found = new Set();
  if (file.endsWith('.py')) {
    for (const m of source.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+([\w*,\s()]+)/gm)) {
      const mod = m[1];
      if (/^\.+$/.test(mod)) for (const name of m[2].replace(/[()]/g, '').split(',')) found.add(`${mod}${name.trim()}`);
      else found.add(mod);
    }
    for (const m of source.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) for (const mod of m[1].split(',')) found.add(mod.trim());
  } else {
    // Type imports in JSDoc and examples in comments are not real imports.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
    const re = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const m of code.matchAll(re)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (spec && spec.startsWith('.')) found.add(spec);
    }
  }
  return [...found].filter(Boolean);
}

/**
 * The project file an import line points at, if it is one.
 * @param {string} from the importing file
 * @param {string} spec as written
 * @param {Set<string>} files
 */
export function resolveImport(from, spec, files) {
  const dir = path.posix.dirname(from);
  if (from.endsWith('.py')) {
    const dots = /^\.*/.exec(spec)?.[0].length ?? 0;
    const rest = spec.slice(dots).replace(/\./g, '/');
    /** @type {string[]} */
    const bases = [];
    if (dots) {
      let base = dir;
      for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
      bases.push(path.posix.join(base, rest));
    } else {
      bases.push(rest, `src/${rest}`, path.posix.join(dir, rest));
    }
    for (const b of bases) for (const c of [`${b}.py`, `${b}/__init__.py`]) if (files.has(path.posix.normalize(c))) return path.posix.normalize(c);
    return null;
  }
  const base = path.posix.normalize(path.posix.join(dir, spec));
  /** @type {string[]} */
  const tries = [base, ...JS_EXTS.map((e) => base + e), ...JS_EXTS.map((e) => `${base}/index${e}`)];
  // TypeScript code imports "./x.js" for the file x.ts.
  if (/\.(m|c)?js$/.test(base)) tries.push(...['.ts', '.tsx', '.mts', '.cts'].map((e) => base.replace(/\.(m|c)?js$/, e)));
  return tries.find((t) => files.has(t)) ?? null;
}

/**
 * A path named in a doc, resolved against the root first and then the doc's folder.
 * @param {string} doc
 * @param {string} name
 * @param {Set<string>} files
 */
function resolveName(doc, name, files) {
  const clean = name.split('#')[0];
  if (!clean) return null;
  for (const c of [clean, path.posix.join(path.posix.dirname(doc), clean)]) {
    const n = path.posix.normalize(c);
    if (files.has(n)) return n;
  }
  return null;
}

/**
 * The files a task changed: between its start commit and the start of the task that began after it,
 * or HEAD and the working tree for the task in progress.
 * @param {string} root
 * @param {string} from
 * @param {string | null} to null for the task in progress
 */
function changedFiles(root, from, to) {
  // The task's own commits: first parents only, without merges, so work merged in from other
  // branches (other tasks' pull requests) isn't counted as this task's. On a straight history this is
  // every commit in the range.
  const names = (git(root, ['log', '--first-parent', '--no-merges', '--name-only', '--format=', `${from}..${to ?? 'HEAD'}`, '--', '.', ':(exclude).menitor']) ?? '').split('\n');
  if (!to) {
    // The task in progress: also what isn't committed yet.
    names.push(...(git(root, ['diff', '--name-only', 'HEAD', '--', '.', ':(exclude).menitor']) ?? '').split('\n'));
    names.push(...(git(root, ['ls-files', '--others', '--exclude-standard']) ?? '').split('\n'));
  }
  return [...new Set(names.filter(Boolean))].filter((f) => !LOCKFILES.has(path.posix.basename(f))).sort();
}

/**
 * Bring the graph up to date with the project: read only the files that changed, drop the ones that
 * are gone, and recompute what each task touched when its commits moved.
 * @param {string} root
 * @param {Graph} graph
 * @param {Plan | null} plan
 * @param {Session} session
 * @returns {{ graph: Graph, read: number, changed: boolean }}
 */
export function refreshGraph(root, graph, plan, session) {
  const next = /** @type {Graph} */ (JSON.parse(JSON.stringify(graph)));
  let read = 0;
  let changed = false;
  const listed = projectFiles(root);
  const present = new Set(listed);
  for (const file of Object.keys(next.files)) {
    if (!present.has(file)) {
      delete next.files[file];
      changed = true;
    }
  }
  for (const file of listed) {
    let stat;
    try {
      stat = fs.statSync(path.join(root, file));
    } catch {
      continue;
    }
    const key = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    if (next.files[file]?.key === key) continue;
    changed = true;
    /** @type {FileNode} */
    const node = { key, size: stat.size };
    const readable = stat.size <= MAX_READ_BYTES && (file.endsWith('.md') || CODE.test(file));
    if (readable) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      read += 1;
      if (file.endsWith('.md')) node.sections = parseSections(text);
      else node.imports = parseImports(file, text);
    }
    next.files[file] = node;
  }

  // Tasks: the section each links, and the files it changed between its start and the next start.
  const started = Object.entries(session.tasks)
    .filter(([, t]) => t.startCommit)
    .sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt));
  const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  /** @type {Record<string, TaskNode>} */
  const tasks = {};
  for (const m of plan?.milestones ?? []) {
    for (const t of m.tasks) {
      const i = started.findIndex(([id]) => id === t.id);
      const from = i >= 0 ? started[i][1].startCommit : null;
      const current = session.currentTask === t.id;
      const to = i >= 0 && !current ? (started[i + 1]?.[1].startCommit ?? null) : null;
      // The key names how files are counted ("fp": first parents), so a change of method recounts.
      const range = from && (to || current) ? `fp:${from}..${to ?? `HEAD@${head}`}` : null;
      const old = next.tasks[t.id];
      // A finished task's range never moves; the task in progress is measured again each time.
      const touched = range && old?.range === range && !current ? old.touched : from && (to || current) ? changedFiles(root, from, to) : [];
      tasks[t.id] = { section: t.docs ?? null, range, touched };
      if (JSON.stringify(tasks[t.id]) !== JSON.stringify(old)) changed = true;
    }
  }
  if (Object.keys(next.tasks).some((id) => !tasks[id])) changed = true;
  next.tasks = tasks;
  return { graph: next, read, changed };
}

/**
 * The links of the graph, worked out from what it stores: imports resolved to files, and which
 * sections and tasks name each file. Nothing is read from disk.
 * @param {Graph} graph
 */
export function linksOf(graph) {
  const files = new Set(Object.keys(graph.files));
  /** @type {Map<string, Set<string>>} */
  const imports = new Map();
  /** @type {Map<string, Set<string>>} */
  const importedBy = new Map();
  /** @type {Map<string, Set<string>>} */
  const namedBy = new Map();
  const add = (/** @type {Map<string, Set<string>>} */ map, /** @type {string} */ key, /** @type {string} */ value) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)?.add(value);
  };
  for (const [file, node] of Object.entries(graph.files)) {
    for (const spec of node.imports ?? []) {
      const target = resolveImport(file, spec, files);
      if (target && target !== file) {
        add(imports, file, target);
        add(importedBy, target, file);
      }
    }
    for (const s of node.sections ?? []) {
      for (const name of [...s.mentions, ...s.links]) {
        const target = resolveName(file, name, files);
        if (target && target !== file) add(namedBy, target, `${file}#${s.anchor}`);
      }
    }
  }
  return { files, imports, importedBy, namedBy };
}

/**
 * A section by its link, such as "docs/prd.md#sign-up", or the whole file without an anchor.
 * @param {Graph} graph
 * @param {string} link
 */
export function findSection(graph, link) {
  const [file, anchor = null] = link.split('#');
  const node = graph.files[file];
  if (!node?.sections) return null;
  if (!anchor) return { file, anchor: null, heading: null, start: 1, end: Math.max(1, ...node.sections.map((s) => s.end)), chars: node.size, mentions: node.sections.flatMap((s) => s.mentions), links: node.sections.flatMap((s) => s.links) };
  const s = node.sections.find((x) => x.anchor === anchor.toLowerCase());
  return s ? { file, ...s } : null;
}

/**
 * What a task touches: the section it links, the files that section names, the files the task
 * changed, and one step out from those along imports, with each file's size, so the reader opens
 * only what matters. Earlier tasks that touched the same files are listed too.
 * @param {Graph} graph
 * @param {string} taskId
 */
export function taskTouches(graph, taskId) {
  const task = graph.tasks[taskId];
  if (!task) return null;
  const { files, imports, importedBy } = linksOf(graph);
  const section = task.section ? findSection(graph, task.section) : null;
  const sectionFile = task.section ? task.section.split('#')[0] : null;
  const named = section ? [...new Set([...section.mentions, ...section.links].map((n) => resolveName(sectionFile ?? '', n, files)).filter((f) => f && f !== sectionFile))] : [];
  const touched = task.touched.filter((f) => files.has(f));
  const core = new Set([...named, ...touched].filter(/** @returns {f is string} */ (f) => Boolean(f)));
  /** @type {{ path: string, via: string }[]} */
  const near = [];
  for (const f of core) {
    for (const t of imports.get(f) ?? []) if (!core.has(t)) near.push({ path: t, via: `imported by ${f}` });
    for (const t of importedBy.get(f) ?? []) if (!core.has(t)) near.push({ path: t, via: `imports ${f}` });
  }
  const seen = new Set();
  const size = (/** @type {string} */ f) => graph.files[f]?.size ?? 0;
  return {
    task: taskId,
    section: section ? { link: task.section, heading: section.heading, lines: [section.start, section.end], chars: section.chars } : task.section ? { link: task.section, missing: true } : null,
    named: named.filter(/** @returns {f is string} */ (f) => Boolean(f)).map((f) => ({ path: f, size: size(f) })),
    touched: touched.map((f) => ({ path: f, size: size(f) })),
    near: near.filter((n) => !seen.has(n.path) && seen.add(n.path)).map((n) => ({ ...n, size: size(n.path) })),
    earlier: Object.entries(graph.tasks)
      .filter(([id, t]) => id !== taskId && t.touched.some((f) => core.has(f)))
      .map(([id, t]) => ({ task: id, files: t.touched.filter((f) => core.has(f)) })),
  };
}

/**
 * Everything the graph knows about one file: its size, what it imports and what imports it, the
 * sections that name it, and the tasks that changed it.
 * @param {Graph} graph
 * @param {string} file
 */
export function fileLinks(graph, file) {
  const node = graph.files[file];
  if (!node) return null;
  const { imports, importedBy, namedBy } = linksOf(graph);
  return {
    path: file,
    size: node.size,
    imports: [...(imports.get(file) ?? [])].sort(),
    importedBy: [...(importedBy.get(file) ?? [])].sort(),
    namedBy: [...(namedBy.get(file) ?? [])].sort(),
    tasks: Object.entries(graph.tasks)
      .filter(([, t]) => t.touched.includes(file))
      .map(([id]) => id),
  };
}
