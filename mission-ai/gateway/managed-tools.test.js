import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createManagedToolAdmission, createManagedToolConfigGuard, createManagedResumeConfigGuard, createManagedToolOwnerGuard,
  MANAGED_NATIVE_DROPS, createManagedProjectGuard } from './generated/managedTools.js';
const options = { enabled: true, toolsEnabled: true, ownerEmail: 'owner@synthetic.invalid',
  gatewayURL: 'https://synthetic.invalid', nativeToken: 'synthetic-native-token-1234567890123',
  toolToken: 'synthetic-tool-token-123456789012345', titleConvo: 'false' };
function config() {
  const ui = { multiConvo: false, agents: false, schedules: false, skills: false, memories: true,
    runCode: true, webSearch: false, fileSearch: false, defaultPinnedTools: ['mcp', 'memory'],
    mcpServers: { use: true, create: false, share: false, public: false, toolsRefreshInterval: 0, statusRefreshInterval: 0 } };
  const servers = { 'mission-ai': { title: 'Mission AI', type: 'streamable-http',
    url: '${MISSION_AI_GATEWAY_URL}/mcp', headers: { Authorization: 'Bearer ${MISSION_AI_TOOL_TOKEN}' }, timeout: 120000, chatMenu: true } };
  return { config: { memory: { disabled: false, personalize: false, tokenLimit: 2000, charLimit: 10000, maxInputTokens: 2000, messageWindowSize: 5 }, summarization: { enabled: false }, interface: structuredClone(ui), mcpServers: structuredClone(servers) },
    memory: { disabled: false, personalize: false, tokenLimit: 2000, charLimit: 10000, maxInputTokens: 2000, messageWindowSize: 5 }, summarization: { enabled: false }, interfaceConfig: ui, mcpConfig: servers,
    endpoints: { all: { titleConvo: false, activityLabel: false, activityPhaseLabel: false, reasoningLabel: false },
      agents: { disableBuilder: true, allowedProviders: ['MissionAI'], capabilities: ['tools', 'execute_code', 'stateful_code_sessions', 'memory'],
        statefulCodeSessions: { allowedEnvironments: ['conversation'], environments: [{ id: 'attached-workers', name: 'Mission AI Mac', type: 'attached', baseURL: 'https://mission-ai-code-api-mckee.onrender.com/v1', owner: 'deployment', default: true, pairing: { workerId: 'mac-primary-code', tokenEnv: 'MISSION_AI_CODE_BRIDGE_ADMIN_TOKEN' } }] }, recursionLimit: 8,
        maxRecursionLimit: 8, modelResponseBodyTimeoutMs: 180000, toolApproval: { enabled: true, mode: 'default', allow: [], ask: ['*'] } },
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
test('owner reconnect admits only the fixed server with an empty body and retains owner checks', () => {
  const admission = createManagedToolAdmission(options);
  const request = { method: 'POST', originalUrl: '/api/mcp/mission-ai/reinitialize', body: {} };
  assert.equal(invoke(admission, request).next, 1);
  assert.equal(invoke(admission, { ...request, body: undefined }).next, 1);
  for (const body of [{ url: 'https://other.invalid' }, { auth: 'injected' }, [], null]) {
    assert.equal(invoke(admission, { ...request, body }).status, 403);
  }
  for (const originalUrl of ['/api/mcp/other/reinitialize', '/api/mcp/mission-ai/reinitialize?other=1', '/api/mcp/mission-ai//reinitialize']) {
    assert.equal(invoke(admission, { ...request, originalUrl }).status, 403);
  }
  assert.equal(invoke(createManagedToolAdmission({ ...options, toolsEnabled: false }), request).status, 403);
  assert.equal(invoke(createManagedToolOwnerGuard(options), { ...request, user: { email: 'different@synthetic.invalid' } }).status, 403);
});
test('configuration drift cannot weaken model, ownership, retry, loop, endpoint or approval boundaries', () => {
  const mutations = [(c) => { c.mcpConfig['mission-ai'].url = 'https://other.invalid/mcp'; },
    (c) => { c.config.mcpServers['mission-ai'].headers.Authorization = 'Bearer wrong'; },
    (c) => { c.endpoints.agents.recursionLimit = 90; }, (c) => { c.endpoints.agents.toolApproval.ask = []; },
    (c) => { c.endpoints.custom[0].provider = 'openai'; }, (c) => { c.endpoints.custom[0].addParams.maxRetries = 1; },
    (c) => { c.endpoints.custom[0].models.default = ['other']; }, (c) => { c.interfaceConfig.mcpServers.create = true; },
    (c) => { c.modelSpecs.list[0].mcpServers = ['other']; }, (c) => { c.config.memory.agent = { provider: 'other', model: 'other' }; }];
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
  const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const native = { CODEAPI_AUTH_PROVIDER: 'librechat-jwt', CODEAPI_JWT_PRIVATE_KEY_BASE64: Buffer.from(key).toString('base64'), CODEAPI_JWT_KID: 'synthetic', CODEAPI_JWT_ISSUER: 'synthetic', CODEAPI_JWT_AUDIENCE: 'codeapi', CODEAPI_JWT_SINGLE_TENANT_ID: 'synthetic', MISSION_AI_CODE_BRIDGE_ADMIN_TOKEN: 'synthetic-code-admin-token-1234567890', MISSION_AI_MANAGED_TOOLS: 'true', MISSION_AI_CONTROL_OWNER_EMAIL: options.ownerEmail, MISSION_AI_TOOL_TOKEN: options.toolToken };
  assert.equal(preflight(native).status, 0);
  for (const extra of [{ ...native, CODEAPI_AUTH_PROVIDER: 'both' }, { ...native, CODEAPI_JWT_PRIVATE_KEY_BASE64: '' }, { ...native, MISSION_AI_CODE_BRIDGE_ADMIN_TOKEN: '' }, { ...native, MISSION_AI_CONTROL_OWNER_EMAIL: '' }, { ...native, MISSION_AI_TOOL_TOKEN: '' },
    { ...native, MISSION_AI_TOOL_TOKEN: options.nativeToken }, { ...native, MISSION_AI_MANAGED_TOOLS: 'automatic' },
    { MISSION_AI_TOOL_TOKEN: options.toolToken }, { ...native, ANTHROPIC_API_KEY: 'synthetic-not-a-real-key' }]) {
    assert.notEqual(preflight(extra).status, 0);
  }
});

test('coding admits only one explicit attached workspace and keeps ask authorization through both boundaries', () => {
  const input = { ...body(), ephemeralAgent: { mcp: ['mission-ai'], execute_code: true },
    codeEnvironmentMode: 'attached', codeApprovalMode: 'ask', codeWorkspaces: [{ environmentId: 'attached-workers', workspaceId: 'project-a' }] };
  for (const boundary of [createManagedToolAdmission(options), createManagedToolConfigGuard(options)]) {
    const result = invoke(boundary, { body: structuredClone(input) }); assert.equal(result.next, 1);
    assert.deepEqual(result.req.body.codeWorkspaces, input.codeWorkspaces);
    assert.equal(result.req.body.ephemeralAgent.execute_code, true); assert.equal(result.req.body.codeApprovalMode, 'ask');
    for (const patch of [{ codeApprovalMode: 'fullAccess' }, { codeApprovalMode: 'acceptEdits' },
      { codeEnvironmentMode: 'without_attached' }, { codeWorkspaces: [] },
      { codeWorkspaces: [{ environmentId: 'other', workspaceId: 'project-a' }] },
      { codeWorkspaces: [{ environmentId: 'attached-workers', workspaceId: '../escape' }] }]) {
      assert.equal(invoke(boundary, { body: { ...input, ...patch } }).status, 403);
    }
  }
});

test('coding-only admission preserves an explicit empty MCP selection', () => {
  const input = { ...body(), ephemeralAgent: { mcp: [], execute_code: true },
    codeEnvironmentMode: 'attached', codeApprovalMode: 'ask',
    codeWorkspaces: [{ environmentId: 'attached-workers', workspaceId: 'primary' }] };
  const result = invoke(createManagedToolAdmission(options), { body: input });
  assert.equal(result.next, 1);
  assert.deepEqual(result.req.body.ephemeralAgent, { mcp: [], execute_code: true });
});
test('coding configuration rejects a substitute service, unmanaged execution or changed worker identity', () => {
  for (const mutate of [
    (c) => { c.endpoints.agents.statefulCodeSessions.environments[0].baseURL = 'https://other.invalid/v1'; },
    (c) => { c.endpoints.agents.statefulCodeSessions.environments[0].type = 'managed'; },
    (c) => { c.endpoints.agents.statefulCodeSessions.environments[0].pairing.workerId = 'other'; },
    (c) => { c.endpoints.agents.statefulCodeSessions.allowedEnvironments = ['user']; },
  ]) { const value = config(); mutate(value); assert.equal(invoke(createManagedToolConfigGuard(options), { config: value }).status, 503); }
});

test('coding discovery admits only the configured deployment and forbids enrollment or environment changes', () => {
  const admission = createManagedToolAdmission(options);
  for (const originalUrl of ['/api/code-environments', '/api/code-environments/attached-workers/status']) {
    assert.equal(invoke(admission, { method: 'GET', originalUrl }).next, 1);
  }
  for (const originalUrl of ['/api/code-environments/other/status', '/api/code-environments?all=true',
    '/api/code-environments/pairings', '/api/code-environments/attached-workers/settings']) {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) assert.equal(invoke(admission, { method, originalUrl }).status, 403);
  }
});

test('inline memory and project selection survive both boundaries without hidden personalization calls', () => {
  const input = { ...body(), chatProjectId: '0123456789abcdef01234567', ephemeralAgent: { mcp: ['mission-ai'], memory: true } };
  for (const boundary of [createManagedToolAdmission(options), createManagedToolConfigGuard(options)]) {
    const result = invoke(boundary, { body: structuredClone(input) }); assert.equal(result.next, 1);
    assert.equal(result.req.body.ephemeralAgent.memory, true); assert.equal(result.req.body.chatProjectId, input.chatProjectId);
    assert.equal(invoke(boundary, { body: { ...input, chatProjectId: '../other' } }).status, 403);
  }
});
test('project context checks authenticated ownership before admitting a model request and fails closed on database errors', async () => {
  const id = '0123456789abcdef01234567'; let calls = 0;
  for (const result of [true, false, 'database_error']) {
    const guard = createManagedProjectGuard({ ...options, projectOwned: async (userId, projectId) => {
      calls++; assert.equal(userId, 'owner-id'); assert.equal(projectId, id);
      if (result === 'database_error') throw new Error('private database details'); return result;
    } });
    const req = { user: { id: 'owner-id', email: options.ownerEmail }, body: { chatProjectId: id } };
    let status; let next = 0;
    await guard(req, { status(value) { status = value; return this; }, json() {} }, () => next++);
    assert.equal(next, result === true ? 1 : 0); assert.equal(status, result === true ? undefined : result === false ? 403 : 503);
  }
  assert.equal(calls, 3);
});
test('project and personal memory APIs are bounded, while agent partitions and unreviewed route aliases remain denied', () => {
  const admit = createManagedToolAdmission(options);
  for (const [method, originalUrl, value] of [
    ['GET', '/api/projects?limit=100&sortBy=name', undefined],
    ['POST', '/api/projects', { name: 'Project', description: 'Context.' }],
    ['PUT', '/api/projects/conversations/conversation-1', { projectId: '0123456789abcdef01234567' }],
    ['GET', '/api/memories', undefined], ['POST', '/api/memories', { key: 'preference', value: 'Concise.' }],
    ['PATCH', '/api/memories/preferences', { memories: false }],
    ['PATCH', '/api/memories/id/0123456789abcdef01234567', { value: 'Updated.' }],
  ]) assert.equal(invoke(admit, { method, originalUrl, body: value }).next, 1);
  for (const [method, originalUrl, value] of [
    ['GET', '/api/projects?limit=1000', undefined], ['GET', '/api/projects?limit=10&limit=20', undefined],
    ['POST', '/api/projects', { name: 'Project', provider: 'other' }],
    ['GET', '/api/memories?agentId=other', undefined], ['POST', '/api/memories', { key: 'preference', value: 'Context', agentId: 'other' }],
    ['POST', '/api/memories', { key: 'preference', value: 'x'.repeat(10001) }],
    ['PUT', '/api/projects/conversations/conversation-1', { projectId: '../other' }],
  ]) assert.equal(invoke(admit, { method, originalUrl, body: value }).status, 403);
});

test('project cost header is server-derived, bounded and confined to the native gateway', async () => {
  const { attachManagedProjectCost } = await import('./generated/projectCost.js');
  const config = { clientOptions: { baseURL: 'https://synthetic.invalid/native/anthropic', defaultHeaders: { 'X-Mission-AI-Project': 'spoofed', keep: 'header' } } };
  const id = '0123456789abcdef01234567';
  attachManagedProjectCost(config, { enabled: true, gatewayURL: 'https://synthetic.invalid', projectId: id });
  assert.deepEqual(config.clientOptions.defaultHeaders, { keep: 'header', 'x-mission-ai-project': id });
  attachManagedProjectCost(config, { enabled: true, gatewayURL: 'https://synthetic.invalid' });
  assert.deepEqual(config.clientOptions.defaultHeaders, { keep: 'header' });
  assert.throws(() => attachManagedProjectCost(config, { enabled: true, gatewayURL: 'https://synthetic.invalid', projectId: '../bad' }));
  assert.throws(() => attachManagedProjectCost({ clientOptions: { baseURL: 'https://other.invalid' } }, { enabled: true, gatewayURL: 'https://synthetic.invalid' }));
  const original = { unchanged: true }; attachManagedProjectCost(original, { enabled: false });
  assert.deepEqual(original, { unchanged: true });
});

const resumeBody = () => ({ conversationId: 'conversation_fixture', generationCreatedAt: 1, generationProtocolVersion: 2,
  endpoint: 'MissionAI', endpointType: 'custom', model: 'claude-sonnet-5-5', spec: 'mission-ai-sonnet',
  actionId: 'action_fixture', decisions: [{ tool_call_id: 'tool_fixture', decision: 'approve', scope: 'once' }],
  ephemeralAgent: { mcp: [], execute_code: true } });
test('resume accepts the stock model-spec disabled capability template without enabling it', () => {
  // useApplyModelSpecAgents adds file_search=false and artifacts='' even when
  // the owner has enabled only the attached coding workspace.
  const ephemeralAgent = { mcp: [], web_search: false, file_search: false, execute_code: true, artifacts: '' };
  const request = { originalUrl: '/api/agents/chat/resume', body: { ...resumeBody(), ephemeralAgent } };
  assert.equal(invoke(createManagedToolAdmission(options), request).next, 1);
  assert.equal(invoke(createManagedToolConfigGuard(options), request).next, 1);
  for (const key of ['web_search', 'file_search', 'skills', 'ask_user_question', 'run_in_background', 'describe_intent', 'artifacts']) {
    assert.equal(invoke(createManagedToolAdmission(options), { ...request,
      body: { ...request.body, ephemeralAgent: { ...ephemeralAgent, [key]: true } } }).status, 403);
  }
  assert.equal(invoke(createManagedToolAdmission(options), { ...request,
    body: { ...request.body, ephemeralAgent: { ...ephemeralAgent, unknown: false } } }).status, 403);
});
test('exact one-action resume is admitted then owner/config checked without trusting client graph', () => {
  const request = { originalUrl: '/api/agents/chat/resume', body: resumeBody() };
  assert.equal(invoke(createManagedToolAdmission(options), request).next, 1);
  const checked = invoke(createManagedToolConfigGuard(options), request);
  assert.equal(checked.next, 1); assert.deepEqual(checked.req.body, request.body);
  assert.equal(invoke(createManagedToolConfigGuard(options), { ...request, user: { email: 'other@synthetic.invalid' } }).status, 403);
  for (const patch of [{ decisions: [{ tool_call_id: 'tool_fixture', decision: 'approve', scope: 'session' }] },
    { endpoint: 'agents' }, { agent_id: 'other' }, { providerKey: 'injected' }, { generationCreatedAt: null },
    { decisions: [] }, { ephemeralAgent: { mcp: ['other'] } }]) {
    assert.equal(invoke(createManagedToolAdmission(options), { ...request, body: { ...resumeBody(), ...patch } }).status, 403);
  }
  for (const originalUrl of ['/api/agents/chat/resume?retry=true', '/api/agents/chat//resume', '/api/agents/chat/Resume']) {
    assert.equal(invoke(createManagedToolAdmission(options), { ...request, originalUrl }).status, 403);
  }
});
test('server-restored resume retains decisions and revalidates pinned model, workspace and ask mode', () => {
  const guard = createManagedResumeConfigGuard(options);
  const restored = { ...body(), ...resumeBody(), codeWorkspaces: [{ environmentId: 'attached-workers', workspaceId: 'primary' }],
    codeEnvironmentMode: 'attached', codeApprovalMode: 'ask' };
  const checked = invoke(guard, { originalUrl: '/api/agents/chat/resume', body: restored });
  assert.equal(checked.next, 1); assert.deepEqual(checked.req.body.decisions, restored.decisions);
  assert.deepEqual(checked.req.body.codeWorkspaces, restored.codeWorkspaces);
  for (const patch of [{ model: 'claude-opus-5-5' }, { codeApprovalMode: 'fullAccess' },
    { codeEnvironmentMode: 'without_attached' }, { ephemeralAgent: { mcp: ['other'] } }]) {
    assert.equal(invoke(guard, { originalUrl: '/api/agents/chat/resume', body: { ...restored, ...patch } }).status, 403);
  }
});

test('the fixed generated inline agent can resume without admitting a saved or alternate agent', () => {
  const inlineId = 'MissionAI__claude-sonnet-5-5___Mission AI — Claude Sonnet 5.5 (offline)';
  const envelope = { ...resumeBody(), agent_id: inlineId };
  const request = { originalUrl: '/api/agents/chat/resume', body: envelope };
  assert.equal(invoke(createManagedToolAdmission(options), request).next, 1);
  assert.equal(invoke(createManagedToolConfigGuard(options), request).next, 1);
  const restored = { ...body(), ...envelope, codeWorkspaces: [{ environmentId: 'attached-workers', workspaceId: 'primary' }],
    codeEnvironmentMode: 'attached', codeApprovalMode: 'ask' };
  const checked = invoke(createManagedResumeConfigGuard(options), { ...request, body: restored });
  assert.equal(checked.next, 1); assert.equal(checked.req.body.agent_id, inlineId);
  assert.deepEqual(checked.req.body.decisions, envelope.decisions);
  for (const agent_id of ['agent_saved', 'MissionAI__claude-opus-5-5___Other', inlineId + '____1', inlineId + 'modified']) {
    assert.equal(invoke(createManagedToolAdmission(options), { ...request, body: { ...envelope, agent_id } }).status, 403);
    assert.equal(invoke(createManagedResumeConfigGuard(options), { ...request, body: { ...restored, agent_id } }).status, 403);
  }
  assert.equal(invoke(createManagedToolConfigGuard(options), { ...request, user: { email: 'other@synthetic.invalid' } }).status, 403);
});
