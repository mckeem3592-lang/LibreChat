import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { agentsEndpointSchema } from 'librechat-data-provider';
import { AppService } from '@librechat/data-schemas';

process.env.MISSION_AI_FREE_BASELINE = 'true';
process.env.MISSION_AI_GITHUB_EDITOR = 'true';
process.env.MISSION_AI_DEVICE_MCP_ENABLED = 'true';
process.env.MISSION_AI_DEVICE_CODE_ENABLED = 'true';
process.env.MISSION_AI_DEVICE_MCP_TOKEN = 'device-mcp-token-for-offline-tests-only-123456';
process.env.LOCAL_MCP_PUBLIC_URL = 'https://local-documents.example/mcp';
process.env.LOCAL_MCP_TOKEN = 'local-documents-token-for-offline-tests-only-123456';
process.env.MISSION_AI_GITHUB_MCP_TOKEN = 'github_pat_offline_test_token_abcdefghijklmnopqrstuvwxyz0123456789';
process.env.GOOGLE_KEY = 'fake-google-key-for-local-tests';
process.env.TAVILY_API_KEY = 'fake-tavily-key-for-local-tests';

const { createManagedToolAdmission, createManagedToolConfigGuard } =
  await import('./generated/managedTools.js');
const raw = yaml.parse(readFileSync(new URL('../config/librechat.github-device-code.yaml', import.meta.url), 'utf8'));
const scheduleRaw = yaml.parse(readFileSync(new URL('../config/librechat.github-device-code-schedules.yaml', import.meta.url), 'utf8'));
const options = { enabled: true, toolsEnabled: false, ownerEmail: 'owner@example.test',
  gatewayURL: 'https://mission-ai-gateway.example',
  nativeToken: 'fake-managed-token-for-local-tests', titleConvo: 'false' };

function request(overrides = {}) {
  const config = structuredClone(raw);
  return { method: 'POST', originalUrl: '/api/agents/chat/MissionAIClaudeCached',
    user: { email: 'owner@example.test' },
    config: { ...config, config, interfaceConfig: config.interface, mcpConfig: config.mcpServers },
    body: { endpoint: 'MissionAIClaudeCached', endpointType: 'custom',
      model: 'claude-sonnet-5-5', spec: 'mission-ai-claude-sonnet',
      text: 'List files in the approved workspace.', promptCache: true, promptCacheTtl: '5m',
      ephemeralAgent: { mcp: ['mission-ai-device', 'mission-ai-local-documents', 'mission-ai-spreadsheet-creator'], execute_code: true },
      codeWorkspaces: [{ environmentId: 'attached-workers', workspaceId: 'primary' }],
      codeEnvironmentMode: 'attached', codeApprovalMode: 'ask' }, ...overrides };
}
function run(middleware, req) {
  let next = 0; let status;
  middleware(req, { status(code) { status = code; return this; }, json() {} }, () => { next++; });
  return { next, status };
}

test('device-code schedule profile is exact and remains default-off', () => {
  const scheduleOptions = { ...options, schedulesEnabled: true, scheduleAgentId: 'agent_owner_schedule' };
  const guard = createManagedToolConfigGuard(scheduleOptions);
  const scheduled = request();
  scheduled.config = { ...structuredClone(scheduleRaw), config: structuredClone(scheduleRaw),
    interfaceConfig: structuredClone(scheduleRaw.interface), mcpConfig: structuredClone(scheduleRaw.mcpServers) };
  assert.equal(run(guard, scheduled).next, 1);
  assert.equal(run(createManagedToolConfigGuard(options), scheduled).status, 503);
  const broadened = request();
  broadened.config = structuredClone(scheduled.config);
  broadened.config.interfaceConfig.agents.create = true;
  assert.equal(run(guard, broadened).status, 503);
  const altered = request();
  altered.config = structuredClone(scheduled.config);
  altered.config.interfaceConfig.schedules.create = false;
  assert.equal(run(guard, altered).status, 503);
});

