import { describe, it, expect, beforeEach } from "vitest";
import {
  recordPollAttempt,
  recordPollSuccess,
  recordPollError,
  recordWebhookReceived,
  recordWebhookDispatched,
  recordWebhookDropped,
  recordWebhookError,
  recordDedupSize,
  recordWebhookDedupSize,
  recordCircuitBreakerState,
  recordDispatchFailure,
  recordQueueFullDrop,
  getAccountMetrics,
  clearMetrics,
} from "../src/metrics.js";

beforeEach(() => {
  clearMetrics();
});

describe("poller metrics", () => {
  it("records poll attempt", () => {
    recordPollAttempt("acct-1", "activity");

    const m = getAccountMetrics("acct-1");
    expect(m).toBeDefined();
    expect(m!.poller.activity.pollCount).toBe(1);
    expect(m!.poller.activity.lastPollAt).toBeTypeOf("number");
  });

  it("records poll success and clears error state", () => {
    recordPollError("acct-1", "readings", "timeout", 5000);
    recordPollSuccess("acct-1", "readings", 3);

    const m = getAccountMetrics("acct-1")!;
    expect(m.poller.readings.lastSuccessAt).toBeTypeOf("number");
    expect(m.poller.readings.dispatchCount).toBe(3);
    expect(m.poller.readings.currentBackoffMs).toBe(0);
    expect(m.poller.readings.lastError).toBeNull();
    expect(m.poller.readings.lastErrorAt).toBeNull();
  });

  it("records poll error with backoff", () => {
    recordPollError("acct-1", "assignments", "ECONNREFUSED", 60000);

    const m = getAccountMetrics("acct-1")!;
    expect(m.poller.assignments.lastErrorAt).toBeTypeOf("number");
    expect(m.poller.assignments.lastError).toBe("ECONNREFUSED");
    expect(m.poller.assignments.currentBackoffMs).toBe(60000);
    expect(m.poller.assignments.errorCount).toBe(1);
  });

  it("accumulates dispatch counts across successes", () => {
    recordPollSuccess("acct-1", "activity", 2);
    recordPollSuccess("acct-1", "activity", 5);

    const m = getAccountMetrics("acct-1")!;
    expect(m.poller.activity.dispatchCount).toBe(7);
  });

  it("tracks dropped count separately from dispatched", () => {
    recordPollSuccess("acct-1", "activity", 3, 2);
    recordPollSuccess("acct-1", "activity", 1, 4);

    const m = getAccountMetrics("acct-1")!;
    expect(m.poller.activity.dispatchCount).toBe(4);
    expect(m.poller.activity.droppedCount).toBe(6);
  });

  it("omitting dropped parameter does not affect droppedCount", () => {
    recordPollSuccess("acct-1", "readings", 5);

    const m = getAccountMetrics("acct-1")!;
    expect(m.poller.readings.dispatchCount).toBe(5);
    expect(m.poller.readings.droppedCount).toBe(0);
  });

  it("tracks separate sources independently", () => {
    recordPollAttempt("acct-1", "activity");
    recordPollAttempt("acct-1", "activity");
    recordPollAttempt("acct-1", "readings");

    const m = getAccountMetrics("acct-1")!;
    expect(m.poller.activity.pollCount).toBe(2);
    expect(m.poller.readings.pollCount).toBe(1);
    expect(m.poller.assignments.pollCount).toBe(0);
  });
});

