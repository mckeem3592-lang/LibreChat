import crypto from 'node:crypto';

let consumed = false;
const attempts = new Map();

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function allowedAttempt(key, now = Date.now()) {
  const windowMs = 10 * 60 * 1000;
  const current = attempts.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    attempts.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 5;
}

export function pairDevice({ code, remoteAddress = '' } = {}) {
  const expected = process.env.MISSION_AI_PAIR_CODE || '';
  const deviceToken = process.env.MISSION_AI_DEVICE_TOKEN || '';
  const expiresAt = Date.parse(process.env.MISSION_AI_PAIR_EXPIRES_AT || '');

  if (!allowedAttempt(remoteAddress || 'unknown')) throw new Error('pair_rate_limited');
  if (!expected || !deviceToken || !Number.isFinite(expiresAt)) throw new Error('pairing_unavailable');
  if (Date.now() > expiresAt) throw new Error('pairing_expired');
  if (consumed) throw new Error('pairing_consumed');
  if (!safeEqual(code || '', expected)) throw new Error('pairing_invalid');

  consumed = true;
  return { deviceToken };
}

export function resetPairingForTests() {
  consumed = false;
  attempts.clear();
}
