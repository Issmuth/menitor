// Best-effort analysis of shell commands (G-2): which files a command would write or delete,
// and whether it changes the repo, adds dependencies or writes files from an inline script.
//
// This is not a full shell parser. It understands quoting, redirects, pipelines, heredocs,
// command substitution, `cd`, `bash -c` and common prefixes such as `sudo` and `env`, which is
// enough to catch the usual ways an agent writes files. A PostToolUse log backs it up.

import path from 'node:path';

/**
 * @typedef {'posix' | 'powershell'} Dialect
 * @typedef {{ type: 'word', value: string, quoted: boolean, subs: string[] }} WordToken
 * @typedef {{ type: 'op', value: string }} OpToken
 * @typedef {WordToken | OpToken} Token
 * @typedef {{ words: WordToken[], redirects: { op: string, target: WordToken | null }[] }} SimpleCommand
 * @typedef {object} Effect
 * @property {'write' | 'delete' | 'git' | 'package' | 'script' | 'state'} kind
 * @property {string} via        what causes it, such as "redirect", "sed -i" or "git commit"
 * @property {string} [path]     the target as written, for write and delete
 * @property {string | null} [cwd] the folder the target is relative to; null when unknown
 */

const CONTROL = new Set([';', '\n', '&&', '||', '|', '|&', '&', ';;', '(', ')', '{', '}']);
const POSIX_OPS = ['&&', '||', ';;', '|&', '&>>', '&>', '>>', '>|', '>&', '<<<', '<<-', '<<', '<>', '<&', '|', '&', ';', '>', '<', '(', ')'];
const PS_OPS = ['&&', '||', '*>>', '*>', '>>', '>', '<', '|', ';', '(', ')', '{', '}'];

/**
 * Find the index just after the bracket that closes the one at `start`, skipping quoted text.
 * @param {string} src
 * @param {number} start index of the opening bracket
 * @param {string} open
 * @param {string} close
 */
