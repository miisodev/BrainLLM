export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: number;
}

/**
 * A small fixed-window limiter for the public HTTP surface.
 *
 * The process is single-instance in the supported deployment, so an in-memory
 * bucket is enough to stop password guessing, registration floods, and runaway
 * session creation without adding a shared store to a personal brain server.
 * `maxKeys` is a second, independent bound: an attacker must not be able to
 * turn a rate limiter into a memory leak by rotating source addresses.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number = 10_000
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("rate limit must be a positive integer");
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error("rate-limit window must be a positive integer");
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error("rate-limit maxKeys must be a positive integer");
  }

  allow(key: string, now: number = Date.now()): RateLimitDecision {
    const current = this.buckets.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      this.prune(now);
      return { allowed: true, remaining: this.limit - 1, retryAfterSeconds: 0, resetAt: now + this.windowMs };
    }

    if (current.count >= this.limit) {
      const resetAt = current.startedAt + this.windowMs;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
        resetAt,
      };
    }

    current.count += 1;
    return {
      allowed: true,
      remaining: this.limit - current.count,
      retryAfterSeconds: 0,
      resetAt: current.startedAt + this.windowMs,
    };
  }

  clear(): void {
    this.buckets.clear();
  }

  get size(): number {
    return this.buckets.size;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= this.windowMs) this.buckets.delete(key);
    }
    if (this.buckets.size <= this.maxKeys) return;

    const ordered = [...this.buckets.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
    for (const [key] of ordered.slice(0, this.buckets.size - this.maxKeys)) this.buckets.delete(key);
  }
}
