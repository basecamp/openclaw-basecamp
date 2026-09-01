/**
 * Tests: turn-kernel dispatch (SPEC §2.2/§2.3, §4.4).
 *
 * The BasecampTurnAdapter runs against the real
 * buildChannelInboundEventContext and the real SDK ingress resolver; only
 * runtime.channel.inbound.run is a fake mini-kernel (tests/dispatch-helpers).
 */

import { recordOutboundMessageIdentity } from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveBasecampAccount,
  resolveBasecampAllowFrom,
  resolveBasecampBucketAllowFrom,
  resolveBasecampDmPolicy,
  resolveBasecampHistoryLimit,
  resolvePersonaAccountId,
} from "../src/config.js";
import { dispatchBasecampEvent } from "../src/dispatch.js";
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
}));
vi.mock("../src/outbound/send.js", () => ({
  postReplyToEvent: vi.fn(),
}));
vi.mock("../src/outbound/format.js", () => ({
  markdownToBasecampHtml: vi.fn((text: string) => `<p>${text}</p>`),
}));
const mockPingPost = vi.fn(async () => ({ data: {}, response: { ok: true } }));
vi.mock("../src/basecamp-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/basecamp-client.js")>();
  return {
    ...actual,
    getClient: vi.fn(() => ({ raw: { POST: mockPingPost } })),
    rawOrThrow: vi.fn(async (result: unknown) => result),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseCfg = () => ({
  channels: {
    basecamp: {
      accounts: { "test-acct": { personId: "999" } },
    },
  },
});
let mockCfg: any;
let kernel: FakeKernel;

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

const dmMsg = (overrides?: Partial<BasecampInboundMessage>): BasecampInboundMessage => ({
  ...mockMsg,
  peer: { kind: "dm", id: "ping:900" },
  parentPeer: undefined,
  meta: { ...mockMsg.meta, recordableType: "Circle", mentionsAgent: false },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // The outbound echo registry is process-global with a 30s TTL — clear it
  // so one test's recorded identity can't drop another test's event.
  (
    (globalThis as Record<symbol, unknown>)[Symbol.for("openclaw.outboundMessageIdentities")] as
      | Map<unknown, unknown>
      | undefined
  )?.clear();
  kernel = createFakeKernel();
  setBasecampRuntime(kernel.runtime as any);
  vi.mocked(resolvePersonaAccountId).mockReturnValue(undefined);
  vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(undefined);
  vi.mocked(resolveBasecampDmPolicy).mockReturnValue("open");
  vi.mocked(resolveBasecampAllowFrom).mockReturnValue([]);
  vi.mocked(resolveBasecampHistoryLimit).mockReturnValue(50);
  vi.mocked(postReplyToEvent).mockResolvedValue({ ok: true, messageId: "reply-1" });
  mockCfg = baseCfg();
  kernel.runtime.channel.routing.resolveAgentRoute.mockReturnValue({
    agentId: "agent-1",
    matchedBy: "binding.peer",
    sessionKey: "session:abc",
  });
});

afterEach(() => {
  clearBasecampRuntime();
});

// ---------------------------------------------------------------------------
// Core admission gates
// ---------------------------------------------------------------------------

describe("dispatchBasecampEvent", () => {
  it("returns false for self-messages (sender.id === account.personId)", async () => {
    const selfMsg = { ...mockMsg, sender: { id: "999", name: "Bot" } };
    const result = await dispatchBasecampEvent(selfMsg, { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(false);
    expect(kernel.plans.length).toBe(0);
    expect(kernel.lastResult().admission).toMatchObject({ kind: "drop", reason: "self_message" });
  });

  it("returns false when no route is matched", async () => {
    kernel.runtime.channel.routing.resolveAgentRoute.mockReturnValue(undefined);
    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(false);
    expect(kernel.lastResult().admission).toMatchObject({ kind: "drop", reason: "no_route" });
  });

  it("drops recent outbound echoes via the shared identity registry", async () => {
    recordOutboundMessageIdentity({
      channel: "basecamp",
      accountId: mockMsg.accountId,
      conversationId: mockMsg.peer.id,
      messageId: mockMsg.meta.recordingId,
    });

    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(false);
    expect(kernel.lastResult().admission).toMatchObject({ kind: "drop", reason: "outbound_echo" });
  });

  it("dispatches successfully with correct context fields", async () => {
    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(true);
    const ctx = kernel.lastCtx();
    expect(ctx).toMatchObject({
      Body: "Hello",
      BodyForAgent: "Hello",
      RawBody: "Hello",
      From: "basecamp:777",
      To: "basecamp:recording:123",
      SenderId: "777",
      SenderName: "Test User",
      ChatType: "group",
      Provider: "basecamp",
      Surface: "basecamp",
      MessageSid: "123",
      AccountId: "test-acct",
      OriginatingChannel: "basecamp",
      OriginatingTo: "basecamp:recording:123",
      WasMentioned: true,
      SessionKey: "session:abc",
      AgentId: "agent-1",
      InboundEventKind: "user_request",
    });
    expect(ctx.Timestamp).toBe(new Date(mockMsg.createdAt).getTime());
  });

  it("passes typed channelContext with Basecamp identifiers", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(kernel.lastCtx().ChannelContext).toEqual({
      sender: { id: "777", name: "Test User", personId: "777" },
      chat: {
        id: "recording:123",
        bucketId: "456",
        recordingId: "123",
        recordableType: "Chat::Transcript",
      },
    });
  });

  it("passes the exact ingress result verbatim as channelIngress into buildContext", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    const buildParams = kernel.runtime.channel.inbound.buildContext.mock.calls[0][0];
    expect(buildParams.channelIngress).toBeDefined();
    expect(buildParams.channelIngress).not.toBe("unsupported");
    expect(buildParams.channelIngress.ingress.admission).toBe("dispatch");
    expect(buildParams.channelIngress.senderAccess.allowed).toBe(true);
  });

  it("uses persona account for outbound when resolvePersonaAccountId returns a value", async () => {
    const personaAccount: ResolvedBasecampAccount = {
      accountId: "persona-acct",
      enabled: true,
      personId: "555",
      token: "tok-persona",
      tokenSource: "config",
      config: { personId: "555", basecampAccountId: "67890" },
    };
    vi.mocked(resolvePersonaAccountId).mockReturnValue("persona-acct");
    vi.mocked(resolveBasecampAccount).mockReturnValue(personaAccount);
    kernel.setAgentReply("Reply!");

    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(true);
    expect(postReplyToEvent).toHaveBeenCalledWith(expect.objectContaining({ account: personaAccount }));
  });

  it("returns false and logs error when basecampAccountId is undefined", async () => {
    const noIdAccount = { ...mockAccount, accountId: "named-acct", config: { personId: "999" } };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await dispatchBasecampEvent(mockMsg, { account: noIdAccount, cfg: mockCfg, log });

    expect(result).toBe(false);
    expect(kernel.lastResult().admission).toMatchObject({ kind: "drop", reason: "outbound_account_id_missing" });
    expect(log.error).toHaveBeenCalled();
  });

  it("accepts basecampAccountId for OAuth accounts", async () => {
    const oauthAccount: ResolvedBasecampAccount = {
      ...mockAccount,
      tokenSource: "oauth",
      token: undefined,
      config: { personId: "999", basecampAccountId: "12345" },
    };

    const result = await dispatchBasecampEvent(mockMsg, { account: oauthAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("falls back to numeric accountId when basecampAccountId is unset", async () => {
    const numericAccount = { ...mockAccount, accountId: "424242", config: { personId: "999" } };

    const result = await dispatchBasecampEvent(mockMsg, { account: numericAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("deliver callback calls postReplyToEvent with correct params", async () => {
    kernel.setAgentReply("Agent says hi");
    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(postReplyToEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketId: "456",
        recordingId: "123",
        recordableType: "Chat::Transcript",
        peerId: "recording:123",
        content: "<p>Agent says hi</p>",
        account: mockAccount,
        retries: 2,
      }),
    );
  });

  it("deliver callback skips postReplyToEvent when payload.text is empty", async () => {
    kernel.setAgentReply("");
    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(postReplyToEvent).not.toHaveBeenCalled();
  });

  it("sets ChatType to 'direct' when msg.peer.kind is 'dm'", async () => {
    await dispatchBasecampEvent(dmMsg(), { account: mockAccount, cfg: mockCfg });

    expect(kernel.lastCtx().ChatType).toBe("direct");
  });
});

// ---------------------------------------------------------------------------
// Surface guidance + structured context (kernel context, SPEC §2.2)
// ---------------------------------------------------------------------------

describe("surface guidance and structured context", () => {
  it("carries Basecamp event metadata as structured context (not prompt lines)", async () => {
    const msg = {
      ...mockMsg,
      meta: { ...mockMsg.meta, column: "In Progress", columnPrevious: "Backlog", stateMarker: "[APPROVED]" },
    };
    await dispatchBasecampEvent(msg, { account: mockAccount, cfg: mockCfg });

    const structured = kernel.lastCtx().ChannelStructuredContext;
    expect(structured).toBeDefined();
    const entry = structured.find((e: any) => e.type === "basecamp_event");
    expect(entry.payload).toMatchObject({
      recordableType: "Chat::Transcript",
      eventKind: "created",
      bucketId: "456",
      recordingId: "123",
      column: "In Progress",
      columnPrevious: "Backlog",
      stateMarker: "[APPROVED]",
    });
  });

  it("includes original HTML in structured context when it differs from text", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    const entry = kernel.lastCtx().ChannelStructuredContext.find((e: any) => e.type === "basecamp_event");
    expect(entry.payload.originalHtml).toBe("<p>Hello</p>");
  });

  it("sets GroupSystemPrompt from surface guidance for group surfaces", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(kernel.lastCtx().GroupSystemPrompt).toContain("Campfire chat room");
  });

  it("omits GroupSystemPrompt for unknown recordable types", async () => {
    const msg = {
      ...mockMsg,
      meta: { ...mockMsg.meta, recordableType: "Upload" as any },
    };
    await dispatchBasecampEvent(msg, { account: mockAccount, cfg: mockCfg });

    expect(kernel.lastCtx().GroupSystemPrompt).toBeUndefined();
  });

  it("carries surface guidance for direct Pings as a ChannelPromptContext line", async () => {
    await dispatchBasecampEvent(dmMsg(), { account: mockAccount, cfg: mockCfg });

    const ctx = kernel.lastCtx();
    expect(ctx.ChannelPromptContext).toEqual([expect.stringContaining("direct Basecamp Ping conversation")]);
    expect(ctx.GroupSystemPrompt).toBeUndefined();
  });

  it("surfaces the parent recording as quote context for comments", async () => {
    const commentMsg: BasecampInboundMessage = {
      ...mockMsg,
      peer: { kind: "group", id: "recording:800" },
      meta: { ...mockMsg.meta, recordableType: "Comment", recordingId: "801", messageId: "801" },
    };
    await dispatchBasecampEvent(commentMsg, { account: mockAccount, cfg: mockCfg });

    expect(kernel.lastCtx().ReplyToId).toBe("800");
  });
});

// ---------------------------------------------------------------------------
// Media facts (§2.2)
// ---------------------------------------------------------------------------

describe("media facts", () => {
  it("projects URL-bearing attachments into inbound media facts", async () => {
    const msg: BasecampInboundMessage = {
      ...mockMsg,
      meta: {
        ...mockMsg.meta,
        attachments: [
          { sgid: "sgid-1", url: "https://example.com/a.png", contentType: "image/png", filename: "a.png" },
          { sgid: "sgid-2" }, // no URL — dropped
        ],
      },
    };
    await dispatchBasecampEvent(msg, { account: mockAccount, cfg: mockCfg });

    const media = kernel.lastCtx().media;
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ url: "https://example.com/a.png", contentType: "image/png" });
  });

  it("omits media facts when there are no attachments", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });
    expect(kernel.lastCtx().media ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bot-loop protection facts (§2.13)
// ---------------------------------------------------------------------------

describe("bot-loop protection facts", () => {
  it("attaches facts when the sender is another configured persona", async () => {
    mockCfg.channels.basecamp.accounts["other-persona"] = { personId: "777" };

    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(kernel.lastPlan().botLoopProtection).toMatchObject({
      scopeId: "test-acct",
      conversationId: "recording:123",
      senderId: "777",
      receiverId: "999",
      defaultEnabled: true,
    });
  });

  it("omits facts for ordinary human senders", async () => {
    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });
    expect(kernel.lastPlan().botLoopProtection).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Engagement gates (plugin-owned classification)
// ---------------------------------------------------------------------------

describe("engagement gates", () => {
  const eventWith = (overrides: Partial<BasecampInboundMessage["meta"]>): BasecampInboundMessage => ({
    ...mockMsg,
    meta: { ...mockMsg.meta, mentionsAgent: false, ...overrides },
  });

  it("drops activity events by default (not in default engage policy)", async () => {
    const msg = eventWith({ recordableType: "Todo", eventKind: "completed" });
    const result = await dispatchBasecampEvent(msg, { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(false);
    expect(kernel.lastResult().admission.reason).toBe("engagement:activity");
  });

  it("drops conversation events by default", async () => {
    const msg = eventWith({ recordableType: "Chat::Line" });
    const result = await dispatchBasecampEvent(msg, { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(false);
    expect(kernel.lastResult().admission.reason).toBe("engagement:conversation");
  });

  it("dispatches @mentions (in default engage policy)", async () => {
    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("dispatches DMs even without @mention", async () => {
    const result = await dispatchBasecampEvent(dmMsg(), { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("dispatches assignment events (assignedToAgent)", async () => {
    const msg = eventWith({ recordableType: "Todo", assignedToAgent: true });
    const result = await dispatchBasecampEvent(msg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("dispatches check-in reminders (Question from readings)", async () => {
    const msg = eventWith({ recordableType: "Question", sources: ["readings"] });
    const result = await dispatchBasecampEvent(msg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("drops Question from activity_feed (classified as activity, not checkin)", async () => {
    const msg = eventWith({ recordableType: "Question", sources: ["activity_feed"] });
    const result = await dispatchBasecampEvent(msg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("respects per-bucket engage override to include conversation", async () => {
    mockCfg.channels.basecamp.buckets = { "456": { engage: ["conversation"] } };
    const msg = eventWith({ recordableType: "Chat::Line" });

    const result = await dispatchBasecampEvent(msg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("respects wildcard bucket engage override", async () => {
    mockCfg.channels.basecamp.buckets = { "*": { engage: ["conversation"] } };
    const msg = eventWith({ recordableType: "Chat::Line" });

    const result = await dispatchBasecampEvent(msg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("prefers exact bucket engage over wildcard", async () => {
    mockCfg.channels.basecamp.buckets = {
      "*": { engage: ["conversation"] },
      "456": { engage: ["mention"] },
    };
    const msg = eventWith({ recordableType: "Chat::Line" });

    const result = await dispatchBasecampEvent(msg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("respects channel-level engage to include activity", async () => {
    mockCfg.channels.basecamp.engage = ["activity"];
    const msg = eventWith({ recordableType: "Todo", eventKind: "completed" });

    const result = await dispatchBasecampEvent(msg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ambient room events (§2.4 / §3.7)
// ---------------------------------------------------------------------------

describe("ambient room events", () => {
  const ambient = (overrides: Partial<BasecampInboundMessage["meta"]>): BasecampInboundMessage => ({
    ...mockMsg,
    meta: { ...mockMsg.meta, mentionsAgent: false, ...overrides },
  });
  const buildParams = () => kernel.runtime.channel.inbound.buildContext.mock.calls[0][0];

  beforeEach(() => {
    mockCfg.messages = { groupChat: { unmentionedInbound: "room_event" } };
  });

  it("classifies an engaged, unmentioned Campfire line as room_event", async () => {
    mockCfg.channels.basecamp.engage = ["mention", "conversation"];

    const result = await dispatchBasecampEvent(ambient({ recordableType: "Chat::Line" }), {
      account: mockAccount,
      cfg: mockCfg,
    });

    expect(result).toBe(true);
    expect(kernel.lastCtx().InboundEventKind).toBe("room_event");
    expect(buildParams().message.inboundEventKind).toBe("room_event");
  });

  it("keeps @mentions as user requests", async () => {
    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(true);
    expect(kernel.lastCtx().InboundEventKind).toBe("user_request");
  });

  it("classifies an engaged card move as room_event", async () => {
    mockCfg.channels.basecamp.engage = ["activity"];
    const cardMove = ambient({
      recordableType: "Kanban::Card",
      eventKind: "card_moved",
      column: "In progress",
      columnPrevious: "Triage",
    });

    const result = await dispatchBasecampEvent(cardMove, { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(true);
    expect(kernel.lastCtx().InboundEventKind).toBe("room_event");
  });

  it("keeps assignments and check-ins as user requests", async () => {
    await dispatchBasecampEvent(ambient({ recordableType: "Todo", assignedToAgent: true }), {
      account: mockAccount,
      cfg: mockCfg,
    });
    expect(kernel.lastCtx().InboundEventKind).toBe("user_request");

    await dispatchBasecampEvent(ambient({ recordableType: "Question", sources: ["readings"] }), {
      account: mockAccount,
      cfg: mockCfg,
    });
    expect(kernel.lastCtx().InboundEventKind).toBe("user_request");
  });

  it("keeps direct Pings as user requests", async () => {
    await dispatchBasecampEvent(dmMsg(), { account: mockAccount, cfg: mockCfg });
    expect(kernel.lastCtx().InboundEventKind).toBe("user_request");
  });

  it("defaults ambient traffic to room_event when no unmentioned-group policy is configured", async () => {
    mockCfg.messages = undefined;
    mockCfg.channels.basecamp.engage = ["conversation"];

    await dispatchBasecampEvent(ambient({ recordableType: "Chat::Line" }), { account: mockAccount, cfg: mockCfg });

    expect(kernel.lastCtx().InboundEventKind).toBe("room_event");
  });

  it("honors an explicit global user_request policy over the Basecamp ambient default", async () => {
    mockCfg.messages = { groupChat: { unmentionedInbound: "user_request" } };
    mockCfg.channels.basecamp.engage = ["conversation"];

    await dispatchBasecampEvent(ambient({ recordableType: "Chat::Line" }), { account: mockAccount, cfg: mockCfg });

    expect(kernel.lastCtx().InboundEventKind).toBe("user_request");
  });

  it("honors the routed agent's groupChat.unmentionedInbound over the global policy", async () => {
    mockCfg.channels.basecamp.engage = ["conversation"];
    mockCfg.agents = { list: [{ id: "agent-1", groupChat: { unmentionedInbound: "user_request" } }] };

    await dispatchBasecampEvent(ambient({ recordableType: "Chat::Line" }), { account: mockAccount, cfg: mockCfg });

    expect(kernel.lastCtx().InboundEventKind).toBe("user_request");
  });

  it("applies a per-agent room_event policy when the global policy is unset", async () => {
    mockCfg.messages = undefined;
    mockCfg.channels.basecamp.engage = ["conversation"];
    mockCfg.agents = { list: [{ id: "agent-1", groupChat: { unmentionedInbound: "room_event" } }] };

    await dispatchBasecampEvent(ambient({ recordableType: "Chat::Line" }), { account: mockAccount, cfg: mockCfg });

    expect(kernel.lastCtx().InboundEventKind).toBe("room_event");
  });

  it("still drops ambient events outside the engage list (the engage gate runs first)", async () => {
    const result = await dispatchBasecampEvent(ambient({ recordableType: "Chat::Line" }), {
      account: mockAccount,
      cfg: mockCfg,
    });

    expect(result).toBe(false);
    expect(kernel.lastResult().admission.reason).toBe("engagement:conversation");
    expect(kernel.plans).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Session transcript chat window (§2.2 sessionTranscript)
// ---------------------------------------------------------------------------

describe("session transcript chat window", () => {
  const buildParams = () => kernel.runtime.channel.inbound.buildContext.mock.calls[0][0];

  it("passes the resolved history limit as a chat window for group surfaces", async () => {
    vi.mocked(resolveBasecampHistoryLimit).mockReturnValue(7);

    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(resolveBasecampHistoryLimit).toHaveBeenCalledWith(mockCfg, "test-acct");
    expect(buildParams().sessionTranscript).toEqual({
      chatWindow: true,
      historyLimit: 7,
      beforeTimestampMs: new Date(mockMsg.createdAt).getTime(),
    });
    expect(kernel.lastCtx().SessionTranscriptContext).toMatchObject({ chatWindow: true, historyLimit: 7 });
  });

  it("disables the window for direct Pings", async () => {
    await dispatchBasecampEvent(dmMsg(), { account: mockAccount, cfg: mockCfg });

    expect(buildParams().sessionTranscript).toMatchObject({ historyLimit: 0 });
    expect(kernel.lastCtx().SessionTranscriptContext).toBeUndefined();
  });

  it("omits the window when the configured limit is 0", async () => {
    vi.mocked(resolveBasecampHistoryLimit).mockReturnValue(0);

    await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(kernel.lastCtx().SessionTranscriptContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DM policy via the shared ingress resolver (§2.3)
// ---------------------------------------------------------------------------

describe("DM policy (ingress resolver)", () => {
  it("drops DMs when dmPolicy is 'disabled'", async () => {
    vi.mocked(resolveBasecampDmPolicy).mockReturnValue("disabled");

    const result = await dispatchBasecampEvent(dmMsg(), { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(false);
    expect(kernel.lastResult().admission.reason).toMatch(/^ingress:/);
  });

  it("issues a pairing challenge (via Ping) when dmPolicy is 'pairing' and sender unknown", async () => {
    vi.mocked(resolveBasecampDmPolicy).mockReturnValue("pairing");
    vi.mocked(resolveBasecampAllowFrom).mockReturnValue([]);
    vi.mocked(resolveBasecampAccount).mockReturnValue(mockAccount);

    const result = await dispatchBasecampEvent(dmMsg(), { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(false);
    expect(kernel.lastResult().admission).toMatchObject({ kind: "handled", reason: "pairing_challenge" });
    expect(kernel.runtime.channel.pairing.upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "basecamp", id: "777" }),
    );
    // Challenge delivered as a Basecamp Ping via the circles endpoint
    expect(mockPingPost).toHaveBeenCalledWith("/circles/people/777/lines.json", expect.anything());
  });

  it("allows DMs when dmPolicy is 'pairing' and sender in allowFrom", async () => {
    vi.mocked(resolveBasecampDmPolicy).mockReturnValue("pairing");
    vi.mocked(resolveBasecampAllowFrom).mockReturnValue(["777"]);

    const result = await dispatchBasecampEvent(dmMsg(), { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("honors pairing-store approvals under 'pairing' policy", async () => {
    vi.mocked(resolveBasecampDmPolicy).mockReturnValue("pairing");
    vi.mocked(resolveBasecampAllowFrom).mockReturnValue([]);
    kernel.runtime.channel.pairing.readAllowFromStore.mockResolvedValue(["777"]);

    const result = await dispatchBasecampEvent(dmMsg(), { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(true);
    expect(kernel.runtime.channel.pairing.upsertPairingRequest).not.toHaveBeenCalled();
  });

  it("drops DMs when dmPolicy is 'allowlist' and sender not listed", async () => {
    vi.mocked(resolveBasecampDmPolicy).mockReturnValue("allowlist");
    vi.mocked(resolveBasecampAllowFrom).mockReturnValue(["someone-else"]);

    const result = await dispatchBasecampEvent(dmMsg(), { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(false);
    expect(kernel.runtime.channel.pairing.upsertPairingRequest).not.toHaveBeenCalled();
  });

  it("allows DMs when dmPolicy is 'open'", async () => {
    vi.mocked(resolveBasecampDmPolicy).mockReturnValue("open");

    const result = await dispatchBasecampEvent(dmMsg(), { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-bucket allowFrom as an ingress route descriptor (§2.3)
// ---------------------------------------------------------------------------

describe("bucket sender gate (route descriptor)", () => {
  it("drops events when sender not in bucket allowFrom", async () => {
    vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(["1", "2"]);

    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });

    expect(result).toBe(false);
    expect(kernel.lastResult().admission.reason).toMatch(/^ingress:/);
  });

  it("allows events when sender is in bucket allowFrom", async () => {
    vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(["777"]);

    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });

  it("bucket allowFrom applies to conversation engagement too", async () => {
    mockCfg.channels.basecamp.buckets = { "456": { engage: ["conversation"] } };
    vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(["1"]);
    const msg = { ...mockMsg, meta: { ...mockMsg.meta, recordableType: "Chat::Line" as const, mentionsAgent: false } };

    const result = await dispatchBasecampEvent(msg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("DM policy still applies after bucket sender gate passes", async () => {
    vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(["777"]);
    vi.mocked(resolveBasecampDmPolicy).mockReturnValue("disabled");

    const result = await dispatchBasecampEvent(dmMsg(), { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(false);
  });

  it("no bucket allowFrom = all senders pass (existing behavior)", async () => {
    vi.mocked(resolveBasecampBucketAllowFrom).mockReturnValue(undefined);

    const result = await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg });
    expect(result).toBe(true);
  });
});
