import { providerConfig } from './providers.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 120000;

export class ProviderRequestError extends Error {
  constructor(provider, status, code = 'provider_request_failed') {
    super(code);
    this.name = 'ProviderRequestError';
    this.provider = provider;
    this.status = status;
    this.code = code;
  }
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
      signal: options.signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ProviderRequestError(provider, 504, 'provider_timeout');
    }
    throw new ProviderRequestError(provider, 502, 'provider_network_error');
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new ProviderRequestError(provider, response.status || 502, 'provider_invalid_response');
  }

  if (!response.ok) {
    const code =
      body?.error?.code ||
      body?.error?.type ||
      body?.error?.status ||
      'provider_http_error';
    throw new ProviderRequestError(provider, response.status, String(code));
  }

  return body;
}

function openAIText(body) {
  if (typeof body?.output_text === 'string') return body.output_text;
  return (body?.output || [])
    .flatMap((item) => item?.content || [])
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
      }),
    },
    fetchImpl,
  );

  return {
    provider: 'openai',
    model: body?.model || model,
    text: openAIText(body),
    usage: {
      inputTokens: Number(body?.usage?.input_tokens || 0),
      outputTokens: Number(body?.usage?.output_tokens || 0),
      cachedInputTokens: Number(body?.usage?.input_tokens_details?.cached_tokens || 0),
      cacheWriteTokens: Number(body?.usage?.input_tokens_details?.cache_write_tokens || 0),
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
    text: (body?.content || [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(''),
    usage: {
      inputTokens: Number(body?.usage?.input_tokens || 0),
      outputTokens: Number(body?.usage?.output_tokens || 0),
      cachedInputTokens: Number(body?.usage?.cache_read_input_tokens || 0),
      cacheWriteTokens: Number(body?.usage?.cache_creation_input_tokens || 0),
    },
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

  return {
    provider: 'google',
    model,
    text: (body?.candidates || [])
      .flatMap((candidate) => candidate?.content?.parts || [])
      .filter((part) => typeof part?.text === 'string')
      .map((part) => part.text)
      .join(''),
    usage: {
      inputTokens: Number(body?.usageMetadata?.promptTokenCount || 0),
      outputTokens: Number(body?.usageMetadata?.candidatesTokenCount || 0),
      cachedInputTokens: Number(body?.usageMetadata?.cachedContentTokenCount || 0),
      cacheWriteTokens: 0,
    },
    requestId: body?.responseId || null,
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
  const outputLimit = Math.min(Math.max(Number(maxOutputTokens) || DEFAULT_MAX_OUTPUT_TOKENS, 1), 32768);
  const input = { model, prompt: String(prompt), system: String(system || ''), maxOutputTokens: outputLimit, fetchImpl };

  if (provider === 'openai') return executeOpenAI(input);
  if (provider === 'anthropic') return executeAnthropic(input);
  if (provider === 'google') return executeGoogle(input);
  throw new ProviderRequestError(provider, 400, 'provider_not_supported');
}
