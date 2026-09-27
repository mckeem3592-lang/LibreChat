function clean(value, max = 96) {
  return String(value ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, max);
}

export function buildAuditEvent({
  action,
  deviceId = '',
  outcome,
  statusCode,
  durationMs,
  at = new Date(),
} = {}) {
  const event = {
    type: 'mission_ai_audit',
    at: at instanceof Date ? at.toISOString() : new Date(at).toISOString(),
    action: clean(action),
    outcome: clean(outcome, 32),
    statusCode: Number.isInteger(statusCode) ? statusCode : null,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null,
  };

  const safeDeviceId = clean(deviceId, 64);
  if (safeDeviceId) event.deviceId = safeDeviceId;
  return event;
}

export function auditEvent(input) {
  console.log(JSON.stringify(buildAuditEvent(input)));
}
