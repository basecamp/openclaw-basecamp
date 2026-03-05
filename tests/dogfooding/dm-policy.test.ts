/**
 * DF-012 → DF-017: DM policy and engagement gate integration tests.
 *
 * Validates the full dispatch gate pipeline: engagement classification,
 * per-bucket engage overrides, DM policy enforcement, and default behavior.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchBasecampEvent } from "../../src/dispatch.js";
import type { BasecampInboundMessage, ResolvedBasecampAccount } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLoadConfig = vi.fn();
const mockResolveRoute = vi.fn();
const mockDispatchReply = vi.fn();

vi.mock("../../src/runtime.js", () => ({
  getBasecampRuntime: vi.fn(() => ({
    config: { loadConfig: mockLoadConfig },
    channel: {
      routing: { resolveAgentRoute: (...args: unknown[]) => mockResolveRoute(...args) },
      reply: { dispatchReplyWithBufferedBlockDispatcher: (...args: unknown[]) => mockDispatchReply(...args) },
    },
  })),
}));

const mockResolvePersona = vi.fn(() => undefined);
const mockResolveAccount = vi.fn();
const mockResolveDmPolicy = vi.fn(() => "open");
const mockResolveAllowFrom = vi.fn(() => [] as string[]);

vi.mock("../../src/config.js", () => ({
  resolvePersonaAccountId: (...args: unknown[]) => mockResolvePersona(...args),
  resolveBasecampAccount: (...args: unknown[]) => mockResolveAccount(...args),
  resolveBasecampDmPolicy: (...args: unknown[]) => mockResolveDmPolicy(...args),
  resolveBasecampAllowFrom: (...args: unknown[]) => mockResolveAllowFrom(...args),
  resolveCircuitBreakerConfig: vi.fn(() => ({ threshold: 5, cooldownMs: 300000 })),
  resolveBasecampBucketAllowFrom: vi.fn(() => undefined),
}));

vi.mock("../../src/outbound/send.js", () => ({
  postReplyToEvent: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../src/outbound/format.js", () => ({
  markdownToBasecampHtml: vi.fn((t: string) => `<p>${t}</p>`),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const account: ResolvedBasecampAccount = {
  accountId: "test-acct",
  enabled: true,
  personId: "999",
  token: "tok",
  tokenSource: "config",
  config: { personId: "999", basecampAccountId: "12345" },
};

function baseMeta() {
  return {
    bucketId: "456",
    recordingId: "1",
    recordableType: "Chat::Transcript" as const,
    eventKind: "created",
    mentions: [] as string[],
    mentionsAgent: false,
    attachments: [] as string[],
    sources: ["activity_feed"] as string[],
  };
}

function msg(overrides?: Partial<BasecampInboundMessage> & { meta?: Record<string, unknown> }): BasecampInboundMessage {
  const { meta: metaOverrides, ...rest } = overrides ?? {};
  return {
    channel: "basecamp",
    accountId: "test-acct",
    peer: { kind: "group", id: "recording:1" },
    parentPeer: { kind: "group", id: "bucket:456" },
    sender: { id: "777", name: "Test User" },
    text: "hello",
    html: "<p>hello</p>",
    meta: { ...baseMeta(), ...metaOverrides },
    dedupKey: "test:1",
    createdAt: "2025-01-15T10:00:00Z",
    ...rest,
  } as BasecampInboundMessage;
}

function dmMsg(senderId = "777"): BasecampInboundMessage {
  return msg({
    peer: { kind: "dm", id: `dm:${senderId}` },
    sender: { id: senderId, name: "DM Sender" },
    meta: { mentionsAgent: false, recordableType: "Chat::Transcript" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dogfooding — DM policy & engagement gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: route exists, config is open, account resolves
    mockResolveRoute.mockReturnValue({
      agentId: "agent-1",
      matchedBy: "peer",
      sessionKey: "sess-1",
    });
    mockDispatchReply.mockResolvedValue(undefined);
    mockResolveAccount.mockReturnValue(account);
    mockResolveDmPolicy.mockReturnValue("open");
    mockResolveAllowFrom.mockReturnValue([]);
    mockLoadConfig.mockReturnValue({
      channels: {
        basecamp: {
          accounts: { "test-acct": { personId: "999", basecampAccountId: "12345" } },
        },
      },
    });
  });

  // DF-012: dmPolicy disabled drops DMs
  it("DF-012: drops DMs when dmPolicy is disabled", async () => {
    mockResolveDmPolicy.mockReturnValue("disabled");

    const result = await dispatchBasecampEvent(dmMsg(), { account });

    expect(result).toBe(false);
    expect(mockDispatchReply).not.toHaveBeenCalled();
  });

  // DF-013: pairing policy allows sender in allowFrom
  it("DF-013: allows DM when sender is in allowFrom list (pairing)", async () => {
    mockResolveDmPolicy.mockReturnValue("pairing");
    mockResolveAllowFrom.mockReturnValue(["777"]);

    const result = await dispatchBasecampEvent(dmMsg("777"), { account });

    expect(result).toBe(true);
    expect(mockDispatchReply).toHaveBeenCalled();
  });

  // DF-014: pairing policy blocks sender not in allowFrom
  it("DF-014: drops DM when sender is not in allowFrom list (pairing)", async () => {
    mockResolveDmPolicy.mockReturnValue("pairing");
    mockResolveAllowFrom.mockReturnValue(["777"]);

    const result = await dispatchBasecampEvent(dmMsg("888"), { account });

    expect(result).toBe(false);
    expect(mockDispatchReply).not.toHaveBeenCalled();
  });

  // DF-015: default config (pairing with empty allowFrom) drops all DMs
  it("DF-015: default pairing policy with empty allowFrom drops all DMs", async () => {
    mockResolveDmPolicy.mockReturnValue("pairing");
    mockResolveAllowFrom.mockReturnValue([]);

    const result = await dispatchBasecampEvent(dmMsg("777"), { account });

    expect(result).toBe(false);
    expect(mockDispatchReply).not.toHaveBeenCalled();
  });

  // DF-016: engagement gate blocks DMs when "dm" not in engage policy
  it("DF-016: engagement gate drops DMs before DM policy when dm not in engage", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        basecamp: {
          accounts: { "test-acct": { personId: "999", basecampAccountId: "12345" } },
          engage: ["mention"],
        },
      },
    });

    const result = await dispatchBasecampEvent(dmMsg(), { account });

    expect(result).toBe(false);
    // DM policy should NOT have been consulted — gate drops first
    expect(mockDispatchReply).not.toHaveBeenCalled();
  });

  // DF-017: per-bucket engage override takes precedence
  it("DF-017: per-bucket engage override takes precedence over channel-level", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        basecamp: {
          accounts: { "test-acct": { personId: "999", basecampAccountId: "12345" } },
          engage: ["dm", "mention", "conversation"],
          buckets: {
            "456": { engage: ["mention"] },
          },
        },
      },
    });

    // Send a conversation event for bucket 456 — bucket override says mention-only
    const conversationMsg = msg({
      meta: {
        recordableType: "Chat::Transcript",
        mentionsAgent: false,
      },
    });

    const result = await dispatchBasecampEvent(conversationMsg, { account });

    expect(result).toBe(false);
    expect(mockDispatchReply).not.toHaveBeenCalled();
  });
});
