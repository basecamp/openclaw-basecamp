import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePersonaAccountId } from "../src/config.js";
import { dispatchBasecampEvent } from "../src/dispatch.js";
import { markdownToBasecampHtml } from "../src/outbound/format.js";
import { postReplyToEvent } from "../src/outbound/send.js";
import { getBasecampRuntime } from "../src/runtime.js";
import type { BasecampInboundMessage, ResolvedBasecampAccount } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/runtime.js", () => ({
  getBasecampRuntime: vi.fn(),
}));
vi.mock("../src/config.js", () => ({
  resolvePersonaAccountId: vi.fn(),
  resolveBasecampAccount: vi.fn(),
  resolveBasecampDmPolicy: vi.fn(() => "open"),
  resolveBasecampAllowFrom: vi.fn(() => []),
  resolveCircuitBreakerConfig: vi.fn(() => ({ threshold: 5, cooldownMs: 300000 })),
  resolveBasecampBucketAllowFrom: vi.fn(() => undefined),
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

const mockRuntime = {
  config: {
    loadConfig: vi.fn(() => ({
      channels: {
        basecamp: {
          accounts: { "test-acct": { personId: "999" } },
        },
      },
    })),
  },
  channel: {
    routing: { resolveAgentRoute: vi.fn() },
    reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
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
};

const mockAccount: ResolvedBasecampAccount = {
  accountId: "test-acct",
  enabled: true,
  personId: "999",
  token: "tok-abc",
  tokenSource: "config",
  config: { personId: "999", basecampAccountId: "12345" },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBasecampRuntime).mockReturnValue(mockRuntime as any);
  vi.mocked(resolvePersonaAccountId).mockReturnValue(undefined);
  mockRuntime.channel.routing.resolveAgentRoute.mockReturnValue({
    agentId: "agent-1",
    matchedBy: "peer",
    sessionKey: "session:abc",
  });
  mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(undefined);
  vi.mocked(postReplyToEvent).mockResolvedValue({ ok: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatch outbound reliability", () => {
  it("deliver callback calls postReplyToEvent with retries: 2", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const deliver = call.dispatcherOptions.deliver;

    await deliver({ text: "Agent reply" }, {});

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

    await dispatchBasecampEvent(mockMsg, { account: mockAccount, log });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const onError = call.dispatcherOptions.onError;

    onError(new Error("ETIMEDOUT connecting to host"));

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

    await dispatchBasecampEvent(mockMsg, { account: mockAccount, log });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    call.dispatcherOptions.onError(new Error("401 Unauthorized"));

    expect(logError.mock.calls[0][0]).toContain('"type":"auth"');
  });

  it("onError classifies unknown errors", async () => {
    const logError = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: logError };

    await dispatchBasecampEvent(mockMsg, { account: mockAccount, log });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    call.dispatcherOptions.onError(new Error("something unexpected"));

    expect(logError.mock.calls[0][0]).toContain('"type":"unknown"');
  });

  it("logs delivery confirmation after successful dispatch", async () => {
    const logInfo = vi.fn();
    const log = { info: logInfo, warn: vi.fn(), error: vi.fn() };

    await dispatchBasecampEvent(mockMsg, { account: mockAccount, log });

    // The delivery log should be the last info call
    const deliveryLog = logInfo.mock.calls.find((c: string[]) => c[0].includes("delivered"));
    expect(deliveryLog).toBeDefined();
    expect(deliveryLog![0]).toContain('"agent":"agent-1"');
    expect(deliveryLog![0]).toContain('"event":"created"');
    expect(deliveryLog![0]).toContain('"recording":"123"');
  });

  it("does not log 'delivered' when onError was called", async () => {
    // Make dispatchReplyWithBufferedBlockDispatcher call onError
    mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions }: any) => {
        dispatcherOptions.onError(new Error("send failed"));
      },
    );

    const logInfo = vi.fn();
    const logError = vi.fn();
    const log = { info: logInfo, warn: vi.fn(), error: logError };

    await dispatchBasecampEvent(mockMsg, { account: mockAccount, log });

    const deliveryLog = logInfo.mock.calls.find(
      (c: string[]) => c[0].includes("delivered") && !c[0].includes("delivery_failed"),
    );
    expect(deliveryLog).toBeUndefined();
    expect(logError).toHaveBeenCalled();
  });

  it("deliver callback throws when postReplyToEvent returns ok: false", async () => {
    vi.mocked(postReplyToEvent).mockResolvedValue({
      ok: false,
      error: "403 Forbidden",
      message: "403 Forbidden",
    });

    await dispatchBasecampEvent(mockMsg, { account: mockAccount });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const deliver = call.dispatcherOptions.deliver;

    await expect(deliver({ text: "Reply" }, {})).rejects.toThrow("403 Forbidden");
  });

  it("chunks long text and sends multiple postReplyToEvent calls", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const deliver = call.dispatcherOptions.deliver;

    // Generate text with sentence breaks that exceeds the 10K chunk limit.
    // "Hello world. " is 14 chars × 1000 = 14,000 chars → 2 chunks.
    const longText = "Hello world. ".repeat(1000);
    await deliver({ text: longText }, {});

    expect(postReplyToEvent).toHaveBeenCalledTimes(2);
    expect(markdownToBasecampHtml).toHaveBeenCalledTimes(2);

    // Each call should have the correct routing params
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
    await dispatchBasecampEvent(mockMsg, { account: mockAccount });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const deliver = call.dispatcherOptions.deliver;

    await deliver({ text: "Short reply" }, {});

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

    await dispatchBasecampEvent(mockMsg, { account: mockAccount });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const deliver = call.dispatcherOptions.deliver;

    // ~35K chars with sentence breaks → 3+ chunks
    const longText = "Hello world. ".repeat(2500);
    await expect(deliver({ text: longText }, {})).rejects.toThrow("rate limited");

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

    await dispatchBasecampEvent(childMsg, { account: mockAccount });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const deliver = call.dispatcherOptions.deliver;
    await deliver({ text: "Reply to thread" }, {});

    expect(postReplyToEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        peerId: "recording:TRANSCRIPT_42",
        recordingId: "LINE_99",
      }),
    );
  });

  it("passes outbound circuit breaker to postReplyToEvent", async () => {
    vi.mocked(postReplyToEvent).mockResolvedValue({ ok: true, messageId: "1" });

    await dispatchBasecampEvent(mockMsg, { account: mockAccount });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const deliver = call.dispatcherOptions.deliver;
    await deliver({ text: "CB test" }, {});

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

    await dispatchBasecampEvent(mockMsg, { account: mockAccount });
    await dispatchBasecampEvent(mockMsg, { account: mockAccount });

    const calls = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls;
    const deliver1 = calls[0][0].dispatcherOptions.deliver;
    const deliver2 = calls[1][0].dispatcherOptions.deliver;
    await deliver1({ text: "First" }, {});
    await deliver2({ text: "Second" }, {});

    // Both calls should use the same CB key
    const call1Args = vi.mocked(postReplyToEvent).mock.calls[0][0] as any;
    const call2Args = vi.mocked(postReplyToEvent).mock.calls[1][0] as any;
    expect(call1Args.circuitBreaker.key).toBe("outbound");
    expect(call2Args.circuitBreaker.key).toBe("outbound");
    // Same CB instance (shared per account)
    expect(call1Args.circuitBreaker.instance).toBe(call2Args.circuitBreaker.instance);
  });
});
