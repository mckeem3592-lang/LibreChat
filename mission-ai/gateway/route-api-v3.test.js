import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredRouteRequest } from './route-api-v3.js';

test('explicit model override wins over catalog default', async () => {
  const previous = process.env.MISSION_AI_MODEL_PRIMARY;
  process.env.MISSION_AI_MODEL_PRIMARY = 'mission-primary-test';
  try {
    const result = await configuredRouteRequest({ task: 'chat', monthSpendUsd: 0 });
    assert.equal(result.route.model, 'mission-primary-test');
  } finally {
    if (previous === undefined) delete process.env.MISSION_AI_MODEL_PRIMARY;
    else process.env.MISSION_AI_MODEL_PRIMARY = previous;
  }
});

test('economy mode uses the economy override', async () => {
  const previous = process.env.MISSION_AI_MODEL_ECONOMY;
  process.env.MISSION_AI_MODEL_ECONOMY = 'mission-economy-test';
  try {
    const result = await configuredRouteRequest({ task: 'coding', monthSpendUsd: 125 });
    assert.equal(result.mode, 'economy');
    assert.equal(result.route.model, 'mission-economy-test');
  } finally {
    if (previous === undefined) delete process.env.MISSION_AI_MODEL_ECONOMY;
    else process.env.MISSION_AI_MODEL_ECONOMY = previous;
  }
});
