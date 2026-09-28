import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('.', import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('Chrome extension uses native messaging with a deterministic identity', async () => {
  const [manifestRaw, background, popup] = await Promise.all([
    text('../chrome-extension/manifest.json'),
    text('../chrome-extension/background.js'),
    text('../chrome-extension/popup.js'),
  ]);
  const manifest = JSON.parse(manifestRaw);

  assert.equal(manifest.version, '0.3.0');
  assert.ok(manifest.permissions.includes('nativeMessaging'));
  assert.ok(!manifest.permissions.includes('offscreen'));
  assert.equal(manifest.host_permissions, undefined);
  assert.ok(typeof manifest.key === 'string' && manifest.key.length > 100);
  assert.ok(background.includes("chrome.runtime.connectNative(NATIVE_HOST)"));
  assert.ok(background.includes("com.missionai.browser_bridge"));
  assert.ok(!background.includes('mission-ai-set-token'));
  assert.ok(!background.includes('127.0.0.1:8766'));
  assert.ok(!popup.includes('/browser/pair'));
  assert.ok(!popup.includes('browserToken'));
});

test('Mac installer restricts native host to the deterministic extension origin', async () => {
  const installer = await text('../companion/install-macos.sh');
  assert.ok(installer.includes('com.missionai.browser_bridge'));
  assert.ok(installer.includes('ggkpmldfojmlehhbadliodeplhneelmb'));
  assert.ok(installer.includes('NativeMessagingHosts'));
  assert.ok(installer.includes('allowed_origins'));
  assert.ok(installer.includes('chmod 700 "$NATIVE_HOST_LAUNCHER"'));
  assert.ok(installer.includes('chmod 600 "$CHROME_NATIVE_MANIFEST"'));
});

test('native host reads browser credential from Keychain and uses Chrome framing', async () => {
  const [host, framing] = await Promise.all([
    text('../companion/native-browser-host.js'),
    text('../companion/native-message-framing.js'),
  ]);
  assert.ok(host.includes("readSecret('mission-ai-browser-token')"));
  assert.ok(host.includes("type === 'browser_result'"));
  assert.ok(host.includes("type === 'browser_tool'"));
  assert.ok(host.includes("ws://127.0.0.1:"));
  assert.ok(host.includes("drainNativeFrames"));
  assert.ok(host.includes("encodeNativeMessage"));
  assert.ok(framing.includes('writeUInt32LE'));
  assert.ok(framing.includes('readUInt32LE'));
  assert.ok(!host.includes('console.log'));
});
