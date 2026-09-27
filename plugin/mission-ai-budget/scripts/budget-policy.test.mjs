import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetDecision, validateBudgetPolicy } from './budget-policy.mjs';

const policy = { targetUsd: 100, economyUsd: 125, hardUsd: 175 };

test('budget thresholds are exact', () => {
  assert.equal(budgetDecision(99.99, policy), 'normal');
  assert.equal(budgetDecision(100, policy), 'notice');
  assert.equal(budgetDecision(125, policy), 'economy');
  assert.equal(budgetDecision(174.99, policy), 'economy');
  assert.equal(budgetDecision(175, policy), 'blocked');
});

test('invalid budget configuration fails closed', () => {
  assert.throws(
    () => validateBudgetPolicy({ targetUsd: 125, economyUsd: 100, hardUsd: 175 }),
    /invalid_budget_policy/,
  );
  assert.throws(() => budgetDecision(-1, policy), /invalid_budget_spend/);
});
