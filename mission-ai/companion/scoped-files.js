import path from 'node:path';
import crypto from 'node:crypto';
import { lstat, readFile, realpath, readdir, stat, writeFile } from 'node:fs/promises';

const ROOTS = new Set(['Desktop', 'Documents', 'Downloads']);
const HIDDEN = /(^|[\\/])\./;
const MAX_TEXT_BYTES = 1_000_000;

function name(value) {
  if (typeof value !== 'string' || !ROOTS.has(value)) throw new Error('file_root_not_allowed');
  return value;
}
function relative(value) {
  if (typeof value !== 'string' || value.length > 2000 || path.isAbsolute(value) ||
      HIDDEN.test(value) || value.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) {
    throw new Error('file_path_not_allowed');
  }
  return value;
}
function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function createScopedFiles(homeDirectory, configuredRoots = {}) {
  async function rootDirectory(rootName) {
    const root = name(rootName);
    const configured = configuredRoots[root];
    if (configured != null && (typeof configured !== 'string' || !path.isAbsolute(configured))) {
      throw new Error('file_root_not_allowed');
    }
    return realpath(configured || path.join(homeDirectory, root));
  }
  async function resolveExisting(rootName, relativePath, directory = false) {
    const root = await rootDirectory(rootName);
    const expected = path.join(root, relative(relativePath));
    const resolved = await realpath(expected);
    if (!inside(root, resolved) || resolved !== expected) throw new Error('file_path_not_allowed');
    const info = await stat(resolved);
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('file_type_not_allowed');
    return { root, resolved, info };
  }
  return {
    async list({ root, directory = '' }) {
      const rootPath = await rootDirectory(root);
      const target = directory ? (await resolveExisting(root, directory, true)).resolved : rootPath;
      const entries = await readdir(target, { withFileTypes: true });
      return { root, directory, entries: entries.filter(item => !item.name.startsWith('.'))
        .slice(0, 200).map(item => ({ name: item.name, type: item.isDirectory() ? 'directory' :
          item.isFile() ? 'file' : 'other' })) };
    },
    async read({ root, path: relativePath }) {
      const { resolved, info } = await resolveExisting(root, relativePath);
      if (info.size > MAX_TEXT_BYTES) throw new Error('file_too_large');
      const bytes = await readFile(resolved);
      if (bytes.includes(0)) throw new Error('binary_file_not_supported');
      return { root, path: relativePath,
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    },
    async write({ root, path: relativePath, text, expectedSha256 }) {
      if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT_BYTES) {
        throw new Error('text_too_long');
      }
      const rootPath = await rootDirectory(root);
      const destination = path.join(rootPath, relative(relativePath));
      const parent = await realpath(path.dirname(destination));
      if (!inside(rootPath, parent) || parent !== path.dirname(destination)) {
        throw new Error('file_path_not_allowed');
      }
      let exists = false;
      try { await lstat(destination); exists = true; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (exists) {
        const current = await resolveExisting(root, relativePath);
        const bytes = await readFile(current.resolved);
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        if (!expectedSha256 || hash !== expectedSha256) throw new Error('file_changed');
      } else if (expectedSha256) throw new Error('file_missing');
      await writeFile(destination, text, { flag: exists ? 'w' : 'wx' });
      return { root, path: relativePath,
        sha256: crypto.createHash('sha256').update(text).digest('hex') };
    },
    async move({ sourceRoot, sourcePath, destinationRoot, destinationPath }) {
      const source = await resolveExisting(sourceRoot, sourcePath);
      const destinationBase = await rootDirectory(destinationRoot);
      const destinationRelative = relative(destinationPath);
      const destination = path.join(destinationBase, destinationRelative);
      const parent = await realpath(path.dirname(destination));
      if (!inside(destinationBase, parent) || parent !== path.dirname(destination)) throw new Error('file_path_not_allowed');
      if (source.resolved === destination) throw new Error('file_destination_same');
      try { await stat(destination); throw new Error('file_destination_exists'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      // Exclusive creation prevents accidental overwrite even when another process races.
      const { link, unlink } = await import('node:fs/promises');
      try {
        await link(source.resolved, destination);
        await unlink(source.resolved);
      } catch (error) {
        if (error?.code !== 'EXDEV') throw error;
        // Cross-volume moves need a separate reviewed copy operation.
        throw new Error('file_cross_volume_not_supported');
      }
      return { moved: true, source: { root: sourceRoot, path: sourcePath },
        destination: { root: destinationRoot, path: destinationPath } };
    },
  };
}
