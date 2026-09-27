export function buildCostComparison(dashboard, {
  baselineMonthlyUsd = 200,
  monthsPerYear = 12,
} = {}) {
  const missionSpendUsd = Number(dashboard?.spendUsd || 0);
  const projectedSpendUsd = Number(dashboard?.projectedSpendUsd ?? missionSpendUsd);
  const baseline = Number(baselineMonthlyUsd);
  if (!Number.isFinite(missionSpendUsd) || missionSpendUsd < 0) {
    throw new Error('invalid_mission_spend');
  }
  if (!Number.isFinite(projectedSpendUsd) || projectedSpendUsd < 0) {
    throw new Error('invalid_projected_spend');
  }
  if (!Number.isFinite(baseline) || baseline <= 0) {
    throw new Error('invalid_baseline');
  }

  const currentSavingsUsd = baseline - missionSpendUsd;
  const projectedSavingsUsd = baseline - projectedSpendUsd;
  return {
    baselineMonthlyUsd: baseline,
    missionSpendUsd,
    projectedSpendUsd,
    currentSavingsUsd,
    projectedSavingsUsd,
    currentSavingsPercent: (currentSavingsUsd / baseline) * 100,
    projectedSavingsPercent: (projectedSavingsUsd / baseline) * 100,
    annualizedBaselineUsd: baseline * monthsPerYear,
    annualizedMissionUsd: missionSpendUsd * monthsPerYear,
    annualizedProjectedMissionUsd: projectedSpendUsd * monthsPerYear,
    annualizedCurrentSavingsUsd: currentSavingsUsd * monthsPerYear,
    annualizedProjectedSavingsUsd: projectedSavingsUsd * monthsPerYear,
  };
}

export function comparisonCsv(comparison) {
  const headers = [
    'baseline_monthly_usd',
    'mission_spend_usd',
    'projected_spend_usd',
    'current_savings_usd',
    'projected_savings_usd',
    'current_savings_percent',
    'projected_savings_percent',
    'annualized_baseline_usd',
    'annualized_mission_usd',
    'annualized_projected_mission_usd',
    'annualized_current_savings_usd',
    'annualized_projected_savings_usd',
  ];
  const values = [
    comparison.baselineMonthlyUsd,
    comparison.missionSpendUsd,
    comparison.projectedSpendUsd,
    comparison.currentSavingsUsd,
    comparison.projectedSavingsUsd,
    comparison.currentSavingsPercent,
    comparison.projectedSavingsPercent,
    comparison.annualizedBaselineUsd,
    comparison.annualizedMissionUsd,
    comparison.annualizedProjectedMissionUsd,
    comparison.annualizedCurrentSavingsUsd,
    comparison.annualizedProjectedSavingsUsd,
  ];
  return `${headers.join(',')}\n${values.join(',')}\n`;
}
