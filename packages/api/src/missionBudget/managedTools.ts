import {
  createManagedChatAdmission, createManagedChatConfigGuard,
  type ManagedChatOptions, type ManagedChatRequest, type ManagedChatResponse,
} from './managedChat.js';

import { admitManagedData } from './managedData.js';

type Json = Record<string, unknown>;
interface Request extends ManagedChatRequest { user?: { email?: string; id?: string } }
export interface ManagedToolOptions extends ManagedChatOptions {
  toolsEnabled?: boolean; ownerEmail?: string; toolToken?: string;
}
type Middleware = (req: Request, res: ManagedChatResponse, next: () => unknown) => unknown;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE_BASE = 'https://mission-ai-code-api-mckee.onrender.com/v1';
const MCP_READS = new Set(['/api/mcp/tools', '/api/mcp/servers',
  '/api/mcp/servers/mission-ai', '/api/mcp/connection/status', '/api/mcp/connection/status/mission-ai']);
export const MANAGED_NATIVE_DROPS: readonly string[] = Object.freeze([
  'useResponsesApi', 'temperature', 'top_p', 'topP', 'topK', 'frequency_penalty', 'frequencyPenalty',
  'presence_penalty', 'presencePenalty', 'seed', 'user', 'verbosity', 'metadata',
  'thinking', 'outputConfig', 'output_config', 'promptCache', 'web_search',
]);
const LEGACY_DROPS = ['useResponsesApi', 'temperature', 'top_p', 'topP', 'frequency_penalty',
  'frequencyPenalty', 'presence_penalty', 'presencePenalty', 'seed', 'user', 'verbosity'];
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
  return value as Json;
}
function exactKeys(value: Json, names: string[]): void {
  if (Object.keys(value).some((key) => !names.includes(key))) throw new Error();
}
function same(value: unknown, names: readonly string[]): void {
  if (!Array.isArray(value) || value.length !== names.length || new Set(value).size !== value.length ||
      value.some((name) => !names.includes(name))) throw new Error();
}
function reject(res: ManagedChatResponse, configuration = false): unknown {
  return res.status(configuration ? 503 : 403).json({ error: {
    code: 'managed_tools_denied', message: 'Mission AI tools are unavailable.' } });
}
function owner(req: Request, options: ManagedToolOptions): boolean {
  return !!options.ownerEmail && !!req.user?.email &&
    req.user.email.toLowerCase() === options.ownerEmail.toLowerCase();
}
const RESUME_PATH = '/api/agents/chat/resume';
const RESUME_FIELDS = ['conversationId', 'generationCreatedAt', 'endpoint', 'endpointType',
  'agent_id', 'model', 'spec', 'promptPrefix', 'ephemeralAgent', 'isTemporary', 'actionId', 'decisions', 'generationProtocolVersion'];
