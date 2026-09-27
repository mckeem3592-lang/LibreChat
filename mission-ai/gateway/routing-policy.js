function asAmount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function validatePolicy(policy = {}) {
  const targetUsd = asAmount(policy.targetUsd);
  const economyUsd = asAmount(policy.economyUsd);
  const hardUsd = asAmount(policy.hardUsd);

  if (
    targetUsd === null ||
    economyUsd === null ||
    hardUsd === null ||
    targetUsd > economyUsd ||
    economyUsd > hardUsd
  ) {
    throw new Error('invalid_policy');
  }

  return { targetUsd, economyUsd, hardUsd };
}

export function policyMode(spendUsd, policy = {}) {
  const spend = asAmount(spendUsd);
  if (spend === null) throw new Error('invalid_spend');

  const checked = validatePolicy(policy);
  if (spend >= checked.hardUsd) return 'blocked';
  if (spend >= checked.economyUsd) return 'economy';
  if (spend >= checked.targetUsd) return 'notice';
  return 'normal';
}
