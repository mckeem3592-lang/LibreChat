import { validateBudgetPolicy } from '../../plugin/mission-ai-budget/scripts/budget-policy.mjs';

function amount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('invalid_budget_snapshot');
  }
  return value;
}

export function requestBudget(dashboard, ledgerSummary) {
  if (ledgerSummary.accountingBlocked) throw new Error('ledger_accounting_blocked');
  const policy = validateBudgetPolicy({
    targetUsd: amount(dashboard.targetUsd),
    economyUsd: amount(dashboard.economyUsd),
    hardUsd: amount(dashboard.hardUsd),
  });
  const nativeUsd = amount(dashboard.spendUsd);
  const delegatedUsd = amount(ledgerSummary.settledUsd);
  const reservedUsd = amount(ledgerSummary.reservedUsd);
  const projectedUsd = amount(nativeUsd + delegatedUsd + reservedUsd);
  if (projectedUsd >= policy.hardUsd) throw new Error('monthly_hard_limit');
  return {
    policy,
    nativeUsd,
    delegatedUsd,
    projectedUsd,
    directCapUsd: Math.max(0, policy.hardUsd - nativeUsd),
  };
}
