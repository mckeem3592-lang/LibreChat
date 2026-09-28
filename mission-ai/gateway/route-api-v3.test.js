import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredRouteRequest } from './route-api-v3.js';

test('strict text pin overrides per-role environment selection', async () => {
  const previous = process.env.MISSION_AI_MODEL_PRIMARY;
  process.env.MISSION_AI_MODEL_PRIMARY = 'mission-primary-test';
  try {
    const result = await configuredRouteRequest({ task: 'chat', monthSpendUsd: 0 });
    assert.equal(result.route.model, 'claude-sonnet-5-5');
  } finally {
    if (previous === undefined) delete process.env.MISSION_AI_MODEL_PRIMARY;
    else process.env.MISSION_AI_MODEL_PRIMARY = previous;
  }
});

test('economy mode retains the same exclusive text model', async () => {
  const previous = process.env.MISSION_AI_MODEL_ECONOMY;
  process.env.MISSION_AI_MODEL_ECONOMY = 'mission-economy-test';
  try {
    const result = await configuredRouteRequest({ task: 'coding', monthSpendUsd: 125 });
    assert.equal(result.mode, 'economy');
    assert.equal(result.route.model, 'claude-sonnet-5-5');
  } finally {
    if (previous === undefined) delete process.env.MISSION_AI_MODEL_ECONOMY;
    else process.env.MISSION_AI_MODEL_ECONOMY = previous;
  }
});
