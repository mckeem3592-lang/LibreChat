import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createNativeBridge } from './generated/native.js';
import { createNativeHttp } from './generated/http.js';
import { createMemoryUsageLedger } from './usage-ledger.js';
import { calculateUsageCost, maximumTextRequestCost } from './cost.js';

const MODEL = 'claude-sonnet-5-5';
const NOW = new Date('2026-09-28T12:00:00Z');
const pricing = { verifiedOn: '2026-09-28', models: {
  [MODEL]: { provider: 'anthropic', input: 2, output: 10, cachedInput: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
} };
const request = (extra = {}) => ({ model: MODEL, max_tokens: 128,
  messages: [{ role: 'user', content: 'Synthetic input.' }], ...extra });
const response = (extra = {}) => ({ id: 'msg_synthetic', type: 'message', role: 'assistant', model: MODEL,
  content: [{ type: 'text', text: 'Synthetic answer.' }], stop_reason: 'end_turn',
  usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 4,
    cache_creation_input_tokens: 8, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 3 },
    service_tier: 'standard', server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    output_tokens_details: { thinking_tokens: 2 }, inference_geo: 'global' }, ...extra });

async function fixture(overrides = {}) {
  const events = [];
  const realLedger = createMemoryUsageLedger();
  const policy = { targetUsd: 100, economyUsd: 125, hardUsd: 175 };
  await realLedger.activateSharedBudget({ policy, timeZone: 'America/Denver', cutoverAt: NOW, history: [] });
  const deps = { provider: 'anthropic', providerKey: 'synthetic-key', modelAllowed: (model) => model === MODEL,
    pricingLoader: () => pricing, estimateCost: maximumTextRequestCost, calculateCost: calculateUsageCost,
    now: () => NOW, randomId: randomUUID,
    budgetReader: () => ({ mode: 'shared', policy, timeZone: 'America/Denver', directCapUsd: 175 }),
    ledger: {
      reserve: async (input) => { events.push({ type: 'reserve', input }); return realLedger.reserve(input); },
      settle: async (input) => { events.push({ type: 'settle', input }); return realLedger.settle(input); },
      release: async (input) => { events.push({ type: 'release', input }); return realLedger.release(input); },
    },
    fetchImpl: async (url, init) => { events.push({ type: 'fetch', url, init }); return { status: 200, json: async () => response() }; },
    ...overrides,
  };
  return { deps, events, realLedger, bridge: createNativeBridge(deps) };
}

test('documented unbilled refusals settle zero, retain token telemetry and do not retry', async () => {
  for (const category of ['cyber', 'general_harms', null]) {
    let attempts = 0;
    const raw = response({ content: [], stop_reason: 'refusal',
      stop_details: { type: 'refusal', category, explanation: null },
      usage: { input_tokens: 20, output_tokens: 0, service_tier: 'standard' } });
    const f = await fixture({ fetchImpl: async () => { attempts++; return { status: 200, json: async () => raw }; } });
    const result = await f.bridge.handle(request());
    const settled = f.events.at(-1).input;
    assert.equal(attempts, 1); assert.equal(settled.actualUsd, 0);
    assert.equal(settled.usage.inputTokens, 20); assert.equal(settled.usage.unbilledRefusal, true);
    assert.equal(result.choices[0].message.content, null);
    assert.equal(result.choices[0].finish_reason, 'content_filter');
  }
});
test('billed and partial-output refusals settle known cost and discard incomplete content', async () => {
  for (const category of ['bio', 'frontier_llm', 'reasoning_extraction']) {
    const raw = response({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category },
      usage: { input_tokens: 20, output_tokens: 0, service_tier: 'standard' } });
    const f = await fixture({ fetchImpl: async () => ({ status: 200, json: async () => raw }) });
    const result = await f.bridge.handle(request());
    assert.equal(f.events.at(-1).input.actualUsd, .00004);
    assert.equal(result.choices[0].message.content, null);
  }
  const raw = response({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } });
  const f = await fixture({ fetchImpl: async () => ({ status: 200, json: async () => raw }) });
  const result = await f.bridge.handle(request());
  assert.equal(f.events.at(-1).input.usage.estimated, false);
  assert(f.events.at(-1).input.actualUsd > 0); assert.equal(result.choices[0].message.content, null);
});
test('unknown pre-output refusal billing retains the conservative estimate', async () => {
  const raw = response({ content: [], stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'future_unknown_category' },
    usage: { input_tokens: 20, output_tokens: 0, service_tier: 'standard' } });
  const f = await fixture({ fetchImpl: async () => ({ status: 200, json: async () => raw }) });
  await assert.rejects(f.bridge.handle(request()), { code: 'native_usage_unverified' });
  assert.equal(f.events.at(-1).input.usage.estimated, true);
});

