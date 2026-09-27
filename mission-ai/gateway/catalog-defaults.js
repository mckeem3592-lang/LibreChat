import { catalogModel } from './model-catalog.js';

export async function verifiedDefault(routeName, route) {
  if (!route) return null;
  const fromCatalog = await catalogModel(route.provider, routeName);
  return fromCatalog || route.defaultModel || null;
}
