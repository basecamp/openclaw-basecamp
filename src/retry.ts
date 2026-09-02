/**
 * Retry utilities for SDK-based API calls.
 *
 * The @37signals/basecamp already retries 429/503 internally (enableRetry: true,
 * up to 3 attempts with Retry-After). Plugin retry exists solely for
 * transport-level failures the SDK doesn't catch (raw fetch TypeErrors).
 *
 * BasecampError is NEVER retried here — that would compound retries
 * (SDK 3 × plugin 3 = 9 attempts).
 *
 * Backoff scheduling delegates to the SDK's `retryAsync` (SPEC §2.25); this
 * module keeps the TypeError-only network classifier and the circuit breaker
 * wrapper, which have no SDK equivalent.
 */

import { retryAsync } from "openclaw/plugin-sdk/runtime-env";
import type { CircuitBreaker } from "./circuit-breaker.js";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  retryable?: (err: unknown) => boolean;
}

/**
 * Classify whether an error is retryable at the plugin level.
 *
 * Only raw network failures (TypeError from fetch) are retryable.
 * BasecampError (any HTTP error) is NOT retryable — the SDK already
 * exhausted its internal retry budget.
 */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("fetch") ||
    msg.includes("failed to fetch") ||
    msg.includes("network") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout")
  );
}

/**
 * Retry wrapper for SDK calls. Only retries transport-level TypeErrors.
 *
 * Exponential backoff (baseDelayMs · 2^attempt, capped at maxDelayMs) with
 * optional ±25% jitter, scheduled by the SDK's `retryAsync`.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const classify = opts?.retryable ?? isRetryableError;
  return retryAsync(fn, {
    attempts: opts?.maxAttempts ?? 3,
    minDelayMs: opts?.baseDelayMs ?? 1000,
    maxDelayMs: opts?.maxDelayMs ?? 30000,
    jitter: (opts?.jitter ?? true) ? 0.25 : 0,
    shouldRetry: (err) => classify(err),
    random: () => Math.random(),
  });
}

/**
 * Wrap a function with circuit breaker checks.
 * Records success/failure on the breaker; throws if the circuit is open.
 */
export async function withCircuitBreaker<T>(cb: CircuitBreaker, key: string, fn: () => Promise<T>): Promise<T> {
  if (cb.isOpen(key)) {
    throw new Error(`Circuit breaker open for ${key}`);
  }
  try {
    const result = await fn();
    cb.recordSuccess(key);
    return result;
  } catch (err) {
    cb.recordFailure(key);
    throw err;
  }
}
