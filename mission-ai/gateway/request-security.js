import { auditEvent } from './audit-log.js';
import { FixedWindowLimiter } from './rate-limit.js';

function requestAction(req) {
  const method = String(req?.method || 'UNKNOWN').toUpperCase();
  const base = String(req?.baseUrl || '');
  const path = String(req?.path || req?.url || '');
  return `${method} ${base}${path}`.slice(0, 96);
}

function requestDeviceId(req) {
  const value = req?.body?.deviceId;
  return typeof value === 'string' ? value : '';
}

export function createRequestSecurity({
  windowMs = 60_000,
  max = 240,
  now = () => Date.now(),
  audit = auditEvent,
} = {}) {
  const limiter = new FixedWindowLimiter({ windowMs, max });
  let seen = 0;

  return function requestSecurity(req, res, next) {
    const startedAt = now();
    const key = String(req?.ip || req?.socket?.remoteAddress || 'unknown');

    seen += 1;
    if (seen % 256 === 0) limiter.prune(startedAt);

    if (!limiter.allow(key, startedAt)) {
      audit({
        action: requestAction(req),
        deviceId: requestDeviceId(req),
        outcome: 'rate_limited',
        statusCode: 429,
        durationMs: 0,
        at: new Date(startedAt),
      });
      res.set('retry-after', String(Math.max(1, Math.ceil(windowMs / 1000))));
      res.status(429).json({ ok: false, error: 'rate_limited' });
      return;
    }

    res.once('finish', () => {
      const statusCode = Number(res.statusCode) || 500;
      audit({
        action: requestAction(req),
        deviceId: requestDeviceId(req),
        outcome: statusCode < 400 ? 'ok' : 'error',
        statusCode,
        durationMs: Math.max(0, now() - startedAt),
        at: new Date(startedAt),
      });
    });

    next();
  };
}
