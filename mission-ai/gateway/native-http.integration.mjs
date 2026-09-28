import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';
import OpenAI from 'openai';
import { createNativeHttp } from './generated/http.js';
import { createNativeBridge } from './generated/native.js';
import { createMemoryUsageLedger } from './usage-ledger.js';
import { loadPricing, maximumTextRequestCost, calculateUsageCost } from './cost.js';

const token = 'local-fixture-only-no-real-credential';
const model = 'gpt-6-luna';
const now = new Date('2026-09-28T17:00:00Z');
const body = { model, messages: [{ role: 'user', content: 'Fixture only' }], max_completion_tokens: 128 };

async function fixture(t, options = {}) {
  const selectedModel = options.anthropic ? 'claude-sonnet-5-5' : model;
  const ledger = createMemoryUsageLedger();
  const policy = { targetUsd: 100, economyUsd: 125, hardUsd: 175 };
  if (options.shared !== false) await ledger.activateSharedBudget({ policy, timeZone: 'America/Denver', cutoverAt: now, history: [] });
  const calls = [];
  let completeSettlement = false;
  const bridge = createNativeBridge({ ledger: { ...ledger, settle: async (input) => {
    const result = await ledger.settle(input); completeSettlement = true; return result;
  } },
    budgetReader: async () => ({ ...(await ledger.sharedBudget()), directCapUsd: 175 }),
    pricingLoader: loadPricing, estimateCost: maximumTextRequestCost, calculateCost: calculateUsageCost,
    providerKey: 'fake-provider-key', provider: options.anthropic ? 'anthropic' : 'openai',
    now: () => now, randomId: () => crypto.randomUUID(),
    modelAllowed: (name) => name === selectedModel,
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      const summary = await ledger.summary({ now });
      assert.ok(summary.reservedUsd > 0, 'Provider dispatch requires an active reservation');
      if (options.anthropic) return { status: 200, json: async () => ({
        id: 'msg_fixture', type: 'message', role: 'assistant', model: selectedModel,
        content: [{ type: 'text', text: 'Fixture result' }], stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 17, service_tier: 'standard' },
      }) };
      return { status: 200, json: async () => ({ id: 'chatcmpl_fixture', object: 'chat.completion',
        created: Math.floor(now.getTime() / 1000), model, service_tier: 'default',
        choices: [{ index: 0, finish_reason: options.tools ? 'tool_calls' : 'stop', message: {
          role: 'assistant', content: options.tools ? null : 'Fixture result',
          ...(options.tools ? { tool_calls: [{ id: 'call_fixture', type: 'function',
            function: { name: 'local_tool', arguments: '{"value":1}' } }] } : {}),
        } }], usage: { prompt_tokens: 11, completion_tokens: 17, total_tokens: 28,
          prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } }) };
    },
  });
  const handlers = createNativeHttp({ enabled: () => options.enabled !== false, token,
    safeEqual: (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)),
    models: async () => [selectedModel], bridge });
  const app = express();
  app.use('/v1', handlers.authorize, express.json());
  app.get('/v1/models', handlers.models);
  app.post('/v1/chat/completions', handlers.complete);
  app.use('/v1', handlers.unsupported);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const client = new OpenAI({ apiKey: token, baseURL, maxRetries: 0 });
  return { client, calls, ledger, baseURL, settled: () => completeSettlement };
}

test('OpenAI client receives nonstreaming completion only after exact cost settlement', async (t) => {
  const f = await fixture(t);
  const result = await f.client.chat.completions.create(body);
  assert.equal(result.choices[0].message.content, 'Fixture result');
  assert.equal(f.settled(), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].stream, false);
  const summary = await f.ledger.summary({ now });
  assert.equal(summary.reservedUsd, 0);
  assert.equal(summary.nativeUsd, 0.0000096);
  assert.equal(summary.delegatedUsd, 0);
  assert.equal((await f.client.models.list()).data[0].id, model);
});

for (const tools of [false, true]) test(`OpenAI client parses buffered SSE and usage (tools=${tools})`, async (t) => {
  const f = await fixture(t, { tools });
  const stream = await f.client.chat.completions.create({ ...body, stream: true, stream_options: { include_usage: true } });
  const chunks = [];
  for await (const chunk of stream) { assert.equal(f.settled(), true); chunks.push(chunk); }
  assert.equal(chunks.length, 3);
  assert.equal(chunks[2].usage.total_tokens, 28);
  if (tools) assert.equal(chunks[0].choices[0].delta.tool_calls[0].index, 0);
  else assert.equal(chunks[0].choices[0].delta.content, 'Fixture result');
  assert.equal(f.calls.length, 1);
});

for (const options of [{ enabled: false }, { shared: false }]) test(`disabled or unactivated bridge never dispatches ${JSON.stringify(options)}`, async (t) => {
  const f = await fixture(t, options);
  await assert.rejects(() => f.client.chat.completions.create({ ...body, enabled: true, hardUsd: 999 }));
  await assert.rejects(() => f.client.chat.completions.create(body));
  assert.equal(f.calls.length, 0);
});

test('authentication, unknown paid routes, queries and injected dependencies cannot bypass native gate', async (t) => {
  const f = await fixture(t);
  const bad = new OpenAI({ apiKey: 'wrong-fixture', baseURL: f.baseURL, maxRetries: 0 });
  await assert.rejects(() => bad.chat.completions.create(body), { status: 401 });
  await assert.rejects(() => f.client.responses.create({ model, input: 'Fixture' }), { status: 404 });
  await assert.rejects(() => f.client.chat.completions.create({ ...body, providerKey: 'override' }), { status: 400 });
  const query = await fetch(`${f.baseURL}/chat/completions?enabled=true`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(query.status, 400);
  assert.equal(f.calls.length, 0);
});

for (const stream of [false, true]) test(`Sonnet compatible SDK transport settles exact Anthropic usage (stream=${stream})`, async (t) => {
  const f = await fixture(t, { anthropic: true });
  const input = { ...body, model: 'claude-sonnet-5-5', stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}) };
  const result = await f.client.chat.completions.create(input);
  if (stream) {
    const chunks = [];
    for await (const chunk of result) { assert.equal(f.settled(), true); chunks.push(chunk); }
    assert.equal(chunks[0].choices[0].delta.content, 'Fixture result');
    assert.equal(chunks[2].usage.total_tokens, 28);
  } else assert.equal(result.choices[0].message.content, 'Fixture result');
  assert.equal(f.settled(), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].max_tokens, 128);
  assert.equal(f.calls[0].max_completion_tokens, undefined);
  assert.equal(f.calls[0].model, 'claude-sonnet-5-5');
  const summary = await f.ledger.summary({ now });
  assert.equal(summary.reservedUsd, 0);
  assert(Math.abs(summary.nativeUsd - 0.000192) < 1e-12);
  await assert.rejects(() => f.client.chat.completions.create(body), { status: 400 });
  assert.equal(f.calls.length, 1);
});
