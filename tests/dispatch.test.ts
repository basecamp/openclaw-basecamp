import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchBasecampEvent } from "../src/dispatch.js";
import type {
  BasecampInboundMessage,
  ResolvedBasecampAccount,
} from "../src/types.js";
import { getBasecampRuntime } from "../src/runtime.js";
import { resolvePersonaAccountId, resolveBasecampAccount } from "../src/config.js";
import { postReplyToEvent } from "../src/outbound/send.js";
import { markdownToBasecampHtml } from "../src/outbound/format.js";

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
  host: "3.basecampapi.com",
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
// Tests
// ---------------------------------------------------------------------------

describe("dispatchBasecampEvent", () => {
  it("returns false for self-messages (sender.id === account.personId)", async () => {
    const selfMsg = { ...mockMsg, sender: { id: "999", name: "Bot" } };
    const result = await dispatchBasecampEvent(selfMsg, { account: mockAccount });

    expect(result).toBe(false);
    expect(
      mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).not.toHaveBeenCalled();
  });

  it("returns false when no route is matched", async () => {
    mockRuntime.channel.routing.resolveAgentRoute.mockReturnValue(null);

    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount });

    expect(result).toBe(false);
    expect(
      mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).not.toHaveBeenCalled();
  });

  it("dispatches successfully with correct MsgContext fields", async () => {
    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount });

    expect(result).toBe(true);
    expect(
      mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).toHaveBeenCalledTimes(1);

    const call =
      mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock
        .calls[0][0];
    const ctx = call.ctx;

    expect(ctx.Body).toBe("Hello");
    expect(ctx.RawBody).toBe("Hello");
    expect(ctx.From).toBe("basecamp:777");
    expect(ctx.To).toBe("basecamp:recording:123");
    expect(ctx.SenderId).toBe("777");
    expect(ctx.SenderName).toBe("Test User");
    expect(ctx.ChatType).toBe("group");
    expect(ctx.Provider).toBe("basecamp");
    expect(ctx.Surface).toBe("basecamp");
    expect(ctx.AccountId).toBe("test-acct");
    expect(ctx.SessionKey).toBe("session:abc");
    expect(ctx.OriginatingChannel).toBe("basecamp");
    expect(ctx.OriginatingTo).toBe("basecamp:recording:123");
    expect(ctx.Timestamp).toBe(new Date("2025-01-15T10:00:00Z").getTime());
  });

  it("uses persona account ID for outbound when resolvePersonaAccountId returns a value", async () => {
    vi.mocked(resolvePersonaAccountId).mockReturnValue("persona-acct");
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      accountId: "persona-acct",
      enabled: true,
      personId: "888",
      token: "tok-persona",
      tokenSource: "config",
      host: "3.basecampapi.com",
      bcqProfile: "persona-profile",
      config: { personId: "888", bcqProfile: "persona-profile" },
    } as any);

    await dispatchBasecampEvent(mockMsg, { account: mockAccount });

    const call =
      mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock
        .calls[0][0];
    const deliver = call.dispatcherOptions.deliver;

    await deliver({ text: "Reply text" }, {});

    expect(postReplyToEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "persona-acct",
        profile: "persona-profile",
      }),
    );
  });

  it("deliver callback calls postReplyToEvent with correct params", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount });

    const call =
      mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock
        .calls[0][0];
    const deliver = call.dispatcherOptions.deliver;

    await deliver({ text: "Agent reply" }, {});

    expect(markdownToBasecampHtml).toHaveBeenCalledWith("Agent reply");
    expect(postReplyToEvent).toHaveBeenCalledWith({
      bucketId: "456",
      recordingId: "123",
      recordableType: "Chat::Transcript",
      peerId: "recording:123",
      content: "<p>Agent reply</p>",
      accountId: "test-acct",
      host: "3.basecampapi.com",
      profile: undefined,
    });
  });

  it("deliver callback skips postReplyToEvent when payload.text is empty", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount });

    const call =
      mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock
        .calls[0][0];
    const deliver = call.dispatcherOptions.deliver;

    await deliver({ text: "" }, {});

    expect(postReplyToEvent).not.toHaveBeenCalled();
  });

  it("UntrustedContext contains [basecamp] prefixed metadata lines", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount });

    const call =
      mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock
        .calls[0][0];
    const ctx = call.ctx;
    const untrusted: string[] = ctx.UntrustedContext;

    expect(untrusted.length).toBeGreaterThan(0);
    for (const line of untrusted) {
      expect(line).toMatch(/^\[basecamp\] /);
    }
    expect(untrusted).toContainEqual(
      expect.stringContaining("recordableType=Chat::Transcript"),
    );
    expect(untrusted).toContainEqual(
      expect.stringContaining("eventKind=created"),
    );
    expect(untrusted).toContainEqual(
      expect.stringContaining("bucketId=456"),
    );
    expect(untrusted).toContainEqual(
      expect.stringContaining("recordingId=123"),
    );
  });

  it("sets ChatType to 'direct' when msg.peer.kind is 'dm'", async () => {
    const dmMsg = { ...mockMsg, peer: { kind: "dm" as const, id: "ping:789" } };

    await dispatchBasecampEvent(dmMsg, { account: mockAccount });

    const call =
      mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock
        .calls[0][0];
    expect(call.ctx.ChatType).toBe("direct");
  });
});