test('schedule profile survives the native LibreChat configuration parser', async () => {
  const req = request();
  req.config = await AppService({ config: structuredClone(scheduleRaw) });
  const guard = createManagedToolConfigGuard({
    ...options, schedulesEnabled: true, scheduleAgentId: 'agent_owner_schedule',
  });
  assert.equal(run(guard, req).next, 1);
});

test('device-code signed schedule fire passes only for the fixed owner agent', () => {
  const scheduleOptions = { ...options, schedulesEnabled: true,
    scheduleAgentId: 'agent_owner_schedule', verifySignedScheduleTrigger: () => true };
  const fire = request({ originalUrl: '/api/agents/chat/agents',
    body: { endpoint: 'agents', agent_id: 'agent_owner_schedule' } });
  assert.equal(run(createManagedToolAdmission(scheduleOptions), fire).next, 1);
  assert.equal(run(createManagedToolConfigGuard(scheduleOptions), fire).next, 1);
  assert.equal(run(createManagedToolConfigGuard(scheduleOptions),
    { ...fire, user: { email: 'other@example.test' } }).status, 403);
  assert.equal(run(createManagedToolAdmission(scheduleOptions),
    { ...fire, body: { ...fire.body, agent_id: 'agent_other' } }).status, 403);
  assert.equal(run(createManagedToolConfigGuard(scheduleOptions),
    { ...fire, body: { ...fire.body, agent_id: 'agent_other' } }).status, 503);
});

test('schedule startup requires the device-code profile, fixed agent, and one process', () => {
  const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    MISSION_AI_GATEWAY_URL: 'https://mission-ai-gateway-mckee.onrender.com',
    MISSION_AI_MANAGED_CHAT: 'true', MISSION_AI_FREE_BASELINE: 'true',
    MISSION_AI_GITHUB_EDITOR: 'true', MISSION_AI_DEVICE_MCP_ENABLED: 'true',
    MISSION_AI_DEVICE_CODE_ENABLED: 'true', MISSION_AI_MANAGED_SCHEDULES: 'true',
    MISSION_AI_SCHEDULE_AGENT_ID: 'agent_owner_schedule', SCHEDULES_SINGLE_PROCESS: 'true',
    MISSION_AI_CONTROL_OWNER_EMAIL: 'owner@example.test',
    MISSION_AI_NATIVE_TOKEN: 'fake-managed-native-token-for-local-tests',
    MISSION_AI_GITHUB_MCP_TOKEN: process.env.MISSION_AI_GITHUB_MCP_TOKEN,
    MISSION_AI_DEVICE_MCP_TOKEN: process.env.MISSION_AI_DEVICE_MCP_TOKEN,
    MISSION_AI_CODE_BRIDGE_ADMIN_TOKEN: 'synthetic-code-admin-token-1234567890',
    CODEAPI_AUTH_PROVIDER: 'librechat-jwt', CODEAPI_JWT_PRIVATE_KEY_BASE64: Buffer.from(key).toString('base64'),
    CODEAPI_JWT_KID: 'synthetic', CODEAPI_JWT_ISSUER: 'synthetic',
    CODEAPI_JWT_AUDIENCE: 'codeapi', CODEAPI_JWT_SINGLE_TENANT_ID: 'synthetic',
    GOOGLE_KEY: 'fake-google-key-for-local-tests',
    TAVILY_API_KEY: 'tvly-synthetic-test-key',
    JWT_SECRET: 'a'.repeat(64), JWT_REFRESH_SECRET: 'b'.repeat(64),
    CREDS_KEY: 'c'.repeat(64), CREDS_IV: 'd'.repeat(32),
    MONGO_URI: 'mongodb+srv://mission_ai_chat_test:synthetic@fixture.mongodb.net/MissionAIChatTest?tls=true',
    DOMAIN_CLIENT: 'https://synthetic.invalid', DOMAIN_SERVER: 'https://synthetic.invalid',
    LOCAL_MCP_PUBLIC_URL: 'https://version-departure-blatantly.ngrok-free.dev/mcp',
    LOCAL_MCP_TOKEN: 'synthetic-local-mcp-token-for-offline-tests-only-123456',
  };
  const script = fileURLToPath(new URL('../chat-test/start.sh', import.meta.url));
  const check = (overrides = {}) => spawnSync('bash', [script, '--check'], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(check().status, 0);
  assert.notEqual(check({ SCHEDULES_SINGLE_PROCESS: 'false' }).status, 0);
  assert.notEqual(check({ MISSION_AI_SCHEDULE_AGENT_ID: '' }).status, 0);
  assert.notEqual(check({ MISSION_AI_DEVICE_CODE_ENABLED: 'false' }).status, 0);
  assert.notEqual(check({ CONFIG_PATH: '/tmp/other.yaml' }).status, 0);
});

