import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('.', import.meta.url);

test('Mac code worker stays pinned to an isolated restricted workspace policy', async () => {
  const installer = await readFile(
    new URL('../code-worker/install-macos.sh', root),
    'utf8',
  );

  assert.match(
    installer,
    /PIN="67d75d859aee891923c40cde1db073489d74a424"/,
  );
  assert.match(installer, /<string>--default-workspace<\/string>/);
  assert.match(installer, /<string>--allow-workspace-writes<\/string>/);
  assert.match(installer, /<string>--allow-workspace-commands<\/string>/);
  assert.match(
    installer,
    /<string>--command-sandbox<\/string>\s*<string>native-srt<\/string>/,
  );
  assert.match(
    installer,
    /<string>--command-policy-preset<\/string>\s*<string>restricted<\/string>/,
  );
  assert.equal(installer.includes('<string>trusted-vm</string>'), false);
  assert.equal(installer.includes('<string>--worker-dir</string>'), false);
});
