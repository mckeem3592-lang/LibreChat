import { anthropicRequest, anthropicUsage, anthropicCompletion } from './anthropicNative.js';
import { normalizeAnthropicMessages, validateAnthropicMessage, anthropicReservationPrompt } from './anthropicMessages.js';

/** Restricted, non-streaming upstream transport. The host owns HTTP authentication and SSE. */
type JsonObject = Record<string, unknown>;
type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteTokens: number;
  cacheWrite5mTokens?: number; cacheWrite1hTokens?: number };
type Awaitable<T> = T | Promise<T>;

interface NativeLedger {
  reserve(input: {
    reservationId: string;
    reserveUsd: number;
    directCapUsd: number;
    now: Date;
    timeZone: string;
    metadata: JsonObject;
  }): Promise<{ reservationId: string; reservedUsd: number }>;
  settle(input: { reservationId: string; actualUsd: number; usage: JsonObject }): Promise<unknown>;
  release(input: { reservationId: string; reason: string }): Promise<unknown>;
}

export interface NativeBridgeDependencies {
  ledger: NativeLedger;
  budgetReader: (input: { now: Date }) => Awaitable<{
    mode: string;
    policy: { targetUsd: number; economyUsd: number; hardUsd: number };
    timeZone: string;
    directCapUsd: number;
  }>;
  pricingLoader: () => Awaitable<unknown>;
  estimateCost: (input: {
    provider: string;
    model: string;
    prompt: string;
    system: string;
    maxOutputTokens: number;
    pricing: unknown;
    imageInputTokens?: number;
  }) => number;
  calculateCost: (
    provider: string,
    model: string,
    usage: Usage,
    pricing: unknown,
  ) => { totalUsd: number; pricingVerifiedOn?: string | null };
  fetchImpl: (url: string, init: RequestInit) => Promise<Pick<Response, 'status' | 'json'>>;
  providerKey: string;
  provider?: 'openai' | 'anthropic';
  protocol?: 'openai' | 'anthropic-messages';
  modelAllowed: (model: string) => Awaitable<boolean>;
  now: () => Date;
  randomId: () => string;
}

export class NativeBridgeError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
    this.name = 'NativeBridgeError';
  }
}

// Deliberately fixed protocol ceilings for this restricted bridge, not user-controlled routing.
const MAX_BODY_BYTES = 1_048_576;
const MAX_OUTPUT_TOKENS = 32_768;
const PROVIDER_TIMEOUT_MS = 30_000;
const UPSTREAM_URL = 'https://api.openai.com/v1/chat/completions';
const ALLOWED_FIELDS = new Set([
  'model', 'messages', 'max_tokens', 'max_completion_tokens', 'n', 'service_tier',
  'stream', 'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls',
  'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'stop', 'seed',
  'reasoning_effort', 'verbosity', 'user', 'store',
]);
const SAFE_FAILURES = new Set([
  'monthly_hard_limit', 'ledger_accounting_blocked', 'ledger_integrity_invalid',
  'ledger_state_invalid', 'reservation_underestimated', 'shared_budget_unready',
]);

function fail(code = 'native_request_invalid', status = 400): never {
  throw new NativeBridgeError(code, status);
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  return value as JsonObject;
}

function keys(value: JsonObject, allowed: readonly string[] | Set<string>): void {
  const permitted = allowed instanceof Set ? allowed : new Set(allowed);
  if (Object.keys(value).some((key) => !permitted.has(key))) fail('native_field_unsupported');
}

function text(value: unknown, max = MAX_BODY_BYTES): string {
  if (typeof value !== 'string' || value.length > max) fail();
  return value;
}

function name(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(result)) fail();
  return result;
}

function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > max) fail();
  return value;
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}

function validJson(value: unknown, depth = 0): void {
  if (depth > 32) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const entry of value) validJson(entry, depth + 1);
    return;
  }
  for (const entry of Object.values(object(value))) validJson(entry, depth + 1);
}

