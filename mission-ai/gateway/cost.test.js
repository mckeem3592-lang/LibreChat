import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateUsageCost,
  maximumTextRequestCost,
  maximumImageRequestCost,
  normalizedBillableUsage,
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

test('preflight uses UTF-8 bytes as a conservative input-token upper bound', () => {
  const cost = maximumTextRequestCost({
    provider: 'openai',
    model: 'gpt-6-sol',
    prompt: 'abcd',
    system: '',
    maxOutputTokens: 1000,
    pricing,
  });
  assert.equal(cost, 0.010008);
});

test('image preflight reserves documented output-token ceiling', () => {
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
    maxImages: 4,
  });
  assert.ok(cost >= (1680 * 4 / 1_000_000) * 60);
});
