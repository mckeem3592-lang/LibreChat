export function validateBudgetPolicy(input = {}) {
  const targetUsd = Number(input.targetUsd);
  const economyUsd = Number(input.economyUsd);
  const hardUsd = Number(input.hardUsd);

  if (
    !Number.isFinite(targetUsd) ||
    !Number.isFinite(economyUsd) ||
    !Number.isFinite(hardUsd) ||
    targetUsd < 0 ||
    targetUsd > economyUsd ||
    economyUsd > hardUsd
  ) {
    throw new Error('invalid_budget_policy');
  }

  return { targetUsd, economyUsd, hardUsd };
}

export function budgetDecision(spendUsd, input = {}) {
  const spend = Number(spendUsd);
  if (!Number.isFinite(spend) || spend < 0) throw new Error('invalid_budget_spend');

  const policy = validateBudgetPolicy(input);
  if (spend >= policy.hardUsd) return 'blocked';
  if (spend >= policy.economyUsd) return 'economy';
  if (spend >= policy.targetUsd) return 'notice';
  return 'normal';
}
