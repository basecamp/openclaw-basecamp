import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveBasecampAccount,
  resolveBasecampAllowFrom,
  resolveBasecampBucketAllowFrom,
  resolveBasecampDmPolicy,
  resolvePersonaAccountId,
} from "../src/config.js";
import { dispatchBasecampEvent } from "../src/dispatch.js";
import { markdownToBasecampHtml } from "../src/outbound/format.js";
import { postReplyToEvent } from "../src/outbound/send.js";
import { clearBasecampRuntime, setBasecampRuntime } from "../src/runtime.js";
import type { BasecampInboundMessage, ResolvedBasecampAccount } from "../src/types.js";

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
  channel: {
    routing: { resolveAgentRoute: vi.fn() },
    reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
  },
};

const baseCfg = () => ({
  channels: {
    basecamp: {
      accounts: { "test-acct": { personId: "999" } },
    },
  },
});
let mockCfg: any;

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
  setBasecampRuntime(mockRuntime as any);
  vi.mocked(resolvePersonaAccountId).mockReturnValue(undefined);
  vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(undefined);
  vi.mocked(postReplyToEvent).mockResolvedValue({ ok: true });
  mockCfg = baseCfg();
  mockRuntime.channel.routing.resolveAgentRoute.mockReturnValue({
    agentId: "agent-1",
    matchedBy: "peer",
    sessionKey: "session:abc",
  });
  mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(undefined);
});

