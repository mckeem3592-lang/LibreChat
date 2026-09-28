import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogModel } from './model-catalog.js';

test('catalog resolves current defaults', async () => {
  assert.equal(await catalogModel('openai', 'economy'), 'gpt-6-luna');
  assert.equal(await catalogModel('openai', 'primary'), 'gpt-6-sol');
  assert.equal(await catalogModel('openai', 'reasoning'), 'gpt-6-astra');
  assert.equal(await catalogModel('anthropic', 'coding'), 'claude-sonnet-5-5');
  assert.equal(await catalogModel('google', 'research'), 'gemini-3.8-flash');
  assert.equal(await catalogModel('google', 'image'), 'gemini-3.1-flash-image');
});
