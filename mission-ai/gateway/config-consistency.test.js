import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('route defaults match catalog', async () => {
  const router = JSON.parse(await readFile(new URL('../config/router.json', import.meta.url), 'utf8'));
  const catalog = JSON.parse(await readFile(new URL('../config/provider-catalog.json', import.meta.url), 'utf8'));
  for (const [name, route] of Object.entries(router.routes)) {
    assert.equal(route.defaultModel, catalog.providers[route.provider][name]);
  }
});
