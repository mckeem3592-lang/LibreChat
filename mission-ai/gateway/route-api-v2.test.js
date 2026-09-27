import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedRouteRequest } from './route-api-v2.js';

test('primary uses catalog model', async () => {
  const result = await verifiedRouteRequest({ task: 'primary', monthSpendUsd: 0 });
  assert.ok(result.route.model);
});

test('economy mode selects an economy route', async () => {
  const result = await verifiedRouteRequest({ task: 'coding', monthSpendUsd: 125 });
  assert.equal(result.mode, 'economy');
  assert.equal(result.route.provider, 'openai');
});
