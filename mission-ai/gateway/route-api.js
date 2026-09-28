import { readFile } from 'node:fs/promises';
import { chooseRoute } from './router.js';
import { providerConfig } from './providers.js';

let cached;

async function loadConfig() {
  if (cached) return cached;
  const url = new URL('../config/router.json', import.meta.url);
  cached = JSON.parse(await readFile(url, 'utf8'));
  return cached;
}

function resolveModel(route) {
  if (!route) return null;
  const configured = route.modelEnv ? process.env[route.modelEnv] : '';
  return configured || route.defaultModel || null;
}

export async function routeRequest(input = {}) {
  const config = await loadConfig();
  const task = String(input.task || 'chat');
  const spend = Number(input.monthSpendUsd ?? 0);
  const decision = chooseRoute(task, spend, { ...config, budget: input.budget ?? config.budget });

  if (!decision.route) return decision;

  const provider = providerConfig(decision.route.provider);
  return {
    ...decision,
    route: {
      provider: decision.route.provider,
      model: resolveModel(decision.route),
      premium: Boolean(decision.route.premium),
      providerConfigured: Boolean(provider?.hasApiKey),
    },
  };
}

export function clearRouteConfigCache() {
  cached = undefined;
}
