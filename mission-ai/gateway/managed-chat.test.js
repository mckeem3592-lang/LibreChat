import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createManagedChatAdmission,
  createManagedChatConfigGuard,
} from './generated/managedChat.js';

const options = {
  enabled: true,
  gatewayURL: 'https://mission-ai-gateway.example',
  nativeToken: 'fake-managed-token-for-local-tests',
  titleConvo: 'false',
};
const specs = [
  ['mission-ai-economy', 'gpt-6-luna'],
  ['mission-ai-primary', 'gpt-6-sol'],
  ['mission-ai-reasoning', 'gpt-6-astra'],
];
function config() {
  const ui = {
    multiConvo: false, agents: false, schedules: false, skills: false, memories: false,
    runCode: false, webSearch: false, fileSearch: false, defaultPinnedTools: [],
  };
  return {
    // AppService exposes the raw YAML under config and parsed views at top level.
    config: { memory: { disabled: true }, summarization: { enabled: false }, interface: { ...ui } },
    memory: { disabled: true }, summarization: { enabled: false }, interfaceConfig: { ...ui },
    mcpConfig: null,
    endpoints: {
      all: { titleConvo: false, activityLabel: false, activityPhaseLabel: false, reasoningLabel: false },
      agents: { disableBuilder: true, allowedProviders: ['MissionAI'], capabilities: [],
        maxProviderErrorChars: 2000, modelResponseBodyTimeoutMs: 30000 },
      custom: [{
        name: 'MissionAI', apiKey: '${MISSION_AI_NATIVE_TOKEN}',
        baseURL: '${MISSION_AI_GATEWAY_URL}/native/openai/v1',
        models: { default: specs.map(([, model]) => model), fetch: false },
        modelDisplayLabel: 'Mission AI', titleConvo: false, dropParams: ['useResponsesApi'],
      }],
    },
    modelSpecs: {
      enforce: true, prioritize: true,
      list: specs.map(([name, model], i) => ({
        name, label: name, ...(i === 0 ? { default: true } : {}),
        preset: { endpoint: 'MissionAI', model, useResponsesApi: false, max_tokens: 4096 },
      })),
    },
  };
}
function payload() {
  // createPayload + parseCompactConvo/openAISchema + useChatFunctions: normal new
  // text chat with the UI's dormant workspace metadata and nullable branches.
  return {
    endpoint: 'MissionAI', endpointType: 'custom', spec: 'mission-ai-economy', model: 'gpt-6-luna',
    text: 'Local fixture text', sender: 'User', isCreatedByUser: true, error: false,
    clientTimestamp: '2026-09-28T12:00:00', messageId: 'message-id', parentMessageId: 'root',
    responseMessageId: 'response-id', conversationId: null, overrideParentMessageId: null,
    isTemporary: false, isRegenerate: false, isContinued: false, addedConvo: null,
    editedContent: null, ephemeralAgent: { web_search: false, file_search: false,
      execute_code: false, memory: false, skills: false, artifacts: '', mcp: [] },
    modelDisplayLabel: 'Mission AI', modelLabel: '', chatGptLabel: '',
    thread_id: null, key: undefined, timezone: 'America/Denver', clientRequestId: 'request-id',
    codeApprovalMode: 'ask', codeEnvironmentMode: 'without_attached', codeWorkspaces: [],
    manualSkills: [], quotes: [], max_tokens: 4096, useResponsesApi: false,
    imageDetail: 'auto', resendFiles: true, web_search: false, artifacts: '',
    temperature: 1, top_p: 1, presence_penalty: 0, frequency_penalty: 0,
    promptPrefix: null, reasoning_context: null, reasoning_mode: null,
    maxContextTokens: null, stop: [],
  };
}
function invoke(middleware, { method = 'POST', path = '/api/agents/chat/MissionAI', body = payload(), appConfig = config() } = {}) {
  const req = { method, originalUrl: path, body, config: appConfig };
  let next = 0;
  let status;
  let result;
  const res = { status(value) { status = value; return this; }, json(value) { result = value; return value; } };
  middleware(req, res, () => { next += 1; });
  return { req, next, status, result };
}
const admission = createManagedChatAdmission(options);
const configuration = createManagedChatConfigGuard(options);

test('disabled mode leaves all legacy traffic and payload references untouched', () => {
  const body = { endpoint: 'arbitrary', apiKey: 'fake', files: ['file'] };
  for (const factory of [createManagedChatAdmission, createManagedChatConfigGuard]) {
    const result = invoke(factory({ enabled: false }), { path: '/api/agents/v1/responses', body, appConfig: null });
    assert.equal(result.next, 1);
    assert.equal(result.req.body, body);
  }
});

