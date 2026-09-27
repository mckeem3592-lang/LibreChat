import test from 'node:test';
import assert from 'node:assert/strict';
import { policyMode, validatePolicy } from './routing-policy.js';

const policy = { targetUsd: 100, economyUsd: 125, hardUsd: 175 };

test('policy modes honor thresholds', () => {
  assert.equal(policyMode(0, policy), 'normal');
  assert.equal(policyMode(100, policy), 'notice');
  assert.equal(policyMode(125, policy), 'economy');
  assert.equal(policyMode(175, policy), 'blocked');
});

test('invalid policy ordering is rejected', () => {
  assert.throws(
    () => validatePolicy({ targetUsd: 125, economyUsd: 100, hardUsd: 175 }),
    /invalid_policy/,
  );
});

test('invalid spend is rejected', () => {
  assert.throws(() => policyMode('not-a-number', policy), /invalid_spend/);
  assert.throws(() => policyMode(-1, policy), /invalid_spend/);
});
