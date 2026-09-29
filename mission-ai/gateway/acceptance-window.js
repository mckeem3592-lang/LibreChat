import { monthStartFor } from '../../plugin/mission-ai-budget/scripts/budget-time.mjs';

// Temporary acceptance only; the ordinary paid-chat gate remains disabled.
export function acceptanceWindow(env, now = new Date()) {
  if (env.MISSION_AI_NATIVE_ENABLED !== 'false') return null;
  const start = Date.parse(env.MISSION_AI_ACCEPTANCE_START || '');
  const end = Date.parse(env.MISSION_AI_ACCEPTANCE_END || '');
  const baseline = Number(env.MISSION_AI_ACCEPTANCE_BASELINE_USD);
  const allowance = Number(env.MISSION_AI_ACCEPTANCE_ALLOWANCE_USD);
  const time = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(time) ||
      end <= start || end - start > 30 * 60 * 1000 || time < start || time >= end ||
      !Number.isFinite(baseline) || baseline < 0 || !Number.isFinite(allowance) ||
      allowance <= 0 || allowance > 0.10) return null;
  if (monthStartFor(new Date(start), 'America/Denver').getTime() !==
      monthStartFor(new Date(end), 'America/Denver').getTime()) return null;
  return { ceilingUsd: baseline + allowance, expiresAt: new Date(end).toISOString() };
}
