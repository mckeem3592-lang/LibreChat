import test from 'node:test';
import assert from 'node:assert/strict';
import { clearSafeRouteCache, safeRouteRequest } from './safe-route-api.js';

test('validated route facade rejects malformed spend', async () => {
  clearSafeRouteCache();
  await assert.rejects(
    () => safeRouteRequest({ task: 'chat', monthSpendUsd: 'not-a-number' }),
    /invalid_spend/,
  );
});

test('validated route facade routes valid spend', async () => {
  clearSafeRouteCache();
  const result = await safeRouteRequest({ task: 'chat', monthSpendUsd: 10 });
  assert.equal(result.mode, 'normal');
  assert.ok(result.route);
});
