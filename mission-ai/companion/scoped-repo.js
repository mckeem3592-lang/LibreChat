import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
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
    async check({ checkId }) {
      if (typeof checkId !== 'string' || !Object.hasOwn(checks, checkId)) throw new Error('repo_check_not_allowed');
      const spec = checks[checkId];
      if (!spec || typeof spec !== 'object' || typeof spec.command !== 'string' ||
          !Array.isArray(spec.args) || !spec.args.every(arg => typeof arg === 'string') ||
          spec.command.includes('/') || spec.command.includes('\\')) throw new Error('repo_check_invalid');
      const cwd = await root();
      try {
        const { stdout, stderr } = await run(spec.command, spec.args, {
          cwd, timeout: 120_000, maxBuffer: MAX_OUTPUT, windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        return { checkId, exitCode: 0, stdout: String(stdout).slice(0, MAX_OUTPUT), stderr: String(stderr).slice(0, MAX_OUTPUT) };
      } catch (error) {
        return { checkId, exitCode: Number.isInteger(error?.code) ? error.code : null,
          stdout: String(error?.stdout ?? '').slice(0, MAX_OUTPUT),
          stderr: String(error?.stderr ?? error?.message ?? '').slice(0, MAX_OUTPUT) };
      }
    },
  };
}
