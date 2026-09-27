import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCostComparison, comparisonCsv } from './cost-comparison.js';

test('compares measured Mission AI spend with the $200 monthly baseline', () => {
  const result = buildCostComparison({
    spendUsd: 80,
    projectedSpendUsd: 90,
  });
  assert.equal(result.currentSavingsUsd, 120);
  assert.equal(result.projectedSavingsUsd, 110);
  assert.equal(result.currentSavingsPercent, 60);
  assert.ok(Math.abs(result.projectedSavingsPercent - 55) < 1e-9);
  assert.equal(result.annualizedCurrentSavingsUsd, 1440);
});

test('CSV export contains only numeric comparison metrics', () => {
  const result = buildCostComparison({ spendUsd: 100, projectedSpendUsd: 110 });
  const csv = comparisonCsv(result);
  assert.match(csv, /^baseline_monthly_usd,/);
  assert.match(csv, /200,100,110,100,90/);
  assert.equal(csv.includes('prompt'), false);
});
