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
