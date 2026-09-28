import assert from 'node:assert/strict';
import test from 'node:test';
import { combineDashboard, queryMissionDashboard } from './mission-dashboard.js';
import { createMemoryUsageLedger } from './usage-ledger.js';

const native = {
  monthStart: '2026-09-01T06:00:00.000Z',
  timeZone: 'America/Denver',
  spendUsd: 50,
  targetUsd: 100,
  economyUsd: 125,
  hardUsd: 175,
  byProvider: [{ provider: 'openai', spendUsd: 50 }],
  byModel: [{ model: 'gpt-6-luna', spendUsd: 50 }],
};

test('combines native and delegated spend with reservations', () => {
  const result = combineDashboard(
    native,
    { settledUsd: 20, reservedUsd: 5 },
    {
      byProvider: [{ provider: 'anthropic', spendUsd: 20 }],
      byModel: [{ model: 'claude-sonnet-5', spendUsd: 20 }],
      byTask: [{ task: 'coding', spendUsd: 20 }],
      byProject: [{ project: 'mission-ai', spendUsd: 20 }],
    },
  );
  assert.equal(result.spendUsd, 70);
  assert.equal(result.projectedSpendUsd, 75);
  assert.equal(result.remainingUsd, 100);
  assert.deepEqual(result.byProvider, [
    { provider: 'openai', spendUsd: 50 },
    { provider: 'anthropic', spendUsd: 20 },
  ]);
  assert.deepEqual(result.byTask, [
    { task: 'librechat-native', spendUsd: 50 },
    { task: 'coding', spendUsd: 20 },
  ]);
});

test('live dashboard reads native and delegated stores without message content', async () => {
  const ledger = createMemoryUsageLedger();
  const now = new Date('2026-09-27T18:00:00Z');
  const reservation = await ledger.reserve({
    reserveUsd: 2,
    directCapUsd: 100,
    now,
    metadata: {
      provider: 'google',
      model: 'gemini-3.8-flash',
      task: 'research',
      project: 'research',
    },
  });
  await ledger.settle({ reservationId: reservation.reservationId, actualUsd: 1 });

  const result = await queryMissionDashboard({
    now,
    usageLedger: ledger,
    nativeReader: async () => ({ ...native, spendUsd: 10 }),
  });
  assert.equal(result.spendUsd, 11);
  assert.equal(result.delegatedSpendUsd, 1);
  assert.equal(JSON.stringify(result).includes('prompt'), false);
});

test('dashboard reports accounting blocks even with budget remaining', () => {
  const result = combineDashboard(native, {
    settledUsd: 1, reservedUsd: 0, accountingBlocked: true, accountingIssue: 'reservation_underestimated',
  }, {});
  assert.equal(result.mode, 'blocked');
  assert.equal(result.projectedMode, 'blocked');
  assert.equal(result.remainingUsd, 0);
  assert.equal(result.accountingIssue, 'reservation_underestimated');
});

test('zero configured limits remain zero on the dashboard', () => {
  const result = combineDashboard({ ...native, spendUsd: 0, targetUsd: 0, economyUsd: 0, hardUsd: 0 }, {
    settledUsd: 0, reservedUsd: 0,
  }, {});
  assert.equal(result.hardUsd, 0);
  assert.equal(result.mode, 'blocked');
});
