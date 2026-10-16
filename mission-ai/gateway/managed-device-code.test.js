import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
      ephemeralAgent: { mcp: ['mission-ai-device', 'mission-ai-local-documents'], execute_code: true },
      codeWorkspaces: [{ environmentId: 'attached-workers', workspaceId: 'primary' }],
      codeEnvironmentMode: 'attached', codeApprovalMode: 'ask' }, ...overrides };
}
function run(middleware, req) {
  let next = 0; let status;
  middleware(req, { status(code) { status = code; return this; }, json() {} }, () => { next++; });
  return { next, status };
}

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
    ephemeralAgent: { mcp: ['mission-ai-device', 'mission-ai-local-documents'], execute_code: true },
    codeWorkspaces: [{ environmentId: 'attached-workers', workspaceId: 'primary' }],
    codeEnvironmentMode: 'attached', codeApprovalMode: 'ask',
    decisions: [{ tool_call_id: 'tool-1', decision: 'approve', scope: 'once' }],
  } });
  assert.equal(run(admission, resume).next, 1);
  assert.equal(run(guard, resume).next, 1);
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
