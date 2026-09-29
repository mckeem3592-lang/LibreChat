/**
 * Admission boundary for the separate Mission AI text-chat canary only.
 * This intentionally version-pins the supported UI protocol and managed model
 * specs. An unknown API, payload field, or effective configuration fails closed.
 * Authentication/ownership remain the responsibility of the existing routers.
 */
type ObjectValue = Record<string, unknown>;
export interface ManagedChatRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  body?: unknown;
  config?: unknown;
}
export interface ManagedChatResponse {
  status: (status: number) => ManagedChatResponse;
  json: (body: unknown) => unknown;
}
export interface ManagedChatOptions {
  enabled: boolean;
  gatewayURL?: string;
  nativeToken?: string;
  titleConvo?: string;
}
type Middleware = (
  req: ManagedChatRequest,
  res: ManagedChatResponse,
  next: () => unknown,
) => unknown;

const FREE_BASELINE = process.env.MISSION_AI_FREE_BASELINE === 'true';
const ENDPOINT = 'MissionAI';
const CHAT_PATH = '/api/agents/chat/MissionAI';
const SPEC = FREE_BASELINE ? 'mission-ai-free' : 'mission-ai-sonnet';
const MODEL = FREE_BASELINE ? 'gemini-3.5-flash-lite' : 'claude-sonnet-5-5';
const SPEC_MODELS: Readonly<Record<string, string>> = Object.freeze({
  [SPEC]: MODEL,
});

const MASTER_GATEWAY_PROMPT = `MISSION AI MASTER GATEWAY v1

You are the Mission AI routing gate.

On the first substantive user request in each new conversation, classify the work into exactly one technical tier before doing the work:

T0 — Simple:
Short factual questions, rewriting, extraction, formatting, basic calculations, simple summaries, or other low-complexity tasks.

T1 — Standard:
Normal knowledge work, drafting, moderate analysis, ordinary coding help, troubleshooting, planning, or structured reasoning that a fast low-cost model can reliably handle.

T2 — Advanced:
Complex multi-step debugging, architecture, substantial code changes, difficult technical analysis, large-context synthesis, or work where failure would create significant rework.

T3 — Expert:
Exceptionally difficult reasoning, deep system design, high-complexity research, cross-system engineering, or tasks requiring the strongest approved reasoning capability.

COST FIREWALL:
Always choose the cheapest approved model capable of reliably completing the task.

Current office routing:
- T0: Gemini 3.5 Flash Lite — Free Baseline
- T1: Gemini 3.5 Flash Lite — Free Baseline
- T2: Premium model required — paid route currently disabled
- T3: Premium model required — paid route currently disabled

For T0 or T1, begin the response with:
[MISSION AI ROUTE] T# | STAY: Gemini 3.5 Flash Lite | FREE BASELINE

Then continue immediately with the requested work.

For T2 or T3, begin the response with:
[MISSION AI ROUTE] T# | STOP: PREMIUM ROUTE REQUIRED | PAID ROUTE DISABLED

Then give one short sentence explaining why the task needs the higher tier and stop. Do not begin the substantive work.

Do not repeat the routing banner on ordinary follow-up messages in the same conversation unless the scope materially changes enough to require a different tier.

Never claim that a paid model has been activated automatically. Model switching is always manual.`;

