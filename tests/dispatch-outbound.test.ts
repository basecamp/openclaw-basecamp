/**
 * Tests: outbound reliability of the turn plan's delivery adapter —
 * chunking, retries, circuit breaker threading, and failure propagation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePersonaAccountId } from "../src/config.js";
import { dispatchBasecampEvent } from "../src/dispatch.js";
import { markdownToBasecampHtml } from "../src/outbound/format.js";
import { postReplyToEvent } from "../src/outbound/send.js";
import { clearBasecampRuntime, setBasecampRuntime } from "../src/runtime.js";
import type { BasecampInboundMessage, ResolvedBasecampAccount } from "../src/types.js";
import { createFakeKernel, type FakeKernel } from "./dispatch-helpers.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/config.js", () => ({
  resolvePersonaAccountId: vi.fn(),
  resolveBasecampAccount: vi.fn(),
  resolveBasecampDmPolicy: vi.fn(() => "open"),
  resolveBasecampAllowFrom: vi.fn(() => []),
  resolveCircuitBreakerConfig: vi.fn(() => ({ threshold: 5, cooldownMs: 300000 })),
  resolveBasecampBucketAllowFrom: vi.fn(() => undefined),
  resolveBasecampHistoryLimit: vi.fn(() => 50),
  resolveBasecampGroupPolicy: vi.fn(() => "open"),
  resolveBasecampGroupAllowFrom: vi.fn(() => []),
}));
vi.mock("../src/outbound/send.js", () => ({
  postReplyToEvent: vi.fn(),
}));
vi.mock("../src/outbound/format.js", () => ({
  markdownToBasecampHtml: vi.fn((text: string) => `<p>${text}</p>`),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let kernel: FakeKernel;

const mockCfg: any = {
  channels: {
    basecamp: {
      accounts: { "test-acct": { personId: "999" } },
    },
  },
};

const mockMsg: BasecampInboundMessage = {
  channel: "basecamp",
  accountId: "test-acct",
  peer: { kind: "group", id: "recording:123" },
  parentPeer: { kind: "group", id: "bucket:456" },
  sender: { id: "777", name: "Test User" },
  text: "Hello",
  html: "<p>Hello</p>",
  meta: {
    bucketId: "456",
    recordingId: "123",
    recordableType: "Chat::Transcript",
    eventKind: "created",
    mentions: [],
    mentionsAgent: true,
    attachments: [],
    sources: ["activity_feed"],
  },
  dedupKey: "activity:1",
  createdAt: "2025-01-15T10:00:00Z",
  correlationId: "corr-1",
};

const mockAccount: ResolvedBasecampAccount = {
  accountId: "test-acct",
  enabled: true,
  personId: "999",
  token: "tok-abc",
  tokenSource: "config",
  config: { personId: "999", basecampAccountId: "12345" },
};

async function dispatchAndGetDelivery(opts?: {
  msg?: BasecampInboundMessage;
  log?: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}) {
  await dispatchBasecampEvent(opts?.msg ?? mockMsg, { account: mockAccount, cfg: mockCfg, log: opts?.log });
  return kernel.lastPlan().delivery;
}

beforeEach(() => {
  vi.clearAllMocks();
  kernel = createFakeKernel();
  setBasecampRuntime(kernel.runtime as any);
  vi.mocked(resolvePersonaAccountId).mockReturnValue(undefined);
  kernel.runtime.channel.routing.resolveAgentRoute.mockReturnValue({
    agentId: "agent-1",
    matchedBy: "binding.peer",
    sessionKey: "session:abc",
  });
  vi.mocked(postReplyToEvent).mockResolvedValue({ ok: true });
});

afterEach(() => {
  clearBasecampRuntime();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatch outbound reliability", () => {
  it("deliver calls postReplyToEvent with retries: 2", async () => {
    const delivery = await dispatchAndGetDelivery();

    await delivery.deliver({ text: "Agent reply" }, {});

    expect(postReplyToEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketId: "456",
        recordingId: "123",
        recordableType: "Chat::Transcript",
        retries: 2,
      }),
    );
  });

  it("onError logs structured error with event metadata", async () => {
    const logError = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: logError };
    const delivery = await dispatchAndGetDelivery({ log });

    delivery.onError(new Error("ETIMEDOUT connecting to host"), { kind: "final" });

    // 2 calls: delivery_failed + dead_letter
    expect(logError).toHaveBeenCalledTimes(2);
    const logged = logError.mock.calls[0][0];
    expect(logged).toContain("delivery_failed");
    expect(logged).toContain('"agent":"agent-1"');
    expect(logged).toContain('"event":"created"');
    expect(logged).toContain('"recording":"123"');
    expect(logged).toContain('"sender":"777"');
    expect(logged).toContain('"type":"network"');
    expect(logged).toContain("ETIMEDOUT");
  });

  it("onError classifies auth errors", async () => {
    const logError = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: logError };
    const delivery = await dispatchAndGetDelivery({ log });

    delivery.onError(new Error("401 Unauthorized"), { kind: "final" });

    expect(logError.mock.calls[0][0]).toContain('"type":"auth"');
  });

  it("onError classifies unknown errors", async () => {
    const logError = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: logError };
    const delivery = await dispatchAndGetDelivery({ log });

    delivery.onError(new Error("something unexpected"), { kind: "final" });

    expect(logError.mock.calls[0][0]).toContain('"type":"unknown"');
  });

  it("logs delivery confirmation after successful delivery", async () => {
    const logInfo = vi.fn();
    const log = { info: logInfo, warn: vi.fn(), error: vi.fn() };
    const delivery = await dispatchAndGetDelivery({ log });

    await delivery.deliver({ text: "Reply" }, {});

    const deliveryLog = logInfo.mock.calls.find((c: string[]) => c[0].includes("delivered"));
    expect(deliveryLog).toBeDefined();
    expect(deliveryLog![0]).toContain('"agent":"agent-1"');
    expect(deliveryLog![0]).toContain('"event":"created"');
    expect(deliveryLog![0]).toContain('"recording":"123"');
  });

  it("does not log 'delivered' when delivery fails", async () => {
    vi.mocked(postReplyToEvent).mockResolvedValue({ ok: false, message: "send failed" });
    const logInfo = vi.fn();
    const logError = vi.fn();
    const log = { info: logInfo, warn: vi.fn(), error: logError };
    const delivery = await dispatchAndGetDelivery({ log });

    await expect(delivery.deliver({ text: "Reply" }, {})).rejects.toThrow("send failed");
    delivery.onError(new Error("send failed"), { kind: "final" });

    const deliveryLog = logInfo.mock.calls.find(
      (c: string[]) => c[0].includes("delivered") && !c[0].includes("delivery_failed"),
    );
    expect(deliveryLog).toBeUndefined();
    expect(logError).toHaveBeenCalled();
  });

  it("deliver throws when postReplyToEvent returns ok: false", async () => {
    vi.mocked(postReplyToEvent).mockResolvedValue({
      ok: false,
      error: "403 Forbidden",
      message: "403 Forbidden",
    });
    const delivery = await dispatchAndGetDelivery();

    await expect(delivery.deliver({ text: "Reply" }, {})).rejects.toThrow("403 Forbidden");
  });

  it("returns collected messageIds from delivered chunks", async () => {
    vi.mocked(postReplyToEvent).mockResolvedValue({ ok: true, messageId: "m-1" });
    const delivery = await dispatchAndGetDelivery();

    const result = await delivery.deliver({ text: "Reply" }, {});

    expect(result).toEqual({ messageIds: ["m-1"] });
  });

  it("chunks long text and sends multiple postReplyToEvent calls", async () => {
    const delivery = await dispatchAndGetDelivery();

    // Generate text with sentence breaks that exceeds the 10K chunk limit.
    // "Hello world. " is 14 chars × 1000 = 14,000 chars → 2 chunks.
    const longText = "Hello world. ".repeat(1000);
    await delivery.deliver({ text: longText }, {});

    expect(postReplyToEvent).toHaveBeenCalledTimes(2);
    expect(markdownToBasecampHtml).toHaveBeenCalledTimes(2);

    for (const postCall of vi.mocked(postReplyToEvent).mock.calls) {
      expect(postCall[0]).toMatchObject({
        bucketId: "456",
        recordingId: "123",
        account: mockAccount,
        retries: 2,
      });
    }
  });

  it("sends single postReplyToEvent call for text under chunk limit", async () => {
    const delivery = await dispatchAndGetDelivery();

    await delivery.deliver({ text: "Short reply" }, {});

    expect(postReplyToEvent).toHaveBeenCalledTimes(1);
    expect(markdownToBasecampHtml).toHaveBeenCalledTimes(1);
  });

  it("stops sending chunks when postReplyToEvent fails mid-sequence", async () => {
    let callCount = 0;
    vi.mocked(postReplyToEvent).mockImplementation(async () => {
      callCount++;
      if (callCount >= 2) return { ok: false, error: "rate limited", message: "rate limited" };
      return { ok: true };
    });
    const delivery = await dispatchAndGetDelivery();

    // ~35K chars with sentence breaks → 3+ chunks
    const longText = "Hello world. ".repeat(2500);
    await expect(delivery.deliver({ text: longText }, {})).rejects.toThrow("rate limited");

    // First chunk succeeded, second failed, remaining never attempted
    expect(callCount).toBe(2);
  });

  it("routes replies using peerId from inbound message", async () => {
    // Use a message where peerId (parent transcript) differs from recordingId (child line)
    const childMsg: BasecampInboundMessage = {
      ...mockMsg,
      peer: { kind: "group", id: "recording:TRANSCRIPT_42" },
      meta: {
        ...mockMsg.meta,
        recordingId: "LINE_99",
        recordableType: "Chat::Line",
      },
    };
    const delivery = await dispatchAndGetDelivery({ msg: childMsg });

    await delivery.deliver({ text: "Reply to thread" }, {});

    expect(postReplyToEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: "recording:TRANSCRIPT_42",
        recordingId: "LINE_99",
      }),
    );
  });

  it("passes outbound circuit breaker to postReplyToEvent", async () => {
    vi.mocked(postReplyToEvent).mockResolvedValue({ ok: true, messageId: "1" });
    const delivery = await dispatchAndGetDelivery();

    await delivery.deliver({ text: "CB test" }, {});

    expect(postReplyToEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        circuitBreaker: expect.objectContaining({
          key: "outbound",
          instance: expect.anything(),
        }),
      }),
    );
  });

  it("uses same circuit breaker key 'outbound' across multiple dispatches", async () => {
    vi.mocked(postReplyToEvent).mockResolvedValue({ ok: true, messageId: "1" });

    const delivery1 = await dispatchAndGetDelivery();
    const delivery2 = await dispatchAndGetDelivery();
    await delivery1.deliver({ text: "First" }, {});
    await delivery2.deliver({ text: "Second" }, {});

    const call1Args = vi.mocked(postReplyToEvent).mock.calls[0][0] as any;
    const call2Args = vi.mocked(postReplyToEvent).mock.calls[1][0] as any;
    expect(call1Args.circuitBreaker.key).toBe("outbound");
    expect(call2Args.circuitBreaker.key).toBe("outbound");
    // Same CB instance (shared per account)
    expect(call1Args.circuitBreaker.instance).toBe(call2Args.circuitBreaker.instance);
  });
});
