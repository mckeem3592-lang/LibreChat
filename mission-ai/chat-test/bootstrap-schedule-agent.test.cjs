'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { expectedAgent, isPinnedAgent, newOwnerAcl, bootstrapFailureCode, main } = require('./bootstrap-schedule-agent.cjs');

const owner = { _id: { toString: () => '507f1f77bcf86cd799439011' } };
const expected = expectedAgent('agent_owner_schedule', owner);

test('default-off startup skips provisioning without database access', async () => {
  const previous = process.env.MISSION_AI_MANAGED_SCHEDULES;
  delete process.env.MISSION_AI_MANAGED_SCHEDULES;
  try {
    assert.equal(await main(), undefined);
  } finally {
    if (previous !== undefined) process.env.MISSION_AI_MANAGED_SCHEDULES = previous;
  }
});

test('owner schedule target is a tool-free Claude agent', () => {
  assert.equal(expected.provider, 'MissionAIClaudeCached');
  assert.equal(expected.model, 'claude-sonnet-5-5');
  assert.equal(expected.skills_enabled, false);
  assert.deepEqual(expected.tools, []);
  assert.equal(isPinnedAgent(expected, expected), true);
});

test('changed ownership, provider, tools, and subagents fail startup validation', () => {
  for (const changed of [
    { author: { toString: () => '507f1f77bcf86cd799439012' } },
    { provider: 'OtherProvider' },
    { tools: ['browser_type'] },
    { skills: ['skill_any'] },
    { subagents: { enabled: true } },
    { subagents: { enabled: 'true' } },
    { tool_options: { browser_type: {} } },
    { stateful_code_sessions: true },
    { edges: [{ from: expected.id, to: 'agent_other' }] },
  ]) {
    assert.equal(isPinnedAgent({ ...expected, ...changed }, expected), false);
  }
});

test('bootstrap logs only fixed internal diagnostic codes', () => {
  assert.equal(bootstrapFailureCode(new Error('agent_viewer_role_unavailable')),
    'agent_viewer_role_unavailable');
  assert.equal(bootstrapFailureCode(new Error('db URI with private credential')),
    'schedule_agent_bootstrap_failed');
  assert.equal(bootstrapFailureCode({ message: 'owner_identity_unavailable' }),
    'owner_identity_unavailable');
});

test('owner ACL stores a tenant ID string, never the tenant search predicate', () => {
  const identity = { principalType: 'user', principalId: 'owner', resourceType: 'agent', resourceId: 'agent' };
  const roleId = 'role';
  const query = { ...identity, tenantId: { $exists: false } };
  const personal = newOwnerAcl(query, undefined, roleId, 'owner', 'User', 1);
  assert.equal(Object.hasOwn(personal, 'tenantId'), false);
  assert.deepEqual(query.tenantId, { $exists: false });
  const tenant = newOwnerAcl({ ...identity, tenantId: 'tenant-a' }, 'tenant-a', roleId, 'owner', 'User', 1);
  assert.equal(tenant.tenantId, 'tenant-a');
  assert.equal(tenant.permBits, 1);
});
