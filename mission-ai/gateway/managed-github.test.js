import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'yaml';

process.env.MISSION_AI_FREE_BASELINE = 'true';
process.env.MISSION_AI_GITHUB_EDITOR = 'true';
process.env.MISSION_AI_GITHUB_MCP_TOKEN = 'github_pat_offline_test_token_abcdefghijklmnopqrstuvwxyz0123456789';
process.env.GOOGLE_KEY = 'fake-google-key-for-local-tests';
const { createManagedToolAdmission, createManagedToolConfigGuard } =
  await import('./generated/managedTools.js');

const raw = yaml.parse(readFileSync(new URL('../config/librechat.github-editor.yaml', import.meta.url), 'utf8'));
const options = { enabled: true, toolsEnabled: false, ownerEmail: 'owner@example.test',
  gatewayURL: 'https://mission-ai-gateway.example',
  nativeToken: 'fake-managed-token-for-local-tests', titleConvo: 'false' };
function fixture(body = {}) {
  const appConfig = structuredClone(raw);
  return { method: 'POST', originalUrl: '/api/agents/chat/MissionAIClaude',
    user: { email: 'owner@example.test' },
    config: { ...appConfig, config: appConfig, interfaceConfig: appConfig.interface,
      mcpConfig: appConfig.mcpServers },
    body: { endpoint: 'MissionAIClaude', endpointType: 'custom',
      model: 'claude-sonnet-5-5', spec: 'mission-ai-project-manager',
      text: 'Read the project index.', ephemeralAgent: { mcp: ['github-code-editor'] }, ...body } };
}
function run(middleware, req) {
  let next = 0; let status; let result;
  middleware(req, { status(code) { status = code; return this; }, json(body) { result = body; } },
    () => { next++; });
  return { next, status, result, req };
}

test('project preset admits only its exact owner-bound paid route', () => {
  const early = createManagedToolAdmission(options);
  const late = createManagedToolConfigGuard(options);
  const accepted = fixture();
  assert.equal(run(early, accepted).next, 1);
  assert.equal(run(late, accepted).next, 1);
  assert.equal(accepted.body.spec, 'mission-ai-project-manager');
  assert.equal(run(late, fixture()).next, 1);
  const wrongOwner = fixture(); wrongOwner.user.email = 'other@example.test';
  assert.equal(run(late, wrongOwner).status, 403);
  assert.equal(run(early, fixture({ model: 'claude-opus-5-5' })).status, 403);
  assert.equal(run(early, fixture({ ephemeralAgent: { mcp: ['other'] } })).status, 403);
});

test('ordinary paid Sonnet ignores stale saved prompt and Project Manager tool selection', () => {
  const early = createManagedToolAdmission(options);
  const late = createManagedToolConfigGuard(options);
  for (const ephemeralAgent of [{ mcp: [] }, { mcp: ['github-code-editor'] }]) {
    const req = fixture({ spec: 'mission-ai-claude-sonnet',
      promptPrefix: 'an older saved conversation prompt', ephemeralAgent });
    assert.equal(run(early, req).next, 1);
    assert.equal(Object.hasOwn(req.body, 'promptPrefix'), false);
    assert.equal(Object.hasOwn(req.body, 'ephemeralAgent'), false);
    assert.equal(run(late, req).next, 1);
  }
  const fresh = fixture({ spec: 'mission-ai-claude-sonnet', ephemeralAgent: { mcp: [] } });
  assert.equal(run(early, fresh).next, 1);
  assert.equal(run(late, fresh).next, 1);
  for (const mcp of [['another-server'], ['github-code-editor', 'another-server']]) {
    assert.equal(run(early, fixture({ spec: 'mission-ai-claude-sonnet',
      ephemeralAgent: { mcp } })).status, 403);
  }
});

test('a live steer reaches its text route through both guards', () => {
  const req = fixture({ conversationId: 'convo1', generationCreatedAt: 1,
    clientSteerId: 'steer1', text: 'Please adjust the answer.', preempt: true });
  req.originalUrl = '/api/agents/chat/steer';
  req.body = { conversationId: req.body.conversationId,
    generationCreatedAt: req.body.generationCreatedAt,
    clientSteerId: req.body.clientSteerId, text: req.body.text,
    preempt: req.body.preempt };
  assert.equal(run(createManagedToolAdmission(options), req).next, 1);
  assert.equal(run(createManagedToolConfigGuard(options), req).next, 1);
});

test('new MCP configuration remains exact and free chats cannot select its tool', () => {
  const late = createManagedToolConfigGuard(options);
  const drift = fixture();
  drift.config.mcpConfig['other'] = { type: 'stdio', command: 'sh' };
  assert.equal(run(late, drift).status, 503);
  const free = fixture({ endpoint: 'MissionAI', model: 'gemini-3.5-flash-lite',
    spec: 'mission-ai-free', ephemeralAgent: { mcp: ['github-code-editor'] } });
  free.originalUrl = '/api/agents/chat/MissionAI';
  assert.equal(run(createManagedToolAdmission(options), free).status, 403);
});

test('a tool decision resumes only a matching project turn', () => {
  const body = { conversationId: 'convo1', generationCreatedAt: 1,
    endpoint: 'MissionAIClaude', endpointType: 'custom', model: 'claude-sonnet-5-5',
    spec: 'mission-ai-project-manager', actionId: 'action1',
    decisions: [{ tool_call_id: 'call1', decision: 'approve', scope: 'once' }],
    ephemeralAgent: { mcp: ['github-code-editor'] } };
  const req = fixture(body); req.originalUrl = '/api/agents/chat/resume'; delete req.body.text;
  assert.equal(run(createManagedToolAdmission(options), req).next, 1);
  assert.equal(run(createManagedToolConfigGuard(options), req).next, 1);
  const restored = fixture({ ...body, maxOutputTokens: 4096 });
  restored.originalUrl = '/api/agents/chat/resume'; delete restored.body.text;
  assert.equal(run(createManagedToolAdmission(options), restored).status, 403);
  assert.equal(run(createManagedToolConfigGuard(options), restored).next, 1);
  const rejected = fixture({ ...body, decisions: [{ tool_call_id: 'call1', decision: 'always' }] });
  rejected.originalUrl = '/api/agents/chat/resume'; delete rejected.body.text;
  assert.equal(run(createManagedToolAdmission(options), rejected).status, 403);
});