test('representative text UI payload reaches existing auth/controller with inert extras removed', () => {
  const first = invoke(admission);
  assert.equal(first.next, 1);
  assert.equal(first.req.body.conversationId, null);
  assert.equal(first.req.body.max_tokens, 4096);
  assert.equal(first.req.body.resendFiles, false);
  for (const key of ['ephemeralAgent', 'key', 'codeWorkspaces', 'manualSkills', 'modelDisplayLabel', 'imageDetail']) {
    assert.equal(Object.hasOwn(first.req.body, key), false, key);
  }
  const second = invoke(configuration, { body: first.req.body });
  assert.equal(second.next, 1);
  assert.deepEqual(second.req.body, first.req.body);
});

test('all three fixed model specs and text edits/regeneration are supported', () => {
  for (const [spec, model] of specs) {
    const result = invoke(admission, { body: { ...payload(), spec, model, isRegenerate: true,
      conversationId: 'existing-conversation', editedContent: { index: 0, type: 'text', text: 'Edited fixture' } } });
    assert.equal(result.next, 1, model);
    assert.equal(invoke(configuration, { body: result.req.body }).next, 1);
  }
});

test('output and numeric sampling limits reject coercion, zero, nonfinite and overflow', () => {
  for (const max_tokens of [0, -1, 32769, 1.2, '128', NaN, Infinity]) {
    assert.equal(invoke(admission, { body: { ...payload(), max_tokens } }).status, 403);
  }
  for (const max_tokens of [1, 128, 32768]) {
    assert.equal(invoke(admission, { body: { ...payload(), max_tokens } }).next, 1);
  }
  for (const [key, value] of [['temperature', 3], ['top_p', -1], ['presence_penalty', Infinity], ['maxContextTokens', '100']]) {
    assert.equal(invoke(admission, { body: { ...payload(), [key]: value } }).status, 403);
  }
});

test('alternate endpoint, unknown model, mismatched spec and inherited spec names fail closed', () => {
  for (const patch of [
    { endpoint: 'openAI' }, { endpoint: 'missionai' }, { endpointType: 'agents' },
    { model: 'other' }, { spec: 'mission-ai-primary' }, { spec: 'toString', model: 'toString' },
    { spec: undefined }, { model: undefined },
  ]) assert.equal(invoke(admission, { body: { ...payload(), ...patch } }).status, 403);
});

test('unknown and nested provider overrides never reach a dispatcher', () => {
  for (const key of ['apiKey', 'baseURL', 'headers', 'provider', 'endpointOption', 'configuration',
    'model_parameters', 'agent_id', 'messages', 'tools', 'tool_resources', 'max_completion_tokens']) {
    const result = invoke(admission, { body: { ...payload(), [key]: { attack: 'fake-secret-marker' } } });
    assert.equal(result.status, 403, key);
    assert.equal(result.next, 0);
    assert.equal(JSON.stringify(result.result).includes('fake-secret-marker'), false);
  }
  assert.equal(invoke(admission, { body: JSON.parse('{"__proto__":{"endpoint":"openAI"}}') }).status, 403);
});

test('files, multimodal content, projects, added conversations and side feature settings are rejected', () => {
  for (const patch of [
    { files: [] }, { content: [{ type: 'image_url' }] }, { addedConvo: {} },
    { chatProjectId: 'project' }, { compact: true }, { manualSkills: ['skill'] }, { quotes: [{}] },
    { codeWorkspaces: [{}] }, { codeEnvironmentMode: 'attached' }, { codeApprovalMode: 'fullAccess' },
    { useResponsesApi: true }, { web_search: true }, { artifacts: 'artifacts' }, { resendFiles: 'true' },
    { key: 'fake-provider-key' }, { thread_id: 'assistant-thread' },
    { editedContent: { index: 0, type: 'think', think: 'hidden' } },
  ]) assert.equal(invoke(admission, { body: { ...payload(), ...patch } }).status, 403, Object.keys(patch)[0]);
});

test('every ephemeral tool capability is denied even when UI hides it', () => {
  for (const key of ['web_search', 'file_search', 'execute_code', 'artifacts', 'skills', 'memory',
    'ask_user_question', 'run_in_background', 'describe_intent']) {
    assert.equal(invoke(admission, { body: { ...payload(), ephemeralAgent: { [key]: true } } }).status, 403, key);
  }
  for (const ephemeralAgent of [{ mcp: ['server'] }, { newFutureTool: false }, [], '']) {
    assert.equal(invoke(admission, { body: { ...payload(), ephemeralAgent } }).status, 403);
  }
});

