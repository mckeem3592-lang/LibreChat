import { queryCostDashboard } from './dashboard.js';
import { defaultUsageLedger } from './usage-ledger.js';
import { budgetDecision } from '../../plugin/mission-ai-budget/scripts/budget-policy.mjs';

function mergeBuckets(left = [], right = [], key) {
  const totals = new Map();
  for (const row of [...left, ...right]) {
    const name = String(row?.[key] || 'unknown');
    const current = totals.get(name) || { [key]: name, spendUsd: 0 };
    current.spendUsd += Number(row?.spendUsd || 0);
    totals.set(name, current);
  }
  return [...totals.values()].sort((a, b) => b.spendUsd - a.spendUsd);
}

export function combineDashboard(nativeDashboard, delegatedSummary, delegatedBreakdown) {
  const shared = nativeDashboard.accountingMode === 'shared';
  if (shared !== (delegatedSummary.sharedMode === true)) throw new Error('budget_mode_changed');
  const nativeSpendUsd = shared
    ? Number(delegatedSummary.nativeUsd) + Number(delegatedSummary.historyUsd)
    : Number(nativeDashboard?.spendUsd || 0);
  const delegatedSpendUsd = Number(shared ? delegatedSummary.delegatedUsd : delegatedSummary?.settledUsd || 0);
  const reconciliationUsd = shared ? delegatedSummary.reconciliationUsd : 0;
  const reservedUsd = Number(delegatedSummary?.reservedUsd || 0);
  const totalSpendUsd = nativeSpendUsd + delegatedSpendUsd + reconciliationUsd;
  if (shared && (['nativeUsd', 'historyUsd', 'delegatedUsd', 'reconciliationUsd', 'settledUsd', 'reservedUsd']
    .some((key) => typeof delegatedSummary[key] !== 'number' || !Number.isFinite(delegatedSummary[key]) || delegatedSummary[key] < 0) ||
      !Number.isFinite(totalSpendUsd) || Math.abs(totalSpendUsd - delegatedSummary.settledUsd) > 1e-9)) {
    throw new Error('invalid_budget_snapshot');
  }
  const projectedSpendUsd = totalSpendUsd + reservedUsd;
  const targetUsd = Number(nativeDashboard?.targetUsd ?? 100);
  const economyUsd = Number(nativeDashboard?.economyUsd ?? 125);
  const hardUsd = Number(nativeDashboard?.hardUsd ?? 175);
  const policy = { targetUsd, economyUsd, hardUsd };
  const accountingBlocked = Boolean(delegatedSummary.accountingBlocked);
  const mode = budgetDecision(totalSpendUsd, policy);
  const projectedMode = budgetDecision(projectedSpendUsd, policy);

  const nativeTask = !shared && nativeSpendUsd > 0
    ? [{ task: 'librechat-native', spendUsd: nativeSpendUsd }]
    : [];
  const nativeProject = !shared && nativeSpendUsd > 0
    ? [{ project: 'librechat-native', spendUsd: nativeSpendUsd }]
    : [];

  return {
    monthStart: nativeDashboard.monthStart,
    timeZone: nativeDashboard.timeZone,
    accountingMode: shared ? 'shared' : 'snapshot',
    pricing: {
      nativeSource: shared ? 'mission-ai-ledger' : 'librechat-transactions',
      delegatedSource: 'mission-ai-ledger',
    },
    spendUsd: totalSpendUsd,
    projectedSpendUsd,
    remainingUsd: accountingBlocked ? 0 : Math.max(0, hardUsd - projectedSpendUsd),
    reservedUsd,
    nativeSpendUsd,
    delegatedSpendUsd,
    ...(shared ? { reconciliationUsd } : {}),
    mode: accountingBlocked ? 'blocked' : mode,
    projectedMode: accountingBlocked ? 'blocked' : projectedMode,
    ...(accountingBlocked ? { accountingBlocked: true, accountingIssue: delegatedSummary.accountingIssue } : {}),
    targetUsd,
    economyUsd,
    hardUsd,
    byProvider: mergeBuckets(
      shared ? [] : nativeDashboard.byProvider,
      delegatedBreakdown.byProvider,
      'provider',
    ),
    byModel: mergeBuckets(
      shared ? [] : nativeDashboard.byModel,
      delegatedBreakdown.byModel,
      'model',
    ),
    byTask: mergeBuckets(nativeTask, delegatedBreakdown.byTask, 'task'),
    byProject: mergeBuckets(nativeProject, delegatedBreakdown.byProject, 'project'),
    native: nativeDashboard,
    delegated: {
      ...delegatedSummary,
      ...delegatedBreakdown,
    },
  };
}

export async function queryMissionDashboard({
  now = new Date(),
  nativeReader = queryCostDashboard,
  usageLedger,
  includePeriods = false,
} = {}) {
  const ledger = usageLedger || defaultUsageLedger();
  const shared = typeof ledger.sharedBudget === 'function' ? await ledger.sharedBudget() : null;
  const nativeDashboard = shared
    ? { accountingMode: 'shared', timeZone: shared.timeZone, ...shared.policy, spendUsd: 0 }
    : await nativeReader({ now });
  if (typeof ledger.reconcileStaleReservations === 'function') {
    await ledger.reconcileStaleReservations({ now });
  }
  const options = { now, timeZone: nativeDashboard.timeZone };
  const [delegatedSummary, delegatedBreakdown, periods] = await Promise.all([
    ledger.summary(options),
    ledger.breakdown(options),
    shared && includePeriods && typeof ledger.spendingPeriods === 'function'
      ? ledger.spendingPeriods(options) : null,
  ]);
  if (shared) nativeDashboard.monthStart = delegatedSummary.monthStart;
  return { ...combineDashboard(nativeDashboard, delegatedSummary, delegatedBreakdown),
    ...(periods ? { periods } : {}) };
}
