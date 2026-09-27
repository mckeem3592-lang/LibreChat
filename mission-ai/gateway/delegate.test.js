import assert from 'node:assert/strict';
import test from 'node:test';
import { delegateRequest } from './delegate.js';

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

test('delegation stays disabled until explicitly enabled', async () => {
  await assert.rejects(
    () => delegateRequest({ task: 'coding', monthSpendUsd: 0, prompt: 'test', enabled: false }),
    /delegation_disabled/,
  );
});

test('hard budget stops before any provider request', async () => {
  let calls = 0;
  await assert.rejects(
    () => delegateRequest({
      task: 'coding',
      monthSpendUsd: 175,
      prompt: 'test',
      enabled: true,
      fetchImpl: async () => { calls += 1; return response({}); },
    }),
    /monthly_hard_limit/,
  );
  assert.equal(calls, 0);
});

test('coding falls back once from Anthropic failure to OpenAI', async () => {
  await env({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, async () => {
    const urls = [];
    const result = await delegateRequest({
      task: 'coding',
      monthSpendUsd: 0,
      prompt: 'fix this',
      enabled: true,
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
    assert.deepEqual(result.attempts.map(({ status }) => status), ['failed', 'succeeded']);
  });
});

test('unconfigured providers are skipped without network calls', async () => {
  await env({ ANTHROPIC_API_KEY: null, OPENAI_API_KEY: 'o' }, async () => {
    let calls = 0;
    const result = await delegateRequest({
      task: 'coding',
      monthSpendUsd: 0,
      prompt: 'fix',
      enabled: true,
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
