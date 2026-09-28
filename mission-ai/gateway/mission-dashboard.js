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
  const nativeSpendUsd = Number(nativeDashboard?.spendUsd || 0);
  const delegatedSpendUsd = Number(delegatedSummary?.settledUsd || 0);
  const reservedUsd = Number(delegatedSummary?.reservedUsd || 0);
  const totalSpendUsd = nativeSpendUsd + delegatedSpendUsd;
  const projectedSpendUsd = totalSpendUsd + reservedUsd;
  const targetUsd = Number(nativeDashboard?.targetUsd ?? 100);
  const economyUsd = Number(nativeDashboard?.economyUsd ?? 125);
  const hardUsd = Number(nativeDashboard?.hardUsd ?? 175);
  const policy = { targetUsd, economyUsd, hardUsd };
  const accountingBlocked = Boolean(delegatedSummary.accountingBlocked);
  const mode = budgetDecision(totalSpendUsd, policy);
  const projectedMode = budgetDecision(projectedSpendUsd, policy);

  const nativeTask = nativeSpendUsd > 0
    ? [{ task: 'librechat-native', spendUsd: nativeSpendUsd }]
    : [];
  const nativeProject = nativeSpendUsd > 0
    ? [{ project: 'librechat-native', spendUsd: nativeSpendUsd }]
    : [];

  return {
    monthStart: nativeDashboard.monthStart,
    timeZone: nativeDashboard.timeZone,
    pricing: {
      nativeSource: 'librechat-transactions',
      delegatedSource: 'mission-ai-ledger',
    },
    spendUsd: totalSpendUsd,
    projectedSpendUsd,
    remainingUsd: accountingBlocked ? 0 : Math.max(0, hardUsd - projectedSpendUsd),
    reservedUsd,
    nativeSpendUsd,
    delegatedSpendUsd,
    mode: accountingBlocked ? 'blocked' : mode,
    projectedMode: accountingBlocked ? 'blocked' : projectedMode,
    ...(accountingBlocked ? { accountingBlocked: true, accountingIssue: delegatedSummary.accountingIssue } : {}),
    targetUsd,
    economyUsd,
    hardUsd,
    byProvider: mergeBuckets(
      nativeDashboard.byProvider,
      delegatedBreakdown.byProvider,
      'provider',
    ),
    byModel: mergeBuckets(
      nativeDashboard.byModel,
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
} = {}) {
  const nativeDashboard = await nativeReader({ now });
  const ledger = usageLedger || defaultUsageLedger();
  if (typeof ledger.reconcileStaleReservations === 'function') {
    await ledger.reconcileStaleReservations({ now });
  }
  const options = { now, timeZone: nativeDashboard.timeZone };
  const [delegatedSummary, delegatedBreakdown] = await Promise.all([
    ledger.summary(options),
    ledger.breakdown(options),
  ]);
  return combineDashboard(nativeDashboard, delegatedSummary, delegatedBreakdown);
}
