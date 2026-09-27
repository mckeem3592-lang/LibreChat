import test from 'node:test';
import assert from 'node:assert/strict';
import { providerConfig } from './providers.js';

test('provider status exposes readiness without credential values', () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'x';
  try {
    const value = providerConfig('openai');
    assert.equal(value.hasApiKey, true);
    assert.equal(Object.hasOwn(value, 'apiKey'), false);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('google prefers GEMINI_API_KEY and remains compatible with GOOGLE_KEY', () => {
  const gemini = process.env.GEMINI_API_KEY;
  const legacy = process.env.GOOGLE_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_KEY = 'legacy';
    assert.equal(providerConfig('google').apiKeyEnv, 'GOOGLE_KEY');
    assert.equal(providerConfig('google').hasApiKey, true);

    process.env.GEMINI_API_KEY = 'official';
    assert.equal(providerConfig('google').apiKeyEnv, 'GEMINI_API_KEY');
    assert.equal(providerConfig('google').hasApiKey, true);
  } finally {
    if (gemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = gemini;
    if (legacy === undefined) delete process.env.GOOGLE_KEY;
    else process.env.GOOGLE_KEY = legacy;
  }
});