function reviewedPrompt(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value === MASTER_GATEWAY_PROMPT || value === `${MASTER_GATEWAY_PROMPT}\n`;
}
const IDENTIFIER = /^[A-Za-z0-9_-]{1,256}$/;
const ID_FIELDS = new Set([
  'conversationId', 'parentMessageId', 'messageId', 'responseMessageId',
  'overrideConvoId', 'overrideUserMessageId', 'overrideParentMessageId', 'clientRequestId',
]);
const BOOL_FIELDS = new Set(['isTemporary', 'isRegenerate', 'isContinued']);
const DISPLAY_FIELDS = new Set(['modelLabel', 'chatGptLabel', 'modelDisplayLabel', 'iconURL', 'greeting']);
const NULL_ONLY_FIELDS = new Set([
  'addedConvo', 'thread_id', 'chatProjectId', 'recoverySteerId', 'reasoning_context',
  'reasoning_summary', 'reasoning_mode', 'fileTokenLimit',
]);
const FALSE_ONLY_FIELDS = new Set(['useResponsesApi', 'web_search', 'compact']);
const EMPTY_ARRAY_FIELDS = new Set(['manualSkills', 'codeWorkspaces', 'quotes']);
const PARAM_LIMITS: Readonly<Record<string, readonly [number, number]>> = {
  temperature: [0, 2], top_p: [0, 1], presence_penalty: [-2, 2], frequency_penalty: [-2, 2],
};
const BODY_FIELDS = new Set([
  ...ID_FIELDS, ...BOOL_FIELDS, ...DISPLAY_FIELDS, ...NULL_ONLY_FIELDS, ...FALSE_ONLY_FIELDS,
  ...EMPTY_ARRAY_FIELDS, ...Object.keys(PARAM_LIMITS),
  'endpoint', 'endpointType', 'model', 'spec', 'text', 'sender', 'clientTimestamp',
  'isCreatedByUser', 'error', 'ephemeralAgent', 'editedContent', 'key', 'timezone',
  'promptPrefix', 'max_tokens', 'maxContextTokens', 'stop', 'reasoning_effort', 'verbosity',
  'disableStreaming', 'resendFiles', 'artifacts', 'imageDetail', 'codeApprovalMode', 'codeEnvironmentMode',
  'expectedPredecessorCreatedAt', 'generationProtocolVersion',
]);

function object(value: unknown): ObjectValue {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  return value as ObjectValue;
}
function keys(value: ObjectValue, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error();
}
function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function string(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length > max) throw new Error();
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error();
  }
  return value;
}
function emptyArray(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 0) throw new Error();
}
function emptyRecord(value: unknown): void {
  if (value != null && Object.keys(object(value)).length !== 0) throw new Error();
}
function sameStrings(value: unknown, expected: readonly string[]): void {
  if (!Array.isArray(value) || value.length !== expected.length ||
      new Set(value).size !== value.length || value.some((item) => !expected.includes(item))) {
    throw new Error();
  }
}
function disabled(value: unknown): void {
  if (value != null && value !== false) throw new Error();
}
function deny(res: ManagedChatResponse, configuration = false): unknown {
  return res.status(configuration ? 503 : 403).json({
    error: {
      code: configuration ? 'managed_chat_configuration_invalid' : 'managed_chat_request_denied',
      message: configuration ? 'Managed chat configuration is unavailable.' :
        'This operation is unavailable in the managed text-chat service.',
    },
  });
}