test('device coding accepts only the reviewed owner, workspace, and approval mode', () => {
  const admit = createManagedToolAdmission(options);
  const guard = createManagedToolConfigGuard(options);
  const accepted = request();
  assert.equal(run(admit, accepted).next, 1);
  assert.equal(run(guard, accepted).next, 1);
  assert.equal(accepted.body.ephemeralAgent.execute_code, true);
  assert.deepEqual(accepted.body.codeWorkspaces,
    [{ environmentId: 'attached-workers', workspaceId: 'primary' }]);
  for (const change of [
    req => { req.body.codeWorkspaces[0].workspaceId = 'other'; },
    req => { req.body.codeEnvironmentMode = 'managed'; },
    req => { req.body.codeApprovalMode = 'auto'; },
    req => { req.body.spec = 'mission-ai-free'; req.body.endpoint = 'MissionAI'; req.body.model = 'gemini-3.5-flash-lite'; },
  ]) {
    const req = request(); change(req);
    assert.equal(run(admit, req).status, 403);
  }
  const other = request({ user: { email: 'other@example.test' } });
  assert.equal(run(admit, other).next, 1);
  assert.equal(run(guard, other).status, 403);
});

test('device coding rejects configuration changes to workspace, approval, and code toggle', () => {
  const guard = createManagedToolConfigGuard(options);
  for (const change of [
    req => { req.config.endpoints.agents.statefulCodeSessions.environments[0].baseURL = 'https://other.invalid/v1'; },
    req => { req.config.endpoints.agents.toolApproval.ask = []; },
    req => { req.config.interfaceConfig.runCode = false; },
    req => { req.config.mcpConfig['mission-ai-spreadsheet-creator'].env.MISSION_AI_SPREADSHEET_USER_ID = 'fixed-user'; },
    req => { req.config.mcpConfig['mission-ai-spreadsheet-creator'].args = ['unreviewed.mjs']; },
  ]) {
    const req = request(); change(req);
    assert.equal(run(guard, req).status, 503);
  }
});

test('device coding accepts the parsed pairing default but rejects principal worker enrollment', () => {
  const guard = createManagedToolConfigGuard(options);
  const parsed = request();
  parsed.config.endpoints.agents = agentsEndpointSchema.parse(parsed.config.endpoints.agents);
  assert.equal(run(guard, parsed).next, 1);

  const enrollment = request();
  enrollment.config.endpoints.agents = agentsEndpointSchema.parse(enrollment.config.endpoints.agents);
  enrollment.config.endpoints.agents.statefulCodeSessions.environments[0].pairing.allowPrincipalWorkers = true;
  assert.equal(run(guard, enrollment).status, 503);
});

test('device coding accepts the LibreChat AppService config', async () => {
  const guard = createManagedToolConfigGuard(options);
  const req = request();
  req.config = await AppService({ config: structuredClone(raw) });
  assert.equal(run(guard, req).next, 1);
});

