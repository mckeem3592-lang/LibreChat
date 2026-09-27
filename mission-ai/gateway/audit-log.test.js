import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAuditEvent } from './audit-log.js';

test('audit event keeps metadata only', () => {
  const event = buildAuditEvent({
    action: 'browser.type',
    deviceId: 'mac-primary',
    outcome: 'ok',
    statusCode: 200,
    durationMs: 12.4,
    at: new Date('2026-09-27T08:00:00Z'),
    args: { text: 'sample payload' },
  });

  assert.deepEqual(event, {
    type: 'mission_ai_audit',
    at: '2026-09-27T08:00:00.000Z',
    action: 'browser.type',
    outcome: 'ok',
    statusCode: 200,
    durationMs: 12,
    deviceId: 'mac-primary',
  });
  assert.equal(JSON.stringify(event).includes('sample payload'), false);
});

test('audit event normalizes control characters', () => {
  const event = buildAuditEvent({
    action: 'mac.click\nextra',
    outcome: 'error\tcase',
    statusCode: 200.5,
    durationMs: -1,
    at: '2026-09-27T08:00:00Z',
  });

  assert.equal(event.action, 'mac.click extra');
  assert.equal(event.outcome, 'error case');
  assert.equal(event.statusCode, null);
  assert.equal(event.durationMs, null);
});
