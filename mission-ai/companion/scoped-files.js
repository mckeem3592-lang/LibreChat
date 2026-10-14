import path from 'node:path';
import { realpath, readdir, stat } from 'node:fs/promises';

const ROOTS = new Set(['Desktop', 'Documents', 'Downloads']);
const HIDDEN = /(^|[\\/])\./;

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

export function createScopedFiles(homeDirectory) {
  async function rootDirectory(rootName) {
    return realpath(path.join(homeDirectory, name(rootName)));
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
