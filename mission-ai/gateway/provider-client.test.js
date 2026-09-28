import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeProvider,
  executeImageProvider,
  normalizeOutputTokenLimit,
  ProviderRequestError,
} from './provider-client.js';

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
          service_tier: 'default',
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
    assert.equal(JSON.parse(request.options.body).service_tier, 'default');
    assert.equal(result.serviceTier, 'default');
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
      maxOutputTokens: 6000,
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
    assert.equal(sent.generation_config.max_output_tokens, 6000);
    assert.equal(request.options.redirect, 'error');
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

test('output limits are validated once without silently defaulting or clamping', async () => {
  assert.equal(normalizeOutputTokenLimit(), 4096);
  assert.equal(normalizeOutputTokenLimit(1), 1);
  assert.equal(normalizeOutputTokenLimit(32768), 32768);
  let calls = 0;
  for (const value of [0, null, false, '10', -1, 0.5, 32769, NaN, Infinity]) {
    await assert.rejects(() => executeProvider({
      provider: 'openai', model: 'gpt-6-sol', prompt: 'hello', maxOutputTokens: value,
      fetchImpl: async () => { calls += 1; },
    }), (error) => error.code === 'provider_input_invalid' && !error.chargeUnknown);
    await assert.rejects(() => executeImageProvider({
      model: 'gemini-3.1-flash-image', prompt: 'moon', maxOutputTokens: value,
      fetchImpl: async () => { calls += 1; },
    }), (error) => error.code === 'provider_input_invalid' && !error.chargeUnknown);
  }
  assert.equal(calls, 0);
});

test('Gemini bills both candidate and thought tokens including thought-only truncation', async () => {
  await withEnv({ GEMINI_API_KEY: 'test-key' }, async () => {
    for (const candidateTokens of [6, undefined]) {
      const output = await executeProvider({
        provider: 'google', model: 'gemini-3.8-flash', prompt: 'research',
        fetchImpl: async () => mockResponse({
          candidates: [],
          usageMetadata: {
            promptTokenCount: 10, thoughtsTokenCount: 20,
            ...(candidateTokens === undefined ? {} : { candidatesTokenCount: candidateTokens }),
          },
        }),
      });
      assert.equal(output.usage.outputTokens, 20 + (candidateTokens || 0));
    }
  });
});

test('missing or invalid provider usage is an uncertain charge rather than free usage', async () => {
  await withEnv({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' }, async () => {
    const cases = [
      ['openai', 'gpt-6-sol', {}],
      ['openai', 'gpt-6-sol', { usage: {} }],
      ['openai', 'gpt-6-sol', { usage: { input_tokens: 1, output_tokens: NaN } }],
      ['openai', 'gpt-6-sol', { usage: { input_tokens: 1, output_tokens: -1 } }],
      ['openai', 'gpt-6-sol', { usage: { input_tokens: 1, output_tokens: '2' } }],
      ['openai', 'gpt-6-sol', { usage: { input_tokens: 1, output_tokens: 2,
        input_tokens_details: { cached_tokens: 2 } } }],
      ['anthropic', 'claude-sonnet-5', {}],
      ['anthropic', 'claude-sonnet-5', { usage: { input_tokens: 1, output_tokens: 2,
        cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 3 } } }],
      ['google', 'gemini-3.8-flash', {}],
      ['google', 'gemini-3.8-flash', { usageMetadata: { promptTokenCount: 1 } }],
      ['google', 'gemini-3.8-flash', { usageMetadata: { promptTokenCount: 1,
        candidatesTokenCount: 2, thoughtsTokenCount: -1 } }],
    ];
    for (const [provider, model, body] of cases) {
      await assert.rejects(() => executeProvider({
        provider, model, prompt: 'hello', fetchImpl: async () => mockResponse(body),
      }), (error) => error instanceof ProviderRequestError &&
        error.code === 'provider_usage_invalid' && error.chargeUnknown);
    }
  });
});

