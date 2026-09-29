import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createNativeBridge } from './generated/native.js';
import { createAnthropicHttp } from './generated/anthropicHttp.js';
import { normalizeAnthropicMessages } from './generated/anthropicMessages.js';
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
  await http.complete({ body: request({ stream: true }) }, res);
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
