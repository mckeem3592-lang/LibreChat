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

test('provider failure stops after one request even with another configured provider', async () => {
  await env({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, async () => {
    const urls = [];
    const ledger = createMemoryUsageLedger();
    await assert.rejects(() => delegateRequest({
      task: 'coding', prompt: 'fix this', enabled: true,
      dashboardReader: dashboard(), usageLedger: ledger,
      fetchImpl: async (url) => {
        urls.push(url);
        return response({ error: { type: 'rate_limit_error' } }, 429);
      },
    }), /delegate_all_providers_failed/);
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes('anthropic.com'));
    const summary = await ledger.summary();
    assert.equal(summary.reservedUsd, 0);
    assert.equal(summary.settledUsd, 0);
  });
});

test('missing primary provider never switches to another configured provider', async () => {
  await env({ ANTHROPIC_API_KEY: null, OPENAI_API_KEY: 'o' }, async () => {
    let calls = 0;
    await assert.rejects(() => delegateRequest({
      task: 'coding', prompt: 'fix', enabled: true,
      dashboardReader: dashboard(), usageLedger: createMemoryUsageLedger(),
      fetchImpl: async () => { calls++; return response({}); },
    }), /delegate_all_providers_failed/);
    assert.equal(calls, 0);
  });
});

test('preflight reservation prevents a request that could cross the hard cap', async () => {
  await env({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, async () => {
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
  await env({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, async () => {
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

test('missing usage is charged conservatively without another paid attempt', async () => {
  await env({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: null }, async () => {
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

test('Anthropic cache writes without TTL details settle the full reservation as estimated', async () => {
  await env({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: null, GEMINI_API_KEY: null }, async () => {
    const ledger = createMemoryUsageLedger();
    const settlements = [];
    let reservedAmount;
    let calls = 0;
    await assert.rejects(() => delegateRequest({
      task: 'coding', prompt: 'fix code', maxOutputTokens: 10, enabled: true,
      dashboardReader: dashboard(),
      usageLedger: {
        ...ledger,
        reserve: async (input) => {
          reservedAmount = input.reserveUsd;
          return ledger.reserve(input);
        },
        settle: async (input) => {
          settlements.push(input);
          return ledger.settle(input);
        },
        release: () => assert.fail('uncertain provider charges must not be released'),
      },
      fetchImpl: async () => {
        calls++;
        return response({
          content: [{ type: 'text', text: 'already generated' }],
          usage: { input_tokens: 12, output_tokens: 8, cache_creation_input_tokens: 4 },
        });
      },
    }), /delegate_all_providers_failed/);
    assert.equal(calls, 1);
    assert.equal(settlements.length, 1);
    assert.ok(reservedAmount > 0);
    assert.equal(settlements[0].actualUsd, reservedAmount);
    assert.equal(settlements[0].usage.estimated, true);
    assert.equal(settlements[0].usage.error, 'provider_usage_invalid');
    const summary = await ledger.summary();
    assert.equal(summary.settledUsd, reservedAmount);
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
  await env({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, async () => {
    const ledger = createMemoryUsageLedger();
    await ledger.reserve({ reserveUsd: 2, directCapUsd: 175 });
    const result = await delegateRequest({
      task: 'reasoning', prompt: 'test', enabled: true,
      dashboardReader: async () => ({ ...(await dashboard(1)()), targetUsd: 1, economyUsd: 2, hardUsd: 10 }),
      usageLedger: ledger,
      fetchImpl: async () => response({ output_text: 'answer', service_tier: 'default', usage: { input_tokens: 10, output_tokens: 10 } }),
    });
    assert.equal(result.mode, 'economy');
    assert.equal(result.role, 'reasoning');
    assert.equal(result.selected.model, 'claude-sonnet-5-5');
  });
});

test('uncertain charge never re-routes even when it crosses the economy threshold', async () => {
  await env({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' }, async () => {
    const ledger = createMemoryUsageLedger();
    const models = [];
    await assert.rejects(() => delegateRequest({
      task: 'reasoning', prompt: 'test', enabled: true,
      dashboardReader: async () => ({ ...(await dashboard()()), targetUsd: 0.10, economyUsd: 0.15, hardUsd: 1 }),
      usageLedger: ledger,
      fetchImpl: async (_url, options) => {
        models.push(JSON.parse(options.body).model);
        throw new Error('network down');
      },
    }), /delegate_all_providers_failed/);
    assert.deepEqual(models, ['claude-sonnet-5-5']);
    const summary = await ledger.summary();
    assert.equal(summary.reservedUsd, 0);
    assert.ok(summary.settledUsd > 0);
  });
});
