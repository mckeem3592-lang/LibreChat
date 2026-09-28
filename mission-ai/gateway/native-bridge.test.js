import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createNativeBridge } from './generated/native.js';
import { createMemoryUsageLedger } from './usage-ledger.js';
import { calculateUsageCost, maximumTextRequestCost } from './cost.js';

const NOW = new Date('2026-09-28T12:00:00Z');
const MODEL = 'test-approved-model';
const TIME_ZONE = 'America/Denver';
const pricing = { verifiedOn: '2026-09-28', models: {
  [MODEL]: { provider: 'openai', input: 1, cachedInput: 0.5, output: 2 },
} };
const request = () => ({ model: MODEL, messages: [{ role: 'user', content: 'Synthetic test.' }] });
const completion = (overrides = {}) => ({
  id: 'chatcmpl-synthetic', object: 'chat.completion', created: 1790596800, model: MODEL,
  service_tier: 'default',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic result.', refusal: null }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30,
    prompt_tokens_details: { cached_tokens: 4, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 3, audio_tokens: 0,
      accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } },
  ...overrides,
});

function fixture(overrides = {}) {
  const events = [];
  const realLedger = createMemoryUsageLedger();
  const ready = realLedger.activateSharedBudget({
    policy: { targetUsd: 100, economyUsd: 125, hardUsd: 175 },
    timeZone: TIME_ZONE, cutoverAt: NOW, history: [],
  });
  const ledger = {
    async reserve(input) { events.push({ type: 'reserve', input }); return realLedger.reserve(input); },
    async settle(input) { events.push({ type: 'settle', input }); return realLedger.settle(input); },
    async release(input) { events.push({ type: 'release', input }); return realLedger.release(input); },
  };
  const deps = {
    ledger, pricingLoader: () => pricing, estimateCost: maximumTextRequestCost,
    calculateCost: calculateUsageCost, providerKey: 'synthetic-test-key',
    modelAllowed: (model) => model === MODEL, now: () => NOW, randomId: randomUUID,
    budgetReader: async () => { await ready; return { mode: 'shared', timeZone: TIME_ZONE, directCapUsd: 175,
      policy: { targetUsd: 100, economyUsd: 125, hardUsd: 175 } }; },
    fetchImpl: async (url, init) => {
      events.push({ type: 'fetch', url, init });
      return { status: 200, json: async () => completion() };
    },
    ...overrides,
  };
  return { bridge: createNativeBridge(deps), deps, ledger, realLedger, events,
    summary: () => realLedger.summary({ now: NOW, timeZone: TIME_ZONE }) };
}

