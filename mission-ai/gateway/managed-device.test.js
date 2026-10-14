import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'yaml';

process.env.MISSION_AI_FREE_BASELINE = 'true';
process.env.MISSION_AI_GITHUB_EDITOR = 'true';
process.env.MISSION_AI_DEVICE_MCP_ENABLED = 'true';
process.env.MISSION_AI_DEVICE_MCP_TOKEN = 'device-mcp-token-for-offline-tests-only-123456';
process.env.MISSION_AI_GITHUB_MCP_TOKEN = 'github_pat_offline_test_token_abcdefghijklmnopqrstuvwxyz0123456789';
process.env.GOOGLE_KEY = 'fake-google-key-for-local-tests';
process.env.TAVILY_API_KEY = 'fake-tavily-key-for-local-tests';
const { createManagedToolAdmission, createManagedToolConfigGuard } =
  await import('./generated/managedTools.js');

const raw = yaml.parse(readFileSync(new URL('../config/librechat.github-device.yaml', import.meta.url), 'utf8'));
const options = { enabled: true, toolsEnabled: false, ownerEmail: 'owner@example.test',
  gatewayURL: 'https://mission-ai-gateway.example',
  nativeToken: 'fake-managed-token-for-local-tests', titleConvo: 'false' };
function fixture(email = 'owner@example.test') {
  const config = structuredClone(raw);
  return { method: 'POST', originalUrl: '/api/agents/chat/MissionAIClaudeCached',
    user: { email }, config: { ...config, config, interfaceConfig: config.interface,
      mcpConfig: config.mcpServers },
    body: { endpoint: 'MissionAIClaudeCached', endpointType: 'custom',
      model: 'claude-sonnet-5-5', spec: 'mission-ai-claude-sonnet',
      text: 'List my available tabs.', promptCache: true, promptCacheTtl: '5m',
      ephemeralAgent: { mcp: ['mission-ai-device'] } } };
}
function run(middleware, req) {
  let next = 0; let status;
  middleware(req, { status(code) { status = code; return this; }, json() {} }, () => { next++; });
  return { next, status };
}

test('only the owner can use the reviewed Claude device profile', () => {
  const early = createManagedToolAdmission(options);
  const late = createManagedToolConfigGuard(options);
  const accepted = fixture();
  assert.equal(run(early, accepted).next, 1);
  assert.equal(run(late, accepted).next, 1);
  const other = fixture('other@example.test');
  assert.equal(run(early, other).next, 1);
  assert.equal(run(late, other).status, 403);
  const drift = fixture();
  drift.config.mcpConfig['mission-ai-device'].url = 'https://different.example/mcp';
  assert.equal(run(late, drift).status, 503);
});

test('OpenAI and other Claude paid presets retain the owner-bound device bridge', () => {
  const early = createManagedToolAdmission(options);
  const late = createManagedToolConfigGuard(options);
  for (const [spec, endpoint, model] of [
    ['mission-ai-gpt-luna', 'MissionAIOpenAI', 'gpt-6-luna'],
    ['mission-ai-claude-opus', 'MissionAIClaude', 'claude-opus-5-5'],
  ]) {
    const req = fixture();
    req.originalUrl = `/api/agents/chat/${endpoint}`;
    Object.assign(req.body, { spec, endpoint, model });
    delete req.body.promptCache;
    delete req.body.promptCacheTtl;
    assert.equal(run(early, req).next, 1);
    assert.equal(run(late, req).next, 1);
    const other = fixture('other@example.test');
    other.originalUrl = req.originalUrl;
    Object.assign(other.body, { spec, endpoint, model });
    delete other.body.promptCache;
    delete other.body.promptCacheTtl;
    assert.equal(run(early, other).next, 1);
    assert.equal(run(late, other).status, 403);
  }
});

test('Project Manager uses native Claude tools and the paired Chrome device', () => {
  const spec = raw.modelSpecs.list.find((item) => item.name === 'mission-ai-project-manager');
  assert.equal(spec.preset.endpoint, 'MissionAIClaudeCached');
  assert.deepEqual(spec.mcpServers, ['github-code-editor', 'mission-ai-device']);
  const req = fixture();
  req.body.spec = 'mission-ai-project-manager';
  req.body.ephemeralAgent.mcp = ['github-code-editor', 'mission-ai-device'];
  delete req.body.promptCache;
  delete req.body.promptCacheTtl;
  assert.equal(run(createManagedToolAdmission(options), req).next, 1);
  assert.equal(run(createManagedToolConfigGuard(options), req).next, 1);
  const other = fixture('other@example.test');
  other.body.spec = 'mission-ai-project-manager';
  other.body.ephemeralAgent.mcp = ['github-code-editor', 'mission-ai-device'];
  delete other.body.promptCache;
  delete other.body.promptCacheTtl;
  assert.equal(run(createManagedToolConfigGuard(options), other).status, 403);
});

test('a reviewed Claude device action can resume only with its device tool', () => {
  const req = fixture();
  req.originalUrl = '/api/agents/chat/resume';
  req.body = { conversationId: 'convo1', generationCreatedAt: 1,
    endpoint: 'MissionAIClaudeCached', endpointType: 'custom', model: 'claude-sonnet-5-5',
    spec: 'mission-ai-claude-sonnet', actionId: 'action1',
    decisions: [{ tool_call_id: 'call1', decision: 'approve', scope: 'once' }],
    ephemeralAgent: { mcp: ['mission-ai-device'] } };
  assert.equal(run(createManagedToolAdmission(options), req).next, 1);
  assert.equal(run(createManagedToolConfigGuard(options), req).next, 1);
  req.body.ephemeralAgent.mcp = ['github-code-editor'];
  assert.equal(run(createManagedToolAdmission(options), req).status, 403);
});
