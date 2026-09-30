/**
 * Admission boundary for the Mission AI managed text-chat service.
 *
 * Exactly seven reviewed model specs are exposed across three reviewed custom
 * endpoints in free-baseline mode. Gemini remains the only default there.
 * The existing non-baseline tool deployment retains its isolated Sonnet profile.
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

type PromptKind = 'gateway' | 'paid';

type ApprovedSpec = Readonly<{
  endpoint: string;
  model: string;
  default: boolean;
  prompt?: PromptKind;
}>;

type ApprovedEndpoint = Readonly<{
  baseURL: 'google' | 'anthropicGateway' | 'openaiGateway';
  apiKey: 'google' | 'native';
  models: readonly string[];
}>;

const RUNTIME_ENV = ((globalThis as unknown as {
  process?: { env?: Record<string, string | undefined> };
}).process?.env ?? {});

const FREE_BASELINE = RUNTIME_ENV.MISSION_AI_FREE_BASELINE === 'true';

const GOOGLE_ENDPOINT = 'MissionAI';
const CLAUDE_ENDPOINT = 'MissionAIClaude';
const OPENAI_ENDPOINT = 'MissionAIOpenAI';

const ENDPOINTS: readonly string[] = Object.freeze(
  FREE_BASELINE ? [GOOGLE_ENDPOINT, CLAUDE_ENDPOINT, OPENAI_ENDPOINT] : [GOOGLE_ENDPOINT],
);

const BASELINE_SPECS: Readonly<Record<string, ApprovedSpec>> = Object.freeze({
  'mission-ai-free': Object.freeze({
    endpoint: GOOGLE_ENDPOINT,
    model: 'gemini-3.5-flash-lite',
    default: true,
    prompt: 'gateway',
  }),
  'mission-ai-gpt-luna': Object.freeze({
    endpoint: OPENAI_ENDPOINT,
    model: 'gpt-6-luna',
    default: false,
    prompt: 'paid',
  }),
  'mission-ai-gpt-sol': Object.freeze({
    endpoint: OPENAI_ENDPOINT,
    model: 'gpt-6-sol',
    default: false,
    prompt: 'paid',
  }),
  'mission-ai-gpt-astra': Object.freeze({
    endpoint: OPENAI_ENDPOINT,
    model: 'gpt-6-astra',
    default: false,
    prompt: 'paid',
  }),
  'mission-ai-claude-haiku': Object.freeze({
    endpoint: CLAUDE_ENDPOINT,
    model: 'claude-haiku-4-5',
    default: false,
    prompt: 'paid',
  }),
  'mission-ai-claude-sonnet': Object.freeze({
    endpoint: CLAUDE_ENDPOINT,
    model: 'claude-sonnet-5-5',
    default: false,
    prompt: 'paid',
  }),
  'mission-ai-claude-opus': Object.freeze({
    endpoint: CLAUDE_ENDPOINT,
    model: 'claude-opus-5-5',
    default: false,
    prompt: 'paid',
  }),
});

const APPROVED_SPECS: Readonly<Record<string, ApprovedSpec>> = FREE_BASELINE
  ? BASELINE_SPECS
  : Object.freeze({
      'mission-ai-sonnet': Object.freeze({
        endpoint: GOOGLE_ENDPOINT,
        model: 'claude-sonnet-5-5',
        default: true,
      }),
    });

const BASELINE_ENDPOINTS: Readonly<Record<string, ApprovedEndpoint>> = Object.freeze({
  [GOOGLE_ENDPOINT]: Object.freeze({
    baseURL: 'google',
    apiKey: 'google',
    models: Object.freeze(['gemini-3.5-flash-lite']),
  }),
  [CLAUDE_ENDPOINT]: Object.freeze({
    baseURL: 'anthropicGateway',
    apiKey: 'native',
    models: Object.freeze([
      'claude-haiku-4-5',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
    ]),
  }),
  [OPENAI_ENDPOINT]: Object.freeze({
    baseURL: 'openaiGateway',
    apiKey: 'native',
    models: Object.freeze([
      'gpt-6-luna',
      'gpt-6-sol',
      'gpt-6-astra',
    ]),
  }),
});

const APPROVED_ENDPOINTS: Readonly<Record<string, ApprovedEndpoint>> = FREE_BASELINE
  ? BASELINE_ENDPOINTS
  : Object.freeze({
      [GOOGLE_ENDPOINT]: Object.freeze({
        baseURL: 'anthropicGateway',
        apiKey: 'native',
        models: Object.freeze(['claude-sonnet-5-5']),
      }),
    });

const MASTER_GATEWAY_PROMPT = `MISSION AI MASTER GATEWAY v2

You are the Mission AI routing gate.

On the first substantive user request in each new conversation, classify the work into exactly one technical tier before doing the work.

T0 — Simple:
Short factual questions, rewriting, extraction, formatting, basic calculations, simple summaries, or other low-complexity tasks.

T1 — Standard:
Normal knowledge work, drafting, moderate analysis, ordinary coding help, troubleshooting, planning, or structured reasoning that a fast low-cost model can reliably handle.

T2 — Advanced:
Complex multi-step debugging, architecture, substantial code changes, difficult technical analysis, large-context synthesis, or work where failure would create significant rework.

T3 — Expert:
Exceptionally difficult reasoning, deep system design, high-complexity research, cross-system engineering, or tasks requiring the strongest approved reasoning capability.

COST FIREWALL:
Always recommend the cheapest approved model capable of reliably completing the task.
Never claim to switch models automatically. Model switching is always manual.

Approved manual routing ladder:
- T0: Gemini 3.5 Flash Lite — Free Baseline
- T1: Gemini 3.5 Flash Lite — Free Baseline
- T2-low: Claude Haiku 4.5 or GPT-6 Luna when sufficient
- T2: Claude Sonnet 5.5 or GPT-6 Sol when stronger reasoning is required
- T3: Claude Opus 5.5 or GPT-6 Astra for the hardest work

For T0 or T1, begin the response with:
[MISSION AI ROUTE] T# | STAY: Gemini 3.5 Flash Lite | FREE BASELINE

Then continue immediately with the requested work.

For T2 or T3, do not begin the substantive work while this free-baseline model is selected.
Begin the response with:
[MISSION AI ROUTE] T# | MANUAL SWITCH REQUIRED | RECOMMENDED: <cheapest approved model>

Then give one short sentence explaining why the higher tier is appropriate and stop.

Do not repeat the routing banner on ordinary follow-up messages in the same conversation unless the scope materially changes enough to require a different tier.`;

const PAID_MODEL_PROMPT = `MISSION AI PAID MODEL GUARD v1

A paid Mission AI model has been selected manually by the user.

Proceed with the user's requested work using this selected model.
Do not claim that Mission AI selected or switched to this paid model automatically.
Do not recommend a more expensive model unless the current model is materially insufficient for the requested task.
If a cheaper approved model would clearly be sufficient for a future new task, you may mention that fact briefly, but do not interrupt the current task.
Keep all provider switching manual.`;

function reviewedPrompt(kind: PromptKind, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const expected = kind === 'gateway' ? MASTER_GATEWAY_PROMPT : PAID_MODEL_PROMPT;
  return value === expected || value === `${expected}\n`;
}

const IDENTIFIER = /^[A-Za-z0-9_-]{1,256}$/;

const ID_FIELDS = new Set([
  'conversationId',
  'parentMessageId',
  'messageId',
  'responseMessageId',
  'overrideConvoId',
  'overrideUserMessageId',
  'overrideParentMessageId',
  'clientRequestId',
]);

const BOOL_FIELDS = new Set(['isTemporary', 'isRegenerate', 'isContinued']);

const DISPLAY_FIELDS = new Set([
  'modelLabel',
  'chatGptLabel',
  'modelDisplayLabel',
  'iconURL',
  'greeting',
]);

const NULL_ONLY_FIELDS = new Set([
  'addedConvo',
  'thread_id',
  'chatProjectId',
  'recoverySteerId',
  'reasoning_context',
  'reasoning_summary',
  'reasoning_mode',
  'fileTokenLimit',
]);

const FALSE_ONLY_FIELDS = new Set(['useResponsesApi', 'web_search', 'compact']);
const EMPTY_ARRAY_FIELDS = new Set(['manualSkills', 'codeWorkspaces', 'quotes']);

const PARAM_LIMITS: Readonly<Record<string, readonly [number, number]>> = {
  temperature: [0, 2],
  top_p: [0, 1],
  presence_penalty: [-2, 2],
  frequency_penalty: [-2, 2],
};

const BODY_FIELDS = new Set([
  ...ID_FIELDS,
  ...BOOL_FIELDS,
  ...DISPLAY_FIELDS,
  ...NULL_ONLY_FIELDS,
  ...FALSE_ONLY_FIELDS,
  ...EMPTY_ARRAY_FIELDS,
  ...Object.keys(PARAM_LIMITS),
  'endpoint',
  'endpointType',
  'model',
  'spec',
  'text',
  'sender',
  'clientTimestamp',
  'isCreatedByUser',
  'error',
  'ephemeralAgent',
  'editedContent',
  'key',
  'timezone',
  'promptPrefix',
  'max_tokens',
  'maxContextTokens',
  'stop',
  'reasoning_effort',
  'verbosity',
  'disableStreaming',
  'resendFiles',
  'artifacts',
  'imageDetail',
  'codeApprovalMode',
  'codeEnvironmentMode',
  'expectedPredecessorCreatedAt',
  'generationProtocolVersion',
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
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
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
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    new Set(value).size !== value.length ||
    value.some((item) => !expected.includes(item))
  ) {
    throw new Error();
  }
}

function disabled(value: unknown): void {
  if (value != null && value !== false) throw new Error();
}

function deny(res: ManagedChatResponse, configuration = false): unknown {
  return res.status(configuration ? 503 : 403).json({
    error: {
      code: configuration
        ? 'managed_chat_configuration_invalid'
        : 'managed_chat_request_denied',
      message: configuration
        ? 'Managed chat configuration is unavailable.'
        : 'This operation is unavailable in the managed text-chat service.',
    },
  });
}

function approvedSpec(name: unknown): { name: string; spec: ApprovedSpec } {
  const specName = string(name);
  if (!own(APPROVED_SPECS, specName)) throw new Error();
  return { name: specName, spec: APPROVED_SPECS[specName] };
}

/** Admit only an exact reviewed spec/endpoint/model tuple. */
function chatBody(value: unknown): ObjectValue {
  const input = object(value);
  keys(input, BODY_FIELDS);

  const approved = approvedSpec(input.spec);

  if (
    input.endpoint !== approved.spec.endpoint ||
    (input.endpointType != null && input.endpointType !== 'custom') ||
    input.model !== approved.spec.model
  ) {
    throw new Error();
  }

  const out: ObjectValue = {
    endpoint: approved.spec.endpoint,
    endpointType: 'custom',
    model: approved.spec.model,
    spec: approved.name,
    text: string(input.text, 1_000_000),
    useResponsesApi: false,
    resendFiles: false,
    max_tokens: integer(input.max_tokens ?? 4096, 1, 32768),
  };

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
      string(value, 4096);
    } else if (NULL_ONLY_FIELDS.has(key)) {
      throw new Error();
    } else if (FALSE_ONLY_FIELDS.has(key)) {
      disabled(value);
    } else if (EMPTY_ARRAY_FIELDS.has(key)) {
      emptyArray(value);
    } else if (own(PARAM_LIMITS, key)) {
      const [min, max] = PARAM_LIMITS[key];
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < min ||
        value > max
      ) {
        throw new Error();
      }
      out[key] = value;
    }
  }

  if (input.sender != null && input.sender !== 'User') throw new Error();
  if (input.isCreatedByUser != null && input.isCreatedByUser !== true) throw new Error();
  if (input.error != null && input.error !== false) throw new Error();

  out.sender = 'User';
  out.isCreatedByUser = true;
  out.error = false;

  if (input.clientTimestamp != null) {
    out.clientTimestamp = string(input.clientTimestamp, 64);
  }

  if (input.timezone != null) {
    const zone = string(input.timezone, 100);
    if (!/^[A-Za-z0-9_+/-]+$/.test(zone)) throw new Error();
    out.timezone = zone;
  }

  /*
   * Enforced model-spec promptPrefix is restored server-side after this request
   * admission boundary. The client must never supply or override it.
   */
  if (input.promptPrefix != null) throw new Error();

  if (input.maxContextTokens != null) {
    out.maxContextTokens = integer(input.maxContextTokens, 1, 1_000_000);
  }

  if (input.expectedPredecessorCreatedAt != null) {
    out.expectedPredecessorCreatedAt = integer(
      input.expectedPredecessorCreatedAt,
      0,
      Number.MAX_SAFE_INTEGER,
    );
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
    keys(
      agent,
      new Set([
        'mcp',
        'web_search',
        'file_search',
        'execute_code',
        'artifacts',
        'skills',
        'memory',
        'ask_user_question',
        'run_in_background',
        'describe_intent',
      ]),
    );

    for (const [key, value] of Object.entries(agent)) {
      if (value == null) continue;
      if (key === 'mcp') emptyArray(value);
      else if (key === 'artifacts' && value === '') continue;
      else disabled(value);
    }
  }

  if (input.codeApprovalMode != null && input.codeApprovalMode !== 'ask') throw new Error();
  if (
    input.codeEnvironmentMode != null &&
    input.codeEnvironmentMode !== 'without_attached'
  ) {
    throw new Error();
  }
  if (input.imageDetail != null && input.imageDetail !== 'auto') throw new Error();

  if (input.resendFiles != null && typeof input.resendFiles !== 'boolean') {
    throw new Error();
  }

  if (input.artifacts != null && input.artifacts !== false && input.artifacts !== '') {
    throw new Error();
  }

  if (input.key != null) {
    const expiry = string(input.key, 40);
    if (expiry !== 'never' && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(expiry)) {
      throw new Error();
    }
  }

  if (input.editedContent != null) {
    const edit = object(input.editedContent);
    keys(edit, new Set(['index', 'type', 'text']));
    if (edit.type !== 'text') throw new Error();

    out.editedContent = {
      index: integer(edit.index, 0, 100_000),
      type: 'text',
      text: string(edit.text, 1_000_000),
    };
  }

  return out;
}

