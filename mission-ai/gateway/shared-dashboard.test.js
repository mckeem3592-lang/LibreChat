import assert from 'node:assert/strict';
import test from 'node:test';
import { queryMissionDashboard } from './mission-dashboard.js';
import { requestBudget, readBudgetDashboard } from './request-budget.js';
import { createMemoryUsageLedger } from './usage-ledger.js';

test('shared dashboard and request budget count imported and live native charges once', async () => {
  const ledger = createMemoryUsageLedger();
  const now = new Date('2026-09-28T17:00:00Z');
  const policy = { targetUsd: 100, economyUsd: 125, hardUsd: 175 };
  await ledger.activateSharedBudget({ policy, timeZone: 'America/Denver', cutoverAt: now,
    history: [{ id: 'test/transactions/a', at: now, usd: 10, provider: 'openai', model: 'gpt-6-luna' }] });
  for (const [source, amount] of [['native', 5], ['delegated', 2]]) {
    const hold = await ledger.reserve({ reserveUsd: amount, directCapUsd: 175, now,
      metadata: { source, provider: 'openai', model: 'gpt-6-luna' } });
    await ledger.settle({ reservationId: hold.reservationId, actualUsd: amount });
  }
  await ledger.reserve({ reserveUsd: 3, directCapUsd: 175, now });
  const nativeReader = () => assert.fail('Post-cutover native mirror must not be added or required');
  const dashboard = await queryMissionDashboard({ now, usageLedger: ledger, nativeReader });
  assert.equal(dashboard.spendUsd, 17);
  assert.equal(dashboard.nativeSpendUsd, 15);
  assert.equal(dashboard.delegatedSpendUsd, 2);
  assert.equal(dashboard.projectedSpendUsd, 20);
  assert.equal(dashboard.byModel[0].spendUsd, 17);
  const budget = requestBudget(await readBudgetDashboard({ ledger, nativeReader, now }), await ledger.summary({ now }));
  assert.equal(budget.directCapUsd, 175);
  assert.equal(budget.projectedUsd, 20);
  assert.equal(budget.nativeUsd, 15);
  assert.throws(() => requestBudget({ ...policy, spendUsd: 10 }, { sharedMode: true }), /budget_mode_changed/);
});
