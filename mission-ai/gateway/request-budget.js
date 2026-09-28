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
  const shared = dashboard.accountingMode === 'shared';
  if (shared !== (ledgerSummary.sharedMode === true)) throw new Error('budget_mode_changed');
  const nativeUsd = shared
    ? amount(ledgerSummary.nativeUsd) + amount(ledgerSummary.historyUsd)
    : amount(dashboard.spendUsd);
  const delegatedUsd = shared ? amount(ledgerSummary.delegatedUsd) : amount(ledgerSummary.settledUsd);
  const reconciliationUsd = shared ? amount(ledgerSummary.reconciliationUsd) : 0;
  const reservedUsd = amount(ledgerSummary.reservedUsd);
  if (shared && Math.abs(amount(ledgerSummary.settledUsd) - nativeUsd - delegatedUsd - reconciliationUsd) > 1e-9) {
    throw new Error('invalid_budget_snapshot');
  }
  const projectedUsd = amount(nativeUsd + delegatedUsd + reconciliationUsd + reservedUsd);
  if (projectedUsd >= policy.hardUsd) throw new Error('monthly_hard_limit');
  return {
    policy,
    nativeUsd,
    delegatedUsd,
    ...(shared ? { reconciliationUsd } : {}),
    projectedUsd,
    directCapUsd: shared ? policy.hardUsd : Math.max(0, policy.hardUsd - nativeUsd),
  };
}

// The ledger becomes the sole accounting authority after a drained, one-time cutover.
export async function readBudgetDashboard({ ledger, nativeReader, now }) {
  const shared = typeof ledger.sharedBudget === 'function' ? await ledger.sharedBudget() : null;
  if (!shared) return nativeReader({ now });
  return {
    accountingMode: 'shared',
    timeZone: shared.timeZone,
    ...shared.policy,
    spendUsd: 0,
  };
}