function resumeEnvelope(input: unknown): Json {
  const body = object(input); exactKeys(body, RESUME_FIELDS);
  for (const key of ['conversationId', 'actionId']) {
    if (typeof body[key] !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(body[key] as string)) throw new Error();
  }
  if (body.generationProtocolVersion != null && body.generationProtocolVersion !== 2) throw new Error();
  if (!Number.isSafeInteger(body.generationCreatedAt) || Number(body.generationCreatedAt) < 0) throw new Error();
  if (body.endpoint !== 'MissionAI' || body.agent_id != null ||
      (body.endpointType != null && body.endpointType !== 'custom') ||
      (body.model != null && body.model !== 'claude-sonnet-5-5') ||
      (body.spec != null && body.spec !== 'mission-ai-sonnet')) throw new Error();
  if (body.promptPrefix != null && (typeof body.promptPrefix !== 'string' || body.promptPrefix.length > 1_000_000)) throw new Error();
  if (body.isTemporary != null && typeof body.isTemporary !== 'boolean') throw new Error();
  if (body.ephemeralAgent != null) {
    const agent = object(body.ephemeralAgent); exactKeys(agent, ['mcp', 'execute_code', 'memory', 'web_search']);
    if (agent.mcp != null && (!Array.isArray(agent.mcp) || agent.mcp.length > 1 || agent.mcp.some(x => x !== 'mission-ai'))) throw new Error();
    for (const key of ['execute_code', 'memory']) if (agent[key] != null && typeof agent[key] !== 'boolean') throw new Error();
    if (agent.web_search != null && agent.web_search !== false) throw new Error();
  }
  if (!Array.isArray(body.decisions) || !body.decisions.length || body.decisions.length > 32) throw new Error();
  const ids = new Set();
  for (const item of body.decisions) {
    const decision = object(item); exactKeys(decision, ['tool_call_id', 'decision', 'scope']);
    if (typeof decision.tool_call_id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(decision.tool_call_id) || ids.has(decision.tool_call_id)) throw new Error();
    ids.add(decision.tool_call_id);
    if (!['approve', 'reject'].includes(String(decision.decision)) || (decision.scope != null && decision.scope !== 'once')) throw new Error();
  }
  return body;
}
function payload(input: unknown): { compatible: Json; restore(body: unknown): Json } {
  const original = object(input);
  const compatible = { ...original };
  const project = original.chatProjectId;
  if (project != null && (typeof project !== 'string' || !/^[a-fA-F0-9]{24}$/.test(project))) throw new Error();
  if (project != null) compatible.chatProjectId = null;
  if (original.max_tokens != null && original.maxOutputTokens != null) throw new Error();
  const tokens = original.maxOutputTokens ?? original.max_tokens ?? 4096;
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 1 || tokens > 32768) throw new Error();
  compatible.max_tokens = tokens; delete compatible.maxOutputTokens;
  for (const [key, allowed] of [['effort', ['low', '']], ['thinking', [true]],
    ['promptCache', [false]], ['promptCacheTtl', ['5m', '1h']]] as const) {
    if (original[key] != null && !(allowed as readonly unknown[]).includes(original[key])) throw new Error();
    delete compatible[key];
  }
  const agent = original.ephemeralAgent == null ? undefined : object(original.ephemeralAgent);
  const selected = agent?.mcp ?? [];
  if (!Array.isArray(selected) || selected.length > 1 || selected.some((name) => name !== 'mission-ai')) throw new Error();
  if (agent?.execute_code != null && typeof agent.execute_code !== 'boolean') throw new Error();
  const coding = agent?.execute_code === true;
  if (agent?.memory != null && typeof agent.memory !== 'boolean') throw new Error();
  const memory = agent?.memory === true;
  const workspaces = original.codeWorkspaces ?? [];
  if (!Array.isArray(workspaces) || workspaces.length > 1) throw new Error();
  for (const value of workspaces) {
    const workspace = object(value); exactKeys(workspace, ['environmentId', 'workspaceId']);
    if (workspace.environmentId !== 'attached-workers' || typeof workspace.workspaceId !== 'string' ||
        !WORKSPACE_ID.test(workspace.workspaceId)) throw new Error();
  }
  if (coding && (workspaces.length !== 1 || original.codeEnvironmentMode !== 'attached')) throw new Error();
  if (!coding && workspaces.length) throw new Error();
  if (original.codeApprovalMode != null && original.codeApprovalMode !== 'ask') throw new Error();
  if (coding) { compatible.codeWorkspaces = []; compatible.codeEnvironmentMode = 'without_attached'; }
  if (agent) compatible.ephemeralAgent = { ...agent, mcp: [], execute_code: false, memory: false };
  return { compatible, restore(value) {
    const body = object(value); const result: Json = { ...body, maxOutputTokens: tokens };
    delete result.max_tokens;
    if (agent || selected.length || coding || memory) result.ephemeralAgent = {
      mcp: [...selected], ...(coding ? { execute_code: true } : {}), ...(memory ? { memory: true } : {}),
    };
    if (project != null) result.chatProjectId = project;
    if (coding) { result.codeWorkspaces = workspaces; result.codeEnvironmentMode = 'attached'; result.codeApprovalMode = 'ask'; }
    return result;
  } };
}

/** Reuse text admission for every unrelated API and metadata invariant. New scope is exact and default-off. */
export function createManagedToolAdmission(options: ManagedToolOptions): Middleware {
  const legacy = createManagedChatAdmission(options);
  if (!options.enabled || !options.toolsEnabled) return legacy;
  return (req, res, next) => {
    const path = req.originalUrl ?? req.url ?? '';
    try { if (admitManagedData(req.method, path, req.body)) return next(); } catch { return reject(res); }
    if (req.method === 'GET' && (MCP_READS.has(path) || path === '/api/code-environments' ||
        path === '/api/code-environments/attached-workers/status')) return next();
    // Reconnect only the fixed, approved server. The MCP router authenticates
    // the request and checks the owner before resolving its stored settings.
    if (req.method === 'POST' && path === '/api/mcp/mission-ai/reinitialize' &&
        (req.body === undefined || req.body != null && typeof req.body === 'object' &&
        !Array.isArray(req.body) && Object.keys(req.body).length === 0)) return next();
    if (req.method === 'POST' && path === RESUME_PATH) {
      try { resumeEnvelope(req.body); return next(); } catch { return reject(res); }
    }
    if (req.method !== 'POST' || path !== '/api/agents/chat/MissionAI') return legacy(req, res, next);
    try {
      const conversion = payload(req.body);
      const probe = { ...req, body: conversion.compatible };
      return legacy(probe, res, () => { req.body = conversion.restore(probe.body); return next(); });
    } catch { return reject(res); }
  };
}

