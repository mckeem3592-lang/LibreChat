import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlySpendPipeline, settledCreditsFromRows } from './budget-query.mjs';

test('monthlySpendPipeline limits spend to settled prompt/completion debits', () => {
  const start = new Date('2026-09-01T06:00:00.000Z');
  const pipeline = monthlySpendPipeline(start);

  assert.deepEqual(pipeline[0], {
    $match: {
      createdAt: { $gte: start },
      tokenType: { $in: ['prompt', 'completion'] },
      tokenValue: { $lt: 0 },
    },
  });
  assert.deepEqual(pipeline[1], {
    $group: {
      _id: null,
      settledCredits: { $sum: { $multiply: ['$tokenValue', -1] } },
    },
  });
});

test('settledCreditsFromRows returns zero for an empty month and validates data', () => {
  assert.equal(settledCreditsFromRows([]), 0);
  assert.equal(settledCreditsFromRows([{ settledCredits: 12_500_000 }]), 12_500_000);
  assert.throws(
    () => settledCreditsFromRows([{ settledCredits: -1 }]),
    /invalid_settled_credits/,
  );
  assert.throws(
    () => settledCreditsFromRows([{ settledCredits: 'not-a-number' }]),
    /invalid_settled_credits/,
  );
});

test('monthlySpendPipeline rejects an invalid start date', () => {
  assert.throws(
    () => monthlySpendPipeline(new Date('invalid')),
    /invalid_month_start/,
  );
});
