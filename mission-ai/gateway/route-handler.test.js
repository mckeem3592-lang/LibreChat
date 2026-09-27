import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRoute } from './route-handler.js';

test('routing handler returns a primary decision', async () => {
  const response = await handleRoute({ task: 'chat', monthSpendUsd: 0 });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.result.routeName, 'primary');
});

test('routing handler returns blocked decision at hard limit', async () => {
  const response = await handleRoute({ task: 'coding', monthSpendUsd: 175 });
  assert.equal(response.status, 200);
  assert.equal(response.body.result.mode, 'blocked');
  assert.equal(response.body.result.route, null);
});

test('routing handler rejects invalid spend input', async () => {
  const response = await handleRoute({ task: 'chat', monthSpendUsd: 'invalid' });
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
});
