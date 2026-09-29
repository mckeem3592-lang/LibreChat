import { NativeBridgeError } from './native.js';

type Json = Record<string, unknown>;
type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens: number;
  cacheWriteTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number };

function fail(code: string, status = 400): never { throw new NativeBridgeError(code, status); }
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('native_provider_response_invalid', 502);
  return value as Json;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('native_usage_unverified', 502);
  return value;
}
function sum(...values: number[]): number { return count(values.reduce((a, b) => a + b, 0)); }

/** Text-only compatibility adapter. Never silently discard tool history or thinking signatures. */
export function anthropicRequest(body: Json): Json {
  if (!['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].includes(String(body.model))) {
    fail('native_model_unsupported');
  }
  for (const key of ['tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p',
    'seed', 'verbosity', 'user']) {
    if (body[key] !== undefined) fail('native_field_unsupported');
  }
  for (const key of ['frequency_penalty', 'presence_penalty']) {
    if (body[key] !== undefined && body[key] !== 0) fail('native_field_unsupported');
  }
  if (body.reasoning_effort !== undefined &&
      (body.model === 'claude-haiku-4-5' || body.reasoning_effort !== 'low')) fail('native_field_unsupported');
  const system: Json[] = [];
  const messages: Json[] = [];
  for (const message of body.messages as Json[]) {
    if (message.name !== undefined || message.tool_calls !== undefined || message.role === 'tool') {
      fail('native_tool_unsupported');
    }
    const blocks = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }] : message.content as Json[];
    if (!blocks?.length || blocks.some((part) => typeof part.text !== 'string' || !part.text.length)) {
      fail('native_request_invalid');
    }
    if (message.role === 'system' || message.role === 'developer') {
      // Moving a later instruction to the top would change the conversation's meaning.
      if (messages.length) fail('native_content_unsupported');
      system.push(...blocks);
    } else {
      const previous = messages[messages.length - 1];
      if (previous && previous.role === message.role) (previous.content as Json[]).push(...blocks);
      else messages.push({ role: message.role, content: [...blocks] });
    }
  }
  if (!messages.length || messages[0].role !== 'user' || messages[messages.length - 1]?.role !== 'user') {
    fail('native_request_invalid');
  }
  return {
    model: body.model, messages, ...(system.length ? { system } : {}),
    max_tokens: body.max_completion_tokens, stream: false, service_tier: 'standard_only',
    ...(body.model === 'claude-sonnet-5-5'
      ? { thinking: { type: 'between_tools' }, output_config: { effort: 'low' } }
      : body.model === 'claude-opus-5-5'
        ? { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }
        : {}),
    ...(body.stop !== undefined ? { stop_sequences: typeof body.stop === 'string' ? [body.stop] : body.stop } : {}),
  };
}

