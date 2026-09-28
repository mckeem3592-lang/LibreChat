import assert from 'node:assert/strict';
import test from 'node:test';
import { requestBudget } from './request-budget.js';

const dashboard = { targetUsd: 100, economyUsd: 125, hardUsd: 175, spendUsd: 10 };
const ledger = { settledUsd: 20, reservedUsd: 5 };

test('request budgets include native, settled, and outstanding costs', () => {
  assert.deepEqual(requestBudget(dashboard, ledger), {
    policy: { targetUsd: 100, economyUsd: 125, hardUsd: 175 },
    nativeUsd: 10, delegatedUsd: 20, projectedUsd: 35, directCapUsd: 165,
  });
});

test('invalid, missing, or zero hard limits never fall back to a spending allowance', () => {
  for (const hardUsd of [undefined, null, false, NaN, Infinity, -1, '175']) {
    assert.throws(() => requestBudget({ ...dashboard, hardUsd }, ledger), /invalid_budget/);
  }
  assert.throws(() => requestBudget({ targetUsd: 0, economyUsd: 0, hardUsd: 0, spendUsd: 0 }, { settledUsd: 0, reservedUsd: 0 }), /monthly_hard_limit/);
  for (const field of ['settledUsd', 'reservedUsd']) {
    assert.throws(() => requestBudget(dashboard, { ...ledger, [field]: NaN }), /invalid_budget_snapshot/);
  }
  assert.throws(() => requestBudget(dashboard, { ...ledger, accountingBlocked: true }), /ledger_accounting_blocked/);
});
