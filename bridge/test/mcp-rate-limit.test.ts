import { describe, expect, it } from "vitest";

import { SlidingWindowRateLimiter } from "../src/mcp/rate-limit.js";

describe("SlidingWindowRateLimiter", () => {
  it("rejects calls beyond the limit until the window advances", () => {
    let now = 1_000;
    const limiter = new SlidingWindowRateLimiter(() => now);
    const policy = { maxCalls: 2, windowMs: 1_000 };

    expect(limiter.tryAcquire("say", policy)).toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
    now = 1_100;
    expect(limiter.tryAcquire("say", policy).allowed).toBe(true);
    now = 1_200;
    expect(limiter.tryAcquire("say", policy)).toEqual({
      allowed: false,
      retryAfterMs: 800,
    });

    now = 2_001;
    expect(limiter.tryAcquire("say", policy).allowed).toBe(true);
  });

  it("tracks tools independently", () => {
    const limiter = new SlidingWindowRateLimiter(() => 10);
    const policy = { maxCalls: 1, windowMs: 1_000 };

    expect(limiter.tryAcquire("say", policy).allowed).toBe(true);
    expect(limiter.tryAcquire("notify", policy).allowed).toBe(true);
    expect(limiter.tryAcquire("say", policy).allowed).toBe(false);
  });
});
