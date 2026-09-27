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
          return response({ error: { type: 'overloaded_error' } }, 529);
        }
        return response({
          id: 'resp_ok',
          model: 'gpt-6-sol',
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
          output: [{ content: [{ type: 'output_text', text: 'ok' }] }],
          usage: {},
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
        dashboardReader: dashboard(173),
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