/** Only text/ordinary branching metadata survives into the existing controller. */
function chatBody(value: unknown): ObjectValue {
  const input = object(value);
  keys(input, BODY_FIELDS);
  if (input.endpoint !== ENDPOINT || (input.endpointType != null && input.endpointType !== 'custom')) {
    throw new Error();
  }
  const spec = string(input.spec);
  if (!own(SPEC_MODELS, spec) || input.model !== SPEC_MODELS[spec]) throw new Error();
  const out: ObjectValue = {
    endpoint: ENDPOINT, endpointType: 'custom', model: input.model, spec,
    text: string(input.text, 1_000_000), useResponsesApi: false, resendFiles: false,
    max_tokens: integer(input.max_tokens ?? 4096, 1, 32768),
  };
  // postGenerationRequest adds this after createPayload. Preserve negotiation
  // metadata for the existing controller, but admit only this client's version.
  if (own(input, 'generationProtocolVersion')) {
    if (input.generationProtocolVersion !== 2) throw new Error();
    out.generationProtocolVersion = 2;
  }
  for (const [key, value] of Object.entries(input)) {
    if (value == null) {
      if (ID_FIELDS.has(key) && value === null) out[key] = null;
      continue;
    }
    if (ID_FIELDS.has(key)) {
      if (!IDENTIFIER.test(string(value))) throw new Error();
      out[key] = value;
    } else if (BOOL_FIELDS.has(key) || key === 'disableStreaming') {
      if (typeof value !== 'boolean') throw new Error();
      out[key] = value;
    } else if (DISPLAY_FIELDS.has(key)) {
      string(value, 4096); // UI decoration is not forwarded as model parameters.
    } else if (NULL_ONLY_FIELDS.has(key)) {
      throw new Error();
    } else if (FALSE_ONLY_FIELDS.has(key)) {
      disabled(value);
    } else if (EMPTY_ARRAY_FIELDS.has(key)) {
      emptyArray(value);
    } else if (own(PARAM_LIMITS, key)) {
      const [min, max] = PARAM_LIMITS[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error();
      out[key] = value;
    }
  }
  if (input.sender != null && input.sender !== 'User') throw new Error();
  if (input.isCreatedByUser != null && input.isCreatedByUser !== true) throw new Error();
  if (input.error != null && input.error !== false) throw new Error();
  out.sender = 'User';
  out.isCreatedByUser = true;
  out.error = false;
  if (input.clientTimestamp != null) out.clientTimestamp = string(input.clientTimestamp, 64);
  if (input.timezone != null) {
    const zone = string(input.timezone, 100);
    if (!/^[A-Za-z0-9_+/-]+$/.test(zone)) throw new Error();
    out.timezone = zone;
  }
  if (input.promptPrefix != null) out.promptPrefix = string(input.promptPrefix, 100_000);
  if (input.maxContextTokens != null) out.maxContextTokens = integer(input.maxContextTokens, 1, 1_000_000);
  if (input.expectedPredecessorCreatedAt != null) {
    out.expectedPredecessorCreatedAt = integer(input.expectedPredecessorCreatedAt, 0, Number.MAX_SAFE_INTEGER);
  }
  if (input.stop != null) {
    const values = typeof input.stop === 'string' ? [input.stop] : input.stop;
    if (!Array.isArray(values) || values.length > 4) throw new Error();
    for (const item of values) string(item, 128);
    out.stop = input.stop;
  }
  for (const [key, values] of [
    ['reasoning_effort', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']],
    ['verbosity', ['low', 'medium', 'high']],
  ] as const) {
    if (input[key] != null) {
      if (!(values as readonly unknown[]).includes(input[key])) throw new Error();
      out[key] = input[key];
    }
  }
  if (input.ephemeralAgent != null) {
    const agent = object(input.ephemeralAgent);
    keys(agent, new Set(['mcp', 'web_search', 'file_search', 'execute_code', 'artifacts', 'skills',
      'memory', 'ask_user_question', 'run_in_background', 'describe_intent']));
    for (const [key, value] of Object.entries(agent)) {
      if (value == null) continue;
      if (key === 'mcp') emptyArray(value);
      else if (key === 'artifacts' && value === '') continue;
      else disabled(value);
    }
  }
  // The UI includes dormant code settings even for ordinary text chat. Discard
  // only the inert defaults; attached workspaces and broader modes are denied.
  if (input.codeApprovalMode != null && input.codeApprovalMode !== 'ask') throw new Error();
  if (input.codeEnvironmentMode != null && input.codeEnvironmentMode !== 'without_attached') throw new Error();
  if (input.imageDetail != null && input.imageDetail !== 'auto') throw new Error();
  // Stock OpenAI/custom UI defaults resendFiles=true even with uploads disabled.
  // Never honor that default in this isolated text-only deployment.
  if (input.resendFiles != null && typeof input.resendFiles !== 'boolean') throw new Error();
  if (input.artifacts != null && input.artifacts !== false && input.artifacts !== '') throw new Error();
  if (input.key != null) {
    const expiry = string(input.key, 40);
    if (expiry !== 'never' && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(expiry)) throw new Error();
  }
  if (input.editedContent != null) {
    const edit = object(input.editedContent);
    keys(edit, new Set(['index', 'type', 'text']));
    if (edit.type !== 'text') throw new Error();
    out.editedContent = { index: integer(edit.index, 0, 100_000), type: 'text', text: string(edit.text, 1_000_000) };
  }
  return out;
}

const READ_PATHS = new Set([
  '/api/mission-ai/status',
  '/api/mission-ai/capabilities',
  '/api/config', '/api/user', '/api/user/terms', '/api/endpoints', '/api/endpoints/token-config',
  '/api/models', '/api/balance', '/api/banner', '/api/presets', '/api/tags', '/api/search/enable',
  '/api/convos', '/api/messages', '/api/agents/chat/active',
]);
const POST_PATHS = new Set([
  '/api/mission-ai/search',
  '/api/auth/login', '/api/auth/refresh', '/api/auth/logout', '/api/auth/2fa/verify-temp',
  '/api/auth/2fa/enable', '/api/auth/2fa/verify', '/api/auth/2fa/confirm',
  '/api/auth/2fa/disable', '/api/auth/2fa/backup/regenerate',
  '/api/user/terms/accept', '/api/agents/chat/abort',
]);
const READ_PATTERNS = [
  /^\/api\/roles\/[A-Za-z0-9_-]{1,128}$/,
  /^\/api\/convos\/(?:gen_title\/)?[A-Za-z0-9_-]{1,256}$/,
  /^\/api\/messages\/[A-Za-z0-9_-]{1,256}(?:\/[A-Za-z0-9_-]{1,256})?$/,
  /^\/api\/agents\/chat\/(?:status|stream)\/[A-Za-z0-9_-]{1,256}$/,
];

export function createManagedChatAdmission(options: ManagedChatOptions): Middleware {
  return (req, res, next) => {
    if (!options.enabled) return next();
    try {
      const raw = req.originalUrl ?? req.url ?? '';
      const separator = raw.indexOf('?');
      const path = separator < 0 ? raw : raw.slice(0, separator);
      const query = separator < 0 ? '' : raw.slice(separator + 1);
      // Do not normalize aliases that Express or another proxy might route
      // differently, including encoded slashes, path traversal and case aliases.
      if (!path.startsWith('/') || /[%\\#]/.test(path) || path.includes('//') ||
          path.split('/').some((part) => part === '.' || part === '..')) throw new Error();
      const method = req.method;
      if (/^\/(?:oauth|v1|mcp)(?:\/|$)/i.test(path)) throw new Error();
      if (!/^\/api(?:\/|$)/i.test(path)) {
        if (method === 'GET' || method === 'HEAD') return next();
        throw new Error();
      }
      if (method === 'POST' && path === CHAT_PATH && query === '') {
        req.body = chatBody(req.body);
        return next();
      }
      if (method === 'GET' && path === '/api/keys') {
        const params = new URLSearchParams(query);
        if (params.size !== 1 || params.get('name') !== ENDPOINT) throw new Error();
        return next();
      }
      if (method === 'GET' && (READ_PATHS.has(path) || READ_PATTERNS.some((rule) => rule.test(path)))) {
        return next();
      }
      // The stock client retries an initial refresh failure with this exact URL.
      // Match raw text so aliases, duplicate parameters and extra options stay denied.
      const refreshRetry = path === '/api/auth/refresh' && query === 'retry=true';
      if (method === 'POST' && POST_PATHS.has(path) && (query === '' || refreshRetry)) return next();
      throw new Error();
    } catch {
      return deny(res);
    }
  };
}

function assertConfiguration(value: unknown, options: ManagedChatOptions): void {
  if (options.titleConvo !== 'false' || !options.nativeToken || options.nativeToken === 'user_provided') {
    throw new Error();
  }
  const gateway = new URL(options.gatewayURL ?? '');
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search ||
      gateway.hash || gateway.pathname !== '/') throw new Error();
  const baseURL = FREE_BASELINE
    ? 'https://generativelanguage.googleapis.com/v1beta/openai'
    : `${gateway.origin}/native/openai/v1`;
  const approvedApiKeys = FREE_BASELINE
    ? [process.env.GOOGLE_KEY, '${GOOGLE_KEY}']
    : [options.nativeToken, '${MISSION_AI_NATIVE_TOKEN}'];
  const approvedBaseURLs = FREE_BASELINE
    ? [baseURL]
    : [baseURL, '${MISSION_AI_GATEWAY_URL}/native/openai/v1'];
  const config = object(value);
  const endpoints = object(config.endpoints);
  keys(endpoints, new Set(['all', 'agents', 'custom']));
  const all = object(endpoints.all);
  for (const flag of ['titleConvo', 'activityLabel', 'activityPhaseLabel', 'reasoningLabel']) {
    if (all[flag] !== false) throw new Error();
  }
  keys(all, new Set(['titleConvo', 'activityLabel', 'activityPhaseLabel', 'reasoningLabel', 'streamRate']));
  const agents = object(endpoints.agents);
  if (agents.disableBuilder !== true) throw new Error();
  sameStrings(agents.allowedProviders, [ENDPOINT]);
  emptyArray(agents.capabilities);
  for (const flag of ['titleConvo', 'activityLabel', 'activityPhaseLabel', 'reasoningLabel']) disabled(agents[flag]);
  for (const key of ['headers', 'addParams', 'customParams']) emptyRecord(agents[key]);
  if (!Array.isArray(endpoints.custom) || endpoints.custom.length !== 1) throw new Error();
  const custom = object(endpoints.custom[0]);
  keys(custom, new Set(['name', 'apiKey', 'baseURL', 'models', 'modelDisplayLabel', 'titleConvo',
    'dropParams', 'addParams', 'iconURL', 'streamRate']));
  if (custom.name !== ENDPOINT || custom.titleConvo !== false ||
      !approvedApiKeys.includes(custom.apiKey as string) ||
      !approvedBaseURLs.includes(custom.baseURL as string)) {
    throw new Error();
  }
  const models = object(custom.models);
  keys(models, new Set(['default', 'fetch']));
  if (models.fetch !== false) throw new Error();
  sameStrings(models.default, Object.values(SPEC_MODELS));
  sameStrings(custom.dropParams, ['useResponsesApi', 'temperature', 'top_p', 'topP',
    'frequency_penalty', 'frequencyPenalty', 'presence_penalty', 'presencePenalty', 'seed', 'user', 'verbosity']);
  const transport = object(custom.addParams);
  keys(transport, new Set(['maxRetries', 'timeout']));
  if (transport.maxRetries !== 0 || transport.timeout !== 180_000) throw new Error();
  const specs = object(config.modelSpecs);
  keys(specs, new Set(['enforce', 'prioritize', 'list', 'addedEndpoints']));
  if (specs.enforce !== true || specs.prioritize !== true) throw new Error();
  if (specs.addedEndpoints != null) emptyArray(specs.addedEndpoints);
  if (!Array.isArray(specs.list) || specs.list.length !== Object.keys(SPEC_MODELS).length) throw new Error();
  const seen = new Set();
  for (const value of specs.list) {
    const spec = object(value);
    keys(spec, new Set(['name', 'label', 'description', 'iconURL', 'default', 'preset']));
    const name = string(spec.name);
    if (!own(SPEC_MODELS, name) || seen.has(name)) throw new Error();
    seen.add(name);
    const preset = object(spec.preset);
    keys(preset, new Set(['endpoint', 'model', 'useResponsesApi', 'max_tokens', 'promptPrefix']));
    if (preset.endpoint !== ENDPOINT || preset.model !== SPEC_MODELS[name] || preset.useResponsesApi !== false) {
      throw new Error();
    }
    integer(preset.max_tokens, 1, 32768);
    if (FREE_BASELINE) {
      if (!reviewedPrompt(preset.promptPrefix)) throw new Error();
    } else if (preset.promptPrefix != null) {
      throw new Error();
    }
  }
  if (object(config.memory).disabled !== true || object(config.summarization).enabled !== false) throw new Error();
  const raw = object(config.config);
  if (object(raw.memory).disabled !== true || object(raw.summarization).enabled !== false) throw new Error();
  emptyRecord(config.mcpConfig);
  emptyRecord(raw.mcpServers);
  for (const view of [config.interfaceConfig, raw.interface]) {
    const ui = object(view);
    for (const key of ['multiConvo', 'agents', 'schedules', 'skills', 'memories', 'runCode', 'webSearch', 'fileSearch']) {
      if (ui[key] !== false) throw new Error();
    }
    emptyArray(ui.defaultPinnedTools);
  }
}

/** Runs after configMiddleware and before endpoint-option/model-spec building. */
export function createManagedChatConfigGuard(options: ManagedChatOptions): Middleware {
  return (req, res, next) => {
    if (!options.enabled) return next();
    try {
      assertConfiguration(req.config, options);
    } catch {
      return deny(res, true);
    }
    try {
      req.body = chatBody(req.body);
    } catch {
      return deny(res);
    }
    return next();
  };
}
