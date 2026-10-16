// Durable, Claude-only admission. The shared monthly ledger remains authoritative.
// This gate never enables the OpenAI-compatible or direct OpenAI routes.
export function normalClaudePolicy(env) {
  if (env.MISSION_AI_NORMAL_CLAUDE_ENABLED !== 'true' ||
      env.MISSION_AI_NATIVE_ENABLED !== 'false' ||
      env.MISSION_AI_DELEGATION_ENABLED !== 'false' ||
      env.MISSION_AI_ACCEPTANCE_SCOPE !== 'disabled') return null;
  return { maxOutputTokens: 4096, maxReservationUsd: 1 };
}
