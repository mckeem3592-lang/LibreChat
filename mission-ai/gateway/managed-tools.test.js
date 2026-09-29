import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createManagedToolAdmission, createManagedToolConfigGuard, createManagedToolOwnerGuard,
  MANAGED_NATIVE_DROPS } from './generated/managedTools.js';
const options = { enabled: true, toolsEnabled: true, ownerEmail: 'owner@synthetic.invalid',
  gatewayURL: 'https://synthetic.invalid', nativeToken: 'synthetic-native-token-1234567890123',
  toolToken: 'synthetic-tool-token-123456789012345', titleConvo: 'false' };
function config() {
  const ui = { multiConvo: false, agents: false, schedules: false, skills: false, memories: false,
    runCode: false, webSearch: false, fileSearch: false, defaultPinnedTools: ['mcp'],
    mcpServers: { use: true, create: false, share: false, public: false, toolsRefreshInterval: 0, statusRefreshInterval: 0 } };
  const servers = { 'mission-ai': { title: 'Mission AI', type: 'streamable-http',
    url: '${MISSION_AI_GATEWAY_URL}/mcp', headers: { Authorization: 'Bearer ${MISSION_AI_TOOL_TOKEN}' }, timeout: 120000, chatMenu: true } };
  return { config: { memory: { disabled: true }, summarization: { enabled: false }, interface: structuredClone(ui), mcpServers: structuredClone(servers) },
    memory: { disabled: true }, summarization: { enabled: false }, interfaceConfig: ui, mcpConfig: servers,
    endpoints: { all: { titleConvo: false, activityLabel: false, activityPhaseLabel: false, reasoningLabel: false },
      agents: { disableBuilder: true, allowedProviders: ['MissionAI'], capabilities: ['tools'], recursionLimit: 8,
        maxRecursionLimit: 8, modelResponseBodyTimeoutMs: 180000, toolApproval: { enabled: true, mode: 'default', allow: [], ask: ['mcp:mission-ai:*'] } },
      custom: [{ name: 'MissionAI', provider: 'anthropic', apiKey: '${MISSION_AI_NATIVE_TOKEN}',
        baseURL: '${MISSION_AI_GATEWAY_URL}/native/anthropic', titleConvo: false, models: { default: ['claude-sonnet-5-5'], fetch: false },
        dropParams: [...MANAGED_NATIVE_DROPS], addParams: { maxRetries: 0, timeout: 180000 } }] },
    modelSpecs: { enforce: true, prioritize: true, list: [{ name: 'mission-ai-sonnet', default: true, mcpServers: ['mission-ai'],
      preset: { endpoint: 'MissionAI', model: 'claude-sonnet-5-5', useResponsesApi: false, maxOutputTokens: 4096,
        effort: 'low', thinking: true, promptCache: false } }] } };
}
const body = () => ({ endpoint: 'MissionAI', endpointType: 'custom', model: 'claude-sonnet-5-5',
  spec: 'mission-ai-sonnet', text: 'Synthetic request.', maxOutputTokens: 4096, effort: 'low', thinking: true,
  promptCache: false, ephemeralAgent: { mcp: ['mission-ai'], web_search: false, execute_code: false } });
