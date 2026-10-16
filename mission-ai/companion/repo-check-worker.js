import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_OUTPUT = 128_000;

async function main() {
  const specPath = process.argv[2];
  if (!specPath || !path.isAbsolute(specPath) || !specPath.endsWith('.json')) {
    throw new Error('repo_check_invalid');
  }
  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  if (typeof spec.checkId !== 'string' || typeof spec.root !== 'string' ||
      !path.isAbsolute(spec.root) || typeof spec.command !== 'string' ||
      spec.command.includes('/') || spec.command.includes('\\') ||
      !Array.isArray(spec.args) || !spec.args.every(arg => typeof arg === 'string') ||
      !Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1_000 || spec.timeoutMs > 1_800_000) {
    throw new Error('repo_check_invalid');
  }
  const marker = await stat(path.join(spec.root, '.git'));
  if (!marker.isDirectory() && !marker.isFile()) throw new Error('repo_root_not_git');
  let result;
  try {
    const { stdout, stderr } = await run(spec.command, spec.args, {
      cwd: spec.root,
      timeout: spec.timeoutMs,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    result = { checkId: spec.checkId, exitCode: 0,
      stdout: String(stdout).slice(0, MAX_OUTPUT), stderr: String(stderr).slice(0, MAX_OUTPUT) };
  } catch (error) {
    result = { checkId: spec.checkId,
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      stdout: String(error?.stdout ?? '').slice(0, MAX_OUTPUT),
      stderr: String(error?.stderr ?? error?.message ?? '').slice(0, MAX_OUTPUT) };
  }
  const completed = { jobId: spec.jobId, checkId: spec.checkId,
    status: result.exitCode === 0 ? 'completed' : 'failed',
    startedAt: spec.startedAt, finishedAt: Date.now(), result };
  const resultPath = specPath.replace(/\.json$/, '.result.json');
  const temporaryPath = `${resultPath}.${process.pid}.tmp`;
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(temporaryPath, JSON.stringify(completed), { flag: 'wx', mode: 0o600 });
  await rename(temporaryPath, resultPath);
}

main().catch(async error => {
  const specPath = process.argv[2];
  if (specPath && path.isAbsolute(specPath) && specPath.endsWith('.json')) {
    try {
      const spec = JSON.parse(await readFile(specPath, 'utf8'));
      const failed = { jobId: spec.jobId, checkId: spec.checkId, status: 'failed',
        startedAt: spec.startedAt, finishedAt: Date.now(),
        result: { checkId: spec.checkId, exitCode: null, stdout: '',
          stderr: String(error?.message ?? error).slice(0, MAX_OUTPUT) } };
      await writeFile(specPath.replace(/\.json$/, '.result.json'), JSON.stringify(failed),
        { flag: 'wx', mode: 0o600 });
    } catch { /* A missing job record will time out in the companion. */ }
  }
  process.exitCode = 1;
});
