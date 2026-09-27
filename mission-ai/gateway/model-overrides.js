const ROLE_ENV = Object.freeze({
  economy: 'MISSION_AI_MODEL_ECONOMY',
  primary: 'MISSION_AI_MODEL_PRIMARY',
  coding: 'MISSION_AI_MODEL_CODING',
  reasoning: 'MISSION_AI_MODEL_REASONING',
  research: 'MISSION_AI_MODEL_RESEARCH',
  computer: 'MISSION_AI_MODEL_COMPUTER',
  image: 'MISSION_AI_MODEL_IMAGE',
});

export function modelOverride(role) {
  const envName = ROLE_ENV[role];
  if (!envName) return null;
  const value = process.env[envName];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function modelOverrideEnv(role) {
  return ROLE_ENV[role] || null;
}
