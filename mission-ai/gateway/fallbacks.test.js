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

test('selects the first available target without retry loops', () => {
  const selected = chooseAvailableTarget(
    ['anthropic:coding', 'openai:primary', 'google:research'],
    { anthropic: false, openai: true, google: true },
  );
  assert.deepEqual(selected, { provider: 'openai', role: 'primary' });
});

test('reports bounded unavailable plan when every provider is down', async () => {
  const plan = await fallbackPlan('coding', {
    policy,
    readiness: { anthropic: false, openai: false, google: false },
  });
  assert.equal(plan.available, false);
  assert.equal(plan.attempts, 2);
  assert.deepEqual(plan.targets, [
    { provider: 'anthropic', role: 'coding' },
    { provider: 'openai', role: 'primary' },
  ]);
});

test('coding falls back from Anthropic to OpenAI', async () => {
  const plan = await fallbackPlan('coding', {
    policy,
    readiness: { anthropic: false, openai: true, google: false },
  });
  assert.equal(plan.available, true);
  assert.equal(plan.attempts, 2);
  assert.equal(plan.selected.provider, 'openai');
  assert.equal(plan.selected.role, 'primary');
  assert.ok(plan.selected.model);
});