describe("webhook metrics", () => {
  it("records webhook received", () => {
    recordWebhookReceived("acct-1");
    recordWebhookReceived("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m.webhook.receivedCount).toBe(2);
    expect(m.webhook.lastReceivedAt).toBeTypeOf("number");
  });

  it("records webhook dispatched", () => {
    recordWebhookDispatched("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m.webhook.dispatchedCount).toBe(1);
  });

  it("records webhook dropped", () => {
    recordWebhookDropped("acct-1");
    recordWebhookDropped("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m.webhook.droppedCount).toBe(2);
  });

  it("records webhook error", () => {
    recordWebhookError("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m.webhook.errorCount).toBe(1);
  });
});

describe("dedup metrics", () => {
  it("records poller dedup size", () => {
    recordDedupSize("acct-1", 42);

    const m = getAccountMetrics("acct-1")!;
    expect(m.dedupSize).toBe(42);
  });

  it("records webhook dedup size", () => {
    recordWebhookDedupSize("acct-1", 17);

    const m = getAccountMetrics("acct-1")!;
    expect(m.webhookDedupSize).toBe(17);
  });
});

describe("circuit breaker metrics", () => {
  it("records circuit breaker state", () => {
    recordCircuitBreakerState("acct-1", "outbound", {
      state: "open",
      failures: 5,
      trippedAt: Date.now(),
    });

    const m = getAccountMetrics("acct-1")!;
    expect(m.circuitBreaker["outbound"]).toBeDefined();
    expect(m.circuitBreaker["outbound"]!.state).toBe("open");
    expect(m.circuitBreaker["outbound"]!.failures).toBe(5);
  });

  it("updates circuit breaker state", () => {
    recordCircuitBreakerState("acct-1", "outbound", {
      state: "open",
      failures: 5,
      trippedAt: Date.now(),
    });
    recordCircuitBreakerState("acct-1", "outbound", {
      state: "half-open",
      failures: 5,
      trippedAt: null,
    });

    const m = getAccountMetrics("acct-1")!;
    expect(m.circuitBreaker["outbound"]!.state).toBe("half-open");
  });
});

describe("dispatch failure metrics", () => {
  it("records dispatch failures", () => {
    recordDispatchFailure("acct-1");
    recordDispatchFailure("acct-1");
    recordDispatchFailure("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m.dispatchFailureCount).toBe(3);
  });

  it("starts at zero", () => {
    recordPollAttempt("acct-1", "activity");
    const m = getAccountMetrics("acct-1")!;
    expect(m.dispatchFailureCount).toBe(0);
  });
});

describe("queue full drop metrics", () => {
  it("records queue full drops", () => {
    recordQueueFullDrop("acct-1");
    recordQueueFullDrop("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m.queueFullDropCount).toBe(2);
  });

  it("starts at zero", () => {
    recordPollAttempt("acct-1", "activity");
    const m = getAccountMetrics("acct-1")!;
    expect(m.queueFullDropCount).toBe(0);
  });

  it("tracks independently from dispatch failures", () => {
    recordDispatchFailure("acct-1");
    recordQueueFullDrop("acct-1");
    recordQueueFullDrop("acct-1");

    const m = getAccountMetrics("acct-1")!;
    expect(m.dispatchFailureCount).toBe(1);
    expect(m.queueFullDropCount).toBe(2);
  });
});

describe("account isolation", () => {
  it("tracks metrics per account", () => {
    recordPollAttempt("acct-1", "activity");
    recordPollAttempt("acct-2", "activity");
    recordPollAttempt("acct-2", "activity");

    expect(getAccountMetrics("acct-1")!.poller.activity.pollCount).toBe(1);
    expect(getAccountMetrics("acct-2")!.poller.activity.pollCount).toBe(2);
  });

  it("returns undefined for unknown account", () => {
    expect(getAccountMetrics("nonexistent")).toBeUndefined();
  });
});

describe("clearMetrics", () => {
  it("clears specific account", () => {
    recordPollAttempt("acct-1", "activity");
    recordPollAttempt("acct-2", "activity");

    clearMetrics("acct-1");

    expect(getAccountMetrics("acct-1")).toBeUndefined();
    expect(getAccountMetrics("acct-2")).toBeDefined();
  });

  it("clears all accounts", () => {
    recordPollAttempt("acct-1", "activity");
    recordPollAttempt("acct-2", "activity");

    clearMetrics();

    expect(getAccountMetrics("acct-1")).toBeUndefined();
    expect(getAccountMetrics("acct-2")).toBeUndefined();
  });
});
