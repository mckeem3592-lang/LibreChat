import { routeRequest } from './route-api.js';
import { catalogModel } from './model-catalog.js';
import { normalizeTask } from './task-routing.js';

export async function verifiedRouteRequest(input = {}) {
  const task = normalizeTask(input.task);
  const result = await routeRequest({ ...input, task });
  if (!result.route) return result;

  let role = task;
  if (result.mode === 'economy') role = 'economy';

  const verified = await catalogModel(result.route.provider, role);
  if (!verified) return result;

  return {
    ...result,
    route: { ...result.route, model: verified },
  };
}