const READ_PATHS = new Set([
  '/api/mission-ai/status',
  '/api/mission-ai/capabilities',
  '/api/config',
  '/api/user',
  '/api/user/terms',
  '/api/endpoints',
  '/api/endpoints/token-config',
  '/api/models',
  '/api/balance',
  '/api/banner',
  '/api/presets',
  '/api/tags',
  '/api/search/enable',
  '/api/convos',
  '/api/messages',
  '/api/agents/chat/active',
]);

const POST_PATHS = new Set([
  '/api/mission-ai/search',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/auth/2fa/verify-temp',
  '/api/auth/2fa/enable',
  '/api/auth/2fa/verify',
  '/api/auth/2fa/confirm',
  '/api/auth/2fa/disable',
  '/api/auth/2fa/backup/regenerate',
  '/api/user/terms/accept',
  '/api/agents/chat/abort',
]);

const READ_PATTERNS = [
  /^\/api\/roles\/[A-Za-z0-9_-]{1,128}$/,
  /^\/api\/convos\/(?:gen_title\/)?[A-Za-z0-9_-]{1,256}$/,
  /^\/api\/messages\/[A-Za-z0-9_-]{1,256}(?:\/[A-Za-z0-9_-]{1,256})?$/,
  /^\/api\/agents\/chat\/(?:status|stream)\/[A-Za-z0-9_-]{1,256}$/,
];