test('Anthropic text transport reserves translated payload and settles additive cache TTL usage before answering', async () => {
  const f = await fixture();
  const result = await f.bridge.handle(request({ messages: [
    { role: 'system', content: 'Synthetic system.' }, { role: 'developer', content: 'Synthetic rule.' },
    { role: 'user', content: 'First.' }, { role: 'assistant', content: 'Previous.' },
    { role: 'user', content: [{ type: 'text', text: 'Next.' }] },
  ] }));
  assert.deepEqual(f.events.map((event) => event.type), ['reserve', 'fetch', 'settle']);
  const sent = f.events[1];
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.init.headers['x-api-key'], 'synthetic-key');
  assert.equal(sent.init.headers.Authorization, undefined);
  assert.equal(sent.init.redirect, 'error');
  const payload = JSON.parse(sent.init.body);
  assert.equal(payload.max_tokens, 128);
  assert.equal(payload.service_tier, 'standard_only');
  assert.deepEqual(payload.thinking, { type: 'between_tools' });
  assert.deepEqual(payload.output_config, { effort: 'low' });
  assert.deepEqual(payload.system, [{ type: 'text', text: 'Synthetic system.' }, { type: 'text', text: 'Synthetic rule.' }]);
  assert.deepEqual(payload.messages.map((message) => message.role), ['user', 'assistant', 'user']);
  assert.equal(f.events[0].input.reserveUsd, maximumTextRequestCost({ provider: 'anthropic', model: MODEL,
    prompt: sent.init.body, maxOutputTokens: 128, pricing }));
  const settlement = f.events.at(-1).input;
  assert.equal(settlement.usage.provider, 'anthropic');
  assert.equal(settlement.usage.serviceTier, 'standard');
  assert.equal(settlement.usage.estimated, false);
  assert(Math.abs(settlement.actualUsd - 0.0001653) < 1e-12);
  assert.equal(result.usage.prompt_tokens, 32);
  assert.equal(result.usage.completion_tokens, 10);
  assert.equal(result.usage.total_tokens, 42);
  assert.equal(result.choices[0].message.content, 'Synthetic answer.');
  assert.equal(JSON.stringify(settlement).includes('Synthetic'), false);
});

test('native HTTP buffered SSE carries the Sonnet completion and aggregate usage after settlement', async () => {
  const f = await fixture();
  const http = createNativeHttp({ enabled: () => true, token: 'x'.repeat(32), safeEqual: (a, b) => a === b,
    models: async () => [MODEL], bridge: f.bridge });
  let frames = '';
  let ended = false;
  const res = { setHeader() {}, write(value) { assert.equal(f.events.at(-1).type, 'settle'); frames += value; },
    end() { ended = true; }, status() { return this; }, json() { assert.fail('expected SSE'); } };
  await http.complete({ body: request({ stream: true, stream_options: { include_usage: true } }) }, res);
  assert.equal(ended, true);
  const chunks = frames.trim().split('\n\n').filter((chunk) => chunk !== 'data: [DONE]')
    .map((chunk) => JSON.parse(chunk.slice(6)));
  assert.equal(chunks[0].model, MODEL);
  assert.equal(chunks[0].choices[0].delta.content, 'Synthetic answer.');
  assert.equal(chunks[2].usage.total_tokens, 42);
});