test('login, MFA, safe configuration/history and stream lifecycle retain existing authentication', () => {
  const routes = [
    ['POST', '/api/auth/login'], ['POST', '/api/auth/refresh'], ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/2fa/enable'], ['POST', '/api/auth/2fa/confirm'], ['POST', '/api/auth/2fa/verify-temp'],
    ['POST', '/api/user/terms/accept'], ['POST', '/api/agents/chat/abort'],
    ['GET', '/api/config'], ['GET', '/api/user'], ['GET', '/api/endpoints'], ['GET', '/api/models'],
    ['GET', '/api/roles/USER'], ['GET', '/api/convos?sortBy=updatedAt'],
    ['GET', '/api/convos/conversation-id'], ['GET', '/api/convos/gen_title/conversation-id'],
    ['GET', '/api/messages/conversation-id'], ['GET', '/api/messages/conversation-id/message-id'],
    ['GET', '/api/agents/chat/active'], ['GET', '/api/agents/chat/status/stream-id'],
    ['GET', '/api/agents/chat/stream/stream-id?lastEventId=12'],
  ];
  for (const [method, path] of routes) assert.equal(invoke(admission, { method, path }).next, 1, path);
});

test('key access permits only the existing single-name expiry read', () => {
  assert.equal(invoke(admission, { method: 'GET', path: '/api/keys?name=MissionAI' }).next, 1);
  for (const path of ['/api/keys', '/api/keys?name=openAI', '/api/keys?name=MissionAI&name=MissionAI', '/api/keys?name=MissionAI&value=secret']) {
    assert.equal(invoke(admission, { method: 'GET', path }).status, 403, path);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal(invoke(admission, { method, path: '/api/keys?name=MissionAI' }).status, 403);
  }
});

test('all unlisted APIs and paid route families are denied regardless of method', () => {
  for (const path of ['/api/auth/register', '/api/auth/requestPasswordReset', '/api/auth/resetPassword',
    '/api/agents/chat', '/api/agents/chat/openAI', '/api/agents/chat/resume', '/api/agents/chat/steer',
    '/api/agents/chat/queued-turns', '/api/agents', '/api/agents/v1/chat/completions', '/api/chat/MissionAI',
    '/api/assistants', '/api/files', '/api/files/audio/speech', '/api/images', '/api/actions', '/api/mcp',
    '/api/schedules', '/api/projects', '/api/api-keys', '/api/admin/config', '/api/convos/fork',
    '/api/messages/branch', '/api/unknown-future-provider', '/api', '/oauth/openai', '/v1/responses']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(invoke(admission, { method, path }).status, 403, `${method} ${path}`);
    }
  }
  for (const path of ['/api/files', '/api/mcp', '/api/agents', '/api/admin/config', '/api/api-keys', '/oauth/google']) {
    assert.equal(invoke(admission, { method: 'GET', path }).status, 403, path);
  }
});

test('ambiguous routing and method aliases cannot bypass the allowlist', () => {
  for (const path of ['/API/config', '/api/config/', '/api//config', '/api/%63onfig', '/%61pi/config',
    '/api/../api/config', '/api/./config', '/api\\config', '/api/config#fragment',
    '/api/agents/chat/%4dissionAI', '/api/agents/chat/MissionAI?override=true', '/api/agents/chat/MissionAI??override=true']) {
    assert.equal(invoke(admission, { method: path.includes('chat') ? 'POST' : 'GET', path }).status, 403, path);
  }
  for (const method of ['HEAD', 'OPTIONS', 'PUT', 'get']) {
    assert.equal(invoke(admission, { method, path: '/api/config' }).status, 403, method);
  }
  for (const path of ['/', '/login', '/c/new', '/assets/app.js', '/health', '/readyz']) {
    assert.equal(invoke(admission, { method: 'GET', path }).next, 1, path);
  }
});

test('effective configuration accepts approved templates or exact resolved gateway credentials', () => {
  assert.equal(invoke(configuration).next, 1);
  const resolved = config();
  Object.assign(resolved.endpoints.custom[0], {
    apiKey: options.nativeToken, baseURL: `${options.gatewayURL}/native/openai/v1`,
  });
  assert.equal(invoke(configuration, { appConfig: resolved }).next, 1);
});

test('configuration rejects missing credentials, title enabled and unapproved gateway locations', () => {
  for (const patch of [
    { nativeToken: '' }, { nativeToken: 'user_provided' }, { titleConvo: undefined }, { titleConvo: 'true' },
    { gatewayURL: undefined }, { gatewayURL: 'http://gateway.example' },
    { gatewayURL: 'https://user:password@gateway.example' }, { gatewayURL: 'https://gateway.example/path' },
    { gatewayURL: 'https://gateway.example?key=fake' },
  ]) {
    const result = invoke(createManagedChatConfigGuard({ ...options, ...patch }));
    assert.equal(result.status, 503);
    assert.equal(result.next, 0);
    assert.deepEqual(result.result, { error: { code: 'managed_chat_configuration_invalid', message: 'Managed chat configuration is unavailable.' } });
  }
});

