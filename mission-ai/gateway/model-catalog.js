import { readFile } from 'node:fs/promises';

let cached;

export async function loadModelCatalog() {
  if (cached) return cached;
  const url = new URL('../config/provider-catalog.json', import.meta.url);
  cached = JSON.parse(await readFile(url, 'utf8'));
  return cached;
}

export async function catalogModel(provider, role) {
  const catalog = await loadModelCatalog();
  return catalog?.providers?.[provider]?.[role] || null;
}

export function clearModelCatalogCache() {
  cached = undefined;
}
