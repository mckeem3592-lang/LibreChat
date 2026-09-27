import test from 'node:test';
import assert from 'node:assert/strict';
import { monthStartFor } from './budget-time.mjs';

test('Denver winter month starts at 07:00 UTC', () => {
  const value = monthStartFor(new Date('2026-02-15T12:00:00Z'), 'America/Denver');
  assert.equal(value.toISOString(), '2026-02-01T07:00:00.000Z');
});

test('Denver summer month starts at 06:00 UTC', () => {
  const value = monthStartFor(new Date('2026-07-15T12:00:00Z'), 'America/Denver');
  assert.equal(value.toISOString(), '2026-07-01T06:00:00.000Z');
});

test('UTC month starts at midnight UTC', () => {
  const value = monthStartFor(new Date('2026-09-27T00:00:00Z'), 'UTC');
  assert.equal(value.toISOString(), '2026-09-01T00:00:00.000Z');
});
