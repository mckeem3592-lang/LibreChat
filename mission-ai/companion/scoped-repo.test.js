import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createScopedRepo } from './scoped-repo.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const execFileAsync = promisify(execFile);

test('scoped repository reads, edits, checks, and rejects stale or escaping writes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mission-repo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'app.js'), 'old\n');
  let invocation;
  const repo = createScopedRepo({ root, checks: {
    lint: { command: 'git', args: ['diff', '--check'], timeoutMs: 300_000 },
  } }, { run: async (command, args, options) => {
    invocation = { command, args, cwd: options.cwd, timeoutMs: options.timeout };
    return { stdout: 'clean\n', stderr: '' };
  } });
  assert.deepEqual((await repo.list()).entries, [{ name: 'src', type: 'directory' }]);
  assert.deepEqual((await repo.list({ directory: 'src' })).entries, [{ name: 'app.js', type: 'file' }]);
  assert.equal((await repo.read({ path: 'src/app.js' })).sha256, hash('old\n'));
  await assert.rejects(repo.write({ path: 'src/app.js', text: 'bad\n', expectedSha256: hash('wrong') }),
    /repo_file_changed/);
  assert.equal((await repo.write({ path: 'src/app.js', text: 'new\n', expectedSha256: hash('old\n') })).sha256,
    hash('new\n'));
  assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'new\n');
  assert.equal((await repo.check({ checkId: 'lint' })).exitCode, 0);
  assert.deepEqual(invocation, { command: 'git', args: ['diff', '--check'],
    cwd: await realpath(root), timeoutMs: 300_000 });
  await assert.rejects(repo.check({ checkId: 'arbitrary' }), /repo_check_not_allowed/);
  await assert.rejects(repo.write({ path: '../outside', text: 'no' }), /repo_path_not_allowed/);
  await assert.rejects(repo.write({ path: 'src/CON.txt', text: 'no' }), /repo_path_not_allowed/);
  await assert.rejects(repo.write({ path: 'src/stream:secret', text: 'no' }), /repo_path_not_allowed/);
  await assert.rejects(repo.read({ path: '.git/config' }), /repo_path_not_allowed/);
  try {
    await symlink(path.join(root, 'src', 'app.js'), path.join(root, 'src', 'link.js'));
    await assert.rejects(repo.read({ path: 'src/link.js' }), /repo_file_not_regular/);
  } catch (error) {
    if (error?.code !== 'EPERM') throw error; // Windows without Developer Mode cannot create this fixture.
  }
});

test('failed checks return the actual exit code and bounded output', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mission-repo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  const repo = createScopedRepo({ root, checks: { test: { command: 'npm', args: ['test'] } } },
    { run: async () => { throw Object.assign(new Error('failed'), { code: 2, stdout: 'summary', stderr: 'failure' }); } });
  assert.deepEqual(await repo.check({ checkId: 'test' }),
    { checkId: 'test', exitCode: 2, stdout: 'summary', stderr: 'failure' });
});

test('a real Git check reports a changed source file and a failing diff', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mission-repo-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'app.js'), 'clean\n');
  await execFileAsync('git', ['add', 'app.js'], { cwd: root });
  const repo = createScopedRepo({ root, checks: { 'diff-check': { command: 'git', args: ['diff', '--check'] } } });
  const old = await repo.read({ path: 'app.js' });
  await repo.write({ path: 'app.js', text: 'dirty  \n', expectedSha256: old.sha256 });
  const current = await repo.read({ path: 'app.js' });
  assert.equal(current.text, 'dirty  \n');
  const check = await repo.check({ checkId: 'diff-check' });
  assert.notEqual(check.exitCode, 0);
  assert.match(check.stdout + check.stderr, /trailing whitespace/i);
  const started = await repo.startCheck({ checkId: 'diff-check' });
  let background;
  for (let attempt = 0; attempt < 100; attempt++) {
    background = repo.checkStatus({ jobId: started.jobId });
    if (background.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(background.status, 'failed');
  assert.notEqual(background.result.exitCode, 0);
  assert.match(background.result.stdout + background.result.stderr, /trailing whitespace/i);
});

test('a named check continues while the caller is away and exposes its terminal result', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mission-repo-job-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  let finish;
  const repo = createScopedRepo({ root, checks: { lint: { command: 'git', args: ['diff', '--check'] } } },
    { run: () => new Promise(resolve => { finish = resolve; }) });
  const started = await repo.startCheck({ checkId: 'lint' });
  assert.equal(started.status, 'running');
  assert.equal(repo.checkStatus({ jobId: started.jobId }).status, 'running');
  await assert.rejects(repo.startCheck({ checkId: 'lint' }), /repo_check_busy/);
  for (let attempt = 0; attempt < 20 && !finish; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(typeof finish, 'function');
  finish({ stdout: 'clean', stderr: '' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(repo.checkStatus({ jobId: started.jobId }).result,
    { checkId: 'lint', exitCode: 0, stdout: 'clean', stderr: '' });
  assert.equal(repo.checkStatus({ jobId: started.jobId }).status, 'completed');
});
