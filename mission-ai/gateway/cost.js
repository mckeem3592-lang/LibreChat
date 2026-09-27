import { readFile } from 'node:fs/promises';

let cachedPricing;

export async function loadPricing() {
  if (cachedPricing) return cachedPricing;
  const raw = await readFile(new URL('../config/pricing.json', import.meta.url), 'utf8');
  cachedPricing = JSON.parse(raw);
  return cachedPricing;
}

export function clearPricingCache() {
  cachedPricing = undefined;
}

function finiteNonnegative(value, name) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) throw new Error(`invalid_${name}`);
  return number;
}

export function normalizedBillableUsage(provider, usage = {}) {
  const inputTokens = finiteNonnegative(usage.inputTokens, 'input_tokens');
  const outputTokens = finiteNonnegative(usage.outputTokens, 'output_tokens');
  const cachedInputTokens = finiteNonnegative(usage.cachedInputTokens, 'cached_input_tokens');
  const cacheWriteTokens = finiteNonnegative(usage.cacheWriteTokens, 'cache_write_tokens');
  const imageOutputTokens = finiteNonnegative(usage.imageOutputTokens, 'image_output_tokens');

  if (provider === 'anthropic') {
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      imageOutputTokens,
    };
  }

  const uncachedInputTokens = Math.max(
    0,
    inputTokens - cachedInputTokens - cacheWriteTokens,
  );
  return {
    inputTokens: uncachedInputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    imageOutputTokens,
  };
}

export function calculateUsageCost(provider, model, usage, pricing) {
  const modelPricing = pricing?.models?.[model];
  if (!modelPricing || modelPricing.provider !== provider) {
    throw new Error('pricing_not_configured');
  }

  const billable = normalizedBillableUsage(provider, usage);
  const perMillion = (tokens, rate) => (tokens / 1_000_000) * Number(rate || 0);
  const components = {
    inputUsd: perMillion(billable.inputTokens, modelPricing.input),
    cachedInputUsd: perMillion(billable.cachedInputTokens, modelPricing.cachedInput),
    cacheWriteUsd: perMillion(billable.cacheWriteTokens, modelPricing.cacheWrite),
    outputUsd: perMillion(billable.outputTokens, modelPricing.output),
    imageOutputUsd: perMillion(billable.imageOutputTokens, modelPricing.imageOutput),
  };
  const totalUsd = Object.values(components).reduce((sum, value) => sum + value, 0);

  return {
    provider,
    model,
    usage: billable,
    components,
    totalUsd,
    pricingVerifiedOn: pricing.verifiedOn || null,
  };
}

export function maximumTextRequestCost({
  provider,
  model,
  prompt = '',
  system = '',
  maxOutputTokens,
  pricing,
}) {
  const modelPricing = pricing?.models?.[model];
  if (!modelPricing || modelPricing.provider !== provider) {
    throw new Error('pricing_not_configured');
  }

  const inputBytes = Buffer.byteLength(String(prompt), 'utf8') + Buffer.byteLength(String(system), 'utf8');
  const outputTokens = finiteNonnegative(maxOutputTokens, 'max_output_tokens');
  return (
    (inputBytes / 1_000_000) * Number(modelPricing.input || 0) +
    (outputTokens / 1_000_000) * Number(modelPricing.output || 0)
  );
}

const IMAGE_OUTPUT_TOKENS = Object.freeze({
  '512': 747,
  '1K': 1120,
  '2K': 1680,
  '4K': 2520,
});

export function maximumImageRequestCost({
  provider,
  model,
  prompt = '',
  imageSize = '1K',
  pricing,
  maxImages = 4,
  referenceInputTokens = 0,
}) {
  const modelPricing = pricing?.models?.[model];
  if (!modelPricing || modelPricing.provider !== provider) {
    throw new Error('pricing_not_configured');
  }
  const outputTokens = IMAGE_OUTPUT_TOKENS[imageSize];
  if (!outputTokens) throw new Error('invalid_image_size');
  const imageRate = Number(modelPricing.imageOutput || 0);
  if (!Number.isFinite(imageRate) || imageRate <= 0) throw new Error('image_pricing_not_configured');

  const promptBytes = Buffer.byteLength(String(prompt), 'utf8');
  const inputUpperBound = promptBytes + Math.max(0, Number(referenceInputTokens || 0));
  return (
    (inputUpperBound / 1_000_000) * Number(modelPricing.input || 0) +
    ((outputTokens * Math.max(1, Number(maxImages) || 1)) / 1_000_000) * imageRate
  );
}
