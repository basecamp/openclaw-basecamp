import { describe, expect, it, vi } from "vitest";
import { isRetryableError, withRetry } from "../src/retry.js";

// ---------------------------------------------------------------------------
// isRetryableError — only TypeError with fetch-related messages
// ---------------------------------------------------------------------------

describe("isRetryableError", () => {
  it("returns true for TypeError with 'fetch' in message", () => {
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
  });

  it("returns true for TypeError with 'Failed to fetch'", () => {
    expect(isRetryableError(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("returns true for TypeError with 'network' in message", () => {
    expect(isRetryableError(new TypeError("network error during fetch"))).toBe(true);
  });

  it("returns true for TypeError with 'econnrefused'", () => {
    expect(isRetryableError(new TypeError("connect ECONNREFUSED 127.0.0.1:443"))).toBe(true);
  });

  it("returns true for TypeError with 'econnreset'", () => {
    expect(isRetryableError(new TypeError("socket hang up ECONNRESET"))).toBe(true);
  });

  it("returns true for TypeError with 'etimedout'", () => {
    expect(isRetryableError(new TypeError("connect ETIMEDOUT 1.2.3.4:443"))).toBe(true);
  });

  it("returns false for TypeError with unrelated message", () => {
    expect(isRetryableError(new TypeError("Cannot read property 'x' of undefined"))).toBe(false);
  });

  it("returns false for regular Error", () => {
    expect(isRetryableError(new Error("fetch failed"))).toBe(false);
  });

  it("returns false for non-Error objects", () => {
    expect(isRetryableError({ message: "fetch failed" })).toBe(false);
  });

  it("returns false for string errors", () => {
    expect(isRetryableError("ETIMEDOUT")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  const fast = { baseDelayMs: 1, maxDelayMs: 4, jitter: false };

  it("retries on retryable TypeError and succeeds on 2nd attempt", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce({ data: "ok" });

    const result = await withRetry(fn, { ...fast, maxAttempts: 3 });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ data: "ok" });
  });

  it("does not retry on non-TypeError", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("server error 500"));

    await expect(withRetry(fn, { ...fast, maxAttempts: 3 })).rejects.toThrow("server error 500");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on TypeError with non-fetch message", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TypeError("Cannot read property 'x'"));

    await expect(withRetry(fn, { ...fast, maxAttempts: 3 })).rejects.toThrow("Cannot read property 'x'");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects maxAttempts limit", async () => {
    const fn = vi.fn().mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(withRetry(fn, { ...fast, maxAttempts: 4 })).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("applies exponential backoff (delays increase)", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });

    const origSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((cb: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (typeof ms === "number" && ms > 0) delays.push(ms);
        return origSetTimeout(cb, 0, ...args);
      });

    await expect(withRetry(fn, { maxAttempts: 4, baseDelayMs: 100, jitter: false })).rejects.toThrow();

    expect(delays).toEqual([100, 200, 400]);
    timeoutSpy.mockRestore();
  });

  it("applies jitter when enabled (delay is reduced up to 25%)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // max jitter: 25% reduction
    const delays: number[] = [];
    const fn = vi.fn().mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });

    const origSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((cb: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (typeof ms === "number" && ms > 0) delays.push(ms);
        return origSetTimeout(cb, 0, ...args);
      });

    await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 1000, jitter: true })).rejects.toThrow();

    // With random()=1, jitter = 1000 * 1 * 0.25 = 250, so delay = 750
    expect(delays).toEqual([750]);
    timeoutSpy.mockRestore();
    vi.spyOn(Math, "random").mockRestore();
  });

  it("custom retryable function overrides default", async () => {
    // Regular Error is normally not retryable, but custom function says yes
    const fn = vi.fn().mockRejectedValueOnce(new Error("server error")).mockResolvedValueOnce({ data: "found" });

    const result = await withRetry(fn, {
      ...fast,
      maxAttempts: 3,
      retryable: () => true,
    });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ data: "found" });
  });

  it("caps delay at maxDelayMs", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });

    const origSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((cb: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (typeof ms === "number" && ms > 0) delays.push(ms);
        return origSetTimeout(cb, 0, ...args);
      });

    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 3000, jitter: false }),
    ).rejects.toThrow();

    expect(delays).toEqual([1000, 2000, 3000, 3000]);
    timeoutSpy.mockRestore();
  });

  it("rethrows non-retryable error immediately", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("not retryable"));

    await expect(withRetry(fn, { ...fast, maxAttempts: 3 })).rejects.toThrow("not retryable");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