function content(value: unknown): string | JsonObject[] {
  if (typeof value === 'string') return text(value);
  return list(value, 256).map((entry) => {
    const part = object(entry);
    keys(part, ['type', 'text']);
    if (part.type !== 'text') fail('native_content_unsupported');
    return { type: 'text', text: text(part.text) };
  });
}

function calls(value: unknown): JsonObject[] {
  return list(value, 128).map((entry) => {
    const call = object(entry);
    keys(call, ['id', 'type', 'function']);
    if (call.type !== 'function') fail('native_tool_unsupported');
    const fn = object(call.function);
    keys(fn, ['name', 'arguments']);
    const id = text(call.id, 200);
    if (!id) fail();
    return { id, type: 'function', function: { name: name(fn.name), arguments: text(fn.arguments) } };
  });
}

function messages(value: unknown): JsonObject[] {
  return list(value, 256).map((entry) => {
    const message = object(entry);
    const role = message.role;
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(String(role))) fail();
    const allowed = role === 'assistant' ? ['role', 'content', 'name', 'tool_calls'] :
      role === 'tool' ? ['role', 'content', 'tool_call_id'] : ['role', 'content', 'name'];
    keys(message, allowed);
    const result: JsonObject = { role };
    if (message.name !== undefined) result.name = name(message.name);
    if (role === 'assistant' && message.tool_calls !== undefined) {
      result.tool_calls = calls(message.tool_calls);
    }
    if (role === 'assistant' && (message.content === null || message.content === undefined)) {
      if (!result.tool_calls) fail();
      result.content = null;
    } else {
      result.content = content(message.content);
    }
    if (role === 'tool') {
      result.tool_call_id = text(message.tool_call_id, 200);
      if (!result.tool_call_id) fail();
    }
    return result;
  });
}

function tools(value: unknown): JsonObject[] {
  return list(value, 128).map((entry) => {
    const tool = object(entry);
    keys(tool, ['type', 'function']);
    if (tool.type !== 'function') fail('native_tool_unsupported');
    const fn = object(tool.function);
    keys(fn, ['name', 'description', 'parameters', 'strict']);
    const normalized: JsonObject = { name: name(fn.name) };
    if (fn.description !== undefined) normalized.description = text(fn.description);
    if (fn.parameters !== undefined) {
      normalized.parameters = object(fn.parameters);
      validJson(fn.parameters);
    }
    if (fn.strict !== undefined) {
      if (typeof fn.strict !== 'boolean') fail();
      normalized.strict = fn.strict;
    }
    return { type: 'function', function: normalized };
  });
}

