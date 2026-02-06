import { describe, it, expect, vi } from "vitest";
import { BcqError, isRetryableError, withRetry } from "../src/bcq.js";

function bcqErr(
  exitCode: number | null,
  stderr: string,
  message = "bcq failed",
): BcqError {
  return new BcqError(message, exitCode, stderr, ["bcq"]);
}

// ---------------------------------------------------------------------------
// isRetryableError
// ---------------------------------------------------------------------------

describe("isRetryableError", () => {
  it("returns true for ETIMEDOUT", () => {
    expect(isRetryableError(bcqErr(1, "connect ETIMEDOUT 1.2.3.4:443"))).toBe(true);
  });

  it("returns true for ECONNREFUSED", () => {
    expect(isRetryableError(bcqErr(1, "connect ECONNREFUSED 127.0.0.1:443"))).toBe(true);
  });

  it("returns true for ECONNRESET", () => {
    expect(isRetryableError(bcqErr(1, "socket hang up ECONNRESET"))).toBe(true);
  });

  it("returns true for 502 server error", () => {
    expect(isRetryableError(bcqErr(1, "HTTP 502 Bad Gateway"))).toBe(true);
  });

  it("returns true for 503 server error", () => {
    expect(isRetryableError(bcqErr(1, "HTTP 503 Service Unavailable"))).toBe(true);
  });

  it("returns true for 504 server error", () => {
    expect(isRetryableError(bcqErr(1, "HTTP 504 Gateway Timeout"))).toBe(true);
  });

  it("returns true for generic 5xx", () => {
    expect(isRetryableError(bcqErr(1, "server returned 5xx"))).toBe(true);
  });

  it("returns false for 401", () => {
    expect(isRetryableError(bcqErr(1, "HTTP 401 Unauthorized"))).toBe(false);
  });

  it("returns false for 403", () => {
    expect(isRetryableError(bcqErr(1, "HTTP 403 Forbidden"))).toBe(false);
  });

  it("returns false for Unauthorized text", () => {
    expect(isRetryableError(bcqErr(1, "Unauthorized access denied"))).toBe(false);
  });

  it("returns false for Forbidden text", () => {
    expect(isRetryableError(bcqErr(1, "Forbidden: insufficient permissions"))).toBe(false);
  });

  it("returns false for 404", () => {
    expect(isRetryableError(bcqErr(1, "HTTP 404 Not Found"))).toBe(false);
  });

  it("returns false for Not Found text", () => {
    expect(isRetryableError(bcqErr(1, "Not Found: resource missing"))).toBe(false);
  });

  it("returns false for 422", () => {
    expect(isRetryableError(bcqErr(1, "HTTP 422 Unprocessable Entity"))).toBe(false);
  });

  it("returns false for Unprocessable text", () => {
    expect(isRetryableError(bcqErr(1, "Unprocessable: invalid body"))).toBe(false);
  });

  it("returns false for JSON parse error (exitCode null)", () => {
    expect(
      isRetryableError(bcqErr(null, "unexpected token <", "bcq output is not valid JSON")),
    ).toBe(false);
  });

  it("returns false for unknown error with exit code 2", () => {
    expect(isRetryableError(bcqErr(2, "something unknown happened"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  const fast = { baseDelayMs: 1, maxDelayMs: 4, jitter: false };

  it("retries on transient error and succeeds on 2nd attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(bcqErr(1, "connect ETIMEDOUT"))
      .mockResolvedValueOnce({ data: "ok", raw: "ok" });

    const result = await withRetry(fn, { ...fast, maxAttempts: 3 });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ data: "ok", raw: "ok" });
  });

  it("does not retry on permanent error (401)", async () => {
    const fn = vi.fn().mockRejectedValueOnce(bcqErr(1, "HTTP 401 Unauthorized"));

    await expect(withRetry(fn, { ...fast, maxAttempts: 3 })).rejects.toThrow("bcq failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 404", async () => {
    const fn = vi.fn().mockRejectedValueOnce(bcqErr(1, "HTTP 404 Not Found"));

    await expect(withRetry(fn, { ...fast, maxAttempts: 3 })).rejects.toThrow("bcq failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 422", async () => {
    const fn = vi.fn().mockRejectedValueOnce(bcqErr(1, "HTTP 422 Unprocessable"));

    await expect(withRetry(fn, { ...fast, maxAttempts: 3 })).rejects.toThrow("bcq failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on JSON parse error (exitCode null)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(bcqErr(null, "unexpected <html>", "bcq output is not valid JSON"));

    await expect(withRetry(fn, { ...fast, maxAttempts: 3 })).rejects.toThrow(
      "bcq output is not valid JSON",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects maxAttempts limit", async () => {
    const fn = vi.fn().mockImplementation(async () => {
      throw bcqErr(1, "ETIMEDOUT");
    });

    await expect(withRetry(fn, { ...fast, maxAttempts: 4 })).rejects.toThrow("bcq failed");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("applies exponential backoff (delays increase)", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockImplementation(async () => {
      throw bcqErr(1, "ECONNREFUSED");
    });

    const origSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((cb: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (typeof ms === "number" && ms > 0) delays.push(ms);
        return origSetTimeout(cb, 0, ...args);
      });

    await expect(
      withRetry(fn, { maxAttempts: 4, baseDelayMs: 100, jitter: false }),
    ).rejects.toThrow();

    expect(delays).toEqual([100, 200, 400]);
    timeoutSpy.mockRestore();
  });

  it("applies jitter when enabled (delay is reduced up to 25%)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // max jitter: 25% reduction
    const delays: number[] = [];
    const fn = vi.fn().mockImplementation(async () => {
      throw bcqErr(1, "ETIMEDOUT");
    });

    const origSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((cb: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (typeof ms === "number" && ms > 0) delays.push(ms);
        return origSetTimeout(cb, 0, ...args);
      });

    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelayMs: 1000, jitter: true }),
    ).rejects.toThrow();

    // With random()=1, jitter = 1000 * 1 * 0.25 = 250, so delay = 750
    expect(delays).toEqual([750]);
    timeoutSpy.mockRestore();
    vi.spyOn(Math, "random").mockRestore();
  });

  it("custom retryable function overrides default", async () => {
    // 404 is normally not retryable, but custom function says yes
    const fn = vi
      .fn()
      .mockRejectedValueOnce(bcqErr(1, "HTTP 404 Not Found"))
      .mockResolvedValueOnce({ data: "found", raw: "found" });

    const result = await withRetry(fn, {
      ...fast,
      maxAttempts: 3,
      retryable: () => true,
    });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ data: "found", raw: "found" });
  });

  it("caps delay at maxDelayMs", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockImplementation(async () => {
      throw bcqErr(1, "ETIMEDOUT");
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

  it("rethrows non-BcqError immediately", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("not a BcqError"));

    await expect(withRetry(fn, { ...fast, maxAttempts: 3 })).rejects.toThrow("not a BcqError");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
