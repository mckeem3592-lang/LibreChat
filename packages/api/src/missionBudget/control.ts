type Json = Record<string, unknown>;
interface Request {
  method?: string;
  originalUrl?: string;
  body?: unknown;
  user?: { email?: string };
  get(name: string): string | undefined;
}
interface Response {
  status(code: number): Response;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
}
interface ProxyDependencies {
  enabled: boolean;
  ownerEmail: string;
  chatOrigin: string;
  gatewayURL: string;
  token: string;
  fetchImpl: typeof fetch;
}
const ERROR_CODES = new Set(['search_disabled', 'search_free_plan_unverified',
  'search_free_credits_exhausted', 'search_busy', 'search_usage_uncertain',
  'search_store_unready', 'search_input_invalid', 'control_unavailable']);
function error(res: Response, status: number, code: string): unknown {
  return res.status(status).json({ error: { code } });
}
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value as Json;
}
export function controlSearchInput(value: unknown): { query: string; maxResults: number } {
  const input = object(value);
  if (Object.keys(input).some((key) => !['query', 'maxResults'].includes(key)) ||
      typeof input.query !== 'string' || !input.query.trim() || input.query.length > 2000 ||
      (input.maxResults != null && (!Number.isInteger(input.maxResults) ||
        Number(input.maxResults) < 1 || Number(input.maxResults) > 5))) throw new Error();
  return { query: input.query.trim(), maxResults: Number(input.maxResults ?? 5) };
}
/** Owner-only, two-route proxy. The browser never receives a gateway credential. */
export function createMissionControlProxy(deps: ProxyDependencies): (req: Request, res: Response) => Promise<unknown> {
  return async (req: Request, res: Response): Promise<unknown> => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.enabled) return error(res, 404, 'control_disabled');
    if (!deps.ownerEmail || !req.user?.email ||
        req.user.email.toLowerCase() !== deps.ownerEmail.toLowerCase()) return error(res, 403, 'unauthorized');
    if (req.method === 'GET' && req.originalUrl === '/api/mission-ai/capabilities') {
      return res.json({ enabled: true });
    }
    const status = req.method === 'GET' && req.originalUrl === '/api/mission-ai/status';
    const search = req.method === 'POST' && req.originalUrl === '/api/mission-ai/search';
    if (!status && !search) return error(res, 404, 'control_route_unsupported');
    let gateway: URL;
    let body;
    try {
      gateway = new URL(deps.gatewayURL);
      const origin = new URL(deps.chatOrigin);
      if (gateway.protocol !== 'https:' || gateway.pathname !== '/' || gateway.search || gateway.hash ||
          gateway.username || gateway.password || origin.protocol !== 'https:' ||
          origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password ||
          deps.token.length < 32) throw new Error();
      if (search && req.get('origin') !== origin.origin) return error(res, 403, 'control_origin_denied');
      if (search) body = controlSearchInput(req.body);
    } catch { return error(res, 400, search ? 'search_input_invalid' : 'control_unavailable'); }
    try {
      const response = await deps.fetchImpl(`${gateway.origin}/native/control/${status ? 'status' : 'search'}`, {
        method: status ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(25_000),
        headers: { Authorization: `Bearer ${deps.token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = object(await response.json());
      if (response.status !== 200) {
        const code = object(result.error).code;
        return error(res, response.status === 429 ? 429 : 503,
          typeof code === 'string' && ERROR_CODES.has(code) ? code : 'control_unavailable');
      }
      return res.json(result);
    } catch { return error(res, 503, 'control_unavailable'); }
  };
}
interface ControlDependencies {
  token: string;
  safeEqual: (left: string, right: string) => boolean;
  dashboard: () => Promise<Json>;
  flags: () => { paidText: boolean; delegation: boolean; images: boolean; freeSearch: boolean };
  search: (body: unknown) => Promise<unknown>;
}
interface ControlHttp {
  authorize(req: Request, res: Response, next: () => void): unknown;
  status(req: Request, res: Response): Promise<unknown>;
  search(req: Request, res: Response): Promise<unknown>;
  unsupported(req: Request, res: Response): unknown;
}
/** Read accounting and run basic free search; no paid or local-control operations. */
export function createMissionControlHttp(deps: ControlDependencies): ControlHttp {
  return {
    authorize(req: Request, res: Response, next: () => void) {
      const auth = req.get('authorization') ?? '';
      if (deps.token.length < 32 || !auth.startsWith('Bearer ') ||
          !deps.safeEqual(auth.slice(7), deps.token)) return error(res, 401, 'unauthorized');
      next();
    },
    async status(_req: Request, res: Response) {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const dashboard = await deps.dashboard();
        const budget: Json = {};
        for (const key of ['spendUsd', 'reservedUsd', 'projectedSpendUsd', 'targetUsd', 'economyUsd', 'hardUsd']) {
          const value = dashboard[key];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error();
          budget[key] = value;
        }
        return res.json({ enabled: true, model: 'claude-sonnet-5-5', automaticFallbacks: false,
          legacyIncluded: false, budget, flags: deps.flags(), accountingBlocked: dashboard.accountingBlocked === true });
      } catch { return error(res, 503, 'control_unavailable'); }
    },
    async search(req: Request, res: Response) {
      res.setHeader('Cache-Control', 'no-store');
      try { return res.json(await deps.search(controlSearchInput(req.body))); }
      catch (cause) {
        const failure = cause as { code?: string; status?: number };
        const code = typeof failure?.code === 'string' && ERROR_CODES.has(failure.code)
          ? failure.code : 'control_unavailable';
        return error(res, failure?.status === 429 ? 429 : 503, code);
      }
    },
    unsupported(_req: Request, res: Response) { return error(res, 404, 'control_route_unsupported'); },
  };
}