function normalizeBody(value: unknown): { body: JsonObject; model: string; outputLimit: number } {
  const input = object(value);
  keys(input, ALLOWED_FIELDS);
  const model = text(input.model, 200);
  if (!model || !/^[a-zA-Z0-9._-]+$/.test(model)) fail('native_model_unsupported');
  if (input.max_tokens !== undefined && input.max_completion_tokens !== undefined) fail();
  const outputLimit = integer(input.max_completion_tokens ?? input.max_tokens ?? 4096, 1, MAX_OUTPUT_TOKENS);
  // Explicit null is not permission to fall back to an unbounded provider default.
  if (input.max_tokens === null || input.max_completion_tokens === null) fail();
  if (input.n !== undefined && input.n !== 1) fail();
  if (input.service_tier !== undefined && input.service_tier !== 'default') fail('native_tier_unsupported');
  if (input.stream !== undefined && typeof input.stream !== 'boolean') fail();
  if (input.stream_options !== undefined) {
    const options = object(input.stream_options);
    keys(options, ['include_usage']);
    if (typeof options.include_usage !== 'boolean' || input.stream !== true) fail();
  }
  if (input.store !== undefined && input.store !== false) fail();
  const body: JsonObject = {
    model, messages: messages(input.messages), max_completion_tokens: outputLimit,
    n: 1, service_tier: 'default', stream: false, store: false,
  };
  if (input.tools !== undefined) body.tools = tools(input.tools);
  if (input.tool_choice !== undefined) {
    if (['none', 'auto', 'required'].includes(String(input.tool_choice))) {
      body.tool_choice = input.tool_choice;
    } else {
      const choice = object(input.tool_choice);
      keys(choice, ['type', 'function']);
      const fn = object(choice.function);
      keys(fn, ['name']);
      if (choice.type !== 'function') fail('native_tool_unsupported');
      body.tool_choice = { type: 'function', function: { name: name(fn.name) } };
    }
    if (!body.tools) fail();
  }
  if (input.parallel_tool_calls !== undefined) {
    if (typeof input.parallel_tool_calls !== 'boolean' || !body.tools) fail();
    body.parallel_tool_calls = input.parallel_tool_calls;
  }
  for (const [key, low, high] of [
    ['temperature', 0, 2], ['top_p', 0, 1], ['frequency_penalty', -2, 2], ['presence_penalty', -2, 2],
  ] as const) {
    const amount = input[key];
    if (amount === undefined) continue;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < low || amount > high) fail();
    body[key] = amount;
  }
  if (input.seed !== undefined) body.seed = integer(input.seed, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  if (input.stop !== undefined) body.stop = typeof input.stop === 'string' ? text(input.stop, 1000) :
    list(input.stop, 4).map((entry) => text(entry, 1000));
  for (const [key, allowed] of [
    ['reasoning_effort', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']],
    ['verbosity', ['low', 'medium', 'high']],
  ] as const) {
    if (input[key] === undefined) continue;
    if (!(allowed as readonly unknown[]).includes(input[key])) fail();
    body[key] = input[key];
  }
  if (input.user !== undefined) body.user = text(input.user, 256);
  return { body, model, outputLimit };
}

function amount(value: unknown, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value === 0)) {
    fail('native_accounting_invalid', 503);
  }
  return value;
}

