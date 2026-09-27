import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeBudget } from '../../plugin/mission-ai-budget/scripts/budget-summary.mjs';

test('budget summary reflects monthly spend', () => {
  const summary = summarizeBudget({
    spentCredits: 42500000,
    targetUsd: 100,
    economyUsd: 125,
    hardUsd: 175,
  });

  assert.deepEqual(
    { spendUsd: summary.spendUsd, remainingUsd: summary.remainingUsd, mode: summary.mode },
    { spendUsd: 42.5, remainingUsd: 132.5, mode: 'normal' },
  );
});