test('custom configuration overrides, endpoint additions and live model fetching are denied', () => {
  const mutations = [
    c => { c.endpoints.openAI = {}; },
    c => { c.endpoints.custom.push({ ...c.endpoints.custom[0], name: 'Other' }); },
    c => { c.endpoints.custom[0].apiKey = 'user_provided'; },
    c => { c.endpoints.custom[0].apiKey = '${OTHER_KEY}'; },
    c => { c.endpoints.custom[0].baseURL = 'https://api.openai.com/v1'; },
    c => { c.endpoints.custom[0].baseURL = 'user_provided'; },
    c => { c.endpoints.custom[0].provider = 'anthropic'; },
    c => { c.endpoints.custom[0].headers = { Authorization: 'fake' }; },
    c => { c.endpoints.custom[0].addParams = {}; },
    c => { c.endpoints.custom[0].customParams = {}; },
    c => { c.endpoints.custom[0].directEndpoint = true; },
    c => { c.endpoints.custom[0].models.fetch = true; },
    c => { c.endpoints.custom[0].models.default.push('unpriced-model'); },
    c => { c.endpoints.custom[0].dropParams.push('max_tokens'); },
    c => { c.endpoints.agents.allowedProviders = []; },
    c => { c.endpoints.agents.capabilities = ['tools']; },
  ];
  for (const mutate of mutations) {
    const value = config(); mutate(value);
    assert.equal(invoke(configuration, { appConfig: value }).status, 503, mutate.toString());
  }
});

test('effective model specs cannot enable tools, change providers or remove token bounds', () => {
  const mutations = [
    c => { c.modelSpecs.enforce = false; }, c => { c.modelSpecs.addedEndpoints = ['openAI']; },
    c => { c.modelSpecs.list[0].webSearch = true; }, c => { c.modelSpecs.list[0].mcpServers = ['server']; },
    c => { c.modelSpecs.list[0].skills = true; }, c => { c.modelSpecs.list[0].subagents = {}; },
    c => { c.modelSpecs.list[0].preset.endpoint = 'openAI'; },
    c => { c.modelSpecs.list[0].preset.model = 'other'; },
    c => { c.modelSpecs.list[0].preset.useResponsesApi = true; },
    c => { c.modelSpecs.list[0].preset.max_tokens = 0; },
    c => { c.modelSpecs.list[0].preset.configuration = {}; },
    c => { c.modelSpecs.list[1] = c.modelSpecs.list[0]; },
  ];
  for (const mutate of mutations) {
    const value = config(); mutate(value);
    assert.equal(invoke(configuration, { appConfig: value }).status, 503, mutate.toString());
  }
});

test('memory, summaries, labels and tool defaults fail closed after per-user config loading', () => {
  const mutations = [
    c => { c.memory.disabled = false; }, c => { c.config.memory.disabled = false; },
    c => { c.summarization.enabled = true; }, c => { c.config.summarization.enabled = true; },
    c => { c.endpoints.all.activityLabel = true; }, c => { c.endpoints.all.reasoningLabel = true; },
    c => { c.endpoints.agents.activityPhaseLabel = true; }, c => { c.mcpConfig = { server: {} }; },
    c => { c.config.mcpServers = { server: {} }; }, c => { c.interfaceConfig.defaultPinnedTools = ['tool']; },
    c => { c.interfaceConfig.runCode = true; }, c => { c.config.interface.skills = true; },
  ];
  for (const mutate of mutations) {
    const value = config(); mutate(value);
    assert.equal(invoke(configuration, { appConfig: value }).status, 503, mutate.toString());
  }
  assert.equal(invoke(configuration, { appConfig: null }).status, 503);
});

test('post-config guard also refuses a payload changed after early admission', () => {
  const first = invoke(admission);
  first.req.body.tools = [{ type: 'function' }];
  assert.equal(invoke(configuration, { body: first.req.body }).status, 403);
});

test('CJS wiring places admission before routers and config validation before chat dispatch', async () => {
  const server = await readFile(new URL('../../api/server/index.js', import.meta.url), 'utf8');
  const agents = await readFile(new URL('../../api/server/routes/agents/index.js', import.meta.url), 'utf8');
  assert.ok(server.indexOf('app.use(createManagedChatAdmission(') > server.indexOf('app.use(handleJsonParseError)'));
  assert.ok(server.indexOf('app.use(createManagedChatAdmission(') < server.indexOf("app.use('/api/auth'"));
  assert.ok(agents.indexOf('chatRouter.use(createManagedChatConfigGuard(') > agents.indexOf('chatRouter.use(configMiddleware)'));
  assert.ok(agents.indexOf('chatRouter.use(createManagedChatConfigGuard(') < agents.indexOf("chatRouter.use('/', chat)"));
});
