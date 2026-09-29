import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createNativeBridge, NativeBridgeError } from './generated/native.js';
import { createAnthropicHttp } from './generated/anthropicHttp.js';
import { normalizeAnthropicMessages, anthropicReservationPrompt } from './generated/anthropicMessages.js';
import { createMemoryUsageLedger } from './usage-ledger.js';
import { maximumTextRequestCost, calculateUsageCost } from './cost.js';

const model = 'claude-sonnet-5-5';
const now = new Date('2026-09-28T12:00:00Z');
const tool = { name: 'browser_list_tabs', input_schema: { type: 'object', properties: {} } };
const request = (extra = {}) => ({ model, max_tokens: 128,
  messages: [{ role: 'user', content: 'Synthetic task.' }], tools: [tool], ...extra });
const answer = (extra = {}) => ({ type: 'message', id: 'msg_fixture', role: 'assistant', model,
  content: [{ type: 'thinking', thinking: '', signature: 'synthetic-signed-block' },
    { type: 'tool_use', id: 'toolu_fixture', name: tool.name, input: {} }],
  stop_reason: 'tool_use', stop_sequence: null,
  usage: { input_tokens: 20, output_tokens: 10, service_tier: 'standard' }, ...extra });
async function fixture(raw = answer(), overrides = {}) {
  const ledger = createMemoryUsageLedger();
  const policy = { targetUsd: 100, economyUsd: 125, hardUsd: 175 };
  await ledger.activateSharedBudget({ policy, timeZone: 'America/Denver', cutoverAt: now, history: [] });
  const events = [];
  const bridge = createNativeBridge({ provider: 'anthropic', protocol: 'anthropic-messages',
    providerKey: 'synthetic-provider-key', modelAllowed: (candidate) => candidate === model,
    now: () => now, randomId: randomUUID,
    budgetReader: () => ({ mode: 'shared', policy, timeZone: 'America/Denver', directCapUsd: 175 }),
    pricingLoader: () => ({ verifiedOn: '2026-09-28', models: { [model]: { provider: 'anthropic', input: 2, output: 10 } } }),
    estimateCost: maximumTextRequestCost, calculateCost: calculateUsageCost,
    ledger: { ...ledger, reserve: async (input) => { events.push('reserve'); return ledger.reserve(input); },
      settle: async (input) => { events.push({ type: 'settle', input }); return ledger.settle(input); } },
    fetchImpl: async (_url, init) => { events.push({ type: 'fetch', init }); return { status: 200, json: async () => raw }; },
    ...overrides,
  });
  return { bridge, events, ledger };
}

