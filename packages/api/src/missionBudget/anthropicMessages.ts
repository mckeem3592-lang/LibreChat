import { NativeBridgeError } from './native.js';

type Json = Record<string, unknown>;
const MAX_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 12_582_912;
const MAX_IMAGE_BYTES = 4_194_304;
function fail(code = 'native_request_invalid', status = 400): never {
  throw new NativeBridgeError(code, status);
}
function record(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  return value as Json;
}
function keys(value: Json, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('native_field_unsupported');
}
function text(value: unknown, maximum = MAX_BYTES, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || value.length > maximum) fail();
  return value;
}
function identifier(value: unknown): string {
  const name = text(value, 200);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) fail('native_tool_unsupported');
  return name;
}
/** Client tools may be called directly only; never admit provider-side execution. */
function directCaller(value: unknown): void {
  if (value === undefined) return;
  const caller = record(value);
  keys(caller, ['type']);
  if (caller.type !== 'direct') fail('native_tool_unsupported');
}
function json(value: unknown, depth = 0): void {
  if (depth > 32) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach((part) => json(part, depth + 1)); return; }
  Object.values(record(value)).forEach((part) => json(part, depth + 1));
}
function cache(value: unknown): void {
  if (value === undefined) return;
  const control = record(value);
  keys(control, ['type', 'ttl']);
  if (control.type !== 'ephemeral' ||
      (control.ttl !== undefined && !['5m', '1h'].includes(String(control.ttl)))) fail();
}
function imageBlock(block: Json): void {
  keys(block, ['type', 'source', 'cache_control']);
  const source = record(block.source);
  keys(source, ['type', 'media_type', 'data']);
  if (source.type !== 'base64' ||
      !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(source.media_type))) fail('native_content_unsupported');
  const data = text(source.data, MAX_IMAGE_BYTES);
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail();
  cache(block.cache_control);
}
function textBlocks(value: unknown, allowEmpty = false, allowImages = false): void {
  if (typeof value === 'string') { text(value, MAX_BYTES, allowEmpty); return; }
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 256) fail();
  for (const part of value) {
    const block = record(part);
    if (block.type === 'image' && allowImages) { imageBlock(block); continue; }
    keys(block, ['type', 'text', 'cache_control']);
    if (block.type !== 'text') fail('native_content_unsupported');
    text(block.text, MAX_BYTES, allowEmpty); cache(block.cache_control);
  }
}

