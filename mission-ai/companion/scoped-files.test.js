import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { createScopedFiles } from './scoped-files.js';

test('scoped files list and move without overwriting or escaping roots', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mission-ai-files-'));
  try {
    for (const root of ['Desktop', 'Documents', 'Downloads']) await mkdir(path.join(home, root));
    await writeFile(path.join(home, 'Downloads', 'receipt.txt'), 'receipt');
    await writeFile(path.join(home, 'Documents', 'existing.txt'), 'old');
    const files = createScopedFiles(home);
    assert.deepEqual((await files.list({ root: 'Downloads' })).entries,
      [{ name: 'receipt.txt', type: 'file' }]);
    await assert.rejects(files.move({ sourceRoot: 'Downloads', sourcePath: 'receipt.txt',
      destinationRoot: 'Documents', destinationPath: 'existing.txt' }), /file_destination_exists/);
    await assert.rejects(files.move({ sourceRoot: 'Downloads', sourcePath: '../Documents/existing.txt',
      destinationRoot: 'Documents', destinationPath: 'new.txt' }), /file_path_not_allowed/);
    await symlink(path.join(home, 'Documents', 'existing.txt'), path.join(home, 'Downloads', 'linked.txt'));
    await assert.rejects(files.move({ sourceRoot: 'Downloads', sourcePath: 'linked.txt',
      destinationRoot: 'Desktop', destinationPath: 'linked.txt' }), /file_path_not_allowed/);
    await files.move({ sourceRoot: 'Downloads', sourcePath: 'receipt.txt',
      destinationRoot: 'Documents', destinationPath: 'receipt.txt' });
    assert.equal(await readFile(path.join(home, 'Documents', 'receipt.txt'), 'utf8'), 'receipt');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
