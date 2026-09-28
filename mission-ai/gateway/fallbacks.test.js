import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseAvailableTarget, fallbackPlan, parseTarget } from './fallbacks.js';

const policy = {
  roles: {
    coding: ['anthropic:coding', 'openai:primary'],
    research: ['google:research', 'openai:primary'],
  },
};

test('parses provider role targets', () => {
  assert.deepEqual(parseTarget('anthropic:coding'), { provider: 'anthropic', role: 'coding' });
  assert.throws(() => parseTarget('bad'), /invalid_fallback_target/);
});

test('missing first target fails closed even when another provider is ready', () => {
  const selected = chooseAvailableTarget(
    ['anthropic:coding', 'openai:primary', 'google:research'],
    { anthropic: false, openai: true, google: true },
  );
  assert.equal(selected, null);
});

test('reports bounded unavailable plan when every provider is down', async () => {
  const plan = await fallbackPlan('coding', {
    policy,
    readiness: { anthropic: false, openai: false, google: false },
  });
  assert.equal(plan.available, false);
  assert.equal(plan.attempts, 1);
  assert.deepEqual(plan.targets, [
    { provider: 'anthropic', role: 'coding' },
  ]);
});

test('coding does not select OpenAI when Anthropic is unavailable', async () => {
  const plan = await fallbackPlan('coding', {
    policy,
    readiness: { anthropic: false, openai: true, google: false },
  });
  assert.equal(plan.available, false);
  assert.equal(plan.attempts, 1);
});