test('reserves the entire normalized request before official upstream dispatch and settles before returning', async () => {
  const f = fixture();
  const result = await f.bridge.handle({ ...request(), stream: true, stream_options: { include_usage: true } });
  assert.equal(result.object, 'chat.completion');
  assert.deepEqual(f.events.map((entry) => entry.type), ['reserve', 'fetch', 'settle']);
  const dispatched = f.events[1];
  const sent = JSON.parse(dispatched.init.body);
  assert.equal(dispatched.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(dispatched.init.redirect, 'error');
  assert.equal(sent.stream, false);
  assert.equal(sent.service_tier, 'default');
  assert.equal(sent.n, 1);
  assert.equal(sent.max_completion_tokens, 4096);
  assert.equal(sent.stream_options, undefined);
  assert.equal(f.events[0].input.reserveUsd, maximumTextRequestCost({ provider: 'openai',
    model: MODEL, prompt: dispatched.init.body, maxOutputTokens: 4096, pricing }));
  assert.equal(f.events[0].input.metadata.source, 'native');
  const settled = f.events[2].input;
  assert.equal(settled.actualUsd, 0.000038);
  assert.equal(settled.usage.outputTokens, 10, 'reasoning is already included in completion tokens');
  assert.equal(settled.usage.estimated, false);
  assert.equal((await f.summary()).reservedUsd, 0);
  assert.equal(JSON.stringify(settled).includes('Synthetic'), false);
});

test('function definitions, calls and tool outputs are forwarded and fully reserved', async () => {
  const f = fixture();
  const input = { ...request(), max_tokens: 128,
    messages: [
      { role: 'system', content: 'Synthetic system.' },
      { role: 'user', content: [{ type: 'text', text: 'Synthetic input.' }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function',
        function: { name: 'local_tool', arguments: '{"value":"synthetic"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Synthetic tool result.' },
    ],
    tools: [{ type: 'function', function: { name: 'local_tool', description: 'Synthetic description.',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, strict: true } }],
    tool_choice: { type: 'function', function: { name: 'local_tool' } }, parallel_tool_calls: false,
  };
  await f.bridge.handle(input);
  const sent = JSON.parse(f.events[1].init.body);
  assert.deepEqual(sent.messages, input.messages);
  assert.deepEqual(sent.tools, input.tools);
  assert.equal(sent.max_completion_tokens, 128);
  assert.equal(sent.max_tokens, undefined);
  assert.equal(f.events[0].input.reserveUsd, maximumTextRequestCost({ provider: 'openai',
    model: MODEL, prompt: f.events[1].init.body, maxOutputTokens: 128, pricing }));
});

test('current documented text details preserve cache-write billing without counting text twice', async () => {
  const f = fixture({ pricingLoader: () => ({ ...pricing, models: {
    [MODEL]: { ...pricing.models[MODEL], cacheWrite: 1.25 },
  } }), fetchImpl: async () => ({ status: 200, json: async () => completion({ usage: {
    prompt_tokens: 20, completion_tokens: 10, total_tokens: 30,
    prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 5, text_tokens: 20, audio_tokens: 0, image_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 3, text_tokens: 7, audio_tokens: 0 },
  } }) }) });
  await f.bridge.handle(request());
  const settled = f.events.at(-1).input;
  assert(Math.abs(settled.actualUsd - 0.00003925) < 1e-12);
  assert.equal(settled.usage.cacheWriteTokens, 5);
  assert.equal(settled.usage.cachedInputTokens, 4);
  assert.equal(settled.usage.estimated, false);
  assert.equal((await f.summary()).reservedUsd, 0);
});

test('returns valid function tool-call completion after accounting', async () => {
  const response = completion({ choices: [{ index: 0, finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function',
      function: { name: 'local_tool', arguments: '{}' } }],
  } }] });
  const f = fixture({ fetchImpl: async () => ({ status: 200, json: async () => response }) });
  assert.deepEqual(await f.bridge.handle(request()), response);
  assert.equal(f.events.at(-1).type, 'settle');
});

test('rejects unbounded, ambiguous or nonnumeric token limits before reserve/dispatch', async () => {
  for (const value of [0, -1, 1.5, 32769, Infinity, NaN, '128', null]) {
    for (const key of ['max_tokens', 'max_completion_tokens']) {
      const f = fixture();
      await assert.rejects(f.bridge.handle({ ...request(), [key]: value }), /native_request_invalid/);
      assert.deepEqual(f.events, []);
    }
  }
  const f = fixture();
  await assert.rejects(f.bridge.handle({ ...request(), max_tokens: 128, max_completion_tokens: 128 }), /native_request_invalid/);
  assert.deepEqual(f.events, []);
});

test('rejects unknown fields, custom URLs, premium tiers, multiple completions and unsupported modalities', async () => {
  const forbidden = [
    { reservationId: 'client-chosen' }, { base_url: 'https://example.invalid' }, { web_search_options: {} },
    { audio: { voice: 'alloy', format: 'mp3' } }, { modalities: ['audio'] }, { prediction: { type: 'content', content: 'x' } },
    { response_format: { type: 'json_object' } }, { service_tier: 'auto' }, { service_tier: 'priority' }, { n: 2 },
    { tools: [{ type: 'web_search' }] }, { tools: [{ type: 'code_interpreter' }] },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image' } }] }] },
    { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'synthetic', format: 'wav' } }] }] },
  ];
  for (const extra of forbidden) {
    const f = fixture();
    await assert.rejects(f.bridge.handle({ ...request(), ...extra }), /native_/);
    assert.deepEqual(f.events, []);
  }
});

test('unapproved model, absent provider key, invalid pricing and oversized input never dispatch', async () => {
  for (const options of [{ modelAllowed: () => false }, { providerKey: '' }, { estimateCost: () => NaN }, { estimateCost: () => 0 }]) {
    const f = fixture(options);
    await assert.rejects(f.bridge.handle(request()), /native_|shared_budget_unready/);
    assert.equal(f.events.some((entry) => entry.type === 'fetch'), false);
  }
  const f = fixture();
  await assert.rejects(f.bridge.handle({ ...request(), messages: [{ role: 'user', content: 'x'.repeat(1_048_576) }] }), /native_request_too_large/);
  assert.deepEqual(f.events, []);
});

