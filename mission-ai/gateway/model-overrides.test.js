import test from 'node:test';
import assert from 'node:assert/strict';
import { modelOverride, modelOverrideEnv } from './model-overrides.js';

test('uses explicit role environment mapping', () => {
  assert.equal(modelOverrideEnv('primary'), 'MISSION_AI_MODEL_PRIMARY');
  assert.equal(modelOverrideEnv('coding'), 'MISSION_AI_MODEL_CODING');
  assert.equal(modelOverrideEnv('unknown'), null);
});

test('trims configured model override without exposing other variables', () => {
  const previous = process.env.MISSION_AI_MODEL_PRIMARY;
  process.env.MISSION_AI_MODEL_PRIMARY = ' custom-primary ';
  try {
    assert.equal(modelOverride('primary'), 'custom-primary');
  } finally {
    if (previous === undefined) delete process.env.MISSION_AI_MODEL_PRIMARY;
    else process.env.MISSION_AI_MODEL_PRIMARY = previous;
  }
});