test('native tool turn preserves signed blocks and settles before returning a callable result', async () => {
  const f = await fixture();
  const result = await f.bridge.handle(request());
  assert.deepEqual(result.content, answer().content);
  assert.deepEqual(f.events.map((event) => typeof event === 'string' ? event : event.type), ['reserve', 'fetch', 'settle']);
  const body = JSON.parse(f.events[1].init.body);
  assert.equal(body.stream, false); assert.equal(body.service_tier, 'standard_only');
  assert.deepEqual(body.tools, [tool]); assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(f.events[1].init.redirect, 'error');
  assert.equal(f.events[2].input.usage.estimated, false);
  assert(Math.abs(f.events[2].input.actualUsd - .00014) < 1e-12);
});
test('native continuation retains signature and paired result, including an empty result', async () => {
  const body = request({ messages: [{ role: 'user', content: 'First.' },
    { role: 'assistant', content: answer().content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture', content: '' }] }] });
  const normalized = normalizeAnthropicMessages(body);
  body.messages[1].content[0].signature = 'changed-after-normalization';
  assert.equal(normalized.body.messages[1].content[0].signature, 'synthetic-signed-block');
  assert.equal(normalized.body.messages[2].content[0].content, '');
});
test('paid server tools, fallback settings, cache variants and orphan results fail before reservation', async () => {
  for (const extra of [{ fallbacks: 'default' }, { model: 'claude-opus-5-5' }, { service_tier: 'auto' },
    { thinking: { type: 'adaptive' } }, { output_config: { effort: 'high' } },
    { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
    { tools: [{ ...tool, cache_control: { type: 'ephemeral', ttl: '24h' } }] },
    { tool_choice: { type: 'any' } }, { max_tokens: null },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'x' }] }] }]) {
    const f = await fixture();
    await assert.rejects(f.bridge.handle(request(extra)), /native_/);
    assert.deepEqual(f.events, []);
  }
});
test('malformed tool output retains known billing and ambiguous usage retains the estimate', async () => {
  for (const raw of [answer({ content: [{ type: 'tool_use', id: 'id', name: 'unregistered_tool', input: {} }] }),
    answer({ usage: { input_tokens: 20, output_tokens: 10, service_tier: 'priority' } })]) {
    const f = await fixture(raw);
    await assert.rejects(f.bridge.handle(request()), /native_/);
    assert.equal(f.events.filter((event) => event?.type === 'fetch').length, 1);
    const settled = f.events[f.events.length - 1].input;
    assert.equal(settled.usage.estimated, raw.usage.service_tier === 'priority');
    assert(settled.actualUsd > 0);
  }
});
test('buffered Messages SSE reconstructs signature and tool arguments only after settlement', async () => {
  const f = await fixture(); let output = '';
  const http = createAnthropicHttp({ enabled: () => true, token: 'x'.repeat(32), safeEqual: (a, b) => a === b, bridge: f.bridge });
  const res = { setHeader() {}, write(value) {
    assert.equal(f.events[f.events.length - 1].type, 'settle'); output += value;
  }, end() {}, status() { return this; }, json() { assert.fail('SSE expected'); } };
  await http.complete({ body: request({ stream: true }), get() { return undefined; } }, res);
  const frames = output.trim().split('\n\n').map((value) => JSON.parse(value.split('\ndata: ')[1]));
  assert.equal(frames[0].type, 'message_start');
  assert.equal(frames.find((frame) => frame.delta?.type === 'signature_delta').delta.signature, 'synthetic-signed-block');
  assert.deepEqual(JSON.parse(frames.find((frame) => frame.delta?.type === 'input_json_delta').delta.partial_json), {});
  assert.equal(frames[frames.length - 2].delta.stop_reason, 'tool_use');
  assert.equal(frames[frames.length - 2].usage.output_tokens, 10);
  assert.equal(frames[frames.length - 1].type, 'message_stop');
});
test('native token, disabled gate and query checks deny without calling a provider', () => {
  let called = 0;
  for (const [enabled, token, query, status] of [[false, 'x'.repeat(32), {}, 404],
    [true, 'wrong', {}, 401], [true, 'x'.repeat(32), { fallback: 'true' }, 400]]) {
    const http = createAnthropicHttp({ enabled: () => enabled, token: 'x'.repeat(32), safeEqual: (a, b) => a === b,
      bridge: { handle() { called++; } } });
    const res = { status(code) { assert.equal(code, status); return this; }, json() {} };
    http.authorize({ get: () => token, query }, res, () => { called++; });
  }
  assert.equal(called, 0);
});

test('provider HTTP failures expose only status, never retry, and preserve conservative accounting', async () => {
  for (const status of [401, 429, 408, 500, 529]) {
    let calls = 0;
    const f = await fixture(undefined, { fetchImpl: async () => {
      calls++; return { status, json: async () => { assert.fail('Provider error body must not be read'); } };
    } });
    let observed;
    await assert.rejects(f.bridge.handle(request()), error => {
      observed = error; return error.code === 'native_provider_rejected' && error.providerHttpStatus === status;
    });
    assert.equal(calls, 1);
    const summary = await f.ledger.summary({ now, timeZone: 'America/Denver' });
    assert.equal(summary.reservedUsd, 0);
    const uncertain = status === 408 || status >= 500;
    assert.equal(summary.settledUsd > 0, uncertain);
    if (uncertain) {
      const settled = f.events.find(event => event.type === 'settle').input;
      assert.equal(settled.usage.estimated, true);
      assert.equal(settled.usage.providerHttpStatus, status);
    }
    const http = createAnthropicHttp({ enabled: () => true, token: 'x'.repeat(32), safeEqual: (a,b) => a === b,
      bridge: { handle() { throw observed; } } });
    const res = { status(code) { assert.equal(code, 502); return this; }, json(body) {
      assert.deepEqual(body, { type: 'error', error: { type: 'mission_budget_error',
        message: 'native_provider_rejected', provider_http_status: status } });
    } };
    await http.complete({ body: request(), get() {} }, res);
    assert.equal(calls, 1);
  }
});