test('unready, snapshot-only and malformed shared budgets cannot dispatch', async () => {
  for (const budget of [null, {}, { mode: 'snapshot' },
    { mode: 'shared', policy: { targetUsd: 100, economyUsd: 125, hardUsd: 175 }, directCapUsd: 175, timeZone: 'Invalid' },
    { mode: 'shared', policy: { targetUsd: 100, economyUsd: 125, hardUsd: 175 }, directCapUsd: 176, timeZone: TIME_ZONE },
  ]) {
    const f = fixture({ budgetReader: async () => budget });
    await assert.rejects(f.bridge.handle(request()), /shared_budget_unready/);
    assert.deepEqual(f.events, []);
  }
});

test('atomic ledger cap blocks native dispatch when another source has reserved the remaining budget', async () => {
  const f = fixture();
  await f.realLedger.reserve({ reservationId: 'delegated-pending', reserveUsd: 175, directCapUsd: 175,
    now: NOW, timeZone: TIME_ZONE, metadata: { source: 'delegated' } });
  await assert.rejects(f.bridge.handle(request()), /monthly_hard_limit/);
  assert.deepEqual(f.events.map((entry) => entry.type), ['reserve']);
});

test('definitive provider rejection releases reservation, without parsing or returning provider body', async () => {
  let attempts = 0;
  const f = fixture({ fetchImpl: async () => {
    attempts++;
    return { status: 401, json: async () => { throw new Error('must not read provider error body'); } };
  } });
  await assert.rejects(f.bridge.handle(request()), /native_provider_rejected/);
  assert.equal(attempts, 1);
  assert.deepEqual(f.events.map((entry) => entry.type), ['reserve', 'release']);
  assert.equal((await f.summary()).reservedUsd, 0);
  assert.equal((await f.summary()).settledUsd, 0);
});

test('network, timeout HTTP status, 5xx and invalid success each conservatively settle full reservation once', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('SECRET provider transport data'); },
    async () => ({ status: 408 }), async () => ({ status: 500 }),
    async () => ({ status: 200, json: async () => { throw new Error('SECRET body'); } }),
    async () => ({ status: 200, json: async () => completion({ usage: undefined }) }),
  ]) {
    let attempts = 0;
    const f = fixture({ fetchImpl: (...args) => { attempts++; return fetchImpl(...args); } });
    await assert.rejects(f.bridge.handle(request()), (error) => !error.message.includes('SECRET'));
    assert.equal(attempts, 1);
    assert.deepEqual(f.events.map((entry) => entry.type), ['reserve', 'settle']);
    assert.equal(f.events[1].input.actualUsd, f.events[0].input.reserveUsd);
    assert.equal(f.events[1].input.usage.estimated, true);
    assert.equal((await f.summary()).reservedUsd, 0);
  }
});

test('deadline aborts a hanging success-body read and settles the full allowance without waiting for transport', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let dispatched;
  let markDispatched;
  const started = new Promise((resolve) => { markDispatched = resolve; });
  const f = fixture({ fetchImpl: async (_url, init) => {
    dispatched = init;
    markDispatched();
    return { status: 200, json: () => new Promise(() => {}) };
  } });
  const pending = f.bridge.handle(request());
  await started;
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, /native_provider_timeout/);
  assert.equal(dispatched.signal.aborted, true);
  assert.equal(f.events.at(-1).input.usage.estimated, true);
  assert.equal(f.events.at(-1).input.actualUsd, f.events[0].input.reserveUsd);
});

test('unverified model/tier and inconsistent or unsupported usage cannot pass acceptance', async () => {
  const variants = [
    { model: `${MODEL}-other` }, { service_tier: undefined }, { service_tier: 'priority' },
    { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 31 } },
    { usage: { prompt_tokens: '20', completion_tokens: 10, total_tokens: 30 } },
    { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_tokens_details: { cached_tokens: 21 } } },
    { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, completion_tokens_details: { audio_tokens: 1 } } },
    ...[
      { cached_tokens: 4, cache_write_tokens: 17 }, { cache_write_tokens: -1 },
      { cache_write_tokens: '5' }, { text_tokens: 21 }, { image_tokens: 1 },
      { text_tokens: 20, unknown_billable_tokens: 1 },
    ].map((prompt_tokens_details) => ({ usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_tokens_details } })),
    { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, completion_tokens_details: { text_tokens: 11 } } },
  ];
  for (const variant of variants) {
    const f = fixture({ fetchImpl: async () => ({ status: 200, json: async () => completion(variant) }) });
    await assert.rejects(f.bridge.handle({ ...request(), max_completion_tokens: 128 }));
    assert.equal(f.events.at(-1).input.usage.estimated, true);
    assert.equal(f.events.at(-1).input.actualUsd, f.events[0].input.reserveUsd);
  }
});

