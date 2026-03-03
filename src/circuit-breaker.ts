/**
 * Circuit breaker — fail-fast on persistent downstream failures.
 *
 * Extracted from basecamp-cli.ts for use with both the CLI path and the
 * @37signals/basecamp client path.
 */

export interface CircuitBreakerOptions {
  threshold?: number;
  cooldownMs?: number;
}

interface CircuitState {
  failures: number;
  trippedAt: number | null;
  cooldownMs: number;
  /** True while a half-open probe is in flight — blocks other callers. */
  halfOpenProbe: boolean;
}

export class CircuitBreaker {
  private circuits = new Map<string, CircuitState>();
  private threshold: number;
  private cooldownMs: number;

  constructor(opts?: CircuitBreakerOptions) {
    this.threshold = opts?.threshold ?? 5;
    this.cooldownMs = opts?.cooldownMs ?? 5 * 60 * 1000;
  }

  isOpen(key: string): boolean {
    const state = this.circuits.get(key);
    if (!state || state.trippedAt === null) return false;
    const elapsed = Date.now() - state.trippedAt;
    if (elapsed >= state.cooldownMs) {
      // Half-open: allow exactly one probe through
      if (state.halfOpenProbe) return true;
      state.halfOpenProbe = true;
      return false;
    }
    return true;
  }

  recordFailure(key: string): void {
    const state = this.circuits.get(key) ?? {
      failures: 0,
      trippedAt: null,
      cooldownMs: this.cooldownMs,
      halfOpenProbe: false,
    };
    state.failures++;
    state.halfOpenProbe = false;
    if (state.failures >= this.threshold) {
      state.trippedAt = Date.now();
    }
    this.circuits.set(key, state);
  }

  recordSuccess(key: string): void {
    const state = this.circuits.get(key);
    if (!state) return;
    state.failures = 0;
    state.trippedAt = null;
    state.halfOpenProbe = false;
  }

  reset(key: string): void {
    this.circuits.delete(key);
  }

  getState(key: string): { failures: number; trippedAt: number | null } | undefined {
    const state = this.circuits.get(key);
    if (!state) return undefined;
    return { failures: state.failures, trippedAt: state.trippedAt };
  }
}
