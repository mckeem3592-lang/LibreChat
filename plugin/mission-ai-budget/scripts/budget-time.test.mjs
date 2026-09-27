import test from 'node:test';
import assert from 'node:assert/strict';
import { monthStartFor } from './budget-time.mjs';
import { budgetDecision, validateBudgetPolicy } from './budget-policy.mjs';

test('Denver winter month starts at 07:00 UTC', () => {
  const value = monthStartFor(new Date('2026-02-15T12:00:00Z'), 'America/Denver');
  assert.equal(value.toISOString(), '2026-02-01T07:00:00.000Z');
});

test('Denver summer month starts at 06:00 UTC', () => {
  const value = monthStartFor(new Date('2026-07-15T12:00:00Z'), 'America/Denver');
  assert.equal(value.toISOString(), '2026-07-01T06:00:00.000Z');
});

test('UTC month starts at midnight UTC', () => {
  const value = monthStartFor(new Date('2026-09-27T00:00:00Z'), 'UTC');
  assert.equal(value.toISOString(), '2026-09-01T00:00:00.000Z');
});

const policy = { targetUsd: 100, economyUsd: 125, hardUsd: 175 };

test('budget thresholds are exact', () => {
  assert.equal(budgetDecision(99.99, policy), 'normal');
  assert.equal(budgetDecision(100, policy), 'notice');
  assert.equal(budgetDecision(125, policy), 'economy');
  assert.equal(budgetDecision(174.99, policy), 'economy');
  assert.equal(budgetDecision(175, policy), 'blocked');
});

test('invalid budget values are rejected', () => {
  assert.throws(
    () => validateBudgetPolicy({ targetUsd: 125, economyUsd: 100, hardUsd: 175 }),
    /invalid_budget_policy/,
  );
  assert.throws(() => budgetDecision(-1, policy), /invalid_budget_spend/);
});