function projectConfiguration(value: unknown, options: ManagedToolOptions): Json {
  if (!options.toolToken || options.toolToken.length < 32 || options.toolToken === options.nativeToken) throw new Error();
  const config = object(value);
  const copy = object(JSON.parse(JSON.stringify(config)));
  const gateway = new URL(options.gatewayURL ?? '');
  const raw = object(copy.config);
  for (const servers of [copy.mcpConfig, raw.mcpServers]) {
    const map = object(servers); exactKeys(map, ['mission-ai']);
    const server = object(map['mission-ai']);
    exactKeys(server, ['title', 'type', 'url', 'headers', 'timeout', 'chatMenu']);
    if (server.title !== 'Mission AI' || server.type !== 'streamable-http' ||
        ![`${gateway.origin}/mcp`, '${MISSION_AI_GATEWAY_URL}/mcp'].includes(String(server.url)) ||
        server.timeout !== 120000 || server.chatMenu !== true) throw new Error();
    const headers = object(server.headers); exactKeys(headers, ['Authorization']);
    if (![`${'Bearer '}${options.toolToken}`, 'Bearer ${MISSION_AI_TOOL_TOKEN}'].includes(String(headers.Authorization))) throw new Error();
  }
  copy.mcpConfig = null; delete raw.mcpServers;
  const endpoints = object(copy.endpoints); const agents = object(endpoints.agents);
  same(agents.capabilities, ['tools', 'execute_code', 'stateful_code_sessions', 'memory']);
  const sessions = object(agents.statefulCodeSessions);
  exactKeys(sessions, ['allowedEnvironments', 'environments']); same(sessions.allowedEnvironments, ['conversation']);
  if (!Array.isArray(sessions.environments) || sessions.environments.length !== 1) throw new Error();
  const environment = object(sessions.environments[0]);
  exactKeys(environment, ['id', 'name', 'type', 'baseURL', 'owner', 'pairing', 'default']);
  if (environment.id !== 'attached-workers' || environment.type !== 'attached' || environment.baseURL !== CODE_BASE ||
      environment.owner !== 'deployment' || environment.default !== true) throw new Error();
  const pairing = object(environment.pairing); exactKeys(pairing, ['workerId', 'tokenEnv', 'allowPrincipalWorkers']);
  if (pairing.workerId !== 'mac-primary-code' || pairing.tokenEnv !== 'MISSION_AI_CODE_BRIDGE_ADMIN_TOKEN' ||
      (pairing.allowPrincipalWorkers !== undefined && pairing.allowPrincipalWorkers !== false)) throw new Error();
  delete agents.statefulCodeSessions;
  if (agents.recursionLimit !== 8 || agents.maxRecursionLimit !== 8 || agents.modelResponseBodyTimeoutMs !== 180000) throw new Error();
  const approval = object(agents.toolApproval);
  exactKeys(approval, ['enabled', 'mode', 'allow', 'ask']);
  if (approval.enabled !== true || approval.mode !== 'default') throw new Error();
  same(approval.allow, []); same(approval.ask, ['*']);
  agents.capabilities = []; delete agents.recursionLimit; delete agents.maxRecursionLimit; delete agents.toolApproval;
  const custom = object((endpoints.custom as unknown[])[0]);
  if (custom.provider !== 'anthropic' ||
      ![`${gateway.origin}/native/anthropic`, '${MISSION_AI_GATEWAY_URL}/native/anthropic'].includes(String(custom.baseURL))) throw new Error();
  same(custom.dropParams, MANAGED_NATIVE_DROPS);
  delete custom.provider; custom.baseURL = `${gateway.origin}/native/openai/v1`; custom.dropParams = LEGACY_DROPS;
  const specs = object(copy.modelSpecs);
  for (const value of specs.list as unknown[]) {
    const spec = object(value); same(spec.mcpServers, ['mission-ai']); delete spec.mcpServers;
    const preset = object(spec.preset);
    if (preset.max_tokens !== undefined || preset.maxOutputTokens !== 4096) throw new Error();
    if (preset.effort !== 'low' || preset.thinking !== true || preset.promptCache !== false) throw new Error();
    delete preset.effort; delete preset.thinking; delete preset.promptCache;
    preset.max_tokens = preset.maxOutputTokens; delete preset.maxOutputTokens;
  }
  for (const view of [copy.interfaceConfig, raw.interface]) {
    const ui = object(view);
    if (ui.runCode !== true) throw new Error(); ui.runCode = false;
    if (ui.memories !== true) throw new Error(); ui.memories = false;
    same(ui.defaultPinnedTools, ['mcp', 'memory']); ui.defaultPinnedTools = [];
    const mcp = object(ui.mcpServers); exactKeys(mcp, ['use', 'create', 'share', 'public',
      'toolsRefreshInterval', 'statusRefreshInterval']);
    if (mcp.use !== true || mcp.create !== false || mcp.share !== false || mcp.public !== false) throw new Error();
    if (mcp.toolsRefreshInterval !== 0 || mcp.statusRefreshInterval !== 0) throw new Error();
  }
  for (const view of [copy.memory, raw.memory]) {
    const memory = object(view); exactKeys(memory, ['disabled', 'personalize', 'tokenLimit', 'charLimit', 'maxInputTokens', 'messageWindowSize']);
    if (memory.disabled !== false || memory.personalize !== false || memory.tokenLimit !== 2000 ||
        memory.charLimit !== 10000 || memory.maxInputTokens !== 2000 || memory.messageWindowSize !== 5) throw new Error();
    memory.disabled = true;
  }
  return copy;
}

