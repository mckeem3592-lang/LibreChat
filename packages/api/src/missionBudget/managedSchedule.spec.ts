import { generateAgentTriggerToken, generateShortLivedToken } from '../crypto/jwt';
import { isAgentTriggerRequest } from '../crypto/jwt';
import { readScheduleFireContext } from '../schedules/trigger';
import {
  createManagedSchedulePinGuard,
  isManagedScheduleAgentRead,
  isManagedScheduleRoute,
  isManagedScheduleTrigger,
} from './managedSchedule';

describe('managed schedule trigger admission', () => {
  const previousSecret = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = 'managed-schedule-test-secret';
  });
  afterAll(() => {
    if (previousSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const agentId = 'agent_owner_schedule';
  const verify = (req: Parameters<typeof isManagedScheduleTrigger>[0]) =>
    isAgentTriggerRequest(req) &&
    readScheduleFireContext({ _isAgentTrigger: true, body: req.body as Record<string, unknown> }) !=
      null;
  const request = () => ({
    method: 'POST',
    originalUrl: '/api/agents/chat/agents',
    headers: {
      'x-lc-agent-trigger': '1',
      authorization: `Bearer ${generateAgentTriggerToken('owner-id')}`,
    },
    body: {
      endpoint: 'agents',
      agent_id: agentId,
      agentTrigger: {
        version: 1,
        event: {
          type: 'schedule.occurrence',
          occurredAt: Date.now(),
          source: { type: 'schedule', id: 'sched_1' },
        },
      },
    },
  });

  it('admits only a signed schedule fire for the pinned agent', () => {
    expect(isManagedScheduleTrigger(request(), agentId, verify)).toBe(true);
    expect(isManagedScheduleTrigger(request(), undefined, verify)).toBe(false);
    expect(isManagedScheduleTrigger(request(), 'agent_other', verify)).toBe(false);
    expect(isManagedScheduleTrigger(request(), agentId)).toBe(false);
  });

  it('rejects ordinary, unsigned, aliased, and unrelated triggers', () => {
    const valid = request();
    expect(
      isManagedScheduleTrigger(
        { ...valid, originalUrl: '/api/agents/chat/agents?x=1' },
        agentId,
        verify,
      ),
    ).toBe(false);
    expect(isManagedScheduleTrigger({ ...valid, method: 'GET' }, agentId, verify)).toBe(false);
    expect(
      isManagedScheduleTrigger(
        {
          ...valid,
          headers: {
            ...valid.headers,
            authorization: `Bearer ${generateShortLivedToken('owner-id')}`,
          },
        },
        agentId,
        verify,
      ),
    ).toBe(false);
    expect(
      isManagedScheduleTrigger(
        {
          ...valid,
          headers: {
            ...valid.headers,
            'x-lc-agent-trigger': '0',
          },
        },
        agentId,
        verify,
      ),
    ).toBe(false);
    expect(
      isManagedScheduleTrigger(
        {
          ...valid,
          body: {
            ...valid.body,
            agentTrigger: {
              ...valid.body.agentTrigger,
              event: {
                ...valid.body.agentTrigger.event,
                type: 'webhook.event',
              },
            },
          },
        },
        agentId,
        verify,
      ),
    ).toBe(false);
    expect(
      isManagedScheduleTrigger(
        {
          ...valid,
          body: {
            ...valid.body,
            agent_id: 'agent_other',
          },
        },
        agentId,
        verify,
      ),
    ).toBe(false);
  });
});

describe('managed schedule agent picker admission', () => {
  const agentId = 'agent_owner_schedule';
  it('admits only VIEW-list and fixed-agent reads', () => {
    expect(
      isManagedScheduleAgentRead(
        { method: 'GET', originalUrl: '/api/agents?requiredPermission=1&limit=1000' },
        agentId,
      ),
    ).toBe(true);
    expect(
      isManagedScheduleAgentRead({ method: 'GET', originalUrl: `/api/agents/${agentId}` }, agentId),
    ).toBe(true);
    expect(
      isManagedScheduleAgentRead(
        { method: 'GET', originalUrl: '/api/agents?requiredPermission=2&limit=1000' },
        agentId,
      ),
    ).toBe(false);
    expect(
      isManagedScheduleAgentRead(
        { method: 'GET', originalUrl: '/api/agents?requiredPermission=1&limit=1000&cursor=x' },
        agentId,
      ),
    ).toBe(false);
    expect(
      isManagedScheduleAgentRead(
        { method: 'GET', originalUrl: '/api/agents/agent_other' },
        agentId,
      ),
    ).toBe(false);
    expect(
      isManagedScheduleAgentRead(
        { method: 'PATCH', originalUrl: `/api/agents/${agentId}` },
        agentId,
      ),
    ).toBe(false);
  });
});

describe('managed schedule route admission', () => {
  const agentId = 'agent_owner_schedule';
  const id = 'sched_12345678-1234-1234-1234-123456789abc';

  it('admits only exact native schedule paths with a pinned create target', () => {
    expect(isManagedScheduleRoute({ method: 'GET', originalUrl: '/api/schedules' }, agentId)).toBe(
      true,
    );
    expect(
      isManagedScheduleRoute(
        { method: 'POST', originalUrl: '/api/schedules', body: { agent_id: agentId } },
        agentId,
      ),
    ).toBe(true);
    expect(
      isManagedScheduleRoute({ method: 'GET', originalUrl: `/api/schedules/${id}` }, agentId),
    ).toBe(true);
    expect(
      isManagedScheduleRoute({ method: 'DELETE', originalUrl: `/api/schedules/${id}` }, agentId),
    ).toBe(true);
    expect(
      isManagedScheduleRoute({ method: 'POST', originalUrl: `/api/schedules/${id}/run` }, agentId),
    ).toBe(true);
    expect(
      isManagedScheduleRoute(
        { method: 'PATCH', originalUrl: `/api/schedules/${id}`, body: { prompt: 'new text' } },
        agentId,
      ),
    ).toBe(true);
    expect(
      isManagedScheduleRoute(
        {
          method: 'PATCH',
          originalUrl: `/api/schedules/${id}`,
          body: { prompt: 'new text', agent_id: agentId },
        },
        agentId,
      ),
    ).toBe(true);
  });

  it('refuses alternate targets, query aliases, management paths and malformed ids', () => {
    expect(
      isManagedScheduleRoute(
        { method: 'POST', originalUrl: '/api/schedules', body: { agent_id: 'agent_other' } },
        agentId,
      ),
    ).toBe(false);
    expect(
      isManagedScheduleRoute(
        { method: 'PATCH', originalUrl: `/api/schedules/${id}`, body: { agent_id: 'agent_other' } },
        agentId,
      ),
    ).toBe(false);
    expect(
      isManagedScheduleRoute({ method: 'GET', originalUrl: '/api/schedules?x=1' }, agentId),
    ).toBe(false);
    expect(
      isManagedScheduleRoute({ method: 'GET', originalUrl: '/api/schedules/all' }, agentId),
    ).toBe(false);
    expect(
      isManagedScheduleRoute(
        { method: 'POST', originalUrl: `/api/schedules/${id}/run?x=1` },
        agentId,
      ),
    ).toBe(false);
    expect(
      isManagedScheduleRoute(
        {
          method: 'DELETE',
          originalUrl: '/api/schedules/sched_------------------------------------',
        },
        agentId,
      ),
    ).toBe(false);
    expect(
      isManagedScheduleRoute({ method: 'GET', originalUrl: '/api/schedules' }, undefined),
    ).toBe(false);
  });

  it('checks stored ownership and agent pin before a no-agent edit or manual run', async () => {
    const getScheduleById = jest.fn(async (_id: string, _userId: string) => ({
      agent_id: agentId,
    }));
    const guard = createManagedSchedulePinGuard({ enabled: true, agentId, getScheduleById });
    const call = async (method: string, path: string, body?: unknown) => {
      let status: number | undefined;
      let next = 0;
      const response = {
        status(code: number) {
          status = code;
          return this;
        },
        json() {},
      };
      await guard(
        { method, originalUrl: path, body, user: { id: 'owner-id' } },
        response,
        () => next++,
      );
      return { status, next };
    };
    expect(await call('PATCH', `/api/schedules/${id}`, { prompt: 'edited' })).toEqual({
      status: undefined,
      next: 1,
    });
    expect(await call('POST', `/api/schedules/${id}/run`)).toEqual({ status: undefined, next: 1 });
    expect(getScheduleById).toHaveBeenCalledWith(id, 'owner-id');
    getScheduleById.mockResolvedValueOnce({ agent_id: 'agent_other' });
    expect(await call('POST', `/api/schedules/${id}/run`)).toEqual({ status: 403, next: 0 });
    getScheduleById.mockResolvedValueOnce(null);
    expect(await call('GET', `/api/schedules/${id}`)).toEqual({ status: 404, next: 0 });
  });
});
