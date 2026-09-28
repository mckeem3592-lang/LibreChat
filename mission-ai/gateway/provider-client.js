import { providerConfig } from './providers.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 120000;

export class ProviderRequestError extends Error {
  constructor(provider, status, code = 'provider_request_failed', { chargeUnknown = false } = {}) {
    super(code);
    this.name = 'ProviderRequestError';
    this.provider = provider;
    this.status = status;
    this.code = code;
    this.chargeUnknown = chargeUnknown;
  }
}

export function normalizeOutputTokenLimit(value = DEFAULT_MAX_OUTPUT_TOKENS) {
  if (!Number.isInteger(value) || value < 1 || value > 32768) {
    throw new ProviderRequestError(null, 400, 'provider_input_invalid');
  }
  return value;
}

function invalidUsage(provider) {
  return new ProviderRequestError(provider, 502, 'provider_usage_invalid', { chargeUnknown: true });
}

function tokenCount(provider, value, optional = false) {
  if (optional && value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw invalidUsage(provider);
  return value;
}

function validateInputCache(provider, inputTokens, cachedInputTokens, cacheWriteTokens = 0) {
  if (cachedInputTokens + cacheWriteTokens > inputTokens) throw invalidUsage(provider);
}

function responseList(provider, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ProviderRequestError(provider, 502, 'provider_invalid_response', { chargeUnknown: true });
  }
  return value;
}

function runtimeProvider(name) {
  const config = providerConfig(name);
  if (!config) throw new ProviderRequestError(name, 400, 'provider_not_supported');
  const apiKey = process.env[config.apiKeyEnv] || '';
  if (!apiKey) throw new ProviderRequestError(name, 503, 'provider_not_configured');
  return { ...config, apiKey };
}

async function jsonRequest(provider, url, options, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: options.signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ProviderRequestError(provider, 504, 'provider_timeout', { chargeUnknown: true });
    }
    throw new ProviderRequestError(provider, 502, 'provider_network_error', { chargeUnknown: true });
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new ProviderRequestError(provider, response.status || 502, 'provider_invalid_response', {
      chargeUnknown: response.ok || response.status >= 500 || response.status === 408,
    });
  }

  if (!response.ok) {
    throw new ProviderRequestError(provider, response.status, 'provider_http_error', {
      chargeUnknown: response.status >= 500 || response.status === 408,
    });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProviderRequestError(provider, 502, 'provider_invalid_response', { chargeUnknown: true });
  }
  return body;
}

function openAIText(body) {
  if (typeof body?.output_text === 'string') return body.output_text;
  return responseList('openai', body?.output)
    .flatMap((item) => responseList('openai', item?.content))
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

async function executeOpenAI({ model, prompt, system, maxOutputTokens, fetchImpl }) {
  const config = runtimeProvider('openai');
  const body = await jsonRequest(
    'openai',
    `${config.baseUrl.replace(/\/$/, '')}/responses`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: prompt,
        ...(system ? { instructions: system } : {}),
        max_output_tokens: maxOutputTokens,
        service_tier: 'default',
      }),
    },
    fetchImpl,
  );

  const inputTokens = tokenCount('openai', body?.usage?.input_tokens);
  const outputTokens = tokenCount('openai', body?.usage?.output_tokens);
  const cachedInputTokens = tokenCount('openai', body?.usage?.input_tokens_details?.cached_tokens, true);
  const cacheWriteTokens = tokenCount('openai', body?.usage?.input_tokens_details?.cache_write_tokens, true);
  validateInputCache('openai', inputTokens, cachedInputTokens, cacheWriteTokens);
  if (body.service_tier !== 'default') {
    throw new ProviderRequestError('openai', 502, 'provider_service_tier_unverified', { chargeUnknown: true });
  }
  return {
    provider: 'openai',
    model: body?.model || model,
    serviceTier: body.service_tier,
    text: openAIText(body),
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
    },
    requestId: body?.id || null,
  };
}

