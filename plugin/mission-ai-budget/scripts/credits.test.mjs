import test from 'node:test';
import assert from 'node:assert/strict';
import { creditsToUsd, usdToCredits } from './credits.mjs';

test('credit conversion is reversible for whole dollars', () => {
  assert.equal(creditsToUsd(1_000_000), 1);
  assert.equal(usdToCredits(1), 1_000_000);
});
