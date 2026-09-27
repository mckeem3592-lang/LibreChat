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