/** Post-authentication owner check and a native projection through the original paid/config boundary. */
export function createManagedToolConfigGuard(options: ManagedToolOptions): Middleware {
  const legacy = createManagedChatConfigGuard(options);
  if (!options.enabled || !options.toolsEnabled) return legacy;
  return (req, res, next) => {
    if (!owner(req, options)) return reject(res);
    let projected: Json;
    try { projected = projectConfiguration(req.config, options); }
    catch { return reject(res, true); }
    try {
      const isResume = (req.originalUrl ?? req.url) === RESUME_PATH;
      if (isResume) resumeEnvelope(req.body);
      const conversion = payload(isResume ? { endpoint: 'MissionAI', model: 'claude-sonnet-5-5', spec: 'mission-ai-sonnet', text: '' } : req.body);
      const probe = { ...req, config: projected, body: conversion.compatible };
      return legacy(probe, res, () => { if (!isResume) req.body = conversion.restore(probe.body); return next(); });
    } catch { return reject(res); }
  };
}

/** Recheck the owner-scoped, server-restored graph before endpoint construction. */
export function createManagedResumeConfigGuard(options: ManagedToolOptions): Middleware {
  const guard = createManagedToolConfigGuard(options);
  return (req, res, next) => {
    if (!options.enabled || !options.toolsEnabled || (req.originalUrl ?? req.url) !== RESUME_PATH) return next();
    try {
      const input = object(req.body);
      const actions = { actionId: input.actionId, decisions: input.decisions, generationCreatedAt: input.generationCreatedAt };
      const body: Json = { ...input, text: '' };
      if (body.agent_id == null) delete body.agent_id;
      for (const key of Object.keys(actions)) delete body[key];
      const probe = { ...req, originalUrl: '/api/agents/chat/MissionAI', body };
      return guard(probe, res, () => { req.body = { ...object(probe.body), ...actions }; return next(); });
    } catch { return reject(res); }
  };
}

export function createManagedToolOwnerGuard(options: ManagedToolOptions): Middleware {
  return (req, res, next) => !options.enabled || !options.toolsEnabled || owner(req, options) ? next() : reject(res);
}

/** Project context must be owned before endpoint construction can dispatch a paid model request. */
export function createManagedProjectGuard(options: ManagedToolOptions & {
  projectOwned: (userId: string, projectId: string) => Promise<boolean>;
}): Middleware {
  return async (req, res, next) => {
    if (!options.enabled || !options.toolsEnabled) return next();
    const id = (req.body as Json | undefined)?.chatProjectId;
    if (id == null) return next();
    if (!owner(req, options) || !req.user?.id || typeof id !== 'string' || !/^[a-fA-F0-9]{24}$/.test(id)) return reject(res);
    try { if (await options.projectOwned(req.user.id, id) !== true) return reject(res); }
    catch { return reject(res, true); }
    return next();
  };
}
