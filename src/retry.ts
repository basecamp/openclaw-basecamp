/**
 * Retry utilities for SDK-based API calls.
 *
 * The @37signals/basecamp already retries 429/503 internally (enableRetry: true,
 * up to 3 attempts with Retry-After). Plugin retry exists solely for
 * transport-level failures the SDK doesn't catch (raw fetch TypeErrors).
 *
 * BasecampError is NEVER retried here — that would compound retries
 * (SDK 3 × plugin 3 = 9 attempts).
 */

import type { CircuitBreaker } from "./circuit-breaker.js";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  retryable?: (err: unknown) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return msg.includes("fetch") || msg.includes("failed to fetch") ||
    msg.includes("network") || msg.includes("econnrefused") ||
    msg.includes("econnreset") || msg.includes("etimedout");
}

/**
 * Retry wrapper for SDK calls. Only retries transport-level TypeErrors.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  const maxDelayMs = opts?.maxDelayMs ?? 30000;
  const jitter = opts?.jitter ?? true;
  const classify = opts?.retryable ?? isRetryableError;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!classify(err)) throw err;
      if (attempt + 1 >= maxAttempts) break;

      let delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      if (jitter) {
        delay -= delay * Math.random() * 0.25;
      }
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Wrap a function with circuit breaker checks.
 * Records success/failure on the breaker; throws if the circuit is open.
 */
export async function withCircuitBreaker<T>(
  cb: CircuitBreaker,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
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
