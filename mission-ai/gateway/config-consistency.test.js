import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('routing config includes required route classes', async () => {
  const text = await readFile(new URL('../config/router.json', import.meta.url), 'utf8');
  const config = JSON.parse(text);
  for (const name of ['economy', 'primary', 'coding', 'reasoning', 'research', 'computer', 'image']) {
    assert.ok(config.routes[name]);
  }
});

test('LibreChat Mission AI config keeps keyless web research enabled', async () => {
  const text = await readFile(new URL('../config/librechat.mission-ai.yaml', import.meta.url), 'utf8');
  assert.match(text, /searchProvider:\s*keenable/);
  assert.match(text, /scraperProvider:\s*keenable/);
  assert.match(text, /rerankerType:\s*none/);
  assert.equal(/keenableApiKey:/.test(text), false);
});

test('LibreChat Mission AI config keeps scheduled and background work enabled', async () => {
  const text = await readFile(new URL('../config/librechat.mission-ai.yaml', import.meta.url), 'utf8');
  assert.match(text, /schedules:\s*\n\s+use:\s*true/);
  assert.match(text, /minIntervalMinutes:\s*60/);
  assert.match(text, /backgroundTasks:\s*\n\s+completionWakeups:\s*true/);
  assert.match(text, /defaultPinnedTools:/);
  assert.match(text, /- 'mcp'/);
});


test('LibreChat direct Chrome policy keeps read-only inventory automatic and mutations reviewed', async () => {
  const text = await readFile(new URL('../config/librechat.mission-ai.yaml', import.meta.url), 'utf8');
  const allowSection = text.split('      allow:')[1]?.split('      deny:')[0] || '';
  const askSection = text.split('      ask:')[1]?.split('      reason:')[0] || '';

  assert.match(allowSection, /browser_list_tabs/);
  assert.equal(/browser_close_tabs/.test(allowSection), false);

  for (const tool of [
    'browser_activate_tab',
    'browser_open_new_tab',
    'browser_close_tabs',
  ]) {
    assert.match(askSection, new RegExp(tool));
  }
});

test('primary agent instructions require create-only file output by default', async () => {
  const text = await readFile(
    new URL('../config/primary-agent-instructions.md', import.meta.url),
    'utf8',
  );
  assert.match(text, /overwrite:false/);
  assert.match(text, /fails with a conflict rather than being replaced/);
  assert.match(text, /Replace an existing file only when the user clearly intends an in-place edit/);
});
