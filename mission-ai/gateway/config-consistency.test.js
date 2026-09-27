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
