import { verifiedRouteRequest } from './route-api-v2.js';

export async function handleRoute(body = {}) {
  try {
    return {
      status: 200,
      body: { ok: true, result: await verifiedRouteRequest(body) },
    };
  } catch (error) {
    return {
      status: 400,
      body: {
        ok: false,
        error: error instanceof Error ? error.message : 'routing_error',
      },
    };
  }
}
