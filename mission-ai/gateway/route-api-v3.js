import { verifiedRouteRequest } from './route-api-v2.js';
import { modelOverride } from './model-overrides.js';
import { normalizeTask } from './task-routing.js';
import { loadModelCatalog } from './model-catalog.js';

export async function configuredRouteRequest(input = {}) {
  const result = await verifiedRouteRequest(input);
  if (!result.route) return result;

  let role = normalizeTask(input.task);
  const { textPolicy } = await loadModelCatalog();
  if (role !== 'image' && textPolicy) {
    return { ...result, route: { ...result.route,
      provider: textPolicy.provider, model: textPolicy.model } };
  }
  if (result.mode === 'economy') role = 'economy';

  const configured = modelOverride(role);
  if (!configured) return result;

  return {
    ...result,
    route: { ...result.route, model: configured },
  };
}
