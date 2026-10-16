type ScheduleRequest = {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

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
  if (
    typeof path !== 'string' ||
    !/^\/api\/schedules\/sched_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/run)?$/i.test(
      path,
    )
  ) {
    return false;
  }
  // Run-now does not carry the stored agent id. It needs a post-auth lookup
  // before admission, so leave it closed until that check exists.
  if (path.endsWith('/run')) return false;
  if (req.method === 'GET' || req.method === 'DELETE') return true;
  if (req.method !== 'PATCH') return false;
  const body = req.body;
  return (
    body != null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>).agent_id === expectedAgentId
  );
}
