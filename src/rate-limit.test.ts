import { describe, expect, test } from "bun:test";
import { FixedWindowRateLimiter } from "./rate-limit.js";

describe("FixedWindowRateLimiter", () => {
  test("allows a bounded number of requests and reports Retry-After", () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000);
    expect(limiter.allow("client", 0).allowed).toBe(true);
    expect(limiter.allow("client", 10).allowed).toBe(true);
    const denied = limiter.allow("client", 20);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(1);
    expect(limiter.allow("client", 1_000).allowed).toBe(true);
  });

  test("keeps separate buckets for separate keys", () => {
    const limiter = new FixedWindowRateLimiter(1, 1_000);
    expect(limiter.allow("a", 0).allowed).toBe(true);
    expect(limiter.allow("b", 0).allowed).toBe(true);
    expect(limiter.allow("a", 1).allowed).toBe(false);
  });

  test("bounds the number of tracked keys", () => {
    const limiter = new FixedWindowRateLimiter(5, 60_000, 2);
    limiter.allow("a", 0);
    limiter.allow("b", 1);
    limiter.allow("c", 2);
    expect(limiter.size).toBe(2);
  });

  test("rejects invalid configuration", () => {
    expect(() => new FixedWindowRateLimiter(0, 1_000)).toThrow();
    expect(() => new FixedWindowRateLimiter(1, 0)).toThrow();
    expect(() => new FixedWindowRateLimiter(1, 1_000, 0)).toThrow();
  });
});
