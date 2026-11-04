import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCommand, splitCommands, tokenize } from '../core/lib/shell.js';

/**
 * Effects as short strings: "write:path", "delete:path", "git:git commit", and so on.
 * @param {string} cmd
 * @param {'posix' | 'powershell'} [dialect]
 */
const fx = (cmd, dialect = 'posix') =>
  analyzeCommand(cmd, { dialect, cwd: '/p' }).map((e) => `${e.kind}:${e.path ?? e.via}${e.cwd && e.cwd !== '/p' ? `@${e.cwd}` : ''}`);

test('quotes, escapes and operators tokenize like a shell', () => {
  const words = (/** @type {string} */ s) => tokenize(s).map((t) => (t.type === 'word' ? t.value : `<${t.value}>`));
  assert.deepEqual(words(`echo "a > b" 'c | d' e\\ f`), ['echo', 'a > b', 'c | d', 'e f']);
  assert.deepEqual(words('a&&b||c;d|e'), ['a', '<&&>', 'b', '<||>', 'c', '<;>', 'd', '<|>', 'e']);
  assert.deepEqual(words('cmd 2>&1 >out 2>>err'), ['cmd', '<2>&>', '1', '<>>', 'out', '<2>>>', 'err']);
  assert.deepEqual(words('echo a2>f'), ['echo', 'a2', '<>>', 'f']);
  assert.deepEqual(words('echo hi # > not a redirect'), ['echo', 'hi']);
});

test('heredoc bodies are input, not commands', () => {
  const cmd = "node menitor.js plan import - <<'EOF'\n{\"why\": \"a -> b > c; rm -rf /\"}\nEOF\necho done";
  assert.deepEqual(fx(cmd), []);
  assert.deepEqual(fx("cat <<EOF > src/app.js\nconst x = a > b;\nEOF"), ['write:src/app.js']);
  assert.deepEqual(fx('cat <<-END\n\tx > y\n\tEND\ntouch ok'), []);
  const commands = splitCommands(tokenize("cat <<'EOF'\nbody\nEOF\nls"));
  assert.deepEqual(commands.map((c) => c.words.map((w) => w.value)), [['cat'], ['ls']]);
});

test('redirects to files are writes; descriptor copies and input are not', () => {
  assert.deepEqual(fx('echo hi > src/a.js'), ['write:src/a.js']);
  assert.deepEqual(fx('echo hi >> log.txt'), ['write:log.txt']);
  assert.deepEqual(fx('npm test > out.txt 2>&1'), ['write:out.txt']);
  assert.deepEqual(fx('npm test &> all.log'), ['write:all.log']);
  assert.deepEqual(fx('echo x >&2'), []);
  assert.deepEqual(fx('sort < in.txt'), []);
  assert.deepEqual(fx('echo "a > b"'), []);
});

test('tee, sed -i, perl -i, truncate and dd', () => {
  assert.deepEqual(fx('npm test | tee -a out.log'), ['write:out.log']);
  assert.deepEqual(fx('sed -i s/a/b/ src/x.js src/y.js'), ['write:src/x.js', 'write:src/y.js']);
  assert.deepEqual(fx("sed -i.bak -e 's/a/b/' src/x.js"), ['write:src/x.js']);
  assert.deepEqual(fx('sed -n 1,5p src/x.js'), []);
  assert.deepEqual(fx("perl -pi -e 's/a/b/' src/x.js"), ['write:src/x.js']);
  assert.deepEqual(fx('truncate -s 0 app.log'), ['write:app.log']);
  assert.deepEqual(fx('dd if=/dev/zero of=disk.img bs=1M'), ['write:disk.img']);
});

test('copies, moves and deletes', () => {
  assert.deepEqual(fx('cp -r template/ src/'), ['write:src/']);
  assert.deepEqual(fx('cp -t src a.js b.js'), ['write:src']);
  assert.deepEqual(fx('mv old.js new.js'), ['delete:old.js', 'write:new.js']);
  assert.deepEqual(fx('rm -rf node_modules src/old.js'), ['delete:node_modules', 'delete:src/old.js']);
  assert.deepEqual(fx('ln -s ../shared lib'), ['write:lib']);
});

test('downloads into the project', () => {
  assert.deepEqual(fx('curl -sSo page.html https://example.com'), ['write:page.html']);
  assert.deepEqual(fx('curl --output=a.zip https://example.com'), ['write:a.zip']);
  assert.deepEqual(fx('curl -s https://example.com | jq .'), []);
  assert.deepEqual(fx('curl -O https://example.com/a.zip'), ['write:.']);
  assert.deepEqual(fx('wget https://example.com/a.zip'), ['write:.']);
  assert.deepEqual(fx('wget -qO- https://example.com | head'), []);
  assert.deepEqual(fx('wget -O x.html https://example.com'), ['write:x.html']);
});

test('cd changes where later paths land', () => {
  assert.deepEqual(fx('cd src && echo x > a.js'), ['write:a.js@/p/src']);
  assert.deepEqual(fx('cd "$DIR" && echo x > a.js').map((s) => s.split('@')[0]), ['write:a.js']);
  const [effect] = analyzeCommand('cd $DIR && echo x > a.js', { cwd: '/p' });
  assert.equal(effect.cwd, null, 'an unknown folder makes later relative paths unknown');
});

