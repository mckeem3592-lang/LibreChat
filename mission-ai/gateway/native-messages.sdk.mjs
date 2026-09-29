import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createNativeBridge } from './generated/native.js';
import { createAnthropicHttp } from './generated/anthropicHttp.js';
import { maximumTextRequestCost, calculateUsageCost } from './cost.js';

// Use the app's already-locked SDK. No extra production dependency or provider call.
const require = createRequire(process.env.MISSION_AI_ANTHROPIC_SDK_TEST_PATH ||
  new URL('../../package.json', import.meta.url));
const Anthropic = require('@anthropic-ai/sdk').default;
const model = 'claude-sonnet-5-5';
const token = 'synthetic-private-native-token-123456';
const content = [
  { type: 'thinking', thinking: '', signature: 'synthetic-signature-for-continuation' },
  { type: 'tool_use', id: 'toolu_synthetic', name: 'browser_list_tabs', input: { scope: 'owned' } },
];
for (const stream of [false, true]) test(`locked Anthropic SDK preserves signed tool continuation (stream=${stream})`, async () => {
  const events = [];
  const bridge = createNativeBridge({ provider: 'anthropic', protocol: 'anthropic-messages',
    providerKey: 'synthetic-not-real-key', modelAllowed: (name) => name === model,
    randomId: randomUUID, now: () => new Date('2026-09-28T12:00:00Z'),
    budgetReader: () => ({ mode: 'shared', policy: { targetUsd: 100, economyUsd: 125, hardUsd: 175 },
      timeZone: 'America/Denver', directCapUsd: 175 }),
    pricingLoader: () => ({ verifiedOn: '2026-09-28', models: { [model]: { provider: 'anthropic', input: 2, output: 10 } } }),
    estimateCost: maximumTextRequestCost, calculateCost: calculateUsageCost,
    ledger: { reserve: async ({ reservationId, reserveUsd }) => ({ reservationId, reservedUsd: reserveUsd }),
      settle: async () => { events.push('settled'); }, release: async () => { assert.fail('release unexpected'); } },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      events.push(JSON.parse(init.body));
      return { status: 200, json: async () => ({ type: 'message', role: 'assistant', id: 'msg_synthetic', model,
        content, stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 10, service_tier: 'standard' } }) };
    },
  });
  const handlers = createAnthropicHttp({ enabled: () => true, token, safeEqual: (a, b) => a === b, bridge });
  let transportCalls = 0;
  const client = new Anthropic({ apiKey: token, baseURL: 'https://synthetic.invalid/native/anthropic', maxRetries: 0,
    fetch: async (url, init) => {
      transportCalls++;
      assert.equal(new URL(url).pathname, '/native/anthropic/v1/messages');
      const headers = new Headers(init.headers);
      const req = { body: JSON.parse(init.body), query: {}, get: (name) => headers.get(name) };
      let status = 200; let text = ''; const responseHeaders = new Headers(); let admitted = false;
      const res = { status(code) { status = code; return this; },
        json(value) { responseHeaders.set('Content-Type', 'application/json'); text = JSON.stringify(value); },
        setHeader(name, value) { responseHeaders.set(name, value); }, write(value) { text += value; }, end() {} };
      handlers.authorize(req, res, () => { admitted = true; });
      if (admitted) await handlers.complete(req, res);
      return new Response(text, { status, headers: responseHeaders });
    } });
  const request = { model, max_tokens: 128, messages: [{ role: 'user', content: 'Synthetic task only.' }],
    tools: [{ name: 'browser_list_tabs', input_schema: { type: 'object', properties: { scope: { type: 'string' } } } }] };
  const message = stream ? await client.messages.stream(request).finalMessage() : await client.messages.create(request);
  assert.deepEqual(message.content, content);
  assert.equal(message.stop_reason, 'tool_use'); assert.equal(message.usage.output_tokens, 10);
  assert.equal(transportCalls, 1); assert.equal(events[1], 'settled');
  // A second synthetic model turn sends the exact returned signature and paired result.
  await client.messages.create({ ...request, messages: [...request.messages,
    { role: 'assistant', content: message.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_synthetic', content: 'Synthetic tab result.' }] }] });
  assert.deepEqual(events[2].messages[1].content, content);
  assert.equal(transportCalls, 2);
});