test('provider transport and response errors preserve charge uncertainty and safe error codes', async () => {
  await withEnv({ OPENAI_API_KEY: 'secret-never-log' }, async () => {
    const cases = [
      [async () => { throw new Error('secret-never-log'); }, true, 'provider_network_error'],
      [async () => { throw Object.assign(new Error('secret-never-log'), { name: 'TimeoutError' }); }, true, 'provider_timeout'],
      [async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('secret-never-log'); } }), true, 'provider_invalid_response'],
      [async () => ({ ok: true, status: 200, json: async () => { throw Object.assign(new Error(), { name: 'AbortError' }); } }), true, 'provider_invalid_response'],
      [async () => mockResponse(null), true, 'provider_invalid_response'],
      [async () => mockResponse({ error: { code: 'secret-never-log' } }, 503), true, 'provider_http_error'],
      [async () => mockResponse({ error: { code: 'secret-never-log' } }, 408), true, 'provider_http_error'],
      [async () => mockResponse({ error: { code: 'secret-never-log' } }, 401), false, 'provider_http_error'],
      [async () => mockResponse({ error: { code: 'secret-never-log' } }, 429), false, 'provider_http_error'],
    ];
    for (const [fetchImpl, chargeUnknown, code] of cases) {
      await assert.rejects(() => executeProvider({
        provider: 'openai', model: 'gpt-6-sol', prompt: 'hello', fetchImpl,
      }), (error) => {
        assert.equal(error.chargeUnknown, chargeUnknown);
        assert.equal(error.code, code);
        assert.equal(JSON.stringify(error).includes('secret-never-log'), false);
        return true;
      });
    }
  });
});

test('malformed successful output is still a possibly billed request', async () => {
  await withEnv({ OPENAI_API_KEY: 'o' }, async () => {
    await assert.rejects(() => executeProvider({
      provider: 'openai', model: 'gpt-6-sol', prompt: 'hello',
      fetchImpl: async () => mockResponse({
        output: {}, service_tier: 'default', usage: { input_tokens: 1, output_tokens: 2 },
      }),
    }), (error) => error.code === 'provider_invalid_response' && error.chargeUnknown);
  });
});

test('OpenAI rejects missing or nonstandard reported service tiers as uncertain billing', async () => {
  await withEnv({ OPENAI_API_KEY: 'test-key' }, async () => {
    for (const serviceTier of [undefined, null, 'auto', 'priority', 'fast', 'ultrafast', 'flex', 'scale', 'unknown']) {
      await assert.rejects(() => executeProvider({
        provider: 'openai', model: 'gpt-6-sol', prompt: 'hello',
        fetchImpl: async (_url, options) => {
          assert.equal(JSON.parse(options.body).service_tier, 'default');
          return mockResponse({
            output_text: 'OK', usage: { input_tokens: 1, output_tokens: 2 },
            ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
          });
        },
      }), (error) => error instanceof ProviderRequestError &&
        error.code === 'provider_service_tier_unverified' && error.chargeUnknown);
    }
  });
});

test('image usage includes text and thoughts without double-counting image tokens', async () => {
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    const result = await executeImageProvider({
      model: 'gemini-3.1-flash-image', prompt: 'moon',
      fetchImpl: async () => mockResponse({
        output_image: { data: 'aW1hZ2U=' },
        usage: {
          total_input_tokens: 10, total_output_tokens: 1130, total_thought_tokens: 20,
          output_tokens_by_modality: [{ modality: 'image', tokens: 1120 }, { modality: 'text', tokens: 10 }],
        },
      }),
    });
    assert.equal(result.usage.outputTokens, 30);
    assert.equal(result.usage.imageOutputTokens, 1120);
  });
});

test('missing image output or missing and inconsistent usage retains charge uncertainty', async () => {
  await withEnv({ GEMINI_API_KEY: 'g' }, async () => {
    for (const body of [
      {},
      { output_image: { data: 'aW1hZ2U=' } },
      { output_image: { data: 'aW1hZ2U=' }, usage: {
        total_input_tokens: 10, total_output_tokens: 1130,
        output_tokens_by_modality: [{ modality: 'image', tokens: 1000 }],
      } },
    ]) {
      await assert.rejects(() => executeImageProvider({
        model: 'gemini-3.1-flash-image', prompt: 'moon',
        fetchImpl: async () => mockResponse(body),
      }), (error) => error instanceof ProviderRequestError && error.chargeUnknown);
    }
  });
});
