import { monthStartFor } from '../../plugin/mission-ai-budget/scripts/budget-time.mjs';

// Temporary acceptance only; the ordinary paid-chat gate remains disabled.
export function acceptanceWindow(env, now = new Date()) {
  if (env.MISSION_AI_NATIVE_ENABLED !== 'false') return null;
  const scope = env.MISSION_AI_ACCEPTANCE_SCOPE || 'coding-read';
  if (!['coding-read', 'final-workflows'].includes(scope)) return null;
  const workflows = scope === 'final-workflows';
  if (workflows && (env.MISSION_AI_DELEGATION_ENABLED !== 'false' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(env.MISSION_AI_ACCEPTANCE_RUN_ID || ''))) return null;
  const start = Date.parse(env.MISSION_AI_ACCEPTANCE_START || '');
  const end = Date.parse(env.MISSION_AI_ACCEPTANCE_END || '');
  const baseline = Number(env.MISSION_AI_ACCEPTANCE_BASELINE_USD);
  const allowance = Number(env.MISSION_AI_ACCEPTANCE_ALLOWANCE_USD);
  const time = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(time) ||
      end <= start || end - start > 30 * 60 * 1000 || time < start || time >= end ||
      !Number.isFinite(baseline) || baseline < 0 || !Number.isFinite(allowance) ||
      allowance <= 0 || allowance > (workflows ? 0.50 : 0.13)) return null;
  if (monthStartFor(new Date(start), 'America/Denver').getTime() !==
      monthStartFor(new Date(end), 'America/Denver').getTime()) return null;
  return { ceilingUsd: baseline + allowance, expiresAt: new Date(end).toISOString(), scope,
    ...(workflows ? { runId: env.MISSION_AI_ACCEPTANCE_RUN_ID } : {}), maxOutputTokens: 256,
    allowedToolNames: workflows ? ['read_file', 'write_file', 'execute_command',
      'browser_list_tabs_mcp_mission-ai', 'mac_screenshot_mcp_mission-ai',
      'mission_generate_image_mcp_mission-ai'] : ['read_file'] };
}
