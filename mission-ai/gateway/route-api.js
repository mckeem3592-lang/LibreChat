import { readFile } from 'node:fs/promises';
import { chooseRoute } from './router.js';

let cached;

async function loadConfig() {
  if (cached) return cached;
  const url = new URL('../config/router.json', import.meta.url);
  cached = JSON.parse(await readFile(url, 'utf8'));
  return cached;
}

export async function routeRequest(input = {}) {
  const config = await loadConfig();
  const task = String(input.task || 'chat');
  const spend = Number(input.monthSpendUsd || 0);
  return chooseRoute(task, spend, config);
}

export function clearRouteConfigCache() {
  cached = undefined;
}