afterEach(() => {
  clearBasecampRuntime();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchBasecampEvent", () => {
  it("returns false for self-messages (sender.id === account.personId)", async () => {
    const selfMsg = { ...mockMsg, sender: { id: "999", name: "Bot" } };
    const result = await dispatchBasecampEvent(selfMsg, { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(false);
    expect(mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("returns false when no route is matched", async () => {
    mockRuntime.channel.routing.resolveAgentRoute.mockReturnValue(null);

    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(false);
    expect(mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("dispatches successfully with correct MsgContext fields", async () => {
    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(true);
    expect(mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
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
      cliProfile: "persona-profile",
      config: { personId: "888", cliProfile: "persona-profile", basecampAccountId: "67890" },
    } as any);

    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const deliver = call.dispatcherOptions.deliver;

    await deliver({ text: "Reply text" }, {});

    expect(postReplyToEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({
          accountId: "persona-acct",
          cliProfile: "persona-profile",
        }),
      }),
    );
  });

  it("returns false and logs error when basecampAccountId is undefined", async () => {
    const accountNoId: ResolvedBasecampAccount = {
      ...mockAccount,
      config: { personId: "999" },
    };
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

    const result = await dispatchBasecampEvent(mockMsg, { account: accountNoId, cfg: mockCfg, log });

    expect(result).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toContain("outbound_account_id_missing");
    expect(mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("accepts basecampAccountId for OAuth accounts", async () => {
    const oauthAccount: ResolvedBasecampAccount = {
      ...mockAccount,
      accountId: "work",
      config: { personId: "999", basecampAccountId: "2914079" },
    };

    const result = await dispatchBasecampEvent(mockMsg, { account: oauthAccount, cfg: mockCfg });

    expect(result).toBe(true);
  });

  it("falls back to numeric accountId when basecampAccountId is unset", async () => {
    const accountNumericId: ResolvedBasecampAccount = {
      ...mockAccount,
      accountId: "2914079",
      config: { personId: "999" },
    };

    const result = await dispatchBasecampEvent(mockMsg, { account: accountNumericId, cfg: mockCfg });

    expect(result).toBe(true);
    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const deliver = call.dispatcherOptions.deliver;
    await deliver({ text: "Reply" }, {});

    expect(postReplyToEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ accountId: "2914079" }),
      }),
    );
  });

  it("deliver callback calls postReplyToEvent with correct params", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const deliver = call.dispatcherOptions.deliver;

    await deliver({ text: "Agent reply" }, {});

    expect(markdownToBasecampHtml).toHaveBeenCalledWith("Agent reply");
    expect(postReplyToEvent).toHaveBeenCalledWith({
      bucketId: "456",
      recordingId: "123",
      recordableType: "Chat::Transcript",
      peerId: "recording:123",
      content: "<p>Agent reply</p>",
      account: mockAccount,
      retries: 2,
      circuitBreaker: expect.objectContaining({ key: "outbound" }),
      correlationId: undefined,
    });
  });

  it("deliver callback skips postReplyToEvent when payload.text is empty", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const deliver = call.dispatcherOptions.deliver;

    await deliver({ text: "" }, {});

    expect(postReplyToEvent).not.toHaveBeenCalled();
  });

  it("ChannelPromptContext contains [basecamp] prefixed metadata lines", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const ctx = call.ctx;
    const promptContext: string[] = ctx.ChannelPromptContext;

    expect(promptContext.length).toBeGreaterThan(0);
    for (const line of promptContext) {
      expect(line).toMatch(/^\[basecamp\] /);
    }
    expect(promptContext).toContainEqual(expect.stringContaining("recordableType=Chat::Transcript"));
    expect(promptContext).toContainEqual(expect.stringContaining("eventKind=created"));
    expect(promptContext).toContainEqual(expect.stringContaining("bucketId=456"));
    expect(promptContext).toContainEqual(expect.stringContaining("recordingId=123"));
  });

  it("ChannelPromptContext leads with surface guidance for known recordable types", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const promptContext: string[] = call.ctx.ChannelPromptContext;

    // Chat::Transcript has a surface prompt — it must be the FIRST line
    expect(promptContext[0]).toMatch(/^\[basecamp\] surface guidance: /);
    expect(promptContext[0]).toContain("Campfire chat");
    // Metadata lines follow unchanged
    expect(promptContext[1]).toBe("[basecamp] recordableType=Chat::Transcript");
  });

  it("ChannelPromptContext omits surface guidance for unknown recordable types", async () => {
    const uploadMsg: BasecampInboundMessage = {
      ...mockMsg,
      meta: { ...mockMsg.meta, recordableType: "Upload", mentionsAgent: true },
    };

    await dispatchBasecampEvent(uploadMsg, { account: mockAccount, cfg: mockCfg });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    const promptContext: string[] = call.ctx.ChannelPromptContext;

    expect(promptContext[0]).toBe("[basecamp] recordableType=Upload");
    expect(promptContext.some((line) => line.includes("surface guidance"))).toBe(false);
  });

  it("sets ChatType to 'direct' when msg.peer.kind is 'dm'", async () => {
    const dmMsg = { ...mockMsg, peer: { kind: "dm" as const, id: "ping:789" } };

    await dispatchBasecampEvent(dmMsg, { account: mockAccount, cfg: mockCfg });

    const call = mockRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0][0];
    expect(call.ctx.ChatType).toBe("direct");
  });

  // -----------------------------------------------------------------------
  // Engagement gate — config-driven classification
  // -----------------------------------------------------------------------

  it("drops activity events by default (not in default engage policy)", async () => {
    const cardMsg: BasecampInboundMessage = {
      ...mockMsg,
      meta: {
        ...mockMsg.meta,
        recordableType: "Kanban::Card",
        eventKind: "moved",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(cardMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("drops conversation events by default", async () => {
    const chatMsg: BasecampInboundMessage = {
      ...mockMsg,
      meta: {
        ...mockMsg.meta,
        recordableType: "Chat::Line",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(chatMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("dispatches @mentions (in default engage policy)", async () => {
    const mentionedMsg: BasecampInboundMessage = {
      ...mockMsg,
      meta: {
        ...mockMsg.meta,
        recordableType: "Kanban::Card",
        mentionsAgent: true,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(mentionedMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("dispatches DMs even without @mention", async () => {
    const dmMsg: BasecampInboundMessage = {
      ...mockMsg,
      peer: { kind: "dm", id: "ping:789" },
      meta: {
        ...mockMsg.meta,
        recordableType: "Chat::Line",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(dmMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("dispatches assignment events (assignedToAgent)", async () => {
    const assignMsg: BasecampInboundMessage = {
      ...mockMsg,
      meta: {
        ...mockMsg.meta,
        recordableType: "Todo",
        eventKind: "assigned",
        mentionsAgent: false,
        assignedToAgent: true,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(assignMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("dispatches check-in reminders (Question from readings)", async () => {
    const checkinMsg: BasecampInboundMessage = {
      ...mockMsg,
      meta: {
        ...mockMsg.meta,
        recordableType: "Question",
        mentionsAgent: false,
        sources: ["readings"],
      },
    };

    const result = await dispatchBasecampEvent(checkinMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("drops Question from activity_feed (classified as activity, not checkin)", async () => {
    const questionMsg: BasecampInboundMessage = {
      ...mockMsg,
      meta: {
        ...mockMsg.meta,
        recordableType: "Question",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(questionMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("respects per-bucket engage override to include conversation", async () => {
    // Override config to include conversation for bucket 456
    mockCfg = {
      channels: {
        basecamp: {
          accounts: { "test-acct": { personId: "999" } },
          buckets: { "456": { engage: ["dm", "mention", "conversation"] } },
        },
      },
    };

    const chatMsg: BasecampInboundMessage = {
      ...mockMsg,
      meta: {
        ...mockMsg.meta,
        recordableType: "Chat::Line",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(chatMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("respects wildcard bucket engage override", async () => {
    mockCfg = {
      channels: {
        basecamp: {
          accounts: { "test-acct": { personId: "999" } },
          buckets: { "*": { engage: ["dm", "mention", "conversation", "activity"] } },
        },
      },
    };

    const cardMsg: BasecampInboundMessage = {
      ...mockMsg,
      meta: {
        ...mockMsg.meta,
        recordableType: "Kanban::Card",
        eventKind: "moved",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(cardMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("prefers exact bucket engage over wildcard", async () => {
    mockCfg = {
      channels: {
        basecamp: {
          accounts: { "test-acct": { personId: "999" } },
          buckets: {
            "456": { engage: ["dm"] },
            "*": { engage: ["dm", "mention", "conversation", "activity"] },
          },
        },
      },
    };

    // Mention should be dropped — exact bucket only allows "dm"
    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("respects channel-level engage to include activity", async () => {
    mockCfg = {
      channels: {
        basecamp: {
          accounts: { "test-acct": { personId: "999" } },
          engage: ["dm", "mention", "assignment", "checkin", "conversation", "activity"],
        },
      },
    };

    const cardMsg: BasecampInboundMessage = {
      ...mockMsg,
      meta: {
        ...mockMsg.meta,
        recordableType: "Kanban::Card",
        eventKind: "moved",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(cardMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  // -----------------------------------------------------------------------
  // DM policy enforcement
  // -----------------------------------------------------------------------

  it("drops DMs when dmPolicy is 'disabled'", async () => {
    vi.mocked(resolveBasecampDmPolicy).mockReturnValue("disabled");

    const dmMsg: BasecampInboundMessage = {
      ...mockMsg,
      peer: { kind: "dm", id: "ping:789" },
      meta: {
        ...mockMsg.meta,
        recordableType: "Chat::Line",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(dmMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("drops DMs when dmPolicy is 'pairing' and sender not in allowFrom", async () => {
    vi.mocked(resolveBasecampDmPolicy).mockReturnValue("pairing");
    vi.mocked(resolveBasecampAllowFrom).mockReturnValue(["111", "222"]);

    const dmMsg: BasecampInboundMessage = {
      ...mockMsg,
      peer: { kind: "dm", id: "ping:789" },
      sender: { id: "777", name: "Stranger" },
      meta: {
        ...mockMsg.meta,
        recordableType: "Chat::Line",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(dmMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("allows DMs when dmPolicy is 'pairing' and sender in allowFrom", async () => {
    vi.mocked(resolveBasecampDmPolicy).mockReturnValue("pairing");
    vi.mocked(resolveBasecampAllowFrom).mockReturnValue(["777"]);

    const dmMsg: BasecampInboundMessage = {
      ...mockMsg,
      peer: { kind: "dm", id: "ping:789" },
      sender: { id: "777", name: "Paired User" },
      meta: {
        ...mockMsg.meta,
        recordableType: "Chat::Line",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(dmMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("allows DMs when dmPolicy is 'open'", async () => {
    vi.mocked(resolveBasecampDmPolicy).mockReturnValue("open");

    const dmMsg: BasecampInboundMessage = {
      ...mockMsg,
      peer: { kind: "dm", id: "ping:789" },
      sender: { id: "777", name: "Anyone" },
      meta: {
        ...mockMsg.meta,
        recordableType: "Chat::Line",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(dmMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("allows DMs when mock dmPolicy defaults to 'open'", async () => {
    // Default mock returns "open" — production default is "pairing"
    const dmMsg: BasecampInboundMessage = {
      ...mockMsg,
      peer: { kind: "dm", id: "ping:789" },
      meta: {
        ...mockMsg.meta,
        recordableType: "Chat::Line",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(dmMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Per-bucket sender gate
  // -----------------------------------------------------------------------

  it("drops events when sender not in bucket allowFrom", async () => {
    vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(["111"]);

    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("allows events when sender is in bucket allowFrom", async () => {
    vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(["777"]);

    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("bucket allowFrom applies to all engagement types (conversation)", async () => {
    vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(["111"]);

    // Enable conversation for the bucket so engagement gate passes
    mockCfg = {
      channels: {
        basecamp: {
          accounts: { "test-acct": { personId: "999" } },
          buckets: { "456": { engage: ["conversation"], allowFrom: ["111"] } },
        },
      },
    };

    const chatMsg: BasecampInboundMessage = {
      ...mockMsg,
      meta: {
        ...mockMsg.meta,
        recordableType: "Chat::Line",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(chatMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("wildcard bucket allowFrom gates all buckets", async () => {
    vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(["111"]);

    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("exact bucket allowFrom overrides wildcard", async () => {
    // The resolver handles precedence; mock returns the resolved list for bucket 456
    vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(["777"]);

    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("DM policy still applies after bucket sender gate passes", async () => {
    vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(["777"]);
    vi.mocked(resolveBasecampDmPolicy).mockReturnValue("disabled");

    const dmMsg: BasecampInboundMessage = {
      ...mockMsg,
      peer: { kind: "dm", id: "ping:789" },
      meta: {
        ...mockMsg.meta,
        recordableType: "Chat::Line",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(dmMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("no bucket allowFrom = all senders pass (existing behavior)", async () => {
    vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(undefined);

    mockCfg = {
      channels: {
        basecamp: {
          accounts: { "test-acct": { personId: "999" } },
          buckets: { "456": { engage: ["conversation"] } },
        },
      },
    };

    const chatMsg: BasecampInboundMessage = {
      ...mockMsg,
      meta: {
        ...mockMsg.meta,
        recordableType: "Chat::Line",
        mentionsAgent: false,
        sources: ["activity_feed"],
      },
    };

    const result = await dispatchBasecampEvent(chatMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });
});
