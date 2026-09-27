import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedRouteRequest } from './route-api-v2.js';

test('verified routing rejects invalid spend input', async () => {
  await assert.rejects(
    verifiedRouteRequest({ task: 'chat', monthSpendUsd: 'invalid' }),
    /invalid_spend/,
  );
});