test('unsupported routing, tools, sampling and relocated instructions fail before reserve or dispatch', async () => {
  for (const extra of [
    { model: 'gpt-6-luna' }, { temperature: 1 }, { top_p: 1 }, { reasoning_effort: 'high' },
    { seed: 1 }, { frequency_penalty: 1 },
    { tools: [{ type: 'function', function: { name: 'test', parameters: {} } }] },
    { messages: [{ role: 'user', content: 'Hi' }, { role: 'system', content: 'Later' }] },
    { messages: [{ role: 'assistant', content: 'Prefill' }] },
    { messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Prefill' }] },
    { messages: [{ role: 'tool', content: 'Result', tool_call_id: 'call_synthetic' }] },
  ]) {
    const f = await fixture();
    await assert.rejects(f.bridge.handle(request(extra)), /native_/);
    assert.deepEqual(f.events, []);
  }
});

test('missing cache TTL, nonstandard tier, extra billable fields and provider tools retain an estimated charge', async () => {
  for (const usage of [
    { ...response().usage, cache_creation: undefined },
    { ...response().usage, cache_creation: { ephemeral_5m_input_tokens: 8 } },
    { ...response().usage, cache_creation_input_tokens: 9 },
    { ...response().usage, service_tier: 'priority' },
    { ...response().usage, server_tool_use: { web_search_requests: 1 } },
    { ...response().usage, extra_billable_tokens: 1 },
    { ...response().usage, output_tokens_details: { thinking_tokens: 11 } },
    { ...response().usage, input_tokens: '20' },
  ]) {
    let attempts = 0;
    const f = await fixture({ fetchImpl: async () => { attempts++; return { status: 200, json: async () => response({ usage }) }; } });
    await assert.rejects(f.bridge.handle(request()), /native_/);
    assert.equal(attempts, 1);
    assert.equal(f.events.at(-1).input.usage.estimated, true);
    assert.equal(f.events.at(-1).input.actualUsd, f.events[0].input.reserveUsd);
  }
});

test('cache-free documented usage is exact and malformed display preserves the known actual charge', async () => {
  for (const content of [[{ type: 'tool_use', id: 'x', input: {} }], [], [{ type: 'text', text: null }]]) {
    const f = await fixture({ fetchImpl: async () => ({ status: 200, json: async () => response({ content,
      usage: { input_tokens: 20, output_tokens: 10, service_tier: 'standard' } }) }) });
    await assert.rejects(f.bridge.handle(request()), /native_provider_response_invalid/);
    assert.equal(f.events.at(-1).input.usage.estimated, false);
    assert(Math.abs(f.events.at(-1).input.actualUsd - 0.00014) < 1e-12);
  }
});

test('Anthropic never falls back or retries on rejection, unknown billing or timeout', async (t) => {
  for (const status of [401, 429, 408, 500]) {
    let attempts = 0;
    const f = await fixture({ fetchImpl: async () => { attempts++; return { status, json: () => assert.fail('error body must remain private') }; } });
    await assert.rejects(f.bridge.handle(request()), /native_provider_rejected/);
    assert.equal(attempts, 1);
    assert.equal(f.events.at(-1).type, status < 500 && status !== 408 ? 'release' : 'settle');
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let started;
  const dispatched = new Promise((resolve) => { started = resolve; });
  const f = await fixture({ fetchImpl: async (_url, init) => { signal = init.signal; started(); return { status: 200, json: () => new Promise(() => {}) }; } });
  const pending = f.bridge.handle(request());
  await dispatched;
  t.mock.timers.tick(120_000);
  await assert.rejects(pending, /native_provider_timeout/);
  assert.equal(signal.aborted, true);
  assert.equal(f.events.at(-1).input.usage.estimated, true);
});

test('known Sonnet cost overrun blocks further admission even when presentation is malformed', async () => {
  const f = await fixture({ fetchImpl: async () => ({ status: 200, json: async () => response({ content: [],
    usage: { input_tokens: 20, output_tokens: 20_000, service_tier: 'standard' } }) }) });
  await assert.rejects(f.bridge.handle(request()), /reservation_underestimated/);
  assert.equal(f.events.at(-1).input.usage.estimated, false);
  await assert.rejects(f.realLedger.reserve({ reservationId: randomUUID(), reserveUsd: 0.01, directCapUsd: 175,
    now: NOW, timeZone: 'America/Denver', metadata: {} }), /ledger_accounting_blocked/);
});

test('production native bridge uses the Anthropic key and exact pinned priced model only', () => {
  const server = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const wiring = server.slice(server.indexOf('async function nativeModels'), server.indexOf('function getDevice'));
  assert.match(wiring, /model === 'claude-sonnet-5-5'.*provider === 'anthropic'/);
  assert.match(wiring, /provider: 'anthropic'/);
  assert.match(wiring, /providerKey: process.env.ANTHROPIC_API_KEY/);
  assert.doesNotMatch(wiring, /OPENAI_API_KEY/);
});