function chatPath(endpoint: string): string {
  return `/api/agents/chat/${endpoint}`;
}

export function createManagedChatAdmission(options: ManagedChatOptions): Middleware {
  return (req, res, next) => {
    if (!options.enabled) return next();

    try {
      const raw = req.originalUrl ?? req.url ?? '';
      const separator = raw.indexOf('?');
      const path = separator < 0 ? raw : raw.slice(0, separator);
      const query = separator < 0 ? '' : raw.slice(separator + 1);

      if (
        !path.startsWith('/') ||
        /[%\\#]/.test(path) ||
        path.includes('//') ||
        path.split('/').some((part) => part === '.' || part === '..')
      ) {
        throw new Error();
      }

      const method = req.method;

      if (/^\/(?:oauth|v1|mcp)(?:\/|$)/i.test(path)) throw new Error();

      if (!/^\/api(?:\/|$)/i.test(path)) {
        if (method === 'GET' || method === 'HEAD') return next();
        throw new Error();
      }

      if (
        method === 'POST' &&
        separator < 0 &&
        ENDPOINTS.some((endpoint) => path === chatPath(endpoint))
      ) {
        const body = chatBody(req.body);
        if (path !== chatPath(body.endpoint as string)) throw new Error();
        req.body = body;
        return next();
      }

      if (method === 'DELETE' && path === '/api/convos' && query === '') {
        const body = object(req.body);
        keys(body, new Set(['arg']));
        const arg = object(body.arg);
        keys(arg, new Set(['conversationId', 'thread_id', 'endpoint', 'source']));
        if (!IDENTIFIER.test(string(arg.conversationId))) throw new Error();
        if (arg.source !== undefined && arg.source !== 'button') throw new Error();
        if (arg.endpoint != null && !ENDPOINTS.includes(string(arg.endpoint))) throw new Error();
        if (arg.thread_id != null && !IDENTIFIER.test(string(arg.thread_id))) throw new Error();
        return next();
      }

      if (method === 'DELETE' && path === '/api/convos/all' && query === '') {
        const body = req.body == null ? {} : object(req.body);
        keys(body, new Set());
        return next();
      }

      if (method === 'GET' && path === '/api/files/speech/config/get' && query === '') {
        return next();
      }

      if (method === 'GET' && path === '/api/keys') {
        const params = new URLSearchParams(query);
        const requested = params.get('name');

        if (
          params.size !== 1 ||
          requested == null ||
          query !== `name=${requested}` ||
          !ENDPOINTS.includes(requested as (typeof ENDPOINTS)[number])
        ) {
          throw new Error();
        }

        return next();
      }

      if (
        method === 'GET' &&
        (READ_PATHS.has(path) || READ_PATTERNS.some((rule) => rule.test(path)))
      ) {
        return next();
      }

      const refreshRetry = path === '/api/auth/refresh' && query === 'retry=true';

      if (
        method === 'POST' &&
        POST_PATHS.has(path) &&
        (query === '' || refreshRetry)
      ) {
        return next();
      }

      throw new Error();
    } catch {
      return deny(res);
    }
  };
}

function expectedEndpointConfig(
  endpoint: string,
  gatewayOrigin: string,
): {
  baseURLs: readonly string[];
  apiKeys: readonly (string | undefined)[];
  models: readonly string[];
} {
  const definition = APPROVED_ENDPOINTS[endpoint];
  if (!definition) throw new Error();

  if (definition.baseURL === 'google') {
    return {
      baseURLs: [
        'https://generativelanguage.googleapis.com/v1beta/openai',
      ],
      apiKeys: [
        RUNTIME_ENV.GOOGLE_KEY,
        '${GOOGLE_KEY}',
      ],
      models: definition.models,
    };
  }

  if (definition.baseURL === 'anthropicGateway') {
    return {
      baseURLs: [
        `${gatewayOrigin}/native/openai/v1`,
        '${MISSION_AI_GATEWAY_URL}/native/openai/v1',
      ],
      apiKeys: [
        '${MISSION_AI_NATIVE_TOKEN}',
      ],
      models: definition.models,
    };
  }

  return {
    baseURLs: [
      `${gatewayOrigin}/native/openai-direct/v1`,
      '${MISSION_AI_GATEWAY_URL}/native/openai-direct/v1',
    ],
    apiKeys: [
      '${MISSION_AI_NATIVE_TOKEN}',
    ],
    models: definition.models,
  };
}

function assertConfiguration(value: unknown, options: ManagedChatOptions): void {
  if (
    options.titleConvo !== 'false' ||
    !options.nativeToken ||
    options.nativeToken === 'user_provided'
  ) {
    throw new Error();
  }

  const gateway = new URL(options.gatewayURL ?? '');

  if (
    gateway.protocol !== 'https:' ||
    gateway.username ||
    gateway.password ||
    gateway.search ||
    gateway.hash ||
    gateway.pathname !== '/'
  ) {
    throw new Error();
  }

  const config = object(value);
  const endpoints = object(config.endpoints);

  keys(endpoints, new Set(['all', 'agents', 'custom']));

  const all = object(endpoints.all);

  for (const flag of [
    'titleConvo',
    'activityLabel',
    'activityPhaseLabel',
    'reasoningLabel',
  ]) {
    if (all[flag] !== false) throw new Error();
  }

  keys(
    all,
    new Set([
      'titleConvo',
      'activityLabel',
      'activityPhaseLabel',
      'reasoningLabel',
      'streamRate',
    ]),
  );

  const agents = object(endpoints.agents);

  if (agents.disableBuilder !== true) throw new Error();
  sameStrings(agents.allowedProviders, ENDPOINTS);
  emptyArray(agents.capabilities);

  for (const flag of [
    'titleConvo',
    'activityLabel',
    'activityPhaseLabel',
    'reasoningLabel',
  ]) {
    disabled(agents[flag]);
  }

  for (const key of ['headers', 'addParams', 'customParams']) {
    emptyRecord(agents[key]);
  }

  if (
    !Array.isArray(endpoints.custom) ||
    endpoints.custom.length !== ENDPOINTS.length
  ) {
    throw new Error();
  }

  const seenEndpoints = new Set<string>();

  for (const endpointValue of endpoints.custom) {
    const custom = object(endpointValue);

    keys(
      custom,
      new Set([
        'name',
        'apiKey',
        'baseURL',
        'models',
        'modelDisplayLabel',
        'titleConvo',
        'dropParams',
        'addParams',
        'iconURL',
        'streamRate',
      ]),
    );

    const name = string(custom.name);

    if (
      !ENDPOINTS.includes(name as (typeof ENDPOINTS)[number]) ||
      seenEndpoints.has(name)
    ) {
      throw new Error();
    }

    seenEndpoints.add(name);

    const expected = expectedEndpointConfig(name, gateway.origin);

    const approvedApiKeys =
      APPROVED_ENDPOINTS[name].apiKey === 'google'
        ? expected.apiKeys
        : [options.nativeToken, ...expected.apiKeys];

    if (
      custom.titleConvo !== false ||
      !approvedApiKeys.includes(custom.apiKey as string | undefined) ||
      !expected.baseURLs.includes(custom.baseURL as string)
    ) {
      throw new Error();
    }

    const models = object(custom.models);

    keys(models, new Set(['default', 'fetch']));

    if (models.fetch !== false) throw new Error();

    sameStrings(models.default, expected.models);

    sameStrings(custom.dropParams, [
      'useResponsesApi',
      'temperature',
      'top_p',
      'topP',
      'frequency_penalty',
      'frequencyPenalty',
      'presence_penalty',
      'presencePenalty',
      'seed',
      'user',
      'verbosity',
    ]);

    const transport = object(custom.addParams);

    keys(transport, new Set(['maxRetries', 'timeout']));

    if (
      transport.maxRetries !== 0 ||
      transport.timeout !== 180_000
    ) {
      throw new Error();
    }
  }

  const specs = object(config.modelSpecs);

  keys(specs, new Set(['enforce', 'prioritize', 'list', 'addedEndpoints']));

  if (specs.enforce !== true || specs.prioritize !== true) throw new Error();

  if (specs.addedEndpoints != null) {
    emptyArray(specs.addedEndpoints);
  }

  if (
    !Array.isArray(specs.list) ||
    specs.list.length !== Object.keys(APPROVED_SPECS).length
  ) {
    throw new Error();
  }

  const seenSpecs = new Set<string>();
  let defaults = 0;

  for (const value of specs.list) {
    const spec = object(value);

    keys(
      spec,
      new Set([
        'name',
        'label',
        'description',
        'iconURL',
        'default',
        'preset',
      ]),
    );

    const name = string(spec.name);

    if (!own(APPROVED_SPECS, name) || seenSpecs.has(name)) {
      throw new Error();
    }

    seenSpecs.add(name);

    const approved = APPROVED_SPECS[name];

    if (approved.default) {
      if (spec.default !== true) throw new Error();
      defaults++;
    } else if (spec.default != null && spec.default !== false) {
      throw new Error();
    }

    const preset = object(spec.preset);

    keys(
      preset,
      new Set([
        'endpoint',
        'model',
        'useResponsesApi',
        'max_tokens',
        'promptPrefix',
      ]),
    );

    if (
      preset.endpoint !== approved.endpoint ||
      preset.model !== approved.model ||
      preset.useResponsesApi !== false
    ) {
      throw new Error();
    }

    integer(preset.max_tokens, 1, 32768);

    if (
      approved.prompt
        ? !reviewedPrompt(approved.prompt, preset.promptPrefix)
        : preset.promptPrefix != null
    ) {
      throw new Error();
    }
  }

  if (defaults !== 1) throw new Error();

  if (
    object(config.memory).disabled !== true ||
    object(config.summarization).enabled !== false
  ) {
    throw new Error();
  }

  const raw = object(config.config);

  if (
    object(raw.memory).disabled !== true ||
    object(raw.summarization).enabled !== false
  ) {
    throw new Error();
  }

  emptyRecord(config.mcpConfig);
  emptyRecord(raw.mcpServers);

  for (const view of [config.interfaceConfig, raw.interface]) {
    const ui = object(view);

    for (const key of [
      'multiConvo',
      'agents',
      'schedules',
      'skills',
      'memories',
      'runCode',
      'webSearch',
      'fileSearch',
    ]) {
      if (ui[key] !== false) throw new Error();
    }

    emptyArray(ui.defaultPinnedTools);
  }
}

/**
 * Runs after configMiddleware and before endpoint-option/model-spec building.
 */
export function createManagedChatConfigGuard(
  options: ManagedChatOptions,
): Middleware {
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
