import assert from 'node:assert/strict';
import test from 'node:test';
import { executeProvider, executeImageProvider, ProviderRequestError } from './provider-client.js';

function withEnv(values, fn) {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.entries(values).forEach(([key, value]) => {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Object.entries(original).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    });
}

function mockResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test('OpenAI adapter uses Responses API and normalizes usage', async () => {
  await withEnv({ OPENAI_API_KEY: 'secret' }, async () => {
    let request;
    const result = await executeProvider({
      provider: 'openai',
      model: 'gpt-6-sol',
      prompt: 'hello',
      system: 'system',
      fetchImpl: async (url, options) => {
        request = { url, options };
        return mockResponse({
          id: 'resp_1',
          model: 'gpt-6-sol',
          output: [{ content: [{ type: 'output_text', text: 'hi' }] }],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            input_tokens_details: { cached_tokens: 3 },
          },
        });
      },
    });
    assert.match(request.url, /\/responses$/);
    assert.equal(JSON.parse(request.options.body).input, 'hello');
    assert.equal(request.options.headers.authorization, 'Bearer secret');
    assert.equal(result.text, 'hi');
    assert.deepEqual(result.usage, {
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 3,
      cacheWriteTokens: 0,
    });
  });
});

test('Anthropic adapter uses Messages API without unsupported sampling params', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'secret' }, async () => {
    let request;
    const result = await executeProvider({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      prompt: 'fix code',
      fetchImpl: async (url, options) => {
        request = { url, options };
        return mockResponse({
          id: 'msg_1',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'fixed' }],
          usage: {
            input_tokens: 12,
            output_tokens: 8,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 5,
            cache_creation: {
              ephemeral_5m_input_tokens: 3,
              ephemeral_1h_input_tokens: 2,
            },
          },
        });
      },
    });
    const sent = JSON.parse(request.options.body);
    assert.match(request.url, /\/v1\/messages$/);
    assert.equal(sent.temperature, undefined);
    assert.equal(request.options.headers['x-api-key'], 'secret');
    assert.equal(result.text, 'fixed');
    assert.equal(result.usage.cacheWriteTokens, 5);
    assert.equal(result.usage.cacheWrite5mTokens, 3);
    assert.equal(result.usage.cacheWrite1hTokens, 2);
  });
});

test('Anthropic cache usage falls back to combined creation count when TTL detail is absent', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'secret' }, async () => {
    const result = await executeProvider({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      prompt: 'fix code',
      fetchImpl: async () =>
        mockResponse({
          id: 'msg_2',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'fixed' }],
          usage: {
            input_tokens: 12,
            output_tokens: 8,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 4,
          },
        }),
    });
    assert.equal(result.usage.cacheWriteTokens, 4);
    assert.equal(result.usage.cacheWrite5mTokens, 4);
    assert.equal(result.usage.cacheWrite1hTokens, 0);
  });
});

test('Google adapter uses generateContent and official API key header', async () => {
  await withEnv({ GEMINI_API_KEY: 'secret', GOOGLE_KEY: null }, async () => {
    let request;
    const result = await executeProvider({
      provider: 'google',
      model: 'gemini-3.8-flash',
      prompt: 'research',
      fetchImpl: async (url, options) => {
        request = { url, options };
        return mockResponse({
          responseId: 'google_1',
          candidates: [{ content: { parts: [{ text: 'result' }] } }],
          usageMetadata: {
            promptTokenCount: 9,
            candidatesTokenCount: 6,
            cachedContentTokenCount: 2,
          },
        });
      },
    });
    assert.match(request.url, /gemini-3\.8-flash:generateContent$/);
    assert.equal(request.options.headers['x-goog-api-key'], 'secret');
    assert.equal(result.text, 'result');
    assert.equal(result.usage.cachedInputTokens, 2);
  });
});

test('provider errors do not expose credential values', async () => {
  await withEnv({ OPENAI_API_KEY: 'do-not-leak' }, async () => {
    await assert.rejects(
      () =>
        executeProvider({
          provider: 'openai',
          model: 'gpt-6-sol',
          prompt: 'hello',
          fetchImpl: async () => mockResponse({ error: { code: 'rate_limit' } }, 429),
        }),
      (error) => {
        assert.ok(error instanceof ProviderRequestError);
        assert.equal(error.status, 429);
        assert.equal(String(error).includes('do-not-leak'), false);
        return true;
      },
    );
  });
});

test('Gemini image adapter parses base64 image output and modality usage', async () => {
  await withEnv({ GEMINI_API_KEY: 'secret', GOOGLE_KEY: null }, async () => {
    let request;
    const result = await executeImageProvider({
      model: 'gemini-3.1-flash-image',
      prompt: 'draw a moon',
      aspectRatio: '16:9',
      imageSize: '2K',
      fetchImpl: async (url, options) => {
        request = { url, options };
        return mockResponse({
          id: 'img_1',
          model: 'gemini-3.1-flash-image',
          steps: [
            {
              type: 'model_output',
              content: [
                {
                  type: 'image',
                  data: 'aW1hZ2U=',
                  mime_type: 'image/png',
                },
              ],
            },
          ],
          usage: {
            total_input_tokens: 12,
            total_output_tokens: 1680,
            output_tokens_by_modality: [
              { modality: 'image', tokens: 1680 },
            ],
          },
        });
      },
    });

    const sent = JSON.parse(request.options.body);
    assert.match(request.url, /\/v1beta\/interactions$/);
    assert.equal(sent.response_format.aspect_ratio, '16:9');
    assert.equal(sent.response_format.image_size, '2K');
    assert.deepEqual(result.images, [{ data: 'aW1hZ2U=', mimeType: 'image/png' }]);
    assert.equal(result.usage.outputTokens, 0);
    assert.equal(result.usage.imageOutputTokens, 1680);
  });
});

test('Gemini image adapter supports reference-image editing without logging credentials', async () => {
  await withEnv({ GEMINI_API_KEY: 'secret', GOOGLE_KEY: null }, async () => {
    let request;
    const result = await executeImageProvider({
      model: 'gemini-3.1-flash-image',
      prompt: 'make the sky darker',
      referenceImage: { data: 'cmVm', mimeType: 'image/png' },
      fetchImpl: async (_url, options) => {
        request = options;
        return mockResponse({
          id: 'img_2',
          output_image: { data: 'ZWRpdA==', mime_type: 'image/png' },
          usage: {
            total_input_tokens: 300,
            total_output_tokens: 1120,
            output_tokens_by_modality: [{ modality: 'image', tokens: 1120 }],
          },
        });
      },
    });

    const sent = JSON.parse(request.body);
    assert.equal(Array.isArray(sent.input), true);
    assert.deepEqual(sent.input[1], {
      type: 'image',
      data: 'cmVm',
      mime_type: 'image/png',
    });
    assert.equal(result.images[0].data, 'ZWRpdA==');
  });
});
