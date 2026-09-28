import assert from 'node:assert/strict';
import test from 'node:test';
import { delegateRequest } from './delegate.js';
import { createMemoryUsageLedger } from './usage-ledger.js';

function env(values, fn) {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.entries(values).forEach(([key, value]) => {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  });
  return Promise.resolve().then(fn).finally(() => {
    Object.entries(original).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function dashboard(spendUsd = 0) {
  return async () => ({
    spendUsd,
    hardUsd: 175,
    targetUsd: 100,
    economyUsd: 125,
    timeZone: 'America/Denver',
  });
}

test('delegation stays disabled until explicitly enabled', async () => {
  await assert.rejects(
    () => delegateRequest({ task: 'coding', prompt: 'test', enabled: false }),
    /delegation_disabled/,
  );
});

test('hard budget stops before any provider request', async () => {
  let calls = 0;
  await assert.rejects(
    () => delegateRequest({
      task: 'coding',
      prompt: 'test',
      enabled: true,
      dashboardReader: dashboard(175),
      usageLedger: createMemoryUsageLedger(),
      fetchImpl: async () => { calls += 1; return response({}); },
    }),
    /monthly_hard_limit/,
  );
  assert.equal(calls, 0);
});

test('coding falls back once from Anthropic failure to OpenAI and settles actual cost', async () => {
  await env({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, async () => {
    const urls = [];
    const ledger = createMemoryUsageLedger();
    const result = await delegateRequest({
      task: 'coding',
      prompt: 'fix this',
      enabled: true,
      dashboardReader: dashboard(0),
      usageLedger: ledger,
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.includes('anthropic.com')) {
          return response({ error: { type: 'rate_limit_error' } }, 429);
        }
        return response({
          id: 'resp_ok',
          model: 'gpt-6-sol',
          service_tier: 'default',
          output: [{ content: [{ type: 'output_text', text: 'fixed' }] }],
          usage: { input_tokens: 20, output_tokens: 5 },
        });
      },
    });

    assert.equal(urls.length, 2);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.selected.provider, 'openai');
    assert.equal(result.output.text, 'fixed');
    assert.equal(result.cost.totalUsd, 0.00009);
    assert.deepEqual(result.attempts.map(({ status }) => status), ['failed', 'succeeded']);
    const summary = await ledger.summary({ now: new Date() });
    assert.equal(summary.reservedUsd, 0);
    assert.equal(summary.settledUsd, result.cost.totalUsd);
  });
});

test('unconfigured providers are skipped without network calls', async () => {
  await env({ ANTHROPIC_API_KEY: null, OPENAI_API_KEY: 'o' }, async () => {
    let calls = 0;
    const result = await delegateRequest({
      task: 'coding',
      prompt: 'fix',
      enabled: true,
      dashboardReader: dashboard(0),
      usageLedger: createMemoryUsageLedger(),
      fetchImpl: async () => {
        calls += 1;
        return response({
          id: 'resp_ok',
          model: 'gpt-6-sol',
          service_tier: 'default',
          output: [{ content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.selected.provider, 'openai');
    assert.equal(result.attempts[0].status, 'skipped');
  });
});

test('preflight reservation prevents a request that could cross the hard cap', async () => {
  await env({ OPENAI_API_KEY: 'o' }, async () => {
    let calls = 0;
    await assert.rejects(
      () => delegateRequest({
        task: 'reasoning',
        prompt: 'x'.repeat(100000),
        maxOutputTokens: 32768,
        enabled: true,
        dashboardReader: dashboard(174.99),
        usageLedger: createMemoryUsageLedger(),
        fetchImpl: async () => { calls += 1; return response({}); },
      }),
      /monthly_hard_limit/,
    );
    assert.equal(calls, 0);
  });
});

test('network uncertainty conservatively settles the reserved amount', async () => {
  await env({ OPENAI_API_KEY: 'o' }, async () => {
    const ledger = createMemoryUsageLedger();
    await assert.rejects(
      () => delegateRequest({
        task: 'primary',
        prompt: 'hello',
        maxOutputTokens: 10,
        enabled: true,
        dashboardReader: dashboard(0),
        usageLedger: ledger,
        fetchImpl: async () => { throw new Error('network down'); },
      }),
      /delegate_all_providers_failed/,
    );
    const summary = await ledger.summary({ now: new Date() });
    assert.equal(summary.reservedUsd, 0);
    assert.ok(summary.settledUsd > 0);
  });
});

test('invalid output limits fail before budget reads or provider calls', async () => {
  for (const maxOutputTokens of [0, null, -1, 0.5, 32769, '10', NaN]) {
    await assert.rejects(() => delegateRequest({
      prompt: 'test', enabled: true, maxOutputTokens,
      dashboardReader: () => assert.fail('budget must not be queried'),
      fetchImpl: () => assert.fail('provider must not be called'),
    }), /provider_input_invalid/);
  }
});

test('missing usage is charged conservatively before another paid attempt', async () => {
  await env({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: null, GEMINI_API_KEY: null }, async () => {
    const ledger = createMemoryUsageLedger();
    let calls = 0;
    await assert.rejects(() => delegateRequest({
      task: 'chat', prompt: 'test', enabled: true,
      dashboardReader: dashboard(), usageLedger: ledger,
      fetchImpl: async () => { calls++; return response({ output_text: 'already generated' }); },
    }), /delegate_all_providers_failed/);
    const summary = await ledger.summary();
    assert.equal(calls, 1);
    assert.ok(summary.settledUsd > 0);
    assert.equal(summary.reservedUsd, 0);
  });
});

test('a failed settlement preserves the reservation and prevents fallback', async () => {
  await env({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' }, async () => {
    const ledger = createMemoryUsageLedger();
    let calls = 0;
    await assert.rejects(() => delegateRequest({
      task: 'chat', prompt: 'test', enabled: true,
      dashboardReader: dashboard(),
      usageLedger: { ...ledger, settle: async () => { throw new Error('storage_unavailable'); } },
      fetchImpl: async () => {
        calls++;
        return response({ output_text: 'generated', service_tier: 'default', usage: { input_tokens: 10, output_tokens: 10 } });
      },
    }), /storage_unavailable/);
    const summary = await ledger.summary();
    assert.equal(calls, 1);
    assert.ok(summary.reservedUsd > 0);
    assert.equal(summary.settledUsd, 0);
  });
});

test('runtime economy threshold includes outstanding reservations', async () => {
  await env({ OPENAI_API_KEY: 'o' }, async () => {
    const ledger = createMemoryUsageLedger();
    await ledger.reserve({ reserveUsd: 2, directCapUsd: 175 });
    const result = await delegateRequest({
      task: 'reasoning', prompt: 'test', enabled: true,
      dashboardReader: async () => ({ ...(await dashboard(1)()), targetUsd: 1, economyUsd: 2, hardUsd: 10 }),
      usageLedger: ledger,
      fetchImpl: async () => response({ output_text: 'answer', service_tier: 'default', usage: { input_tokens: 10, output_tokens: 10 } }),
    });
    assert.equal(result.mode, 'economy');
    assert.equal(result.role, 'economy');
  });
});

test('uncertain premium charges trigger economy routing before a fallback request', async () => {
  await env({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' }, async () => {
    const ledger = createMemoryUsageLedger();
    const models = [];
    const result = await delegateRequest({
      task: 'reasoning', prompt: 'test', enabled: true,
      dashboardReader: async () => ({ ...(await dashboard()()), targetUsd: 0.10, economyUsd: 0.15, hardUsd: 1 }),
      usageLedger: ledger,
      fetchImpl: async (_url, options) => {
        const { model } = JSON.parse(options.body);
        models.push(model);
        if (models.length === 1) throw new Error('network down');
        return response({ output_text: 'answer', service_tier: 'default', usage: { input_tokens: 10, output_tokens: 10 } });
      },
    });
    assert.deepEqual(models, ['gpt-6-astra', 'gpt-6-luna']);
    assert.equal(result.mode, 'economy');
    assert.equal(result.role, 'economy');
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.budget.delegatedSpendUsd, (await ledger.summary()).settledUsd);
  });
});