/** Verify billable fields independently of presentation, so malformed text cannot hide a known charge. */
export function anthropicUsage(value: unknown, model: string): { response: Json; usage: Usage; billable: boolean } {
  const response = object(value);
  // Haiku's documented alias resolves to this fixed snapshot; do not accept arbitrary dated IDs.
  if (response.model !== model &&
      !(model === 'claude-haiku-4-5' && response.model === 'claude-haiku-4-5-20251001')) {
    fail('native_model_unverified', 502);
  }
  const raw = object(response.usage);
  const allowed = new Set(['input_tokens', 'output_tokens', 'cache_read_input_tokens',
    'cache_creation_input_tokens', 'cache_creation', 'service_tier', 'server_tool_use',
    'inference_geo', 'output_tokens_details']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) fail('native_usage_unverified', 502);
  if (raw.service_tier !== 'standard') fail('native_tier_unverified', 502);
  const inputTokens = count(raw.input_tokens);
  const outputTokens = count(raw.output_tokens);
  const cachedInputTokens = count(raw.cache_read_input_tokens ?? 0);
  const cacheWriteTokens = count(raw.cache_creation_input_tokens ?? 0);
  let cacheWrite5mTokens = 0;
  let cacheWrite1hTokens = 0;
  if (raw.cache_creation != null) {
    const detail = object(raw.cache_creation);
    if (Object.keys(detail).some((key) => !['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'].includes(key))) {
      fail('native_usage_unverified', 502);
    }
    cacheWrite5mTokens = count(detail.ephemeral_5m_input_tokens);
    cacheWrite1hTokens = count(detail.ephemeral_1h_input_tokens);
  }
  if (sum(cacheWrite5mTokens, cacheWrite1hTokens) !== cacheWriteTokens) fail('native_usage_unverified', 502);
  sum(inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens);
  if (raw.server_tool_use != null) {
    const detail = object(raw.server_tool_use);
    if (Object.entries(detail).some(([key, value]) =>
      !['web_search_requests', 'web_fetch_requests'].includes(key) || value !== 0)) fail('native_usage_unverified', 502);
  }
  if (raw.output_tokens_details != null) {
    const detail = object(raw.output_tokens_details);
    if (Object.keys(detail).some((key) => key !== 'thinking_tokens') ||
        count(detail.thinking_tokens) > outputTokens) fail('native_usage_unverified', 502);
  }
  let billable = true;
  if (response.stop_reason === 'refusal' && outputTokens === 0) {
    // September 2026 provider policy: unknown categories retain an estimate.
    if (!Array.isArray(response.content) || response.content.length) fail('native_usage_unverified', 502);
    const details = object(response.stop_details);
    if (details.type !== 'refusal' || Object.keys(details).some((key) =>
      !['type', 'category', 'explanation', 'recommended_model'].includes(key)) ||
      details.recommended_model != null) fail('native_usage_unverified', 502);
    if (details.category === null || ['cyber', 'general_harms'].includes(String(details.category))) billable = false;
    else if (!['bio', 'frontier_llm', 'reasoning_extraction'].includes(String(details.category))) {
      fail('native_usage_unverified', 502);
    }
  }
  return { response, billable, usage: { inputTokens, outputTokens, cachedInputTokens,
    cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens } };
}

export function anthropicCompletion(raw: Json, usage: Pick<Usage,
  'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheWriteTokens'>, now: Date): Json {
  if (raw.type !== 'message' || raw.role !== 'assistant' || typeof raw.id !== 'string' ||
      !raw.id || raw.id.length > 300 || !Array.isArray(raw.content) ||
      (!raw.content.length && raw.stop_reason !== 'refusal')) {
    fail('native_provider_response_invalid', 502);
  }
  let content = '';
  const refused = raw.stop_reason === 'refusal';
  for (const part of raw.content) {
    if (refused) continue; // Never expose incomplete output from a refusal.
    const block = object(part);
    if (block.type === 'text' && typeof block.text === 'string' &&
        (block.citations == null || (Array.isArray(block.citations) && !block.citations.length))) {
      content += block.text;
    } else if (['thinking', 'redacted_thinking'].includes(String(block.type))) {
      // No tool calls are supported by this adapter; don't expose hidden reasoning to the client.
      continue;
    } else fail('native_provider_response_invalid', 502);
  }
  if ((!content && !refused) || !['end_turn', 'stop_sequence', 'max_tokens', 'refusal'].includes(String(raw.stop_reason))) {
    fail('native_provider_response_invalid', 502);
  }
  const promptTokens = sum(usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteTokens);
  return {
    id: raw.id, object: 'chat.completion', created: Math.floor(now.getTime() / 1000),
    model: raw.model, service_tier: 'default',
    choices: [{ index: 0, message: { role: 'assistant', content: refused ? null : content,
      refusal: refused ? 'Request declined by the provider.' : null },
      finish_reason: refused ? 'content_filter' : raw.stop_reason === 'max_tokens' ? 'length' : 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: usage.outputTokens,
      total_tokens: sum(promptTokens, usage.outputTokens),
      prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } },
  };
}
