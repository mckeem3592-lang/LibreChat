import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createManagedToolConfigGuard } from './generated/managedTools.js';
import { createNativeBridge } from './generated/native.js';
import { createAnthropicHttp } from './generated/anthropicHttp.js';
import { attachManagedProjectCost } from './generated/projectCost.js';
import { maximumTextRequestCost, calculateUsageCost } from './cost.js';

const require = createRequire(new URL('../../package.json', import.meta.url));
const token = 'synthetic-native-only-token-12345678';
process.env.MISSION_AI_GATEWAY_URL = 'https://synthetic.invalid';
process.env.MISSION_AI_NATIVE_TOKEN = token;
process.env.MISSION_AI_TOOL_TOKEN = 'synthetic-tool-only-token-123456789';
const { configSchema } = require('librechat-data-provider');
const { load } = require('js-yaml');
const { getLLMConfig } = require('@librechat/api');
const { getChatModelClass, Providers } = require('@librechat/agents');
const { HumanMessage, ToolMessage } = require('@langchain/core/messages');
const config = configSchema.parse(load(readFileSync(new URL('../config/librechat.tools-budget.yaml', import.meta.url), 'utf8')));
const options = { enabled: true, toolsEnabled: true, ownerEmail: 'owner@synthetic.invalid',
  gatewayURL: 'https://synthetic.invalid', nativeToken: token,
  toolToken: 'synthetic-tool-only-token-123456789', titleConvo: 'false' };

test('actual YAML schema and AppConfig views satisfy the native tool configuration boundary', () => {
  const guard = createManagedToolConfigGuard(options);
  let admitted = false;
  const req = { user: { email: options.ownerEmail }, body: { endpoint: 'MissionAI', endpointType: 'custom',
    model: 'claude-sonnet-5-5', spec: 'mission-ai-sonnet', text: 'Synthetic task.',
    maxOutputTokens: 4096, effort: 'low', thinking: true, promptCache: false, ephemeralAgent: { mcp: ['mission-ai'] } },
    config: { config, endpoints: config.endpoints, memory: config.memory, summarization: config.summarization,
      interfaceConfig: config.interface, mcpConfig: config.mcpServers, modelSpecs: config.modelSpecs } };
  guard(req, { status(code) { assert.fail(`Parsed native configuration refused: ${code}`); }, json() {} }, () => { admitted = true; });
  assert.equal(admitted, true); assert.equal(req.body.maxOutputTokens, 4096);
});

