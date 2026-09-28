import test from 'node:test';
import assert from 'node:assert/strict';
import { clearRouteConfigCache, routeRequest } from './route-api.js';

test('route API pins text despite environment override', async () => {
  const previous = process.env.MISSION_AI_MODEL_PRIMARY;
  process.env.MISSION_AI_MODEL_PRIMARY = 'mission-test-primary';
  try {
    clearRouteConfigCache();
    const result = await routeRequest({ task: 'primary', monthSpendUsd: 0 });
    assert.equal(result.mode, 'normal');
    assert.equal(result.route.provider, 'anthropic');
    assert.equal(result.route.model, 'claude-sonnet-5-5');
  } finally {
    if (previous === undefined) delete process.env.MISSION_AI_MODEL_PRIMARY;
    else process.env.MISSION_AI_MODEL_PRIMARY = previous;
    clearRouteConfigCache();
  }
});

test('route API blocks routing at the hard limit', async () => {
  clearRouteConfigCache();
  const result = await routeRequest({ task: 'coding', monthSpendUsd: 175 });
  assert.equal(result.mode, 'blocked');
  assert.equal(result.route, null);
});
