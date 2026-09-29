import {
  createManagedChatAdmission, createManagedChatConfigGuard,
  type ManagedChatOptions, type ManagedChatRequest, type ManagedChatResponse,
} from './managedChat.js';

type Json = Record<string, unknown>;
interface Request extends ManagedChatRequest { user?: { email?: string } }
export interface ManagedToolOptions extends ManagedChatOptions {
  toolsEnabled?: boolean; ownerEmail?: string; toolToken?: string;
}
type Middleware = (req: Request, res: ManagedChatResponse, next: () => unknown) => unknown;
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
function payload(input: unknown): { compatible: Json; restore(body: unknown): Json } {
  const original = object(input);
  const compatible = { ...original };
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
  if (agent) compatible.ephemeralAgent = { ...agent, mcp: [] };
  return { compatible, restore(value) {
    const body = object(value); const result: Json = { ...body, maxOutputTokens: tokens };
    delete result.max_tokens;
    if (selected.length) result.ephemeralAgent = { mcp: ['mission-ai'] };
    return result;
  } };
}

/** Reuse text admission for every unrelated API and metadata invariant. New scope is exact and default-off. */
export function createManagedToolAdmission(options: ManagedToolOptions): Middleware {
  const legacy = createManagedChatAdmission(options);
  if (!options.enabled || !options.toolsEnabled) return legacy;
  return (req, res, next) => {
    const path = req.originalUrl ?? req.url ?? '';
    if (req.method === 'GET' && MCP_READS.has(path)) return next();
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
  same(agents.capabilities, ['tools']);
  if (agents.recursionLimit !== 8 || agents.maxRecursionLimit !== 8 || agents.modelResponseBodyTimeoutMs !== 180000) throw new Error();
  const approval = object(agents.toolApproval);
  exactKeys(approval, ['enabled', 'mode', 'allow', 'ask']);
  if (approval.enabled !== true || approval.mode !== 'default') throw new Error();
  same(approval.allow, []); same(approval.ask, ['mcp:mission-ai:*']);
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
    const ui = object(view); same(ui.defaultPinnedTools, ['mcp']); ui.defaultPinnedTools = [];
    const mcp = object(ui.mcpServers); exactKeys(mcp, ['use', 'create', 'share', 'public',
      'toolsRefreshInterval', 'statusRefreshInterval']);
    if (mcp.use !== true || mcp.create !== false || mcp.share !== false || mcp.public !== false) throw new Error();
    if (mcp.toolsRefreshInterval !== 0 || mcp.statusRefreshInterval !== 0) throw new Error();
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
      const conversion = payload(req.body);
      const probe = { ...req, config: projected, body: conversion.compatible };
      return legacy(probe, res, () => { req.body = conversion.restore(probe.body); return next(); });
    } catch { return reject(res); }
  };
}

export function createManagedToolOwnerGuard(options: ManagedToolOptions): Middleware {
  return (req, res, next) => !options.enabled || !options.toolsEnabled || owner(req, options) ? next() : reject(res);
}