function matchBracket(src, start, open, close) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      i = end === -1 ? src.length : end;
    } else if (c === '"') {
      i += 1;
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
    } else if (c === open) {
      depth += 1;
    } else if (c === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/**
 * Split shell source into words and operators.
 * @param {string} src
 * @param {Dialect} [dialect]
 * @returns {Token[]}
 */
export function tokenize(src, dialect = 'posix') {
  /** @type {Token[]} */
  const tokens = [];
  const ops = dialect === 'powershell' ? PS_OPS : POSIX_OPS;
  const escape = dialect === 'powershell' ? '`' : '\\';
  /** @type {string | null} */
  let word = null;
  let quoted = false;
  /** @type {string[]} */
  let subs = [];
  /** @type {{ delim: string, strip: boolean }[]} */
  const heredocs = [];
  /** @type {boolean | null} */
  let expectDelim = null;

  const pushWord = () => {
    if (word === null) return;
    if (expectDelim !== null) {
      heredocs.push({ delim: word, strip: expectDelim });
      expectDelim = null;
    }
    tokens.push({ type: 'word', value: word, quoted, subs });
    word = null;
    quoted = false;
    subs = [];
  };
  /** @param {string} text */
  const append = (text) => {
    word = (word ?? '') + text;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === '\n' || c === '\r') {
      pushWord();
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      i += 1;
      tokens.push({ type: 'op', value: '\n' });
      // Skip heredoc bodies: their text is input, not commands.
      while (heredocs.length) {
        const { delim, strip } = /** @type {{ delim: string, strip: boolean }} */ (heredocs.shift());
        while (i < src.length) {
          const end = src.indexOf('\n', i);
          const line = src.slice(i, end === -1 ? src.length : end).replace(/\r$/, '');
          i = end === -1 ? src.length : end + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t') {
      pushWord();
      i += 1;
      continue;
    }
    if (c === escape) {
      if (src[i + 1] === '\n') {
        i += 2;
      } else {
        append(src[i + 1] ?? '');
        quoted = true;
        i += 2;
      }
      continue;
    }
    if (c === '#' && word === null) {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (dialect === 'powershell' && c === '@' && (src[i + 1] === '"' || src[i + 1] === "'") && word === null) {
      // A here-string: @' ... '@ or @" ... "@
      const q = src[i + 1];
      const end = src.indexOf(`\n${q}@`, i + 2);
      append(src.slice(i + 2, end === -1 ? src.length : end).replace(/^\r?\n/, ''));
      quoted = true;
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (c === "'") {
      if (dialect === 'powershell') {
        let j = i + 1;
        let text = '';
        while (j < src.length) {
          if (src[j] === "'" && src[j + 1] === "'") {
            text += "'";
            j += 2;
          } else if (src[j] === "'") {
            break;
          } else {
            text += src[j];
            j += 1;
          }
        }
        append(text);
        i = j + 1;
      } else {
        const end = src.indexOf("'", i + 1);
        append(src.slice(i + 1, end === -1 ? src.length : end));
        i = end === -1 ? src.length : end + 1;
      }
      quoted = true;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === escape) {
          text += src[j + 1] ?? '';
          j += 2;
        } else if (src[j] === '$' && src[j + 1] === '(') {
          const end = matchBracket(src, j + 1, '(', ')');
          subs.push(src.slice(j + 2, end - 1));
          text += src.slice(j, end);
          j = end;
        } else if (src[j] === '`' && dialect === 'posix') {
          const end = src.indexOf('`', j + 1);
          subs.push(src.slice(j + 1, end === -1 ? src.length : end));
          text += src.slice(j, end === -1 ? src.length : end + 1);
          j = end === -1 ? src.length : end + 1;
        } else {
          text += src[j];
          j += 1;
        }
      }
      append(text);
      quoted = true;
      i = j + 1;
      continue;
    }
    if (c === '`' && dialect === 'posix') {
      const end = src.indexOf('`', i + 1);
      subs.push(src.slice(i + 1, end === -1 ? src.length : end));
      append(src.slice(i, end === -1 ? src.length : end + 1));
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const end = matchBracket(src, i + 1, '(', ')');
      if (src[i + 2] !== '(') subs.push(src.slice(i + 2, end - 1));
      append(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      const end = matchBracket(src, i + 1, '{', '}');
      append(src.slice(i, end));
      i = end;
      continue;
    }
    if (dialect === 'posix' && (c === '<' || c === '>') && src[i + 1] === '(') {
      // Process substitution: <(cmd) or >(cmd)
      const end = matchBracket(src, i + 1, '(', ')');
      subs.push(src.slice(i + 2, end - 1));
      append(src.slice(i, end));
      i = end;
      continue;
    }

    const found = ops.find((o) => src.startsWith(o, i));
    if (found) {
      let op = found;
      // PowerShell writes descriptor duplication as 2>&1 with no & operator of its own.
      if (dialect === 'powershell' && (op === '>' || op === '>>') && src[i + op.length] === '&') op += '&';
      // A redirect with a file descriptor, such as 2> or 2>&1.
      if ((op.startsWith('>') || op.startsWith('<')) && word !== null && !quoted && /^\d+$/.test(word)) {
        const fd = word;
        word = null;
        tokens.push({ type: 'op', value: `${fd}${op}` });
      } else {
        pushWord();
        tokens.push({ type: 'op', value: op });
      }
      if (op === '<<' || op === '<<-') expectDelim = op === '<<-';
      i += op.length;
      continue;
    }

    append(c);
    i += 1;
  }
  pushWord();
  return tokens;
}

/**
 * @param {string} op
 */
function isRedirect(op) {
  return /^(\d*|\*|&)(>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)$/.test(op);
}

/**
 * @param {string} op
 */
function isWriteRedirect(op) {
  return /^(\d*|\*|&)(>>|>\||>&|>|<>)$/.test(op);
}

/**
 * Group tokens into simple commands.
 * @param {Token[]} tokens
 * @returns {SimpleCommand[]}
 */
export function splitCommands(tokens) {
  /** @type {SimpleCommand[]} */
  const commands = [];
  /** @type {SimpleCommand} */
  let cur = { words: [], redirects: [] };
  const finish = () => {
    if (cur.words.length || cur.redirects.length) commands.push(cur);
    cur = { words: [], redirects: [] };
  };
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.type === 'op') {
      if (CONTROL.has(tok.value)) {
        finish();
      } else if (isRedirect(tok.value)) {
        const next = tokens[k + 1];
        if (next && next.type === 'word') {
          cur.redirects.push({ op: tok.value, target: next });
          k += 1;
        } else {
          cur.redirects.push({ op: tok.value, target: null });
        }
      }
    } else {
      cur.words.push(tok);
    }
  }
  finish();
  return commands;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * @param {string} word
 */
function commandName(word) {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/**
 * Drop prefixes such as sudo, env, nohup and xargs so the real command comes first.
 * `fed` is true when xargs passes the command file names that the line doesn't show.
 * @param {string[]} words
 */
function stripPrefixes(words) {
  const w = [...words];
  let fed = false;
  for (let guard = 0; guard < 10 && w.length; guard++) {
    while (w.length && ASSIGNMENT.test(w[0])) w.shift();
    // PowerShell's call operator: & "tool.exe" args
    if (w[0] === '&' || w[0] === '.') {
      w.shift();
      continue;
    }
    const name = commandName(w[0] ?? '');
    if (name === 'sudo' || name === 'doas') {
      w.shift();
      while (w.length && w[0].startsWith('-')) {
        const flag = w.shift();
        if (flag && /^-[ugCDhpRrt]$/.test(flag)) w.shift();
      }
    } else if (name === 'env') {
      w.shift();
      while (w.length && (w[0].startsWith('-') || ASSIGNMENT.test(w[0]))) {
        const flag = w.shift();
        if (flag === '-u' || flag === '-C' || flag === '-S') w.shift();
      }
    } else if (['command', 'builtin', 'exec', 'nohup', 'time', 'stdbuf', 'setsid'].includes(name)) {
      w.shift();
      while (w.length && w[0].startsWith('-')) w.shift();
    } else if (name === 'nice' || name === 'ionice') {
      w.shift();
      while (w.length && w[0].startsWith('-')) {
        const flag = w.shift();
        if (flag && /^-[nc]$/.test(flag)) w.shift();
      }
    } else if (name === 'timeout') {
      w.shift();
      while (w.length && w[0].startsWith('-')) {
        const flag = w.shift();
        if (flag === '-s' || flag === '-k') w.shift();
      }
      w.shift();
    } else if (name === 'xargs') {
      fed = true;
      w.shift();
      while (w.length && w[0].startsWith('-')) {
        const flag = w.shift();
        if (flag && /^-[IndPLsaE]$/.test(flag)) w.shift();
      }
    } else {
      break;
    }
  }
  return { words: w, fed };
}

/**
 * Non-option arguments. Options listed in `withValue` consume the next argument.
 * @param {string[]} args
 * @param {Set<string>} [withValue]
 */
function positionals(args, withValue = new Set()) {
  const out = [];
  let rest = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (rest) {
      out.push(a);
    } else if (a === '--') {
      rest = true;
    } else if (a.startsWith('-') && a.length > 1) {
      if (withValue.has(a)) k += 1;
    } else {
      out.push(a);
    }
  }
  return out;
}

// Git subcommands that never change the working tree, the index or refs.
const GIT_READ = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'annotate', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'ls-remote',
  'cat-file', 'describe', 'shortlog', 'grep', 'merge-base', 'show-ref', 'for-each-ref', 'name-rev', 'whatchanged',
  'count-objects', 'check-ignore', 'check-attr', 'var', 'help', 'version', 'fetch', 'range-diff', 'cherry',
  'verify-commit', 'verify-tag', 'show-branch', 'fsck',
]);

