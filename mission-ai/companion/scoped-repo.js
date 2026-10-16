import crypto from 'node:crypto';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BYTES = 256_000;
const MAX_OUTPUT = 128_000;
const HIDDEN = /(^|[\\/])\./;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.length > 2000 ||
      path.isAbsolute(value) || HIDDEN.test(value) || /[\0:*?"<>|]/.test(value) ||
      value.split(/[\\/]/).some(part => !part || part === '..' || part === '.' ||
        part.endsWith(' ') || part.endsWith('.') ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('repo_path_not_allowed');
  }
  return value;
}

function within(root, candidate) {
  return candidate.startsWith(root + path.sep);
}

export function createScopedRepo(config = {}, { run = execFileAsync } = {}) {
  const configured = config?.root;
  const checks = config?.checks ?? {};
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) return null;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) throw new Error('repo_checks_invalid');
  const jobs = new Map();
  const jobDirectory = config?.jobDirectory;
  if (jobDirectory != null && (typeof jobDirectory !== 'string' || !path.isAbsolute(jobDirectory))) {
    throw new Error('repo_job_directory_invalid');
  }
  const workerPath = fileURLToPath(new URL('./repo-check-worker.js', import.meta.url));
  let starting = false;

  function durableStatus(jobId) {
    const specPath = path.join(jobDirectory, `${jobId}.json`);
    let spec;
    try {
      spec = JSON.parse(readFileSync(specPath, 'utf8'));
    } catch {
      throw new Error('repo_job_not_found');
    }
    const resultPath = path.join(jobDirectory, `${jobId}.result.json`);
    if (existsSync(resultPath)) {
      const result = JSON.parse(readFileSync(resultPath, 'utf8'));
      if (Date.now() - result.finishedAt > 3_600_000) throw new Error('repo_job_not_found');
      return result;
    }
    if (Date.now() - spec.startedAt > spec.timeoutMs + 10_000) {
      return { jobId, checkId: spec.checkId, status: 'failed', startedAt: spec.startedAt,
        finishedAt: spec.startedAt + spec.timeoutMs + 10_000,
        result: { checkId: spec.checkId, exitCode: null, stdout: '',
          stderr: 'Repository check worker stopped without a result' } };
    }
    return { jobId, checkId: spec.checkId, status: 'running', startedAt: spec.startedAt };
  }

  function durableJobs() {
    if (!existsSync(jobDirectory)) return [];
    return readdirSync(jobDirectory)
      .filter(name => /^[0-9a-f-]{36}\.json$/.test(name))
      .map(name => {
        const jobId = name.slice(0, -5);
        try { return { jobId, status: durableStatus(jobId) }; }
        catch { return { jobId, status: { status: 'expired', finishedAt: 0 } }; }
      });
  }

  async function root() {
    const resolved = await realpath(configured);
    const marker = await stat(path.join(resolved, '.git'));
    if (!marker.isDirectory() && !marker.isFile()) throw new Error('repo_root_not_git');
    return resolved;
  }

  async function target(relativePath, allowNew = false) {
    const base = await root();
    const name = relativeFile(relativePath);
    const full = path.resolve(base, name);
    if (!within(base, full)) throw new Error('repo_path_not_allowed');
    const parent = await realpath(path.dirname(full));
    if (parent !== path.dirname(full) || !within(base, parent) && parent !== base) {
      throw new Error('repo_path_not_allowed');
    }
    try {
      const entry = await lstat(full);
      if (!entry.isFile()) throw new Error('repo_file_not_regular');
      return { base, full, exists: true };
    } catch (error) {
      if (allowNew && error?.code === 'ENOENT') return { base, full, exists: false };
      throw error;
    }
  }

  async function runCheck({ checkId }) {
    if (typeof checkId !== 'string' || !Object.hasOwn(checks, checkId)) throw new Error('repo_check_not_allowed');
    const spec = checks[checkId];
    if (!spec || typeof spec !== 'object' || typeof spec.command !== 'string' ||
        !Array.isArray(spec.args) || !spec.args.every(arg => typeof arg === 'string') ||
        spec.command.includes('/') || spec.command.includes('\\')) throw new Error('repo_check_invalid');
    const timeoutMs = spec.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_800_000) {
      throw new Error('repo_check_invalid');
    }
    const cwd = await root();
    try {
      const { stdout, stderr } = await run(spec.command, spec.args, {
        cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return { checkId, exitCode: 0, stdout: String(stdout).slice(0, MAX_OUTPUT), stderr: String(stderr).slice(0, MAX_OUTPUT) };
    } catch (error) {
      return { checkId, exitCode: Number.isInteger(error?.code) ? error.code : null,
        stdout: String(error?.stdout ?? '').slice(0, MAX_OUTPUT),
        stderr: String(error?.stderr ?? error?.message ?? '').slice(0, MAX_OUTPUT) };
    }
  }

  return {
    async list({ directory = '' } = {}) {
      const base = await root();
      const full = directory ? path.resolve(base, relativeFile(directory)) : base;
      if (full !== base && !within(base, full)) throw new Error('repo_path_not_allowed');
      const entry = await lstat(full);
      if (!entry.isDirectory() || await realpath(full) !== full) throw new Error('repo_directory_not_allowed');
      const entries = await readdir(full, { withFileTypes: true });
      return { directory, entries: entries.filter(item => !item.name.startsWith('.') && !item.isSymbolicLink())
        .slice(0, 200).map(item => ({ name: item.name, type: item.isDirectory() ? 'directory' :
          item.isFile() ? 'file' : 'other' })) };
    },
    async read({ path: relativePath }) {
      const { full } = await target(relativePath);
      const bytes = await readFile(full);
      if (bytes.length > MAX_BYTES) throw new Error('repo_file_too_large');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new Error('repo_binary_file');
      return { path: relativePath, text, sha256: digest(bytes) };
    },
    async write({ path: relativePath, text, expectedSha256 }) {
      if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw new Error('repo_text_too_large');
      const { full, exists } = await target(relativePath, true);
      if (exists) {
        const prior = await readFile(full);
        if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '') || digest(prior) !== expectedSha256) {
          throw new Error('repo_file_changed');
        }
      } else if (expectedSha256 !== undefined) throw new Error('repo_file_missing');
      await writeFile(full, text, { flag: exists ? 'w' : 'wx' });
      return { path: relativePath, sha256: digest(Buffer.from(text)), created: !exists };
    },
    check: runCheck,
    async startCheck({ checkId }) {
      if (typeof checkId !== 'string' || !Object.hasOwn(checks, checkId)) throw new Error('repo_check_not_allowed');
      if (starting) throw new Error('repo_check_busy');
      starting = true;
      try {
        if (jobDirectory) {
          const spec = checks[checkId];
          const timeoutMs = spec?.timeoutMs ?? 120_000;
          if (!spec || typeof spec.command !== 'string' || !Array.isArray(spec.args) ||
              !spec.args.every(arg => typeof arg === 'string') ||
              spec.command.includes('/') || spec.command.includes('\\') ||
              !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_800_000) {
            throw new Error('repo_check_invalid');
          }
          const cwd = await root();
          await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
          const prior = durableJobs();
          if (prior.some(job => job.status.status === 'running')) throw new Error('repo_check_busy');
          for (const job of prior) {
            if (Date.now() - job.status.finishedAt > 3_600_000 || prior.length >= 20) {
              unlinkSync(path.join(jobDirectory, `${job.jobId}.json`));
              const resultPath = path.join(jobDirectory, `${job.jobId}.result.json`);
              if (existsSync(resultPath)) unlinkSync(resultPath);
            }
          }
          const jobId = crypto.randomUUID();
          const startedAt = Date.now();
          const specPath = path.join(jobDirectory, `${jobId}.json`);
          await writeFile(specPath, JSON.stringify({ jobId, checkId, root: cwd,
            command: spec.command, args: spec.args, timeoutMs, startedAt }),
          { flag: 'wx', mode: 0o600 });
          try {
            const child = spawn(process.execPath, [workerPath, specPath], {
              detached: true, stdio: 'ignore', windowsHide: true,
            });
            child.on('error', error => {
              const failed = { jobId, checkId, status: 'failed', startedAt,
                finishedAt: Date.now(), result: { checkId, exitCode: null,
                  stdout: '', stderr: String(error?.message ?? error).slice(0, MAX_OUTPUT) } };
              void writeFile(path.join(jobDirectory, `${jobId}.result.json`),
                JSON.stringify(failed), { flag: 'wx', mode: 0o600 }).catch(() => {});
            });
            child.unref();
          } catch (error) {
            unlinkSync(specPath);
            throw error;
          }
          return { jobId, status: 'running', checkId };
        }
      if ([...jobs.values()].some(job => job.status === 'running')) throw new Error('repo_check_busy');
      await root();
      for (const [id, job] of jobs) {
        if (job.status !== 'running' && Date.now() - job.finishedAt > 3_600_000) jobs.delete(id);
      }
      if (jobs.size >= 20) {
        const oldest = jobs.keys().next().value;
        jobs.delete(oldest);
      }
      const jobId = crypto.randomUUID();
      const job = { checkId, status: 'running', startedAt: Date.now() };
      jobs.set(jobId, job);
      void runCheck({ checkId }).then(result => {
        job.status = result.exitCode === 0 ? 'completed' : 'failed';
        job.result = result;
        job.finishedAt = Date.now();
      }, error => {
        job.status = 'failed';
        job.result = { checkId, exitCode: null, stdout: '', stderr: String(error?.message ?? error) };
        job.finishedAt = Date.now();
      });
      return { jobId, status: 'running', checkId };
      } finally {
        starting = false;
      }
    },
    checkStatus({ jobId }) {
      if (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/.test(jobId)) throw new Error('repo_job_not_found');
      if (jobDirectory) return durableStatus(jobId);
      const job = jobs.get(jobId);
      if (!job) throw new Error('repo_job_not_found');
      if (job.status !== 'running' && Date.now() - job.finishedAt > 3_600_000) {
        jobs.delete(jobId);
        throw new Error('repo_job_not_found');
      }
      return { jobId, ...job };
    },
  };
}