test('provider output-limit violation records known actual usage rather than an estimated charge', async () => {
  const f = fixture({ fetchImpl: async () => ({ status: 200, json: async () => completion({
    usage: { prompt_tokens: 20, completion_tokens: 129, total_tokens: 149 },
  }) }) });
  await assert.rejects(f.bridge.handle({ ...request(), max_completion_tokens: 128 }), /native_output_limit_exceeded/);
  const settled = f.events.at(-1).input;
  assert.equal(settled.usage.estimated, false);
  assert.equal(settled.usage.outputTokens, 129);
  assert.equal(settled.actualUsd, 0.000278);
});

test('malformed completion fields preserve verified actual usage before rejecting the response', async () => {
  for (const malformed of [
    { id: null }, { object: 'unexpected' }, { created: 'not-a-number' },
    { choices: [] },
    { choices: [{ index: 0, message: { role: 'assistant', content: 'test', new_provider_metadata: true }, finish_reason: 'stop' }] },
  ]) {
    const f = fixture({ fetchImpl: async () => ({ status: 200, json: async () => completion(malformed) }) });
    await assert.rejects(f.bridge.handle(request()), (error) => error.code === 'native_provider_response_invalid' && error.status === 502);
    const settled = f.events.at(-1).input;
    assert.equal(settled.actualUsd, 0.000038);
    assert.equal(settled.usage.estimated, false);
    assert.equal((await f.summary()).settledUsd, 0.000038);
    assert.equal((await f.summary()).reservedUsd, 0);
  }
});

test('malformed display fields cannot hide a known actual overrun or allow further admission', async () => {
  const f = fixture({ fetchImpl: async () => ({ status: 200, json: async () => completion({
    choices: [{ index: 0, message: { role: 'assistant', content: 'test', new_provider_metadata: true }, finish_reason: 'length' }],
    usage: { prompt_tokens: 20, completion_tokens: 20_000, total_tokens: 20_020 },
  }) }) });
  await assert.rejects(f.bridge.handle({ ...request(), max_completion_tokens: 128 }), /reservation_underestimated/);
  const settled = f.events.at(-1).input;
  assert.equal(settled.actualUsd, 0.04002);
  assert.equal(settled.usage.estimated, false);
  assert.equal((await f.summary()).settledUsd, 0.04002);
  assert.equal((await f.summary()).accountingBlocked, true);
  await assert.rejects(() => f.realLedger.reserve({ reserveUsd: 0.001, source: 'native', now: NOW,
    timeZone: TIME_ZONE }), /ledger_accounting_blocked/);
});

test('failed actual or estimated settlement retains the hold and never returns a completion', async () => {
  for (const success of [true, false]) {
    const f = fixture({ fetchImpl: async () => {
      if (!success) throw new Error('synthetic failure');
      return { status: 200, json: async () => completion() };
    } });
    f.deps.ledger.settle = async () => { throw new Error('SECRET database details'); };
    await assert.rejects(f.bridge.handle(request()), /native_settlement_failed/);
    assert.equal((await f.summary()).reservedUsd, f.events[0].input.reserveUsd);
    assert.equal(f.events.some((entry) => entry.type === 'release'), false);
  }
});

test('post-response pricing failure retains the hold without exposing the provider response', async () => {
  const f = fixture({ calculateCost: () => { throw new Error('SECRET pricing internals'); } });
  await assert.rejects(f.bridge.handle(request()), /native_settlement_failed/);
  assert.equal((await f.summary()).reservedUsd, f.events[0].input.reserveUsd);
  assert.equal(f.events.some((entry) => entry.type === 'release'), false);
});

test('known cost overrun settles evidence, blocks the ledger and suppresses the response', async () => {
  const f = fixture({ estimateCost: () => 0.000001 });
  await assert.rejects(f.bridge.handle(request()), /reservation_underestimated/);
  const summary = await f.summary();
  assert.equal(summary.accountingBlocked, true);
  assert.equal(summary.settledUsd, 0.000038);
  assert.equal(summary.reservedUsd, 0);
});
