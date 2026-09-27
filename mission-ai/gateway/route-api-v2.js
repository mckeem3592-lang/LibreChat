import { routeRequest } from './route-api.js';
import { catalogModel } from './model-catalog.js';

export async function verifiedRouteRequest(input = {}) {
  const result = await routeRequest(input);
  if (!result.route) return result;

  let role = String(input.task || 'primary');
  if (role === 'chat') role = 'primary';
  if (result.mode === 'economy') role = 'economy';

  const verified = await catalogModel(result.route.provider, role);
  if (!verified) return result;

  return {
    ...result,
    route: { ...result.route, model: verified },
  };
}
