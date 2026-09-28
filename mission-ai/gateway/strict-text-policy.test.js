import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredRouteRequest } from './route-api-v3.js';
import { routeRequest } from './route-api.js';
import { fallbackTargets } from './fallbacks.js';
import { executeProvider } from './provider-client.js';
import { calculateUsageCost, loadPricing } from './cost.js';

test('all text classes stay pinned and every fallback chain contains exactly one target', async () => {
  for (const role of ['economy', 'primary', 'coding', 'reasoning', 'research', 'computer']) {
    for (const monthSpendUsd of [0, 125]) {
      const result = await configuredRouteRequest({ task: role, monthSpendUsd });
      assert.equal(result.route.provider, 'anthropic');
      assert.equal(result.route.model, 'claude-sonnet-5-5');
      const raw = await routeRequest({ task: role, monthSpendUsd });
      assert.equal(raw.route.model, 'claude-sonnet-5-5');
    }
    assert.deepEqual(await fallbackTargets(role), [{ provider: 'anthropic', role }]);
  }
  assert.deepEqual(await fallbackTargets('image'), [{ provider: 'google', role: 'image' }]);
});

test('Sonnet 5.5 uses between-tools thinking, low effort and verified cache pricing without a live call', async () => {
  const prior = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'offline-test-key';
  let calls = 0;
  try {
    const output = await executeProvider({ provider: 'anthropic', model: 'claude-sonnet-5-5',
      prompt: 'offline', maxOutputTokens: 10,
      fetchImpl: async (_url, options) => {
        calls++;
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'claude-sonnet-5-5');
        assert.deepEqual(body.thinking, { type: 'between_tools' });
        assert.deepEqual(body.output_config, { effort: 'low' });
        return { ok: true, status: 200, json: async () => ({ model: body.model,
          content: [{ type: 'text', text: 'OK' }],
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5,
            cache_creation_input_tokens: 3,
            cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 } },
        }) };
      },
    });
    assert.equal(calls, 1);
    assert.equal(output.text, 'OK');
    const cost = calculateUsageCost('anthropic', 'claude-sonnet-5-5', output.usage, await loadPricing());
    assert.ok(Math.abs(cost.totalUsd - 0.0000515) < 1e-12);
  } finally {
    if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prior;
  }
});
