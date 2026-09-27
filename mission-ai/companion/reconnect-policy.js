export function reconnectDelayMs(attempt, { baseMs = 1000, maxMs = 60000 } = {}) {
  const count = Number.isInteger(attempt) && attempt >= 0 ? attempt : 0;
  if (!Number.isFinite(baseMs) || baseMs <= 0) throw new Error('invalid_base_delay');
  if (!Number.isFinite(maxMs) || maxMs < baseMs) throw new Error('invalid_max_delay');
  return Math.min(maxMs, baseMs * (2 ** Math.min(count, 16)));
}
