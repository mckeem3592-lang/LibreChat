import { routeRequest } from './route-api.js';
import { policyMode } from './routing-policy.js';
import { readFile } from 'node:fs/promises';

let policyCache;

async function loadPolicy() {
  if (policyCache) return policyCache;
  const url = new URL('../config/router.json', import.meta.url);
  const config = JSON.parse(await readFile(url, 'utf8'));
  policyCache = config.budget;
  return policyCache;
}

export async function safeRouteRequest(input = {}) {
  const spend = input.monthSpendUsd ?? 0;
  const policy = await loadPolicy();
  policyMode(spend, policy);
  return routeRequest({ ...input, monthSpendUsd: Number(spend) });
}

export function clearSafeRouteCache() {
  policyCache = undefined;
}
