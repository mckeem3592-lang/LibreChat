export class FixedWindowLimiter {
  constructor({ windowMs = 60_000, max = 120 } = {}) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('invalid_window');
    if (!Number.isInteger(max) || max <= 0) throw new Error('invalid_max');
    this.windowMs = windowMs;
    this.max = max;
    this.entries = new Map();
  }

  allow(key, now = Date.now()) {
    const id = String(key || 'unknown');
    const current = this.entries.get(id);
    if (!current || now >= current.resetAt) {
      this.entries.set(id, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.max) return false;
    current.count += 1;
    return true;
  }

  prune(now = Date.now()) {
    for (const [key, value] of this.entries) {
      if (now >= value.resetAt) this.entries.delete(key);
    }
  }
}