test('a paused coding action resumes only with the same attached workspace', () => {
  const admission = createManagedToolAdmission(options);
  const guard = createManagedToolConfigGuard(options);
  const resume = request({ originalUrl: '/api/agents/chat/resume', body: {
    conversationId: 'conversation-1', actionId: 'action-1', generationCreatedAt: 1,
    endpoint: 'MissionAIClaudeCached', endpointType: 'custom',
    model: 'claude-sonnet-5-5', spec: 'mission-ai-claude-sonnet',
    ephemeralAgent: { mcp: ['mission-ai-device', 'mission-ai-local-documents', 'mission-ai-spreadsheet-creator'], execute_code: true },
    codeWorkspaces: [{ environmentId: 'attached-workers', workspaceId: 'primary' }],
    codeEnvironmentMode: 'attached', codeApprovalMode: 'ask',
    decisions: [{ tool_call_id: 'tool-1', decision: 'approve', scope: 'once' }],
  } });
  assert.equal(run(admission, resume).next, 1);
  assert.equal(run(guard, resume).next, 1);
  for (const omitted of ['codeEnvironmentMode', 'codeApprovalMode', 'codeWorkspaces']) {
    const sparse = request({ originalUrl: '/api/agents/chat/resume',
      body: structuredClone(resume.body) });
    delete sparse.body[omitted];
    assert.equal(run(admission, sparse).next, 1, `admission accepts omitted ${omitted}`);
    assert.equal(run(guard, sparse).next, 1, `pre-restore config accepts omitted ${omitted}`);
    // restoreResumeContext pins the paused setting before this guard runs.
    sparse.body[omitted] = resume.body[omitted];
    assert.equal(run(guard, sparse).next, 1, `restored ${omitted} stays bounded`);
  }
  const sparse = request({ originalUrl: '/api/agents/chat/resume',
    body: structuredClone(resume.body) });
  delete sparse.body.codeEnvironmentMode;
  delete sparse.body.codeApprovalMode;
  delete sparse.body.codeWorkspaces;
  assert.equal(run(admission, sparse).next, 1);
  assert.equal(run(guard, sparse).next, 1);
  const changed = request({ originalUrl: '/api/agents/chat/resume',
    body: structuredClone(resume.body) });
  changed.body.codeWorkspaces[0].workspaceId = 'other';
  assert.equal(run(admission, changed).status, 403);

  const withoutMcp = request({ originalUrl: '/api/agents/chat/resume',
    body: structuredClone(resume.body) });
  withoutMcp.body.ephemeralAgent.mcp = [];
  assert.equal(run(admission, withoutMcp).next, 1);
  assert.equal(run(guard, withoutMcp).next, 1);

  const unknownMcp = request({ originalUrl: '/api/agents/chat/resume',
    body: structuredClone(resume.body) });
  unknownMcp.body.ephemeralAgent.mcp = ['unreviewed-server'];
  assert.equal(run(admission, unknownMcp).status, 403);
});

test('server-restored coding context admits the display and scope fields captured at pause', () => {
  const admission = createManagedToolAdmission(options);
  const guard = createManagedToolConfigGuard(options);
  const resume = request({ originalUrl: '/api/agents/chat/resume', body: {
    conversationId: 'conversation-1', actionId: 'action-1', generationCreatedAt: 1,
    endpoint: 'MissionAIClaudeCached', endpointType: 'custom',
    model: 'claude-sonnet-5-5', spec: 'mission-ai-claude-sonnet',
    ephemeralAgent: { mcp: ['mission-ai-device'], execute_code: true },
    codeWorkspaces: [{ environmentId: 'attached-workers', workspaceId: 'primary' }],
    codeEnvironmentMode: 'attached', codeApprovalMode: 'ask',
    decisions: [{ tool_call_id: 'tool-1', decision: 'approve', scope: 'once' }],
  } });
  assert.equal(run(admission, resume).next, 1);
  // restoreResumeContext replays these fields from the paused job before the
  // second config guard; the client is not allowed to inject them at admission.
  const restored = { ...resume, body: { ...resume.body,
    modelLabel: 'Mission AI — Claude Sonnet 5.5',
    chatProjectId: '507f1f77bcf86cd799439011',
    timezone: 'America/Denver', manualSkills: [], addedConvo: null,
  } };
  assert.equal(run(guard, restored).next, 1);
  const injected = { ...resume, body: { ...restored.body } };
  assert.equal(run(admission, injected).status, 403);
  const skills = { ...restored, body: { ...restored.body, manualSkills: ['unreviewed'] } };
  assert.equal(run(guard, skills).status, 403);
});
