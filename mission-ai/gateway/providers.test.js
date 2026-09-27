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
