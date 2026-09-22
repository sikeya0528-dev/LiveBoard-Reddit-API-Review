const asNum = (value, fallback = NaN) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function parseRetryAfter(value, nowMs) {
  if (value == null) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(String(value));
  return Number.isFinite(when) ? Math.max(0, when - nowMs) : 0;
}

export class WsbRateBudget {
  constructor({ maxPerMinute = 60, now = () => Date.now() } = {}) {
    this.maxPerMinute = maxPerMinute;
    this.now = now;
    this.requests = [];
    this.serverBlockedUntil = 0;
    this.backoffUntil = 0;
    this.failures = 0;
    this.lastHeaders = null;
    this.serverRemaining = null;
    this.serverResetAt = 0;
  }

  #prune(nowMs) { this.requests = this.requests.filter(ts => nowMs - ts < 60_000); }

  status(nowMs = this.now()) {
    this.#prune(nowMs);
    if (this.serverResetAt && nowMs >= this.serverResetAt) { this.serverRemaining = null; this.serverResetAt = 0; }
    let nextAllowedAt = Math.max(this.serverBlockedUntil, this.backoffUntil);
    if (this.requests.length >= this.maxPerMinute) nextAllowedAt = Math.max(nextAllowedAt, this.requests[0] + 60_000);
    if (this.serverRemaining !== null && this.serverRemaining <= 0 && this.serverResetAt > nowMs) nextAllowedAt = Math.max(nextAllowedAt, this.serverResetAt);
    return Object.freeze({
      allowed: nowMs >= nextAllowedAt && this.requests.length < this.maxPerMinute && !(this.serverRemaining !== null && this.serverRemaining <= 0 && this.serverResetAt > nowMs),
      usedLastMinute: this.requests.length,
      maxPerMinute: this.maxPerMinute,
      nextAllowedAt,
      serverBlockedUntil: this.serverBlockedUntil,
      backoffUntil: this.backoffUntil,
      serverRemaining: this.serverRemaining,
      serverResetAt: this.serverResetAt
    });
  }

  reserve(nowMs = this.now()) {
    const status = this.status(nowMs);
    if (!status.allowed) return Object.freeze({ ok: false, ...status });
    this.requests.push(nowMs);
    if (this.serverRemaining !== null && this.serverResetAt > nowMs) this.serverRemaining = Math.max(0, this.serverRemaining - 1);
    return Object.freeze({ ok: true, usedLastMinute: this.requests.length, maxPerMinute: this.maxPerMinute, serverRemaining: this.serverRemaining });
  }

  recordResponse({ status = 200, headers = {} } = {}, nowMs = this.now()) {
    const lower = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
    this.lastHeaders = lower;
    if (status === 429) {
      const retryMs = parseRetryAfter(lower['retry-after'], nowMs) || Math.min(60_000, 1_000 * 2 ** Math.min(this.failures, 6));
      this.serverBlockedUntil = Math.max(this.serverBlockedUntil, nowMs + retryMs);
      this.failures += 1;
    } else if (status >= 500) {
      this.failures += 1;
      const retryMs = Math.min(60_000, 1_000 * 2 ** Math.min(this.failures - 1, 6));
      this.backoffUntil = Math.max(this.backoffUntil, nowMs + retryMs);
    } else {
      this.failures = 0;
      this.backoffUntil = 0;
    }

    const remaining = asNum(lower['x-ratelimit-remaining']);
    const resetSeconds = asNum(lower['x-ratelimit-reset']);
    if (Number.isFinite(remaining)) this.serverRemaining = Math.max(0, remaining);
    if (Number.isFinite(resetSeconds)) this.serverResetAt = nowMs + Math.max(0, resetSeconds * 1000);
    if (Number.isFinite(remaining) && remaining <= 0 && Number.isFinite(resetSeconds)) {
      this.serverBlockedUntil = Math.max(this.serverBlockedUntil, this.serverResetAt);
    }
    return this.status(nowMs);
  }
}
