import assert from 'node:assert/strict';
import test from 'node:test';
import { normalClaudePolicy } from './normal-claude.js';

const env = {
  MISSION_AI_NORMAL_CLAUDE_ENABLED: 'true',
  MISSION_AI_NATIVE_ENABLED: 'false',
  MISSION_AI_DELEGATION_ENABLED: 'false',
  MISSION_AI_ACCEPTANCE_SCOPE: 'disabled',
};

test('normal Claude requires exact independent gates', () => {
  assert.deepEqual(normalClaudePolicy(env), { maxOutputTokens: 4096, maxReservationUsd: 1 });
  for (const [key, value] of [
    ['MISSION_AI_NORMAL_CLAUDE_ENABLED', 'false'],
    ['MISSION_AI_NATIVE_ENABLED', 'true'],
    ['MISSION_AI_DELEGATION_ENABLED', 'true'],
    ['MISSION_AI_ACCEPTANCE_SCOPE', 'final-workflows'],
  ]) assert.equal(normalClaudePolicy({ ...env, [key]: value }), null);
  assert.equal(normalClaudePolicy({}), null);
});