function invoke(middleware, overrides = {}) {
  const req = { method: 'POST', originalUrl: '/api/agents/chat/MissionAI', body: body(), config: config(),
    user: { email: options.ownerEmail }, ...overrides };
  let next = 0; let status; let response;
  middleware(req, { status(code) { status = code; return this; }, json(value) { response = value; } }, () => { next++; });
  return { req, next, status, response };
}
test('native MCP payload survives both boundaries without altering effective configuration', () => {
  const first = invoke(createManagedToolAdmission(options)); assert.equal(first.next, 1);
  assert.equal(first.req.body.max_tokens, undefined); assert.equal(first.req.body.maxOutputTokens, 4096);
  assert.deepEqual(first.req.body.ephemeralAgent, { mcp: ['mission-ai'] });
  const before = JSON.stringify(first.req.config);
  const second = invoke(createManagedToolConfigGuard(options), { body: first.req.body, config: first.req.config });
  assert.equal(second.next, 1); assert.equal(JSON.stringify(second.req.config), before);
  assert.equal(second.req.body.maxOutputTokens, 4096);
});
test('other accounts and an absent owner binding cannot use MCP or native tool chat', () => {
  for (const user of [undefined, { email: 'different@synthetic.invalid' }]) {
    assert.equal(invoke(createManagedToolOwnerGuard(options), { user }).status, 403);
    assert.equal(invoke(createManagedToolConfigGuard(options), { user }).status, 403);
  }
  assert.equal(invoke(createManagedToolOwnerGuard({ ...options, ownerEmail: '' })).status, 403);
});
test('only exact MCP read paths are admitted; credentials, OAuth, writes and query aliases are denied', () => {
  const admission = createManagedToolAdmission(options);
  for (const originalUrl of ['/api/mcp/tools', '/api/mcp/servers', '/api/mcp/connection/status']) {
    assert.equal(invoke(admission, { method: 'GET', originalUrl }).next, 1);
  }
  for (const originalUrl of ['/api/mcp/tools?server=other', '/api/mcp/other/reinitialize',
    '/api/mcp/mission-ai/auth-values', '/api/mcp/mission-ai/oauth/initiate', '/api/mcp/servers/other', '/api/mcp//tools']) {
    for (const method of ['GET', 'POST']) assert.equal(invoke(admission, { method, originalUrl }).status, 403);
  }
});
test('injected servers, builtin paid tools, sampling overrides and excessive output are refused', () => {
  const admission = createManagedToolAdmission(options);
  for (const patch of [{ ephemeralAgent: { mcp: ['other'] } }, { ephemeralAgent: { mcp: ['mission-ai'], web_search: true } },
    { effort: 'high' }, { thinking: false }, { promptCache: true }, { maxOutputTokens: 32769 },
    { max_tokens: 128 }, { providerKey: 'synthetic' }, { tools: [{}] }]) {
    assert.equal(invoke(admission, { body: { ...body(), ...patch } }).status, 403);
  }
});
test('configuration drift cannot weaken model, ownership, retry, loop, endpoint or approval boundaries', () => {
  const mutations = [(c) => { c.mcpConfig['mission-ai'].url = 'https://other.invalid/mcp'; },
    (c) => { c.config.mcpServers['mission-ai'].headers.Authorization = 'Bearer wrong'; },
    (c) => { c.endpoints.agents.recursionLimit = 90; }, (c) => { c.endpoints.agents.toolApproval.ask = []; },
    (c) => { c.endpoints.custom[0].provider = 'openai'; }, (c) => { c.endpoints.custom[0].addParams.maxRetries = 1; },
    (c) => { c.endpoints.custom[0].models.default = ['other']; }, (c) => { c.interfaceConfig.mcpServers.create = true; },
    (c) => { c.modelSpecs.list[0].mcpServers = ['other']; }, (c) => { c.config.interface.memories = true; }];
  for (const mutate of mutations) { const changed = config(); mutate(changed);
    const result = invoke(createManagedToolConfigGuard(options), { config: changed });
    assert.equal(result.status, 503); assert.equal(result.next, 0); }
});
test('default-off tools preserve the original text boundary and deny MCP access', () => {
  const admission = createManagedToolAdmission({ ...options, toolsEnabled: false });
  assert.equal(invoke(admission, { method: 'GET', originalUrl: '/api/mcp/tools' }).status, 403);
  assert.equal(invoke(admission).status, 403);
});
test('startup preflight selects only the reviewed configuration and requires owner and separate tool credentials', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME,
    MISSION_AI_GATEWAY_URL: 'https://mission-ai-gateway-mckee.onrender.com', MISSION_AI_MANAGED_CHAT: 'true',
    MISSION_AI_NATIVE_TOKEN: options.nativeToken, JWT_SECRET: 'a'.repeat(64), JWT_REFRESH_SECRET: 'b'.repeat(64),
    CREDS_KEY: 'c'.repeat(64), CREDS_IV: 'd'.repeat(32),
    MONGO_URI: 'mongodb+srv://' + 'mission_ai_chat_test:synthetic@fixture.mongodb.net/MissionAIChatTest?tls=true',
    DOMAIN_CLIENT: 'https://synthetic.invalid', DOMAIN_SERVER: 'https://synthetic.invalid' };
  const script = fileURLToPath(new URL('../chat-test/start.sh', import.meta.url));
  const preflight = (extra) => spawnSync('bash', [script, '--check'], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000 });
  assert.equal(preflight({}).status, 0);
  const native = { MISSION_AI_MANAGED_TOOLS: 'true', MISSION_AI_CONTROL_OWNER_EMAIL: options.ownerEmail, MISSION_AI_TOOL_TOKEN: options.toolToken };
  assert.equal(preflight(native).status, 0);
  for (const extra of [{ ...native, MISSION_AI_CONTROL_OWNER_EMAIL: '' }, { ...native, MISSION_AI_TOOL_TOKEN: '' },
    { ...native, MISSION_AI_TOOL_TOKEN: options.nativeToken }, { ...native, MISSION_AI_MANAGED_TOOLS: 'automatic' },
    { MISSION_AI_TOOL_TOKEN: options.toolToken }, { ...native, ANTHROPIC_API_KEY: 'synthetic-not-a-real-key' }]) {
    assert.notEqual(preflight(extra).status, 0);
  }
});
