import { budgetDecision, validateBudgetPolicy } from './budget-policy.mjs';
import { creditsToUsd, usdToCredits } from './credits.mjs';

export function summarizeBudget({ spentCredits, targetUsd, economyUsd, hardUsd }) {
  const credits = Number(spentCredits);
  if (!Number.isFinite(credits) || credits < 0) throw new Error('invalid_spent_credits');
  const policy = validateBudgetPolicy({ targetUsd, economyUsd, hardUsd });
  const spendUsd = creditsToUsd(credits);
  const remainingCredits = Math.max(0, usdToCredits(policy.hardUsd) - Math.floor(credits));
  return {
    spendUsd,
    remainingUsd: creditsToUsd(remainingCredits),
    remainingCredits,
    mode: budgetDecision(spendUsd, policy),
    targetUsd: policy.targetUsd,
    economyUsd: policy.economyUsd,
    hardUsd: policy.hardUsd,
  };
}