/**
 * @param {string} sub
 * @param {string[]} args
 */
function isReadOnlyGit(sub, args) {
  if (!sub || sub === '--version' || sub === '--help' || sub === '-h') return true;
  if (GIT_READ.has(sub)) return true;
  const pos = positionals(args, new Set(['--sort', '--format', '--contains', '--merged', '--no-merged', '--points-at', '--color']));
  const has = (/** @type {string[]} */ ...flags) => args.some((a) => flags.includes(a));
  switch (sub) {
    case 'branch':
      if (has('-d', '-D', '-m', '-M', '-c', '-C', '-f', '--delete', '--move', '--copy', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description')) return false;
      return pos.length === 0 || has('-l', '--list');
    case 'tag':
      if (has('-d', '--delete', '-a', '-s', '-f', '-m', '--force')) return false;
      return pos.length === 0 || has('-l', '--list');
    case 'remote':
      return args.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(args[0]);
    case 'config':
      if (has('--unset', '--unset-all', '--add', '--replace-all', '--edit', '-e', '--rename-section', '--remove-section')) return false;
      return has('--get', '--get-all', '--get-regexp', '--list', '-l') || pos.length <= 1;
    case 'stash':
      return ['list', 'show'].includes(args[0]);
    case 'worktree':
      return args[0] === 'list';
    case 'reflog':
      return args.length === 0 || args[0] === 'show' || args[0].startsWith('-');
    case 'notes':
      return args.length === 0 || ['list', 'show'].includes(args[0]);
    case 'submodule':
      return args.length === 0 || args[0] === 'status';
    case 'symbolic-ref':
      return pos.length <= 1 && !has('-d', '--delete');
    case 'lfs':
      return ['ls-files', 'status', 'env', 'version'].includes(args[0]);
    default:
      return false;
  }
}

/**
 * @param {string[]} args
 */
function gitSubcommand(args) {
  let cwdChange = null;
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) {
    const a = args[k];
    if (a === '-C') {
      cwdChange = args[k + 1] ?? null;
      k += 2;
    } else if (a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') {
      k += 2;
    } else if (a === '--version' || a === '--help' || a === '-h') {
      return { sub: a, rest: [], cwdChange };
    } else {
      k += 1;
    }
  }
  return { sub: args[k] ?? '', rest: args.slice(k + 1), cwdChange };
}

const PM = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const SCAFFOLD_WORDS = new Set(['init', 'new', 'create', 'generate', 'g', 'add', 'scaffold', 'migrate', 'startproject', 'startapp']);

/**
 * Does running this package create project files (create-*, `prisma init`, `shadcn add`)?
 * @param {string[]} args
 */
function runnerScaffolds(args) {
  const pos = positionals(args, new Set(['-p', '--package', '-c', '--call']));
  const pkg = (pos[0] ?? '').replace(/@[^/@]*$/, '');
  const base = pkg.split('/').pop() ?? '';
  return base.startsWith('create-') || pos.slice(1).some((a) => SCAFFOLD_WORDS.has(a));
}

/**
 * @param {string} name
 * @param {string[]} args
 * @returns {string | null} what the command changes, or null when it only runs or restores
 */
function packageChange(name, args) {
  if (RUNNERS.has(name)) return runnerScaffolds(args) ? `${name} ${args.join(' ')}`.trim() : null;
  const opts = new Set(['--prefix', '-C', '--dir', '--filter', '-F', '--cwd', '-w', '--workspace']);
  const pos = positionals(args, opts);
  const sub = pos[0] ?? '';
  const rest = pos.slice(1);
  if (['exec', 'x', 'dlx'].includes(sub)) {
    const after = args.slice(args.indexOf(sub) + 1);
    return runnerScaffolds(after) ? `${name} ${sub} ${after.join(' ')}`.trim() : null;
  }
  if (['install', 'i', 'in', 'ins', 'isntall', 'add'].includes(sub)) {
    if (sub === 'add' || rest.length) return `${name} ${sub} ${rest.join(' ')}`.trim();
    return null;
  }
  if (['uninstall', 'remove', 'rm', 'r', 'un', 'unlink', 'update', 'up', 'upgrade', 'create', 'init', 'innit', 'version'].includes(sub)) {
    return `${name} ${sub}`;
  }
  if (sub === 'pkg' && ['set', 'delete', 'fix'].includes(rest[0])) return `${name} pkg ${rest[0]}`;
  return null;
}

/** Other ecosystems' commands that add dependencies or generate project files. */
const OTHER_PM = /** @type {Record<string, Set<string>>} */ ({
  cargo: new Set(['add', 'remove', 'new', 'init']),
  poetry: new Set(['add', 'remove', 'new', 'init']),
  uv: new Set(['add', 'remove', 'init']),
  go: new Set(['get', 'mod']),
  composer: new Set(['require', 'remove', 'create-project', 'init']),
  dotnet: new Set(['new', 'add', 'remove']),
  rails: new Set(['new', 'generate', 'g']),
  'django-admin': new Set(['startproject', 'startapp']),
});

const INLINE_FLAGS = /** @type {Record<string, Set<string>>} */ ({
  node: new Set(['-e', '--eval', '-p', '--print']),
  deno: new Set(['eval']),
  bun: new Set(['-e', '--eval']),
  python: new Set(['-c']),
  python3: new Set(['-c']),
  py: new Set(['-c']),
  ruby: new Set(['-e']),
  perl: new Set(['-e', '-E']),
  php: new Set(['-r']),
});

const SCRIPT_WRITE =
  /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|cpSync|renameSync|rmSync|unlinkSync|rmdirSync|truncateSync|file_put_contents|write_text|write_bytes|writeTextFile|WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText)\b|\bshutil\.(copy\w*|move|rmtree)\b|\bos\.(rename|remove|unlink|replace)\b|\bopen\([^)]*,\s*['"][wax]|\bFile\.(write|delete|rename)\b|\bIO\.write\b|\bBun\.write\b|\bfs\.(cp|rm|rename|unlink|writeFile|appendFile)\b|\[(System\.)?IO\.File\]::(Write|Append|Copy|Move|Delete|Create)/i;

/** Inline code that reaches into Menitor's own state or guard. */
const STATE_TOUCH = /\.menitor\b|guard\.js|saveGuard|applyLearnerCommand|saveSession|savePlan|saveProgress|saveLearner/;

/**
 * Inline code passed to an interpreter, if any.
 * @param {string} name
 * @param {string[]} args
 */
function inlineCode(name, args) {
  const flags = INLINE_FLAGS[name];
  if (!flags) return null;
  for (let k = 0; k < args.length; k++) {
    if (flags.has(args[k])) return args[k + 1] ?? '';
    // Combined forms such as -pe or -ne for perl, or --eval=...
    if (name === 'perl' && /^-[a-zA-Z]*e$/.test(args[k])) return args[k + 1] ?? '';
    if (args[k].startsWith('--eval=')) return args[k].slice(7);
  }
  return null;
}

// PowerShell cmdlets and their common aliases.
const PS_WRITE = new Set(['set-content', 'add-content', 'ac', 'out-file', 'new-item', 'ni', 'tee-object', 'clear-content', 'clc', 'export-csv', 'export-clixml']);
const PS_DELETE = new Set(['remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir', 'rm']);
const PS_COPY = new Set(['copy-item', 'copy', 'cpi', 'cp']);
const PS_MOVE = new Set(['move-item', 'move', 'mi', 'mv', 'rename-item', 'ren', 'rni']);
const PS_CD = new Set(['set-location', 'sl', 'cd', 'chdir', 'push-location', 'pushd']);
const PS_WEB = new Set(['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'start-bitstransfer']);
const PS_PATH_PARAMS = new Set(['-path', '-literalpath', '-filepath', '-destination', '-outfile', '-pspath', '-lp']);
const PS_VALUE_PARAMS = new Set(['-value', '-encoding', '-itemtype', '-type', '-name', '-newname', '-delimiter', '-inputobject', '-width', '-filter', '-include', '-exclude', '-credential', '-uri', '-method', '-body', '-headers', '-contenttype', '-source']);

/**
 * @param {string[]} args
 */
function psArgs(args) {
  /** @type {string[]} */
  const pathParams = [];
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {string[]} */
  const pos = [];
  for (let k = 0; k < args.length; k++) {
    const raw = args[k];
    const lower = raw.toLowerCase();
    const [flag, inline] = lower.includes(':') && lower.startsWith('-') ? [lower.slice(0, lower.indexOf(':')), raw.slice(raw.indexOf(':') + 1)] : [lower, null];
    if (PS_PATH_PARAMS.has(flag)) {
      const v = inline ?? args[++k];
      if (v !== undefined) pathParams.push(v);
    } else if (PS_VALUE_PARAMS.has(flag)) {
      const v = inline ?? args[++k];
      if (v !== undefined) values[flag] = v;
    } else if (raw.startsWith('-') && raw.length > 1) {
      // A switch such as -Force or -Recurse.
    } else {
      pos.push(raw);
    }
  }
  return { pathParams, values, pos };
}

/**
 * Analyze a command line and list its effects.
 * @param {string} source
 * @param {{ dialect?: Dialect, cwd?: string | null, depth?: number }} [options]
 * @returns {Effect[]}
 */
export function analyzeCommand(source, options = {}) {
  const dialect = options.dialect ?? 'posix';
  const depth = options.depth ?? 0;
  /** @type {Effect[]} */
  const effects = [];
  if (depth > 4) return effects;
  /** @type {string | null} */
  let cwd = options.cwd ?? null;

  /**
   * @param {string} target
   * @param {string} via
   * @param {string | null} [base]
   */
  const write = (target, via, base = cwd) => effects.push({ kind: 'write', path: target, via, cwd: base });
  /**
   * @param {string} target
   * @param {string} via
   */
  const del = (target, via) => effects.push({ kind: 'delete', path: target, via, cwd });
  /**
   * @param {string} src
   * @param {Dialect} [d]
   */
  const nested = (src, d = dialect) => effects.push(...analyzeCommand(src, { dialect: d, cwd, depth: depth + 1 }));

  for (const cmd of splitCommands(tokenize(source, dialect))) {
    for (const w of cmd.words) for (const sub of w.subs) nested(sub);
    for (const r of cmd.redirects) {
      for (const sub of r.target?.subs ?? []) nested(sub);
      if (!isWriteRedirect(r.op) || !r.target) continue;
      const t = r.target.value;
      if (r.op.endsWith('>&') && /^(\d+|-)$/.test(t)) continue; // 2>&1 duplicates a descriptor
      write(t, 'redirect');
    }

    const { words, fed } = stripPrefixes(cmd.words.map((w) => w.value));
    if (!words.length) continue;
    const name = commandName(words[0]);
    const args = words.slice(1);
    const before = effects.length;

    if (dialect === 'powershell') {
      if (/\[(System\.)?IO\.File\]::(Write|Append|Copy|Move|Delete|Create)/i.test(words.join(' '))) {
        effects.push({ kind: 'script', via: 'a .NET file call' });
        continue;
      }
      if (PS_CD.has(name)) {
        const { pathParams, pos } = psArgs(args);
        const target = pathParams[0] ?? pos[0];
        cwd = target && cwd !== null && !/[$`]/.test(target) ? path.resolve(cwd, target) : null;
        continue;
      }
      if (PS_WRITE.has(name)) {
        const { pathParams, values, pos } = psArgs(args);
        const targets = [...pathParams, ...pos.slice(0, 1)];
        if (values['-name']) targets.push(targets.length ? path.join(targets[0], values['-name']) : values['-name']);
        for (const t of targets) write(t, name);
        continue;
      }
      if (PS_DELETE.has(name)) {
        const { pathParams, pos } = psArgs(args);
        for (const t of [...pathParams, ...pos]) del(t, name);
        continue;
      }
      if (PS_COPY.has(name) || PS_MOVE.has(name)) {
        const { pathParams, values, pos } = psArgs(args);
        const all = [...pathParams, ...pos];
        const isRename = ['rename-item', 'ren', 'rni'].includes(name);
        if (PS_MOVE.has(name) && all[0]) del(all[0], name);
        if (isRename) {
          const newName = values['-newname'] ?? pos[1];
          if (newName && all[0]) write(path.join(path.dirname(all[0]), newName), name);
        } else if (all.length >= 2) {
          write(all[all.length - 1], name);
        } else if (all.length === 1 && PS_COPY.has(name)) {
          write('.', name);
        }
        continue;
      }
      if (PS_WEB.has(name)) {
        const { pathParams } = psArgs(args);
        for (const t of pathParams) write(t, name);
        continue;
      }
      if (name === 'powershell' || name === 'pwsh') {
        const k = args.findIndex((a) => /^-(c|command)$/i.test(a));
        if (k !== -1) nested(args.slice(k + 1).join(' '), 'powershell');
        continue;
      }
    }

    switch (name) {
      case 'cd':
      case 'pushd':
      case 'chdir': {
        const target = args.find((a) => !a.startsWith('-'));
        cwd = target && cwd !== null && !/[$`~]/.test(target) && target !== '-' ? path.resolve(cwd, target) : null;
        break;
      }
      case 'bash':
      case 'sh':
      case 'zsh':
      case 'dash':
      case 'ksh':
      case 'fish': {
        const k = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
        if (k !== -1 && args[k + 1] !== undefined) nested(args[k + 1], 'posix');
        break;
      }
      case 'powershell':
      case 'pwsh': {
        const k = args.findIndex((a) => /^-(c|command)$/i.test(a));
        if (k !== -1) nested(args.slice(k + 1).join(' '), 'powershell');
        break;
      }
      case 'cmd': {
        const k = args.findIndex((a) => /^\/[ck]$/i.test(a));
        if (k !== -1) nested(args.slice(k + 1).join(' '), 'posix');
        break;
      }
      case 'eval':
        nested(args.join(' '), 'posix');
        break;
      case 'find': {
        const start = args.find((a) => !a.startsWith('-') && a !== '!' && a !== '(') ?? '.';
        if (args.includes('-delete')) del(start, 'find -delete');
        for (let k = 0; k < args.length; k++) {
          if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[k])) continue;
          const end = args.findIndex((a, j) => j > k && (a === ';' || a === '+'));
          const inner = args.slice(k + 1, end === -1 ? args.length : end).map((a) => (a === '{}' ? start : a));
          nested(inner.map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a)).join(' '), 'posix');
          if (end !== -1) k = end;
        }
        break;
      }
      case 'tee':
        for (const t of positionals(args)) write(t, 'tee');
        break;
      case 'sed': {
        if (!args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) break;
        const scripted = args.some((a) => ['-e', '-f', '--expression', '--file'].includes(a) || a.startsWith('--expression='));
        const pos = positionals(args, new Set(['-e', '-f', '--expression', '--file', '-l']));
        for (const t of scripted ? pos : pos.slice(1)) write(t, 'sed -i');
        break;
      }
      case 'perl':
      case 'ruby': {
        const code = inlineCode(name, args);
        if (code !== null && STATE_TOUCH.test(code)) {
          effects.push({ kind: 'state', via: `${name} -e` });
          break;
        }
        if (args.some((a) => /^-[a-zA-Z]*i/.test(a))) {
          const pos = positionals(args, new Set(['-e', '-E', '-I', '-M']));
          const files = code !== null ? pos.filter((p) => p !== code) : pos.slice(1);
          if (files.length) for (const t of files) write(t, `${name} -i`);
          else write('.', `${name} -i`);
        } else if (code !== null && SCRIPT_WRITE.test(code)) {
          effects.push({ kind: 'script', via: `${name} -e` });
        }
        break;
      }
      case 'cp':
      case 'install':
      case 'ln':
      case 'rsync':
      case 'scp':
      case 'mv': {
        const withValue = new Set(['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group', '-e', '--exclude', '--include']);
        const target = args.find((a, k) => args[k - 1] === '-t' || args[k - 1] === '--target-directory') ?? args.find((a) => a.startsWith('--target-directory='))?.slice(19);
        const pos = positionals(args, withValue);
        if (name === 'mv') for (const src of target ? pos : pos.slice(0, -1)) del(src, 'mv');
        if (target) write(target, name);
        else if (pos.length >= 2) write(pos[pos.length - 1], name);
        break;
      }
      case 'rm':
      case 'rmdir':
      case 'unlink':
      case 'shred':
      case 'trash':
        for (const t of positionals(args)) del(t, name);
        break;
      case 'truncate':
        for (const t of positionals(args, new Set(['-s', '--size', '-r', '--reference']))) write(t, 'truncate');
        break;
      case 'dd':
        for (const a of args) if (a.startsWith('of=')) write(a.slice(3), 'dd');
        break;
      case 'curl': {
        for (let k = 0; k < args.length; k++) {
          const a = args[k];
          if (a === '-o' || a === '--output' || (/^-[a-zA-Z]*o$/.test(a) && !a.startsWith('--'))) {
            if (args[k + 1] && args[k + 1] !== '-') write(args[k + 1], 'curl -o');
            k += 1;
          } else if (a.startsWith('--output=')) {
            write(a.slice(9), 'curl -o');
          } else if (a === '-O' || a === '--remote-name' || a === '--remote-name-all' || /^-[a-zA-Z]*O[a-zA-Z]*$/.test(a)) {
            write('.', 'curl -O');
          }
        }
        break;
      }
      case 'wget': {
        let target = '.';
        for (let k = 0; k < args.length; k++) {
          const a = args[k];
          if (a === '-O' || a === '--output-document') target = args[++k] ?? '.';
          else if (a.startsWith('--output-document=')) target = a.slice(18);
          else if (/^-[a-zA-Z]*O/.test(a) && !a.startsWith('--')) target = a.slice(a.indexOf('O') + 1) || (args[++k] ?? '.');
          else if (a === '-P' || a === '--directory-prefix') target = args[++k] ?? '.';
          else if (a === '--spider') target = '-';
        }
        if (target !== '-') write(target, 'wget');
        break;
      }
      case 'patch':
        if (!args.includes('--dry-run')) write(args.find((a, k) => args[k - 1] === '-o') ?? '.', 'patch');
        break;
      case 'git': {
        const { sub, rest, cwdChange } = gitSubcommand(args);
        if (!isReadOnlyGit(sub, rest)) {
          effects.push({ kind: 'git', via: `git ${sub}`, cwd: cwdChange && cwd ? path.resolve(cwd, cwdChange) : cwd });
        }
        break;
      }
      default: {
        if (PM.has(name) || RUNNERS.has(name)) {
          const change = packageChange(name, args);
          if (change) effects.push({ kind: 'package', via: change });
        } else if (OTHER_PM[name]) {
          const sub = positionals(args)[0];
          if (sub && OTHER_PM[name].has(sub)) effects.push({ kind: 'package', via: `${name} ${sub}` });
        }
        const code = inlineCode(name, args);
        const flag = `${name} ${INLINE_FLAGS[name] ? [...INLINE_FLAGS[name]][0] : ''}`.trim();
        if (code !== null && STATE_TOUCH.test(code)) effects.push({ kind: 'state', via: flag });
        else if (code !== null && SCRIPT_WRITE.test(code)) effects.push({ kind: 'script', via: flag });
        if ((name === 'python' || name === 'python3' || name === 'py') && args[0] === '-m' && args[1] === 'django' && ['startproject', 'startapp'].includes(args[2])) {
          effects.push({ kind: 'package', via: `django ${args[2]}` });
        }
      }
    }

    // xargs supplies file names the line doesn't show: a writer it feeds acts on files here.
    if (fed && effects.length === before && FED_WRITERS.has(name)) {
      const inPlace = name !== 'sed' && name !== 'perl' && name !== 'ruby' ? true : args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
      if (inPlace) effects.push({ kind: ['rm', 'rmdir', 'unlink', 'shred'].includes(name) ? 'delete' : 'write', path: '.', via: `xargs ${name}`, cwd });
    }
  }
  return effects;
}

/** Commands that write or delete the files xargs passes them. */
const FED_WRITERS = new Set(['sed', 'perl', 'ruby', 'rm', 'rmdir', 'unlink', 'shred', 'cp', 'mv', 'tee', 'truncate', 'touch']);
