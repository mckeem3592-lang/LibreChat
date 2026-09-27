import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogModel } from './model-catalog.js';

test('catalog resolves current defaults', async () => {
  assert.equal(await catalogModel('openai', 'primary'), 'gpt-5.6-sol');
  assert.equal(await catalogModel('anthropic', 'coding'), 'claude-sonnet-5');
  assert.equal(await catalogModel('google', 'research'), 'gemini-3.8-flash');
});
