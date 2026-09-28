import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateUsageCost,
  maximumTextRequestCost,
  maximumImageRequestCost,
  normalizedBillableUsage,
  loadPricing,
} from './cost.js';

const pricing = {
  verifiedOn: '2026-09-27',
  models: {
    'gpt-6-sol': {
      provider: 'openai',
      input: 2,
      cachedInput: 0.2,
      cacheWrite: 2.5,
      output: 10,
    },
    'claude-sonnet-5': {
      provider: 'anthropic',
      input: 2,
      cachedInput: 0.2,
      cacheWrite: 2.5,
      cacheWrite1h: 4,
      output: 10,
    },
  },
};

test('OpenAI cached input is not double counted as uncached input', () => {
  assert.deepEqual(
    normalizedBillableUsage('openai', {
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 100,
    }),
    {
      inputTokens: 600,
      outputTokens: 100,
      cachedInputTokens: 400,
      cacheWriteTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      imageOutputTokens: 0,
    },
  );
});

test('Anthropic cache categories remain separate from uncached input', () => {
  assert.deepEqual(
    normalizedBillableUsage('anthropic', {
      inputTokens: 600,
      cachedInputTokens: 400,
      cacheWriteTokens: 100,
      outputTokens: 100,
    }),
    {
      inputTokens: 600,
      outputTokens: 100,
      cachedInputTokens: 400,
      cacheWriteTokens: 100,
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 0,
      imageOutputTokens: 0,
    },
  );
});

test('calculates provider-reported usage cost from versioned pricing', () => {
  const result = calculateUsageCost(
    'openai',
    'gpt-6-sol',
    { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 },
    pricing,
  );
  assert.equal(result.totalUsd, 0.00228);
  assert.equal(result.pricingVerifiedOn, '2026-09-27');
});

test('Anthropic cache write TTLs use separate official rates', () => {
  const result = calculateUsageCost(
    'anthropic',
    'claude-sonnet-5',
    {
      inputTokens: 1000,
      cachedInputTokens: 500,
      cacheWriteTokens: 300,
      cacheWrite5mTokens: 200,
      cacheWrite1hTokens: 100,
      outputTokens: 50,
    },
    pricing,
  );
  assert.equal(result.components.cacheWriteUsd, 0.0005);
  assert.equal(result.components.cacheWrite1hUsd, 0.0004);
  assert.equal(result.totalUsd, 0.0035);
});

test('preflight includes UTF-8 bytes, framing allowance, and highest input category rate', () => {
  const cost = maximumTextRequestCost({
    provider: 'openai',
    model: 'gpt-6-sol',
    prompt: 'abcd',
    system: '',
    maxOutputTokens: 1000,
    pricing,
  });
  assert.ok(Math.abs(cost - 0.01257) < 1e-12);
});

test('image preflight reserves the enforced total output-token cap at the highest modality rate', () => {
  const imagePricing = {
    models: {
      'gemini-3.1-flash-image': {
        provider: 'google',
        input: 0.5,
        output: 3,
        imageOutput: 60,
      },
    },
  };
  const cost = maximumImageRequestCost({
    provider: 'google',
    model: 'gemini-3.1-flash-image',
    prompt: 'moon',
    imageSize: '2K',
    pricing: imagePricing,
    maxOutputTokens: 4096,
  });
  assert.equal(cost, ((1024 + 4) / 1_000_000) * 0.5 + (4096 / 1_000_000) * 60);
});

test('invalid or missing billable prices never silently produce free usage', () => {
  for (const input of [undefined, NaN, -1, Infinity, '2']) {
    const invalid = { models: { model: { provider: 'openai', input, output: 1 } } };
    assert.throws(() => calculateUsageCost('openai', 'model', { inputTokens: 1 }, invalid), /invalid_pricing_rate/);
    assert.throws(() => maximumTextRequestCost({ provider: 'openai', model: 'model', prompt: 'x', maxOutputTokens: 1, pricing: invalid }), /invalid_pricing_rate/);
  }
});

test('invalid usage never silently becomes zero cost', () => {
  for (const inputTokens of [NaN, -1, Infinity, null, '1']) {
    assert.throws(() => calculateUsageCost('openai', 'gpt-6-sol', { inputTokens }, pricing), /invalid_input_tokens/);
  }
});

test('configured OpenAI long context rates apply to all input categories and output above 272000 tokens', async () => {
  const catalog = await loadPricing();
  for (const model of ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra']) {
    const prices = catalog.models[model];
    for (const inputTokens of [272000, 272001]) {
      const result = calculateUsageCost('openai', model, {
        inputTokens, cachedInputTokens: 100000, cacheWriteTokens: 10000, outputTokens: 100,
      }, catalog);
      const inputMultiplier = inputTokens === 272000 ? 1 : 2;
      const outputMultiplier = inputTokens === 272000 ? 1 : 1.5;
      assert.equal(result.components.inputUsd, ((inputTokens - 110000) / 1e6) * prices.input * inputMultiplier);
      assert.equal(result.components.cachedInputUsd, (100000 / 1e6) * prices.cachedInput * inputMultiplier);
      assert.equal(result.components.cacheWriteUsd, (10000 / 1e6) * prices.cacheWrite * inputMultiplier);
      assert.ok(Math.abs(result.components.outputUsd - (100 / 1e6) * prices.output * outputMultiplier) < 1e-12);
    }
  }
});

test('reservation applies long-context output rate when input allowance crosses the threshold', async () => {
  const catalog = await loadPricing();
  for (const inputUpperBound of [272000, 272001]) {
    const cost = maximumTextRequestCost({
      provider: 'openai', model: 'gpt-6-sol',
      prompt: 'a'.repeat(inputUpperBound - 1024), maxOutputTokens: 100, pricing: catalog,
    });
    const expected = inputUpperBound === 272000
      ? (272000 / 1e6) * 2.5 + (100 / 1e6) * 10
      : (272001 / 1e6) * 5 + (100 / 1e6) * 15;
    assert.equal(cost, expected);
  }
});

test('invalid long-context tiers fail before settlement or reservation', () => {
  for (const longContext of [null, {}, { aboveInputTokens: 272000, inputMultiplier: 0, outputMultiplier: 1.5 }]) {
    const catalog = { models: { model: { provider: 'openai', input: 1, output: 1, longContext } } };
    assert.throws(() => calculateUsageCost('openai', 'model', { inputTokens: 1 }, catalog), /invalid_long_context_pricing/);
    assert.throws(() => maximumTextRequestCost({ provider: 'openai', model: 'model', prompt: 'a', maxOutputTokens: 1, pricing: catalog }), /invalid_long_context_pricing/);
  }
});