test('nested commands are analyzed too', () => {
  assert.deepEqual(fx('bash -c "echo x > y.txt"'), ['write:y.txt']);
  assert.deepEqual(fx("sh -lc 'git commit -m x'"), ['git:git commit']);
  assert.deepEqual(fx('echo $(echo x > z.txt)'), ['write:z.txt']);
  assert.deepEqual(fx('echo `touch a; echo b > c`'), ['write:c']);
  assert.deepEqual(fx('eval "echo hi > e.txt"'), ['write:e.txt']);
  assert.deepEqual(fx('sudo -u root tee /etc/hosts'), ['write:/etc/hosts']);
  assert.deepEqual(fx('FOO=1 env BAR=2 nohup echo x > n.txt'), ['write:n.txt']);
  assert.deepEqual(fx('find . -name "*.js" | xargs sed -i s/a/b/'), ['write:.']);
  assert.deepEqual(fx('git ls-files | xargs rm'), ['delete:.']);
  assert.deepEqual(fx('ls | xargs wc -l'), []);
  assert.deepEqual(fx('find src -name "*.tmp" -delete'), ['delete:src']);
  assert.deepEqual(fx("find . -name '*.js' -exec sed -i s/a/b/ {} \\;"), ['write:.']);
  assert.deepEqual(fx('find . -type f -exec grep -l todo {} +'), []);
});

test('git: read-only subcommands pass, the rest change the repo', () => {
  for (const ok of ['git status', 'git diff HEAD~1', 'git log --oneline -5', 'git show HEAD', 'git branch', 'git branch -a', 'git branch --show-current', 'git tag', 'git tag -l "v*"', 'git remote -v', 'git config user.name', 'git config --list', 'git stash list', 'git fetch origin', 'git rev-parse HEAD', 'git --version', 'git -C sub status', 'git --no-pager log']) {
    assert.deepEqual(fx(ok), [], ok);
  }
  for (const [cmd, via] of [
    ['git commit -m x', 'git commit'],
    ['git add .', 'git add'],
    ['git checkout -b feat/x', 'git checkout'],
    ['git switch main', 'git switch'],
    ['git branch feat/x', 'git branch'],
    ['git branch -D old', 'git branch'],
    ['git tag v1.0', 'git tag'],
    ['git config user.name Bot', 'git config'],
    ['git stash', 'git stash'],
    ['git reset --hard', 'git reset'],
    ['git push', 'git push'],
    ['git merge feat/x', 'git merge'],
  ]) {
    assert.deepEqual(fx(cmd), [`git:${via}`], cmd);
  }
  assert.deepEqual(fx('git -C sub commit -m x'), ['git:git commit@/p/sub']);
});

test('package managers: adding and scaffolding change files, restoring does not', () => {
  for (const ok of ['npm install', 'npm ci', 'npm i --legacy-peer-deps', 'pnpm install', 'yarn', 'npm test', 'npm run build', 'npx prisma --help', 'npx tsc --noEmit', 'bun run dev']) {
    assert.deepEqual(fx(ok), [], ok);
  }
  for (const cmd of ['npm i -D vitest', 'npm install express', 'pnpm add zod', 'yarn add react', 'bun add hono', 'npm uninstall lodash', 'npm init -y', 'npm create vite@latest app', 'npx create-next-app@latest web', 'npx shadcn@latest add button', 'npx prisma init', 'npx prisma migrate dev', 'pnpm dlx create-svelte app', 'npm pkg set name=x', 'cargo add serde', 'django-admin startproject site']) {
    assert.equal(fx(cmd)[0]?.split(':')[0], 'package', cmd);
  }
});

test('inline scripts that write files', () => {
  assert.deepEqual(fx(`node -e "require('fs').writeFileSync('a.js', 'x')"`), ['script:node -e']);
  assert.deepEqual(fx(`python3 -c "open('a.py', 'w').write('x')"`), ['script:python3 -c']);
  assert.deepEqual(fx(`node -e "console.log(require('fs').readFileSync('a.js', 'utf8'))"`), []);
  assert.deepEqual(fx(`python -c "import shutil; shutil.copy('a', 'b')"`), ['script:python -c']);
});

test('PowerShell cmdlets, aliases and redirects', () => {
  assert.deepEqual(fx('Set-Content -Path src\\a.js -Value "x"', 'powershell'), ['write:src\\a.js']);
  assert.deepEqual(fx("Set-Content src\\a.js 'x'", 'powershell'), ['write:src\\a.js']);
  assert.deepEqual(fx('"x" | Out-File -FilePath a.txt', 'powershell'), ['write:a.txt']);
  assert.deepEqual(fx('New-Item -ItemType File -Path src -Name b.js', 'powershell'), ['write:src', 'write:src/b.js']);
  assert.deepEqual(fx('npm test 2>&1 | Out-File log.txt', 'powershell'), ['write:log.txt']);
  assert.deepEqual(fx('Get-Content a.txt 2>&1', 'powershell'), []);
  assert.deepEqual(fx('Remove-Item -Recurse -Force dist; Copy-Item a.js src\\b.js', 'powershell'), ['delete:dist', 'write:src\\b.js']);
  assert.deepEqual(fx('Rename-Item a.js b.js', 'powershell'), ['delete:a.js', 'write:b.js']);
  assert.deepEqual(fx('echo x > a.txt', 'powershell'), ['write:a.txt']);
  assert.deepEqual(fx('[IO.File]::WriteAllText("a.txt", "x")', 'powershell'), ['script:a .NET file call']);
  assert.deepEqual(fx('& "C:\\Program Files\\Git\\bin\\git.exe" commit -m x', 'powershell'), ['git:git commit']);
  assert.deepEqual(fx('Invoke-WebRequest -Uri https://x -OutFile page.html', 'powershell'), ['write:page.html']);
  assert.deepEqual(fx("Get-ChildItem; Write-Output 'a > b'", 'powershell'), []);
  assert.deepEqual(fx("pwsh -Command \"Set-Content a.txt 'x'\""), ['write:a.txt']);
});