/** Native blocks retain signatures and tool IDs. Provider-hosted paid tools are forbidden. */
export function normalizeAnthropicMessages(value: unknown): {
  body: Json; model: string; outputLimit: number; imageInputTokens: number;
} {
  json(value);
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).length > MAX_REQUEST_BYTES) fail('native_request_too_large', 413);
  // Snapshot before the ledger's first await; callers cannot alter the approved request.
  const body = record(JSON.parse(serialized));
  keys(body, ['model', 'messages', 'system', 'max_tokens', 'stream', 'service_tier',
    'thinking', 'output_config', 'tools', 'tool_choice', 'stop_sequences']);
  if (body.model !== 'claude-sonnet-5-5') fail('native_model_unsupported');
  const outputLimit = body.max_tokens;
  if (typeof outputLimit !== 'number' || !Number.isSafeInteger(outputLimit) ||
      outputLimit < 1 || outputLimit > 32768) fail();
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail();
  if (body.service_tier !== undefined && body.service_tier !== 'standard_only') fail('native_tier_unsupported');
  if (body.thinking !== undefined) {
    const thinking = record(body.thinking); keys(thinking, ['type']);
    if (thinking.type !== 'between_tools') fail('native_field_unsupported');
  }
  if (body.output_config !== undefined) {
    const output = record(body.output_config); keys(output, ['effort']);
    if (output.effort !== 'low') fail('native_field_unsupported');
  }
  if (body.system !== undefined) textBlocks(body.system);
  if (body.stop_sequences !== undefined) {
    if (!Array.isArray(body.stop_sequences) || body.stop_sequences.length > 4) fail();
    body.stop_sequences.forEach((stop) => text(stop, 1000));
  }
  const toolNames = new Set<string>();
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || !body.tools.length || body.tools.length > 128) fail();
    for (const value of body.tools) {
      const tool = record(value);
      keys(tool, ['name', 'description', 'input_schema', 'cache_control']);
      const name = identifier(tool.name);
      if (toolNames.has(name)) fail('native_tool_unsupported');
      toolNames.add(name);
      if (tool.description !== undefined) text(tool.description);
      const schema = record(tool.input_schema);
      if (schema.type !== 'object') fail('native_tool_unsupported');
      cache(tool.cache_control);
    }
  }
  if (body.tool_choice !== undefined) {
    const choice = record(body.tool_choice);
    keys(choice, ['type', 'name', 'disable_parallel_tool_use']);
    if (!toolNames.size || !['auto', 'none'].includes(String(choice.type)) || choice.name !== undefined ||
        (choice.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== 'boolean')) {
      fail('native_tool_unsupported');
    }
  }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256) fail();
  let imageCount = 0;
  const seen = new Set<string>();
  let pending = new Set<string>();
  for (const value of body.messages) {
    const message = record(value); keys(message, ['role', 'content']);
    if (!['user', 'assistant'].includes(String(message.role))) fail();
    if (typeof message.content === 'string') {
      if (pending.size) fail('native_tool_unsupported');
      text(message.content); continue;
    }
    if (!Array.isArray(message.content) || !message.content.length || message.content.length > 256) fail();
    const nextPending = new Set<string>();
    for (const value of message.content) {
      const block = record(value);
      if (block.type === 'text') {
        keys(block, ['type', 'text', 'cache_control']); text(block.text); cache(block.cache_control);
      } else if (block.type === 'image' && message.role === 'user') {
        imageBlock(block); imageCount++;
      } else if (block.type === 'thinking' && message.role === 'assistant') {
        keys(block, ['type', 'thinking', 'signature']); text(block.thinking, MAX_BYTES, true); text(block.signature);
      } else if (block.type === 'redacted_thinking' && message.role === 'assistant') {
        keys(block, ['type', 'data']); text(block.data);
      } else if (block.type === 'tool_use' && message.role === 'assistant') {
        keys(block, ['type', 'id', 'name', 'input', 'caller']);
        directCaller(block.caller);
        const id = identifier(block.id); identifier(block.name); record(block.input);
        if (seen.has(id)) fail('native_tool_unsupported');
        seen.add(id); nextPending.add(id);
      } else if (block.type === 'tool_result' && message.role === 'user') {
        keys(block, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control']);
        const id = identifier(block.tool_use_id);
        if (!pending.delete(id)) fail('native_tool_unsupported');
        if (block.is_error !== undefined && typeof block.is_error !== 'boolean') fail();
        textBlocks(block.content, true, true); cache(block.cache_control);
        if (Array.isArray(block.content)) imageCount += block.content.filter((part) => record(part).type === 'image').length;
      } else fail('native_content_unsupported');
    }
    if (pending.size) fail('native_tool_unsupported');
    pending = nextPending;
  }
  if (pending.size || record(body.messages[0]).role !== 'user' ||
      record(body.messages[body.messages.length - 1]).role !== 'user') fail('native_request_invalid');
  body.stream = false;
  body.service_tier = 'standard_only';
  body.thinking = { type: 'between_tools' };
  body.output_config = { effort: 'low' };
  // Reserve the documented Sonnet 5.5 maximum visual tokens even for tiny compressed images.
  if (imageCount > 20 || new TextEncoder().encode(anthropicReservationPrompt(body)).length > MAX_BYTES) fail('native_request_too_large', 413);
  return { body, model: 'claude-sonnet-5-5', outputLimit, imageInputTokens: imageCount * 4784 };
}

/** Only validated image bytes are excluded from text-token estimation; visual tokens are reserved separately. */
export function anthropicReservationPrompt(body: Json): string {
  const snapshot = JSON.parse(JSON.stringify(body)) as Json;
  for (const message of snapshot.messages as Json[]) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Json[]) {
      if (block.type === 'image') (block.source as Json).data = '';
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const part of block.content as Json[]) if (part.type === 'image') (part.source as Json).data = '';
      }
    }
  }
  return JSON.stringify(snapshot);
}

/** Check presentation only after known provider billing has been settled. */
export function validateAnthropicMessage(response: Json, request: Json): Json {
  try {
    if (new TextEncoder().encode(JSON.stringify(response)).length > MAX_BYTES) fail();
    if (response.type !== 'message' || response.role !== 'assistant' || !text(response.id, 300) ||
        !Array.isArray(response.content) || response.content.length > 256 ||
        !['end_turn', 'stop_sequence', 'max_tokens', 'tool_use', 'refusal'].includes(String(response.stop_reason))) fail();
    if (response.stop_reason === 'refusal') return { ...response, content: [] };
    const names = new Set((request.tools as Json[] | undefined)?.map((tool) => tool.name));
    const ids = new Set<string>();
    let hasCall = false;
    if (!response.content.length) fail();
    for (const value of response.content) {
      const block = record(value);
      if (block.type === 'text') {
        keys(block, ['type', 'text', 'citations']); text(block.text);
        if (block.citations != null && (!Array.isArray(block.citations) || block.citations.length)) fail();
      } else if (block.type === 'thinking') {
        keys(block, ['type', 'thinking', 'signature']); text(block.thinking, MAX_BYTES, true); text(block.signature);
      } else if (block.type === 'redacted_thinking') {
        keys(block, ['type', 'data']); text(block.data);
      } else if (block.type === 'tool_use') {
        keys(block, ['type', 'id', 'name', 'input', 'caller']);
        directCaller(block.caller);
        const id = identifier(block.id);
        if (ids.has(id) || !names.has(block.name)) fail();
        ids.add(id); record(block.input); json(block.input); hasCall = true;
      } else fail();
    }
    if ((response.stop_reason === 'tool_use') !== hasCall) fail();
    return response;
  } catch { fail('native_provider_response_invalid', 502); }
}
