/**
 * Integration test: startCompositePoller → CircuitBreaker → metrics registry.
 *
 * Verifies the end-to-end wiring: poll functions receive a CircuitBreaker
 * instance, failures update its internal state, and syncCircuitBreakerMetrics
 * propagates that state to the metrics registry (read by the status adapter).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BcqError } from "../src/bcq.js";
import { getAccountMetrics, clearMetrics } from "../src/metrics.js";

// ---------------------------------------------------------------------------
// Module mocks — intercept poll functions and config at the module boundary
// ---------------------------------------------------------------------------

vi.mock("../src/config.js", () => ({
  resolvePollingIntervals: () => ({
    activityIntervalMs: 50,
    readingsIntervalMs: 50,
    assignmentsIntervalMs: 50,
  }),
  resolveCircuitBreakerConfig: () => ({
    threshold: 1,
    cooldownMs: 60_000,
  }),
}));

vi.mock("../src/logging.js", () => ({
  createStructuredLog: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Track circuit breaker instances passed to poll functions
let activityCbCapture: { instance: any; key: string } | undefined;
let readingsCbCapture: { instance: any; key: string } | undefined;
let assignmentsCbCapture: { instance: any; key: string } | undefined;

vi.mock("../src/inbound/activity.js", () => ({
  pollActivityFeed: vi.fn(async (opts: any) => {
    activityCbCapture = opts.circuitBreaker;
    if (opts.circuitBreaker) {
      opts.circuitBreaker.instance.recordFailure(opts.circuitBreaker.key);
    }
    throw new BcqError("ETIMEDOUT", 1, "ETIMEDOUT", ["bcq", "timeline"]);
  }),
}));

vi.mock("../src/inbound/readings.js", () => ({
  pollReadings: vi.fn(async (opts: any) => {
    readingsCbCapture = opts.circuitBreaker;
    // Readings succeeds — verifies success path clears breaker state
    if (opts.circuitBreaker) {
      opts.circuitBreaker.instance.recordSuccess(opts.circuitBreaker.key);
    }
    return { events: [], newestAt: undefined, processedSgids: [] };
  }),
}));

vi.mock("../src/inbound/assignments.js", () => ({
  pollAssignments: vi.fn(async (opts: any) => {
    assignmentsCbCapture = opts.circuitBreaker;
    if (opts.circuitBreaker) {
      opts.circuitBreaker.instance.recordFailure(opts.circuitBreaker.key);
    }
    throw new BcqError("ECONNREFUSED", 1, "ECONNREFUSED", ["bcq", "api", "get"]);
  }),
}));

vi.mock("../src/bcq.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bcq.js")>();
  return {
    ...actual,
    bcqMarkReadingsRead: vi.fn(async () => ({ data: null, raw: "" })),
  };
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("startCompositePoller — circuit breaker integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    clearMetrics();
    activityCbCapture = undefined;
    readingsCbCapture = undefined;
    assignmentsCbCapture = undefined;
    tmpDir = await mkdtemp(join(tmpdir(), "poller-cb-"));
  });

  afterEach(async () => {
    clearMetrics();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("propagates circuit breaker state to metrics registry after poll cycles", async () => {
    const { startCompositePoller } = await import("../src/inbound/poller.js");

    const ac = new AbortController();
    const account = {
      accountId: "test-cb",
      personId: "99",
      enabled: true,
      token: "tok",
      tokenSource: "inline" as const,
      bcqProfile: undefined,
      displayName: "Test",
      config: { personId: "99", bcqAccountId: "12345" },
    } as any;

    // Run poller for ~300ms — enough for at least 1 poll cycle.
    // Threshold is 1, so a single failure trips the breaker.
    const pollerPromise = startCompositePoller({
      account,
      cfg: {},
      abortSignal: ac.signal,
      onEvent: async () => true,
      stateDir: tmpDir,
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    });

    // Let the poller run for a few cycles
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await pollerPromise;

    // Verify circuit breaker instances were threaded through
    expect(activityCbCapture).toBeDefined();
    expect(activityCbCapture!.key).toBe("activity");
    expect(readingsCbCapture).toBeDefined();
    expect(readingsCbCapture!.key).toBe("readings");
    expect(assignmentsCbCapture).toBeDefined();
    expect(assignmentsCbCapture!.key).toBe("assignments");

    // Verify metrics registry has circuit breaker state
    const metrics = getAccountMetrics("test-cb");
    expect(metrics).toBeDefined();

    // Activity: 1+ failures with threshold 1 → should be "open"
    const activityCb = metrics!.circuitBreaker["activity"];
    expect(activityCb).toBeDefined();
    expect(activityCb.state).toBe("open");
    expect(activityCb.failures).toBeGreaterThanOrEqual(1);
    expect(activityCb.trippedAt).toBeTypeOf("number");

    // Readings: success path → should be "closed" (or not present if never failed)
    // Since readings mock calls recordSuccess, the breaker key may not have state
    // unless it previously failed. With a fresh breaker, getState returns undefined
    // and syncCircuitBreakerMetrics returns early — so no entry is expected.
    const readingsCb = metrics!.circuitBreaker["readings"];
    if (readingsCb) {
      expect(readingsCb.state).toBe("closed");
      expect(readingsCb.failures).toBe(0);
    }

    // Assignments: 1+ failures → should be "open"
    const assignmentsCb = metrics!.circuitBreaker["assignments"];
    expect(assignmentsCb).toBeDefined();
    expect(assignmentsCb.state).toBe("open");
    expect(assignmentsCb.failures).toBeGreaterThanOrEqual(1);
  });

  it("uses separate breaker keys for readings fetch vs mark-read", async () => {
    // Override readings mock to return events with SGIDs (triggers mark-read path)
    const { pollReadings } = await import("../src/inbound/readings.js");
    vi.mocked(pollReadings).mockImplementation(async (opts: any) => {
      readingsCbCapture = opts.circuitBreaker;
      return {
        events: [],
        newestAt: undefined,
        processedSgids: ["sgid://bc3/Recording/1"],
      };
    });

    const { bcqMarkReadingsRead } = await import("../src/bcq.js");
    let markReadCbCapture: { instance: any; key: string } | undefined;
    vi.mocked(bcqMarkReadingsRead).mockImplementation(async (_sgids: string[], opts: any) => {
      markReadCbCapture = opts?.circuitBreaker;
      return { data: null, raw: "" };
    });

    const { startCompositePoller } = await import("../src/inbound/poller.js");

    const ac = new AbortController();
    const account = {
      accountId: "test-keys",
      personId: "99",
      enabled: true,
      token: "tok",
      tokenSource: "inline" as const,
      config: { personId: "99", bcqAccountId: "12345" },
    } as any;

    const pollerPromise = startCompositePoller({
      account,
      cfg: {},
      abortSignal: ac.signal,
      onEvent: async () => true,
      stateDir: tmpDir,
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    });

    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await pollerPromise;

    // readings fetch key
    expect(readingsCbCapture).toBeDefined();
    expect(readingsCbCapture!.key).toBe("readings");

    // mark-read key is separate
    expect(markReadCbCapture).toBeDefined();
    expect(markReadCbCapture!.key).toBe("readings:mark-read");

    // They share the same CircuitBreaker instance but use different keys
    expect(markReadCbCapture!.instance).toBe(readingsCbCapture!.instance);
    expect(markReadCbCapture!.key).not.toBe(readingsCbCapture!.key);
  });
});