async function executeAnthropic({ model, prompt, system, maxOutputTokens, fetchImpl }) {
  const config = runtimeProvider('anthropic');
  const body = await jsonRequest(
    'anthropic',
    `${config.baseUrl.replace(/\/$/, '')}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        messages: [{ role: 'user', content: prompt }],
        ...(system ? { system } : {}),
      }),
    },
    fetchImpl,
  );

  return {
    provider: 'anthropic',
    model: body?.model || model,
    text: responseList('anthropic', body?.content)
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(''),
    usage: (() => {
      const cacheCreation = body?.usage?.cache_creation;
      const reportedCacheWriteTokens = tokenCount('anthropic', body?.usage?.cache_creation_input_tokens, true);
      const hasCacheDetail = cacheCreation != null;
      if (hasCacheDetail && (typeof cacheCreation !== 'object' || Array.isArray(cacheCreation))) {
        throw invalidUsage('anthropic');
      }
      // A combined count cannot establish the billed TTL. Reject uncertain usage so
      // callers retain the reserved maximum as an explicitly estimated settlement.
      const cacheWrite5mTokens = hasCacheDetail
        ? tokenCount('anthropic', cacheCreation.ephemeral_5m_input_tokens, true) : 0;
      const cacheWrite1hTokens = hasCacheDetail
        ? tokenCount('anthropic', cacheCreation.ephemeral_1h_input_tokens, true) : 0;
      const detailedCacheWriteTokens = cacheWrite5mTokens + cacheWrite1hTokens;
      if (!Number.isSafeInteger(detailedCacheWriteTokens) ||
          ((reportedCacheWriteTokens > 0 || detailedCacheWriteTokens > 0) &&
            (!hasCacheDetail || cacheCreation.ephemeral_5m_input_tokens === undefined ||
              cacheCreation.ephemeral_1h_input_tokens === undefined)) ||
          (body?.usage?.cache_creation_input_tokens !== undefined &&
            detailedCacheWriteTokens !== reportedCacheWriteTokens)) throw invalidUsage('anthropic');
      return {
        inputTokens: tokenCount('anthropic', body?.usage?.input_tokens),
        outputTokens: tokenCount('anthropic', body?.usage?.output_tokens),
        cachedInputTokens: tokenCount('anthropic', body?.usage?.cache_read_input_tokens, true),
        cacheWriteTokens: detailedCacheWriteTokens,
        cacheWrite5mTokens,
        cacheWrite1hTokens,
      };
    })(),
    requestId: body?.id || null,
  };
}

async function executeGoogle({ model, prompt, system, maxOutputTokens, fetchImpl }) {
  const config = runtimeProvider('google');
  const body = await jsonRequest(
    'google',
    `${config.baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': config.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        ...(system
          ? { system_instruction: { parts: [{ text: system }] } }
          : {}),
        generationConfig: { maxOutputTokens },
      }),
    },
    fetchImpl,
  );

  const usage = body?.usageMetadata;
  const inputTokens = tokenCount('google', usage?.promptTokenCount);
  const candidateTokens = tokenCount('google', usage?.candidatesTokenCount,
    usage?.thoughtsTokenCount !== undefined);
  const thoughtTokens = tokenCount('google', usage?.thoughtsTokenCount, true);
  const cachedInputTokens = tokenCount('google', usage?.cachedContentTokenCount, true);
  validateInputCache('google', inputTokens, cachedInputTokens);
  return {
    provider: 'google',
    model,
    text: responseList('google', body?.candidates)
      .flatMap((candidate) => responseList('google', candidate?.content?.parts))
      .filter((part) => typeof part?.text === 'string')
      .map((part) => part.text)
      .join(''),
    usage: {
      inputTokens,
      outputTokens: candidateTokens + thoughtTokens,
      cachedInputTokens,
      cacheWriteTokens: 0,
    },
    requestId: body?.responseId || null,
  };
}


function interactionUsage(body) {
  const usage = body?.usage || {};
  const details = responseList('google',
    usage.output_tokens_by_modality ??
    usage.outputTokensByModality ??
    usage.candidatesTokensDetails);
  let imageOutputTokens = 0;
  let textOutputTokens = 0;
  for (const item of details) {
    const tokens = tokenCount('google', item?.tokens ?? item?.tokenCount);
    const modality = String(item?.modality || '').toLowerCase();
    if (modality === 'image') imageOutputTokens += tokens;
    else if (modality === 'text') textOutputTokens += tokens;
    else throw invalidUsage('google');
  }
  const totalOutputTokens = tokenCount('google',
    usage.total_output_tokens ??
      usage.totalOutputTokens ??
      usage.candidatesTokenCount,
  );
  if (details.length && (imageOutputTokens === 0 ||
      imageOutputTokens + textOutputTokens !== totalOutputTokens)) throw invalidUsage('google');
  if (!details.length) imageOutputTokens = totalOutputTokens;
  if (imageOutputTokens === 0) throw invalidUsage('google');
  const inputTokens = tokenCount('google', usage.total_input_tokens ??
    usage.totalInputTokens ?? usage.promptTokenCount);
  const thoughtTokens = tokenCount('google', usage.total_thought_tokens ??
    usage.totalThoughtTokens ?? usage.thoughtsTokenCount, true);
  const cachedInputTokens = tokenCount('google', usage.total_cached_tokens ??
    usage.totalCachedTokens ?? usage.cachedContentTokenCount, true);
  validateInputCache('google', inputTokens, cachedInputTokens);
  return {
    inputTokens,
    outputTokens: textOutputTokens + thoughtTokens,
    imageOutputTokens,
    cachedInputTokens,
    cacheWriteTokens: 0,
  };
}

