import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("circuit starts closed (isOpen returns false)", () => {
    const cb = new CircuitBreaker({ threshold: 3 });
    expect(cb.isOpen("acct-1")).toBe(false);
  });

  it("trips after threshold consecutive failures", () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 });

    cb.recordFailure("acct-1");
    cb.recordFailure("acct-1");
    expect(cb.isOpen("acct-1")).toBe(false);

    cb.recordFailure("acct-1");
    expect(cb.isOpen("acct-1")).toBe(true);
  });

  it("isOpen returns true when tripped", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });

    cb.recordFailure("acct-1");
    cb.recordFailure("acct-1");

    expect(cb.isOpen("acct-1")).toBe(true);
  });

  it("fails fast when circuit is open (before cooldown)", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });

    cb.recordFailure("acct-1");
    cb.recordFailure("acct-1");

    // Advance less than cooldown
    vi.advanceTimersByTime(30_000);
    expect(cb.isOpen("acct-1")).toBe(true);
  });

  it("recovers after cooldown period (half-open -> closed on success)", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });

    cb.recordFailure("acct-1");
    cb.recordFailure("acct-1");
    expect(cb.isOpen("acct-1")).toBe(true);

    // Advance past cooldown
    vi.advanceTimersByTime(60_000);
    // Half-open: isOpen returns false to allow one attempt
    expect(cb.isOpen("acct-1")).toBe(false);

    // Simulate successful request
    cb.recordSuccess("acct-1");
    expect(cb.isOpen("acct-1")).toBe(false);
    expect(cb.getState("acct-1")).toEqual({ failures: 0, trippedAt: null });
  });

  it("re-trips on failure during half-open", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });

    cb.recordFailure("acct-1");
    cb.recordFailure("acct-1");
    expect(cb.isOpen("acct-1")).toBe(true);

    // Advance past cooldown (half-open)
    vi.advanceTimersByTime(60_000);
    expect(cb.isOpen("acct-1")).toBe(false);

    // Request fails again during half-open -> re-trips
    cb.recordFailure("acct-1");
    expect(cb.isOpen("acct-1")).toBe(true);
  });

  it("half-open allows only one probe (subsequent callers are blocked)", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });

    cb.recordFailure("acct-1");
    cb.recordFailure("acct-1");
    expect(cb.isOpen("acct-1")).toBe(true);

    // Advance past cooldown (half-open)
    vi.advanceTimersByTime(60_000);

    // First caller gets through (the probe)
    expect(cb.isOpen("acct-1")).toBe(false);

    // Second caller is blocked while probe is in flight
    expect(cb.isOpen("acct-1")).toBe(true);
    expect(cb.isOpen("acct-1")).toBe(true);

    // Probe succeeds -> circuit closes, all callers allowed through
    cb.recordSuccess("acct-1");
    expect(cb.isOpen("acct-1")).toBe(false);
  });

  it("recordSuccess resets failure count", () => {
    const cb = new CircuitBreaker({ threshold: 3 });

    cb.recordFailure("acct-1");
    cb.recordFailure("acct-1");
    cb.recordSuccess("acct-1");

    expect(cb.getState("acct-1")).toEqual({ failures: 0, trippedAt: null });
    expect(cb.isOpen("acct-1")).toBe(false);

    // Needs full threshold again to trip
    cb.recordFailure("acct-1");
    cb.recordFailure("acct-1");
    expect(cb.isOpen("acct-1")).toBe(false);
    cb.recordFailure("acct-1");
    expect(cb.isOpen("acct-1")).toBe(true);
  });

  it("reset() force-resets the circuit", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });

    cb.recordFailure("acct-1");
    cb.recordFailure("acct-1");
    expect(cb.isOpen("acct-1")).toBe(true);

    cb.reset("acct-1");
    expect(cb.isOpen("acct-1")).toBe(false);
    expect(cb.getState("acct-1")).toBeUndefined();
  });

  it("independent circuits per key", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });

    cb.recordFailure("acct-1");
    cb.recordFailure("acct-1");
    expect(cb.isOpen("acct-1")).toBe(true);
    expect(cb.isOpen("acct-2")).toBe(false);

    cb.recordFailure("acct-2");
    expect(cb.isOpen("acct-2")).toBe(false);
    cb.recordFailure("acct-2");
    expect(cb.isOpen("acct-2")).toBe(true);

    // Reset one doesn't affect the other
    cb.reset("acct-1");
    expect(cb.isOpen("acct-1")).toBe(false);
    expect(cb.isOpen("acct-2")).toBe(true);
  });

  it("getState returns correct state", () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 60_000 });

    expect(cb.getState("acct-1")).toBeUndefined();

    cb.recordFailure("acct-1");
    expect(cb.getState("acct-1")).toEqual({ failures: 1, trippedAt: null });

    cb.recordFailure("acct-1");
    cb.recordFailure("acct-1");
    const state = cb.getState("acct-1");
    expect(state?.failures).toBe(3);
    expect(state?.trippedAt).toBeTypeOf("number");
  });

  it("recordSuccess on unknown key is a no-op", () => {
    const cb = new CircuitBreaker();
    cb.recordSuccess("unknown");
    expect(cb.getState("unknown")).toBeUndefined();
  });

  it("uses default threshold of 5 and cooldown of 5 minutes", () => {
    const cb = new CircuitBreaker();

    for (let i = 0; i < 4; i++) cb.recordFailure("acct-1");
    expect(cb.isOpen("acct-1")).toBe(false);

    cb.recordFailure("acct-1");
    expect(cb.isOpen("acct-1")).toBe(true);

    // 4 minutes not enough
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(cb.isOpen("acct-1")).toBe(true);

    // 5 minutes is enough
    vi.advanceTimersByTime(1 * 60 * 1000);
    expect(cb.isOpen("acct-1")).toBe(false);
  });
});