test('invalid provider status cannot enter the public error or accounting metadata', () => {
  for (const value of [undefined, 0, 600, NaN, '500', 'secret', 500.5]) {
    assert.equal(new NativeBridgeError('native_provider_rejected', 502, value).providerHttpStatus, undefined);
  }
});

const image = { type: 'image', source: { type: 'base64', media_type: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' } };
test('user images and screenshot tool results retain typed bytes with visual-token reservations', async () => {
  for (const messages of [
    [{ role: 'user', content: [image, { type: 'text', text: 'Describe.' }] }],
    [{ role: 'user', content: 'First.' }, { role: 'assistant', content: answer().content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture', content: [image] }] }],
  ]) {
    const input = request({ messages });
    assert.equal(normalizeAnthropicMessages(input).imageInputTokens, 4784);
    let reservedInput;
    const f = await fixture(answer(), { estimateCost: (value) => { reservedInput = value; return maximumTextRequestCost(value); } });
    await f.bridge.handle(input);
    const fetchEvent = f.events.find((event) => event.type === 'fetch');
    assert.deepEqual(JSON.parse(fetchEvent.init.body).messages, messages);
    const expected = maximumTextRequestCost({ provider: 'anthropic', model,
      prompt: anthropicReservationPrompt(JSON.parse(fetchEvent.init.body)), maxOutputTokens: 128, imageInputTokens: 4784,
      pricing: { models: { [model]: { provider: 'anthropic', input: 2, output: 10 } } } });
    const summary = await f.ledger.summary({ now, timeZone: 'America/Denver' });
    assert(summary.settledUsd > 0);
    assert(expected > .009568);
    assert.equal(reservedInput.imageInputTokens, 4784);
    assert.equal(maximumTextRequestCost(reservedInput), expected);
  }
});
test('external image sources, invalid encoding, assistant images and excess images are rejected before billing', async () => {
  for (const content of [
    [{ ...image, source: { type: 'url', url: 'https://example.invalid/image' } }],
    [{ ...image, source: { ...image.source, data: 'not base64!' } }],
    Array.from({ length: 21 }, () => image),
  ]) {
    const f = await fixture();
    await assert.rejects(f.bridge.handle(request({ messages: [{ role: 'user', content }] })), /native_/);
    assert.deepEqual(f.events, []);
  }
  assert.throws(() => normalizeAnthropicMessages(request({ messages: [
    { role: 'user', content: 'First.' }, { role: 'assistant', content: [image] },
    { role: 'user', content: 'Next.' },
  ] })), /native_content_unsupported/);
});

test('multi-step screenshot history fits the bounded image transport without estimating base64 as text', () => {
  const screenshots = Array.from({ length: 5 }, () => ({ ...image, source: { ...image.source, data: 'A'.repeat(262144) } }));
  const value = normalizeAnthropicMessages(request({ messages: [{ role: 'user', content: screenshots }] }));
  assert.equal(value.imageInputTokens, 5 * 4784);
  assert(anthropicReservationPrompt(value.body).length < 2000);
  assert.throws(() => normalizeAnthropicMessages(request({ messages: [{ role: 'user', content: 'x'.repeat(1048576) }] })), /native_request_too_large/);
});

test('project attribution reaches settlement without entering the provider request', async () => {
  const id = '0123456789abcdef01234567';
  const f = await fixture();
  const http = createAnthropicHttp({ enabled: () => true, token: 'x'.repeat(32), safeEqual: (a,b) => a === b, bridge: f.bridge });
  await http.complete({ body: request(), get: () => id }, { json() {}, status() { return this; } });
  assert.equal(f.events.at(-1).input.usage.project, id);
  assert(!JSON.stringify(f.events.find(e => e.type === 'fetch').init).includes(id));
  for (const projectId of ['', '../other', null, 42]) {
    const rejected = await fixture();
    await assert.rejects(rejected.bridge.handle(request(), { projectId }), /native_project_invalid/);
    assert.deepEqual(rejected.events, []);
  }
});


test('documented direct caller survives tool response and paired continuation', async () => {
  const raw = answer(); raw.content[1].caller = { type: 'direct' };
  const f = await fixture(raw);
  const result = await f.bridge.handle(request());
  assert.deepEqual(result.content[1].caller, { type: 'direct' });
  const next = request({ messages: [{ role: 'user', content: 'First.' },
    { role: 'assistant', content: result.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture', content: 'Synthetic result.' }] }] });
  assert.deepEqual(normalizeAnthropicMessages(next).body.messages[1].content[1].caller, { type: 'direct' });
});
test('programmatic or malformed caller remains denied before dispatch on continuation', async () => {
  for (const caller of [{ type: 'code_execution_20260120', tool_id: 'srvtoolu_fixture' },
    { type: 'direct', tool_id: 'unexpected' }, null, 'direct']) {
    const raw = answer(); raw.content[1].caller = caller;
    const f = await fixture(raw);
    await assert.rejects(f.bridge.handle(request()), /native_provider_response_invalid/);
    assert.equal(f.events.at(-1).input.usage.estimated, false);
    const next = request({ messages: [{ role: 'user', content: 'First.' },
      { role: 'assistant', content: raw.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture', content: 'x' }] }] });
    assert.throws(() => normalizeAnthropicMessages(next), /native_/);
  }
});


test('temporary output ceiling is sent upstream and reserved at the same real limit', async () => {
  const policy = { targetUsd: 100, economyUsd: 125, hardUsd: 175 };
  for (const requested of [128, 4096]) {
    let estimate;
    const f = await fixture(answer(), { estimateCost: value => { estimate = value; return maximumTextRequestCost(value); }, budgetReader: () => ({ mode: 'shared', policy,
      timeZone: 'America/Denver', directCapUsd: 175, maxOutputTokens: 2048 }) });
    await f.bridge.handle(request({ max_tokens: requested }));
    const sent = JSON.parse(f.events.find(e => e.type === 'fetch').init.body);
    assert.equal(sent.max_tokens, Math.min(requested, 2048));
    assert.equal(estimate.maxOutputTokens, sent.max_tokens);
    assert.equal(JSON.parse(estimate.prompt).max_tokens, sent.max_tokens);
    const reserve = f.events.at(-1).input;
    assert.equal(reserve.usage.estimated, false);
    const expected = maximumTextRequestCost({ provider: 'anthropic', model,
      prompt: anthropicReservationPrompt(sent), maxOutputTokens: sent.max_tokens,
      pricing: { models: { [model]: { provider: 'anthropic', input: 2, output: 10 } } } });
    const summary = await f.ledger.summary({ now, timeZone: 'America/Denver' });
    assert(summary.settledUsd <= expected);
  }
});
test('ordinary output limit is unchanged and invalid acceptance limits fail before paid dispatch', async () => {
  const f = await fixture(); await f.bridge.handle(request({ max_tokens: 4096 }));
  assert.equal(JSON.parse(f.events.find(e => e.type === 'fetch').init.body).max_tokens, 4096);
  const policy = { targetUsd: 100, economyUsd: 125, hardUsd: 175 };
  for (const maxOutputTokens of [0, 32769, NaN, '2048']) {
    const denied = await fixture(answer(), { budgetReader: () => ({ mode: 'shared', policy,
      timeZone: 'America/Denver', directCapUsd: 175, maxOutputTokens }) });
    await assert.rejects(denied.bridge.handle(request()), /shared_budget_unready/);
    assert.deepEqual(denied.events, []);
  }
});
