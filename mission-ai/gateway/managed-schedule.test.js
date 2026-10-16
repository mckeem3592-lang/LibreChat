import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedToolAdmission, createManagedToolConfigGuard } from './generated/managedTools.js';

const agentId = 'agent_owner_schedule';
const scheduleId = 'sched_12345678-1234-1234-1234-123456789abc';

function invoke(options, request) {
  const guard = createManagedToolAdmission({ enabled: true, toolsEnabled: true, ...options });
  let next = 0;
  let status;
  guard(
    request,
    {
      status(value) {
        status = value;
        return this;
      },
      json() {},
    },
    () => {
      next++;
    },
  );
  return { next, status };
}

test('managed scheduling is off unless both the flag and fixed agent are supplied', () => {
  const request = { method: 'POST', originalUrl: '/api/schedules', body: { agent_id: agentId } };
  assert.equal(invoke({}, request).status, 403);
  assert.equal(invoke({ schedulesEnabled: true }, request).status, 403);
  assert.equal(invoke({ scheduleAgentId: agentId }, request).status, 403);
  assert.equal(invoke({ schedulesEnabled: true, scheduleAgentId: agentId }, request).next, 1);
  assert.equal(
    invoke(
      { schedulesEnabled: true, scheduleAgentId: agentId },
      { ...request, body: { agent_id: 'agent_other' } },
    ).status,
    403,
  );
});

test('schedule route aliases and unverified trigger posts remain denied', () => {
  const options = { schedulesEnabled: true, scheduleAgentId: agentId };
  const base = { method: 'GET', originalUrl: '/api/schedules' };
  assert.equal(invoke(options, base).next, 1);
  assert.equal(invoke(options, { ...base, originalUrl: '/api/schedules?other=1' }).status, 403);
  assert.equal(
    invoke(options, { method: 'POST', originalUrl: `/api/schedules/${scheduleId}/run` }).next,
    1,
  );
  assert.equal(
    invoke(options, {
      method: 'POST',
      originalUrl: '/api/agents/chat/agents',
      body: { endpoint: 'agents', agent_id: agentId },
    }).status,
    403,
  );
  assert.equal(
    invoke(
      { ...options, verifySignedScheduleTrigger: () => true },
      {
        method: 'POST',
        originalUrl: '/api/agents/chat/agents',
        body: { endpoint: 'agents', agent_id: agentId },
      },
    ).next,
    1,
  );
});

test('post-auth schedule fire admits only the owner and a verified fixed-agent trigger', () => {
  const fire = {
    method: 'POST',
    originalUrl: '/api/agents/chat/agents',
    user: { email: 'owner@example.com' },
    body: { endpoint: 'agents', agent_id: agentId },
  };
  const run = (options, request) => {
    const guard = createManagedToolConfigGuard({
      enabled: true,
      toolsEnabled: true,
      ownerEmail: 'owner@example.com',
      schedulesEnabled: true,
      scheduleAgentId: agentId,
      verifySignedScheduleTrigger: () => true,
      ...options,
    });
    let next = 0;
    let status;
    guard(request, { status(code) { status = code; return this; }, json() {} }, () => next++);
    return { next, status };
  };
  assert.equal(run({}, fire).next, 1);
  assert.equal(run({}, { ...fire, user: { email: 'other@example.com' } }).status, 403);
  assert.equal(run({}, { ...fire, body: { ...fire.body, agent_id: 'agent_other' } }).status, 503);
  assert.equal(run({ verifySignedScheduleTrigger: () => false }, fire).status, 503);
  assert.equal(run({ schedulesEnabled: false }, fire).status, 503);
});
