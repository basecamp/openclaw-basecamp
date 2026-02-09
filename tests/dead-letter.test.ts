import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recordDispatchFailure,
  recordQueueFullDrop,
  recordWebhookReceived,
  recordWebhookDispatched,
  getAccountMetrics,
  clearMetrics,
} from "../src/metrics.js";

beforeEach(() => {
  clearMetrics();
});

describe("dead-letter metrics integration", () => {
  it("dispatchFailureCount accumulates across multiple failures", () => {
    recordDispatchFailure("acct-1");
    recordDispatchFailure("acct-1");
    recordDispatchFailure("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m.dispatchFailureCount).toBe(3);
    expect(m.queueFullDropCount).toBe(0);
  });

  it("queueFullDropCount accumulates independently", () => {
    recordQueueFullDrop("acct-1");
    recordQueueFullDrop("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m.queueFullDropCount).toBe(2);
    expect(m.dispatchFailureCount).toBe(0);
  });

  it("both counters track independently on the same account", () => {
    recordDispatchFailure("acct-1");
    recordQueueFullDrop("acct-1");
    recordDispatchFailure("acct-1");
    recordQueueFullDrop("acct-1");
    recordQueueFullDrop("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m.dispatchFailureCount).toBe(2);
    expect(m.queueFullDropCount).toBe(3);
  });

  it("counters are per-account", () => {
    recordDispatchFailure("acct-1");
    recordDispatchFailure("acct-2");
    recordDispatchFailure("acct-2");
    recordQueueFullDrop("acct-1");
    recordQueueFullDrop("acct-1");

    expect(getAccountMetrics("acct-1")!.dispatchFailureCount).toBe(1);
    expect(getAccountMetrics("acct-1")!.queueFullDropCount).toBe(2);
    expect(getAccountMetrics("acct-2")!.dispatchFailureCount).toBe(2);
    expect(getAccountMetrics("acct-2")!.queueFullDropCount).toBe(0);
  });

  it("counters coexist with other webhook metrics", () => {
    recordWebhookReceived("acct-1");
    recordWebhookDispatched("acct-1");
    recordDispatchFailure("acct-1");
    recordQueueFullDrop("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m.webhook.receivedCount).toBe(1);
    expect(m.webhook.dispatchedCount).toBe(1);
    expect(m.dispatchFailureCount).toBe(1);
    expect(m.queueFullDropCount).toBe(1);
  });

  it("clearMetrics resets all counters", () => {
    recordDispatchFailure("acct-1");
    recordQueueFullDrop("acct-1");
    clearMetrics("acct-1");

    expect(getAccountMetrics("acct-1")).toBeUndefined();
  });
});

describe("status adapter audit shape", () => {
  // These tests verify the metrics data that the status adapter would read
  // to populate the dispatchFailures and queueFullDrops fields.
  // (The actual status adapter integration requires mocking the full plugin SDK,
  // which is tested in the status adapter tests.)

  it("metrics include dispatchFailureCount when failures occur", () => {
    recordDispatchFailure("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m).toHaveProperty("dispatchFailureCount");
    expect(m.dispatchFailureCount).toBe(1);
  });

  it("metrics include queueFullDropCount when drops occur", () => {
    recordQueueFullDrop("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m).toHaveProperty("queueFullDropCount");
    expect(m.queueFullDropCount).toBe(1);
  });

  it("zero-value counters are present in fresh account metrics", () => {
    // Trigger account creation with any metric
    recordWebhookReceived("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m.dispatchFailureCount).toBe(0);
    expect(m.queueFullDropCount).toBe(0);
  });
});
