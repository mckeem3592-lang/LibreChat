import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findMissionAIExtensionPaths } from './extension-registration.mjs';

test('detects an older unpacked Mission AI extension registration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-ai-extension-audit-'));
  try {
    const profile = path.join(root, 'Profile 2');
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'Secure Preferences'), JSON.stringify({
      extensions: { settings: {
        ggkpmldfojmlehhbadliodeplhneelmb: {
          path: '/Users/example/.local/share/mission-ai/source/mission-ai/chrome-extension',
        },
        unrelated: { path: '/Users/example/other-extension' },
      } },
    }));
    assert.deepEqual(findMissionAIExtensionPaths(root), [{
      profile: 'Profile 2',
      id: 'ggkpmldfojmlehhbadliodeplhneelmb',
      path: '/Users/example/.local/share/mission-ai/source/mission-ai/chrome-extension',
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
