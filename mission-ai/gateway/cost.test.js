import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateUsageCost,
  maximumTextRequestCost,
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
