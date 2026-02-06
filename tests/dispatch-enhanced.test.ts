import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchBasecampEvent } from "../src/dispatch.js";
import type {
  BasecampInboundMessage,
  ResolvedBasecampAccount,
} from "../src/types.js";
import { getBasecampRuntime } from "../src/runtime.js";
import { resolvePersonaAccountId, resolveBasecampAccount } from "../src/config.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/runtime.js", () => ({
  getBasecampRuntime: vi.fn(),
}));
vi.mock("../src/config.js", () => ({
  resolvePersonaAccountId: vi.fn(),
  resolveBasecampAccount: vi.fn(),
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
    mentionsAgent: false,
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
  config: { personId: "999" },
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
  mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(
    undefined,
  );
});

// ---------------------------------------------------------------------------
// L4: Enhanced dispatch error logging
// ---------------------------------------------------------------------------

describe("dispatchBasecampEvent enhanced onError logging", () => {
  it("onError logs structured error with event metadata", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };

    await dispatchBasecampEvent(mockMsg, { account: mockAccount, log });

    // Get the onError callback from the dispatch call
    const call =
      mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock
        .calls[0][0];
    const onError = call.dispatcherOptions.onError;

    // Simulate an error
    onError(new Error("Connection refused ECONNREFUSED"));

    expect(log.error).toHaveBeenCalledTimes(1);
    const errorMsg = log.error.mock.calls[0][0];
    expect(errorMsg).toContain("agent=agent-1");
    expect(errorMsg).toContain("recording=123");
    expect(errorMsg).toContain("event=created");
    expect(errorMsg).toContain("sender=777");
    expect(errorMsg).toContain("type=network");
  });

  it("classifies auth errors correctly", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };

    await dispatchBasecampEvent(mockMsg, { account: mockAccount, log });

    const call =
      mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock
        .calls[0][0];
    const onError = call.dispatcherOptions.onError;

    onError(new Error("401 Unauthorized"));

    const errorMsg = log.error.mock.calls[0][0];
    expect(errorMsg).toContain("type=auth");
  });

  it("classifies routing errors correctly", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };

    await dispatchBasecampEvent(mockMsg, { account: mockAccount, log });

    const call =
      mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock
        .calls[0][0];
    const onError = call.dispatcherOptions.onError;

    onError(new Error("no route matched"));

    const errorMsg = log.error.mock.calls[0][0];
    expect(errorMsg).toContain("type=routing");
  });

  it("classifies unknown errors correctly", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };

    await dispatchBasecampEvent(mockMsg, { account: mockAccount, log });

    const call =
      mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock
        .calls[0][0];
    const onError = call.dispatcherOptions.onError;

    onError(new Error("something unexpected happened"));

    const errorMsg = log.error.mock.calls[0][0];
    expect(errorMsg).toContain("type=unknown");
  });
});
