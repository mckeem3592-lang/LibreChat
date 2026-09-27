import { readFile } from 'node:fs/promises';
import { providerConfig } from './providers.js';
import { catalogModel } from './model-catalog.js';
import { modelOverride } from './model-overrides.js';

let cachedPolicy;

async function loadPolicy() {
  if (cachedPolicy) return cachedPolicy;
  const raw = await readFile(new URL('../config/provider-fallbacks.json', import.meta.url), 'utf8');
  cachedPolicy = JSON.parse(raw);
  return cachedPolicy;
}

export function parseTarget(target) {
  const [provider, role, ...rest] = String(target || '').split(':');
  if (!provider || !role || rest.length) throw new Error('invalid_fallback_target');
  return { provider, role };
}

export function chooseAvailableTarget(targets, readiness = {}) {
  for (const target of targets || []) {
    const parsed = parseTarget(target);
    if (readiness[parsed.provider] === true) return parsed;
  }
  return null;
}

export async function providerReadiness() {
  return Object.fromEntries(
    ['openai', 'anthropic', 'google'].map((name) => [
      name,
      Boolean(providerConfig(name)?.hasApiKey),
    ]),
  );
}

export async function fallbackPlan(role, {
  readiness,
  policy,
} = {}) {
  const fallbackPolicy = policy || await loadPolicy();
  const targets = fallbackPolicy?.roles?.[role];
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('fallback_role_not_configured');

  const state = readiness || await providerReadiness();
  const selected = chooseAvailableTarget(targets, state);
  if (!selected) {
    return {
      available: false,
      role,
      attempts: targets.length,
      targets: targets.map((target) => parseTarget(target)),
    };
  }

  const model = modelOverride(selected.role) || await catalogModel(selected.provider, selected.role);
  return {
    available: true,
    role,
    attempts: targets.indexOf(`${selected.provider}:${selected.role}`) + 1,
    selected: { ...selected, model },
  };
}

export function resetFallbackCache() {
  cachedPolicy = undefined;
}
