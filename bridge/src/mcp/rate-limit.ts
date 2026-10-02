export interface RateLimitPolicy {
  readonly maxCalls: number;
  readonly windowMs: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

export class SlidingWindowRateLimiter {
  readonly #timestamps = new Map<string, number[]>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  tryAcquire(key: string, policy: RateLimitPolicy): RateLimitResult {
    if (policy.maxCalls < 1 || policy.windowMs < 1) {
      throw new RangeError("Rate-limit values must be positive.");
    }

    const now = this.#now();
    const cutoff = now - policy.windowMs;
    const recent = (this.#timestamps.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );

    if (recent.length >= policy.maxCalls) {
      this.#timestamps.set(key, recent);
      return {
        allowed: false,
        retryAfterMs: Math.max(1, recent[0] + policy.windowMs - now),
      };
    }

    recent.push(now);
    this.#timestamps.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}