function responseUsage(value: unknown, model: string): { response: JsonObject; usage: Usage } {
  const response = object(value);
  if (response.model !== model) fail('native_model_unverified', 502);
  if (response.service_tier !== 'default') fail('native_tier_unverified', 502);
  const usage = object(response.usage);
  keys(usage, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details']);
  const inputTokens = integer(usage.prompt_tokens, 0, Number.MAX_SAFE_INTEGER);
  // Retain known billable usage even when the provider violates the requested output ceiling.
  const outputTokens = integer(usage.completion_tokens, 0, Number.MAX_SAFE_INTEGER);
  if (integer(usage.total_tokens, 1, Number.MAX_SAFE_INTEGER) !== inputTokens + outputTokens) fail();
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  if (usage.prompt_tokens_details !== undefined && usage.prompt_tokens_details !== null) {
    const details = object(usage.prompt_tokens_details);
    keys(details, ['cached_tokens', 'cache_write_tokens', 'audio_tokens', 'image_tokens', 'text_tokens']);
    cachedInputTokens = integer(details.cached_tokens ?? 0, 0, inputTokens);
    cacheWriteTokens = integer(details.cache_write_tokens ?? 0, 0, inputTokens - cachedInputTokens);
    if (details.text_tokens !== undefined) integer(details.text_tokens, 0, inputTokens);
    if ((details.audio_tokens ?? 0) !== 0 || (details.image_tokens ?? 0) !== 0) fail();
  }
  if (usage.completion_tokens_details !== undefined && usage.completion_tokens_details !== null) {
    const details = object(usage.completion_tokens_details);
    keys(details, ['reasoning_tokens', 'text_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']);
    integer(details.reasoning_tokens ?? 0, 0, outputTokens);
    if (details.text_tokens !== undefined) integer(details.text_tokens, 0, outputTokens);
    for (const key of ['audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']) {
      if ((details[key] ?? 0) !== 0) fail();
    }
  }
  return { response, usage: { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens } };
}

function validateCompletionResponse(response: JsonObject): void {
  try {
    if (response.object !== 'chat.completion' || !text(response.id, 300)) fail();
    integer(response.created, 0, Number.MAX_SAFE_INTEGER);
    const choices = list(response.choices, 1);
    const choice = object(choices[0]);
    if (choice.index !== 0 || !['stop', 'length', 'tool_calls', 'content_filter'].includes(String(choice.finish_reason))) fail();
    const message = object(choice.message);
    keys(message, ['role', 'content', 'refusal', 'tool_calls', 'annotations']);
    if (message.role !== 'assistant') fail();
    if (message.content !== null && message.content !== undefined) text(message.content);
    if (message.refusal !== null && message.refusal !== undefined) text(message.refusal);
    if (message.tool_calls !== undefined) calls(message.tool_calls);
    if (message.annotations !== undefined && (!Array.isArray(message.annotations) || message.annotations.length)) fail();
    if (message.content === undefined && message.refusal === undefined && message.tool_calls === undefined) fail();
  } catch {
    fail('native_provider_response_invalid', 502);
  }
}

function safeFailure(error: unknown, fallback: string): NativeBridgeError {
  if (error instanceof NativeBridgeError) return error;
  const message = error instanceof Error ? error.message : '';
  return new NativeBridgeError(SAFE_FAILURES.has(message) ? message : fallback, 503);
}

export function createNativeBridge(deps: NativeBridgeDependencies): { handle(body: unknown): Promise<JsonObject> } {
  return {
    async handle(input) {
      const provider = deps.provider ?? 'openai';
      if (!['openai', 'anthropic'].includes(provider)) fail('native_provider_unready', 503);
      const nativeMessages = deps.protocol === 'anthropic-messages';
      if (nativeMessages && provider !== 'anthropic') fail('native_provider_unready', 503);
      if (deps.protocol !== undefined && !['openai', 'anthropic-messages'].includes(deps.protocol)) {
        fail('native_provider_unready', 503);
      }
      const normalized = nativeMessages ? normalizeAnthropicMessages(input) : normalizeBody(input);
      const { body, model, outputLimit } = normalized;
      const imageInputTokens = 'imageInputTokens' in normalized && typeof normalized.imageInputTokens === 'number' ? normalized.imageInputTokens : 0;
      const upstreamBody = provider === 'anthropic' && !nativeMessages ? anthropicRequest(body) : body;
      const serialized = JSON.stringify(upstreamBody);
      if (new TextEncoder().encode(serialized).length > (nativeMessages ? 12_582_912 : MAX_BODY_BYTES)) fail('native_request_too_large', 413);
      try {
        if (await deps.modelAllowed(model) !== true) fail('native_model_unsupported');
      } catch (error) {
        throw safeFailure(error, 'native_provider_unready');
      }
      if (typeof deps.providerKey !== 'string' || !deps.providerKey.trim()) fail('native_provider_unready', 503);
      const now = deps.now();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('shared_budget_unready', 503);
      let budget;
      let pricing;
      let reserveUsd;
      let reservation;
      const metadata = { source: 'native', provider, model, task: 'native_chat', project: 'native' };
      try {
        budget = await deps.budgetReader({ now });
        if (budget.mode !== 'shared' || typeof budget.timeZone !== 'string' || !budget.timeZone) {
          fail('shared_budget_unready', 503);
        }
        new Intl.DateTimeFormat('en-US', { timeZone: budget.timeZone });
        const policy = budget.policy;
        if (amount(policy.targetUsd) > amount(policy.economyUsd) ||
            amount(policy.economyUsd) > amount(policy.hardUsd, true) ||
            amount(budget.directCapUsd) > policy.hardUsd) fail('shared_budget_unready', 503);
        pricing = await deps.pricingLoader();
        reserveUsd = amount(deps.estimateCost({
          provider, model, prompt: nativeMessages ? anthropicReservationPrompt(body) : serialized, system: '', maxOutputTokens: outputLimit, pricing, imageInputTokens,
        }), true);
        const reservationId = deps.randomId();
        if (typeof reservationId !== 'string' || !reservationId || reservationId.length > 200) fail('native_accounting_invalid', 503);
        reservation = await deps.ledger.reserve({
          reservationId, reserveUsd, directCapUsd: budget.directCapUsd, now, timeZone: budget.timeZone, metadata,
        });
        if (reservation.reservationId !== reservationId || reservation.reservedUsd !== reserveUsd) fail('native_accounting_invalid', 503);
      } catch (error) {
        throw safeFailure(error, 'shared_budget_unready');
      }

      let response;
      let failure: NativeBridgeError | undefined;
      let definitiveRejection = false;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The deadline covers headers AND the body. Promise.race also bounds a broken injected transport.
        response = await Promise.race([
          (async () => {
            const upstream = await deps.fetchImpl(provider === 'anthropic'
              ? 'https://api.anthropic.com/v1/messages' : UPSTREAM_URL, {
              method: 'POST', headers: provider === 'anthropic'
                ? { 'x-api-key': deps.providerKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
                : { Authorization: `Bearer ${deps.providerKey}`, 'Content-Type': 'application/json' },
              body: serialized, redirect: 'error', signal: controller.signal,
            });
            if (upstream.status < 200 || upstream.status >= 300) {
              definitiveRejection = upstream.status >= 400 && upstream.status < 500 && upstream.status !== 408;
              fail('native_provider_rejected', 502);
            }
            const raw = await upstream.json();
            return provider === 'anthropic' ? anthropicUsage(raw, model) : responseUsage(raw, model);
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new NativeBridgeError('native_provider_timeout', 504));
            }, provider === 'anthropic' ? 120_000 : PROVIDER_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        failure = error instanceof NativeBridgeError && error.code.startsWith('native_') ? error :
          new NativeBridgeError('native_provider_response_invalid', 502);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (failure || !response) {
        try {
          if (definitiveRejection) {
            await deps.ledger.release({ reservationId: reservation.reservationId, reason: 'native_provider_rejected' });
          } else {
            await deps.ledger.settle({
              reservationId: reservation.reservationId, actualUsd: reserveUsd,
              usage: { ...metadata, estimated: true, error: failure?.code ?? 'native_provider_response_invalid' },
            });
          }
        } catch (error) {
          throw safeFailure(error, 'native_settlement_failed');
        }
        throw failure ?? new NativeBridgeError('native_provider_response_invalid', 502);
      }
      try {
        const unbilledRefusal = provider === 'anthropic' && 'billable' in response && response.billable === false;
        const cost = unbilledRefusal ? { totalUsd: 0, pricingVerifiedOn: null }
          : deps.calculateCost(provider, model, response.usage, pricing);
        const actualUsd = amount(cost.totalUsd);
        await deps.ledger.settle({
          reservationId: reservation.reservationId, actualUsd,
          usage: { ...metadata, ...response.usage, serviceTier: provider === 'anthropic' ? 'standard' : 'default', estimated: false,
            ...(unbilledRefusal ? { unbilledRefusal: true, billingRuleVerifiedOn: '2026-09-28' } : {}),
            pricingVerifiedOn: cost.pricingVerifiedOn ?? null },
        });
        if (actualUsd > reserveUsd + 1e-9) fail('reservation_underestimated', 503);
        // Valid billable usage survives malformed presentation/protocol fields.
        if (response.usage.outputTokens > outputLimit) fail('native_output_limit_exceeded', 502);
        if (nativeMessages) return validateAnthropicMessage(response.response, upstreamBody);
        const completion = provider === 'anthropic'
          ? anthropicCompletion(response.response, response.usage, now) : response.response;
        validateCompletionResponse(completion);
        return completion;
      } catch (error) {
        // A provider response exists: never release on pricing/database/internal failures.
        throw safeFailure(error, 'native_settlement_failed');
      }
    },
  };
}
