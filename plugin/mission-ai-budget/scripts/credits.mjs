export const CREDITS_PER_USD = 1_000_000;

export function creditsToUsd(credits) {
  const value = Number(credits);
  if (!Number.isFinite(value)) throw new Error('invalid_credits');
  return value / CREDITS_PER_USD;
}

export function usdToCredits(usd) {
  const value = Number(usd);
  if (!Number.isFinite(value) || value < 0) throw new Error('invalid_usd');
  return Math.floor(value * CREDITS_PER_USD);
}
