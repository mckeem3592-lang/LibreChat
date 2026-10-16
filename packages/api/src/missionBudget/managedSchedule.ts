import { readScheduleFireContext } from '../schedules/trigger';

type ScheduleRequest = {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  user?: { id?: string; email?: string };
};

type ScheduleResponse = {
  status: (status: number) => ScheduleResponse;
  json: (body: unknown) => unknown;
};

const SCHEDULE_ID_PATH =
  /^\/api\/schedules\/(sched_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/run)?$/i;

/** Only the native schedule picker and card may read the fixed agent. Native
 * AGENTS:USE and resource VIEW checks remain in the agent routes. */
export function isManagedScheduleAgentRead(
  req: ScheduleRequest,
  expectedAgentId?: string,
): boolean {
  if (
    !expectedAgentId ||
    !/^agent_[A-Za-z0-9_-]{1,200}$/.test(expectedAgentId) ||
    req.method !== 'GET'
  )
    return false;
  const path = req.originalUrl ?? req.url;
  if (path === `/api/agents/${expectedAgentId}`) return true;
  if (typeof path !== 'string' || !path.startsWith('/api/agents?')) return false;
  const params = new URLSearchParams(path.slice('/api/agents?'.length));
  return (
    params.size === 2 && params.get('requiredPermission') === '1' && params.get('limit') === '1000'
  );
}

/** Admission runs before authentication. A server-injected verifier checks the
 * signed schedule trigger; this helper checks the fixed agent pin. The chat
 * router authenticates again and enforces the owner's role and agent ACL. */
export function isManagedScheduleTrigger(
  req: ScheduleRequest,
  expectedAgentId: string | undefined,
  verifySignedScheduleTrigger?: (request: ScheduleRequest) => boolean,
): boolean {
  if (
    !expectedAgentId ||
    !/^agent_[A-Za-z0-9_-]{1,200}$/.test(expectedAgentId) ||
    req.method !== 'POST' ||
    (req.originalUrl ?? req.url) !== '/api/agents/chat/agents' ||
    !verifySignedScheduleTrigger?.(req)
  ) {
    return false;
  }
  const body = req.body;
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return false;
  const fields = body as Record<string, unknown>;
  if (fields.endpoint !== 'agents' || fields.agent_id !== expectedAgentId) return false;
  return true;
}

export function createManagedSchedulePayloadGuard(options: {
  enabled: boolean;
  agentId?: string;
  isSignedTrigger: (request: ScheduleRequest) => boolean;
}): (req: ScheduleRequest, res: ScheduleResponse, next: () => unknown) => unknown {
  return (req, res, next) => {
    if (!options.enabled || req.method !== 'POST' ||
        (req.originalUrl ?? req.url) !== '/api/agents/chat/agents' ||
        !options.isSignedTrigger(req)) return next();
    const body = req.body;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: { code: 'invalid_schedule_trigger',
        message: 'Invalid schedule trigger payload' } });
    }
    const fields = body as Record<string, unknown>;
    if (fields.agent_id !== options.agentId || fields.conversationId != null) return next();
    if (readScheduleFireContext({ _isAgentTrigger: true, body: fields }) == null) {
      return res.status(400).json({ error: { code: 'invalid_schedule_trigger',
        message: 'Invalid schedule trigger payload' } });
    }
    return next();
  };
}

/** Exact route admission only. Authentication, schedule ownership, role checks,
 * payload validation, and engine readiness remain in the native router. */
export function isManagedScheduleRoute(
  req: ScheduleRequest,
  expectedAgentId: string | undefined,
): boolean {
  if (!expectedAgentId || !/^agent_[A-Za-z0-9_-]{1,200}$/.test(expectedAgentId)) return false;
  const path = req.originalUrl ?? req.url;
  if (path === '/api/schedules') {
    if (req.method === 'GET') return true;
    if (req.method !== 'POST') return false;
    const body = req.body;
    return (
      body != null &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).agent_id === expectedAgentId
    );
  }
  if (typeof path !== 'string' || !SCHEDULE_ID_PATH.test(path)) {
    return false;
  }
  // Run-now carries only an id; a post-auth guard checks the stored agent pin.
  if (path.endsWith('/run')) return req.method === 'POST';
  if (req.method === 'GET' || req.method === 'DELETE') return true;
  if (req.method !== 'PATCH') return false;
  const body = req.body;
  return (
    body != null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    ((body as Record<string, unknown>).agent_id === undefined ||
      (body as Record<string, unknown>).agent_id === expectedAgentId)
  );
}

/** This runs after JWT and owner authentication, before native handlers. It
 * fences edits that omit agent_id as well as run-now and existing-row reads. */
export function createManagedSchedulePinGuard(options: {
  enabled: boolean;
  agentId?: string;
  getScheduleById: (id: string, userId: string) => Promise<{ agent_id?: string } | null>;
}): (req: ScheduleRequest, res: ScheduleResponse, next: () => unknown) => Promise<unknown> {
  return async (
    req: ScheduleRequest,
    res: ScheduleResponse,
    next: () => unknown,
  ): Promise<unknown> => {
    if (!options.enabled) return next();
    if (
      !options.agentId ||
      !/^agent_[A-Za-z0-9_-]{1,200}$/.test(options.agentId) ||
      !isManagedScheduleRoute(req, options.agentId) ||
      !req.user?.id
    ) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const path = req.originalUrl ?? req.url ?? '';
    if (path === '/api/schedules') return next();
    const id = SCHEDULE_ID_PATH.exec(path)?.[1];
    if (!id) return res.status(403).json({ error: 'Forbidden' });
    try {
      const row = await options.getScheduleById(id, req.user.id);
      if (!row) return res.status(404).json({ error: 'Schedule not found' });
      if (row.agent_id !== options.agentId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return next();
    } catch {
      return res.status(503).json({ error: 'Schedule target check unavailable' });
    }
  };
}