const workflows = [
  { tool: 'browser_list_tabs', result: 'Synthetic owned Chrome tab inventory.', rejected: false },
  { tool: 'mac_screenshot', result: 'Synthetic approved display geometry.', image: true, rejected: false },
  { tool: 'read_file', result: 'Synthetic document artifact verification.', rejected: false },
  { tool: 'browser_list_tabs', result: '', rejected: true },
];
for (const workflow of workflows) test(`real LibreChat capped tool round trip: ${workflow.tool}, rejected=${workflow.rejected}`, async (t) => {
  const { rejected } = workflow;
  const selected = config.endpoints.custom[0]; const preset = config.modelSpecs.list[0].preset;
  const { llmConfig } = getLLMConfig(token, { modelOptions: { model: preset.model, maxOutputTokens: preset.maxOutputTokens,
    effort: preset.effort, thinking: preset.thinking, promptCache: preset.promptCache },
    reverseProxyUrl: `${options.gatewayURL}/native/anthropic`, addParams: selected.addParams, dropParams: selected.dropParams });
  const sent = []; let clientCalls = 0; let settled = 0;
  const bridge = createNativeBridge({ provider: 'anthropic', protocol: 'anthropic-messages',
    providerKey: 'synthetic-provider-key', modelAllowed: (name) => name === preset.model,
    now: () => new Date('2026-09-28T12:00:00Z'), randomId: randomUUID,
    budgetReader: () => ({ mode: 'shared', policy: { targetUsd: 100, economyUsd: 125, hardUsd: 175 }, timeZone: 'America/Denver', directCapUsd: 175 }),
    pricingLoader: () => ({ verifiedOn: '2026-09-28', models: { [preset.model]: { provider: 'anthropic', input: 2, output: 10 } } }),
    estimateCost: maximumTextRequestCost, calculateCost: calculateUsageCost,
    ledger: { reserve: async ({ reservationId, reserveUsd, metadata }) => { assert.equal(metadata.project, '0123456789abcdef01234567'); return { reservationId, reservedUsd: reserveUsd }; },
      settle: async ({ usage }) => { assert.equal(usage.project, '0123456789abcdef01234567'); settled++; }, release: async () => {} },
    fetchImpl: async (_url, init) => {
      assert(!JSON.stringify(init).includes('0123456789abcdef01234567'));
      sent.push(JSON.parse(init.body));
      return { status: rejected ? 400 : 200, json: async () => ({ type: 'message', id: 'msg_synthetic', role: 'assistant', model: preset.model,
        content: sent.length === 1 ? [{ type: 'thinking', thinking: '', signature: 'synthetic-preserved-signature' },
          { type: 'tool_use', id: 'toolu_synthetic', name: workflow.tool, input: {} }] : [{ type: 'text', text: 'Synthetic workflow completed.' }],
        stop_reason: sent.length === 1 ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10, service_tier: 'standard' } }) };
    } });
  const http = createAnthropicHttp({ enabled: () => true, token, safeEqual: (a, b) => a === b, bridge });
  const fetch = async (url, init) => {
    assert.equal(new URL(typeof url === 'string' ? url : url.url).origin, options.gatewayURL);
    clientCalls++; const headers = new Headers(init.headers);
    assert.equal(headers.get('x-mission-ai-project'), '0123456789abcdef01234567');
    const req = { body: JSON.parse(init.body), query: {}, get: (key) => headers.get(key) };
    let status = 200; let content = ''; let admitted = false; const responseHeaders = new Headers();
    const res = { status(code) { status = code; return this; },
      json(value) { responseHeaders.set('Content-Type', 'application/json'); content = JSON.stringify(value); },
      setHeader(name, value) { responseHeaders.set(name, value); }, write(value) { content += value; }, end() {} };
    http.authorize(req, res, () => { admitted = true; }); if (admitted) await http.complete(req, res);
    return new Response(content, { status, headers: responseHeaders });
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const Chat = getChatModelClass(Providers.ANTHROPIC);
  const projectId = '0123456789abcdef01234567';
  attachManagedProjectCost(llmConfig, { enabled: true, gatewayURL: options.gatewayURL, projectId });
  const client = new Chat({ ...llmConfig, clientOptions: { ...llmConfig.clientOptions, fetch } }).bindTools([
    { type: 'function', function: { name: workflow.tool, description: 'Synthetic local tool.', parameters: { type: 'object', properties: {} } } },
  ]);
  if (rejected) {
    await assert.rejects(client.invoke([new HumanMessage('Synthetic request.')]));
    assert.equal(clientCalls, 1); assert.equal(sent.length, 1); return;
  }
  const first = await client.invoke([new HumanMessage('Synthetic request.')]);
  assert.equal(settled, 1); assert.equal(first.tool_calls[0].id, 'toolu_synthetic');
  assert.equal(sent[0].max_tokens, 4096); assert.equal(sent[0].metadata, undefined);
  assert.equal(sent[0].service_tier, 'standard_only');
  assert.deepEqual(sent[0].thinking, { type: 'between_tools' });
  assert.equal(first.tool_calls[0].name, workflow.tool);
  const final = await client.invoke([new HumanMessage('Synthetic request.'), first,
    new ToolMessage({ tool_call_id: 'toolu_synthetic', content: [
      { type: 'text', text: workflow.result },
      ...(workflow.image ? [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' } }] : []),
    ] })]);
  assert.equal(final.content, 'Synthetic workflow completed.');
  assert.equal(final.tool_calls?.length ?? 0, 0);
  assert.equal(settled, 2); assert.equal(clientCalls, 2);
  const assistant = sent[1].messages.find((message) => message.role === 'assistant');
  assert.equal(assistant.content.find((block) => block.type === 'thinking').signature, 'synthetic-preserved-signature');
  const result = sent[1].messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).find((block) => block.type === 'tool_result');
  assert.equal(result.content.find((block) => block.type === 'text').text, workflow.result);
  if (workflow.image) assert.equal(result.content.find((block) => block.type === 'image').source.media_type, 'image/png');
  else assert.equal(result.content.some((block) => block.type === 'image'), false);
});