function interactionImages(body) {
  const images = [];
  const push = (item) => {
    const data = item?.data;
    const mimeType = item?.mime_type || item?.mimeType || 'image/png';
    if (typeof data !== 'string' || data.length === 0) return;
    images.push({ data, mimeType });
  };

  push(body?.output_image);
  for (const step of responseList('google', body?.steps)) {
    for (const item of responseList('google', step?.content)) {
      if (item?.type === 'image') push(item);
    }
  }
  for (const candidate of responseList('google', body?.candidates)) {
    for (const part of responseList('google', candidate?.content?.parts)) {
      if (part?.inlineData) push(part.inlineData);
      if (part?.inline_data) push(part.inline_data);
    }
  }

  const unique = new Map(images.map((image) => [`${image.mimeType}:${image.data}`, image]));
  return [...unique.values()];
}

export async function executeImageProvider({
  provider = 'google',
  model,
  prompt,
  aspectRatio = '1:1',
  imageSize = '1K',
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  referenceImage = null,
  fetchImpl = fetch,
}) {
  if (provider !== 'google') {
    throw new ProviderRequestError(provider, 400, 'image_provider_not_supported');
  }
  if (!model || !prompt) {
    throw new ProviderRequestError(provider, 400, 'provider_input_invalid');
  }
  const outputLimit = normalizeOutputTokenLimit(maxOutputTokens);

  const allowedRatios = new Set([
    '1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4',
    '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
  ]);
  const allowedSizes = new Set(['512', '1K', '2K', '4K']);
  if (!allowedRatios.has(aspectRatio) || !allowedSizes.has(imageSize)) {
    throw new ProviderRequestError(provider, 400, 'image_config_invalid');
  }

  const config = runtimeProvider('google');
  const input = referenceImage
    ? [
        { type: 'text', text: String(prompt) },
        {
          type: 'image',
          data: String(referenceImage.data || ''),
          mime_type: String(referenceImage.mimeType || 'image/png'),
        },
      ]
    : String(prompt);

  const body = await jsonRequest(
    'google',
    `${config.baseUrl.replace(/\/$/, '')}/v1beta/interactions`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': config.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input,
        generation_config: { max_output_tokens: outputLimit },
        response_format: {
          type: 'image',
          aspect_ratio: aspectRatio,
          image_size: imageSize,
        },
      }),
    },
    fetchImpl,
  );

  const images = interactionImages(body);
  if (images.length === 0) {
    throw new ProviderRequestError(provider, 502, 'image_output_missing', { chargeUnknown: true });
  }

  return {
    provider: 'google',
    model: body?.model || model,
    images,
    text: typeof body?.output_text === 'string' ? body.output_text : '',
    usage: interactionUsage(body),
    requestId: body?.id || body?.responseId || null,
  };
}

export async function executeProvider({
  provider,
  model,
  prompt,
  system = '',
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  fetchImpl = fetch,
}) {
  if (!model || !prompt) throw new ProviderRequestError(provider, 400, 'provider_input_invalid');
  const outputLimit = normalizeOutputTokenLimit(maxOutputTokens);
  const input = { model, prompt: String(prompt), system: String(system || ''), maxOutputTokens: outputLimit, fetchImpl };

  if (provider === 'openai') return executeOpenAI(input);
  if (provider === 'anthropic') return executeAnthropic(input);
  if (provider === 'google') return executeGoogle(input);
  throw new ProviderRequestError(provider, 400, 'provider_not_supported');
}
