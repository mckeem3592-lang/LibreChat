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
  const number = value === undefined ? 0 : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) {
    throw new Error(`invalid_${name}`);
  }
  return number;
}

function rate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('invalid_pricing_rate');
  }
  return value;
}

function reservationInputTokens(inputTokens, pricing) {
  const overhead = pricing?.reservation?.inputOverheadTokens ?? 1024;
  if (!Number.isSafeInteger(overhead) || overhead < 0) throw new Error('invalid_reservation_overhead');
  return inputTokens + overhead;
}

function pricingForInput(modelPricing, inputTokens) {
  const tier = modelPricing.longContext;
  if (tier === undefined) return modelPricing;
  if (!Number.isSafeInteger(tier?.aboveInputTokens) || tier.aboveInputTokens < 0 ||
      typeof tier.inputMultiplier !== 'number' || !Number.isFinite(tier.inputMultiplier) || tier.inputMultiplier < 1 ||
      typeof tier.outputMultiplier !== 'number' || !Number.isFinite(tier.outputMultiplier) || tier.outputMultiplier < 1) {
    throw new Error('invalid_long_context_pricing');
  }
  if (inputTokens <= tier.aboveInputTokens) return modelPricing;
  const adjusted = { ...modelPricing };
  for (const key of ['input', 'cachedInput', 'cacheWrite', 'cacheWrite1h']) {
    if (modelPricing[key] !== undefined) adjusted[key] = rate(modelPricing[key]) * tier.inputMultiplier;
  }
  for (const key of ['output', 'imageOutput']) {
    if (modelPricing[key] !== undefined) adjusted[key] = rate(modelPricing[key]) * tier.outputMultiplier;
  }
  return adjusted;
}

function inputReservationCost(modelPricing, inputTokens) {
  const rates = [modelPricing.input];
  for (const key of ['cachedInput', 'cacheWrite', 'cacheWrite1h']) {
    if (modelPricing[key] !== undefined) rates.push(modelPricing[key]);
  }
  return (inputTokens / 1_000_000) * Math.max(...rates.map(rate));
}

export function normalizedBillableUsage(provider, usage = {}) {
  const inputTokens = finiteNonnegative(usage.inputTokens, 'input_tokens');
  const outputTokens = finiteNonnegative(usage.outputTokens, 'output_tokens');
  const cachedInputTokens = finiteNonnegative(usage.cachedInputTokens, 'cached_input_tokens');
  const cacheWriteTokens = finiteNonnegative(usage.cacheWriteTokens, 'cache_write_tokens');
  const cacheWrite5mTokens = finiteNonnegative(
    usage.cacheWrite5mTokens ?? cacheWriteTokens,
    'cache_write_5m_tokens',
  );
  const cacheWrite1hTokens = finiteNonnegative(usage.cacheWrite1hTokens, 'cache_write_1h_tokens');
  const imageOutputTokens = finiteNonnegative(usage.imageOutputTokens, 'image_output_tokens');

  if (provider === 'anthropic') {
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      cacheWrite5mTokens,
      cacheWrite1hTokens,
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
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    imageOutputTokens,
  };
}

export function calculateUsageCost(provider, model, usage, pricing) {
  let modelPricing = pricing?.models?.[model];
  if (!modelPricing || modelPricing.provider !== provider) {
    throw new Error('pricing_not_configured');
  }

  const billable = normalizedBillableUsage(provider, usage);
  const totalInputTokens = billable.inputTokens + billable.cachedInputTokens +
    billable.cacheWrite5mTokens + billable.cacheWrite1hTokens;
  modelPricing = pricingForInput(modelPricing, totalInputTokens);
  const perMillion = (tokens, price) => tokens === 0 ? 0 : (tokens / 1_000_000) * rate(price);
  const components = {
    inputUsd: perMillion(billable.inputTokens, modelPricing.input),
    cachedInputUsd: perMillion(billable.cachedInputTokens, modelPricing.cachedInput),
    cacheWriteUsd: perMillion(billable.cacheWrite5mTokens, modelPricing.cacheWrite),
    cacheWrite1hUsd: perMillion(
      billable.cacheWrite1hTokens,
      modelPricing.cacheWrite1h ?? modelPricing.cacheWrite,
    ),
    outputUsd: perMillion(billable.outputTokens, modelPricing.output),
    imageOutputUsd: perMillion(billable.imageOutputTokens, modelPricing.imageOutput),
  };
  const totalUsd = Object.values(components).reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(totalUsd)) throw new Error('invalid_usage_cost');

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
  imageInputTokens = 0,
}) {
  let modelPricing = pricing?.models?.[model];
  if (!modelPricing || modelPricing.provider !== provider) {
    throw new Error('pricing_not_configured');
  }

  const inputBytes = Buffer.byteLength(String(prompt), 'utf8') + Buffer.byteLength(String(system), 'utf8');
  const inputUpperBound = reservationInputTokens(
    inputBytes + finiteNonnegative(imageInputTokens, 'image_input_tokens'), pricing,
  );
  modelPricing = pricingForInput(modelPricing, inputUpperBound);
  const outputTokens = finiteNonnegative(maxOutputTokens, 'max_output_tokens');
  return (
    inputReservationCost(modelPricing, inputUpperBound) +
    (outputTokens / 1_000_000) * rate(modelPricing.output)
  );
}

export function maximumImageRequestCost({
  provider,
  model,
  prompt = '',
  imageSize = '1K',
  pricing,
  maxOutputTokens = 4096,
  referenceInputTokens = 0,
}) {
  let modelPricing = pricing?.models?.[model];
  if (!modelPricing || modelPricing.provider !== provider) {
    throw new Error('pricing_not_configured');
  }
  if (!['512', '1K', '2K', '4K'].includes(imageSize)) throw new Error('invalid_image_size');
  const promptBytes = Buffer.byteLength(String(prompt), 'utf8');
  const inputUpperBound = reservationInputTokens(
    promptBytes + finiteNonnegative(referenceInputTokens, 'reference_input_tokens'), pricing,
  );
  modelPricing = pricingForInput(modelPricing, inputUpperBound);
  const outputTokens = finiteNonnegative(maxOutputTokens, 'max_output_tokens');
  const imageRate = rate(modelPricing.imageOutput);
  if (!Number.isFinite(imageRate) || imageRate <= 0) throw new Error('image_pricing_not_configured');

  return (
    inputReservationCost(modelPricing, inputUpperBound) +
    (outputTokens / 1_000_000) * Math.max(imageRate, rate(modelPricing.output))
  );
}
