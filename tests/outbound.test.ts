import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRecentOutboundMessageIdentity,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBasecampRuntime, setBasecampRuntime } from "../src/runtime.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "bc-outbound-"));
  setBasecampRuntime({
    state: { resolveStateDir: () => stateDir },
  } as any);
});

afterEach(async () => {
  const { closeAllRecordingIndexes } = await import("../src/inbound/recording-index.js");
  await closeAllRecordingIndexes();
  clearBasecampRuntime();
  rmSync(stateDir, { recursive: true, force: true });
});

import { chunkMarkdownText, parseOutboundTarget, resolveOutboundTarget } from "../src/adapters/outbound.js";

// --- Basecamp client mock (all API writes go through it) ---
// vi.hoisted: the vi.mock factory below is hoisted above imports.
const { MockBasecampError, mockClient } = vi.hoisted(() => {
  class MockBasecampError extends Error {
    httpStatus?: number;
    constructor(msg: string, httpStatus?: number) {
      super(msg);
      this.name = "BasecampError";
      this.httpStatus = httpStatus;
    }
  }
  const mockClient = {
    campfires: { createLine: vi.fn() },
    comments: { create: vi.fn() },
    projects: { get: vi.fn() },
    attachments: { create: vi.fn() },
    raw: { GET: vi.fn() },
  };
  return { MockBasecampError, mockClient };
});

vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => mockClient),
  numId: (_label: string, value: string | number) => Number(value),
  rawOrThrow: vi.fn(async (result: any) => result?.data),
  isBasecampError: (err: unknown): err is MockBasecampError => err instanceof MockBasecampError,
  BasecampError: MockBasecampError,
  clearClients: vi.fn(),
}));

// --- Mocks required to import channel.ts without pulling in heavy deps ---
vi.mock("../src/dispatch.js", () => ({ dispatchBasecampEvent: vi.fn() }));
vi.mock("../src/adapters/onboarding.js", () => ({ basecampSetupWizard: {} }));
vi.mock("../src/adapters/status.js", () => ({ basecampStatusAdapter: {} }));
vi.mock("../src/adapters/pairing.js", () => ({ basecampPairingAdapter: {} }));
vi.mock("../src/adapters/directory.js", () => ({ basecampDirectoryAdapter: {} }));
vi.mock("../src/adapters/messaging.js", () => ({ basecampMessagingAdapter: {} }));
vi.mock("../src/adapters/resolver.js", () => ({ basecampResolverAdapter: {} }));
vi.mock("../src/adapters/heartbeat.js", () => ({ basecampHeartbeatAdapter: {} }));
vi.mock("../src/adapters/groups.js", () => ({ basecampGroupAdapter: {} }));
vi.mock("../src/adapters/agent-prompt.js", () => ({ basecampAgentPromptAdapter: {} }));

import { basecampChannel } from "../src/channel.js";
import { getRecordingIndex } from "../src/inbound/recording-index.js";
import { clearDefaultChatCache, sendBasecampMedia, sendBasecampText } from "../src/outbound/send.js";

let accountSeq = 0;

/** Unique account id per test — send.ts caches (index, chat, circle) by account. */
function nextAccountId(): string {
  accountSeq += 1;
  return `acct-${accountSeq}`;
}

function makeCfg(accountId: string, accountOverrides?: Record<string, unknown>) {
  return {
    channels: {
      basecamp: {
        accounts: {
          [accountId]: {
            personId: "99",
            token: "test-token",
            basecampAccountId: "12345",
            ...accountOverrides,
          },
        },
      },
    },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearDefaultChatCache();
});

// ---------------------------------------------------------------------------
// Target grammar — parseOutboundTarget / resolveOutboundTarget (SPEC §2.5)
// ---------------------------------------------------------------------------

describe("outbound.parseOutboundTarget", () => {
  it("parses recording:<id>", () => {
    expect(parseOutboundTarget("recording:123")).toEqual({ kind: "recording", recordingId: "123" });
  });

  it("parses ping:<id> as a circle bucket", () => {
    expect(parseOutboundTarget("ping:456")).toEqual({ kind: "ping", bucketId: "456" });
  });

  it("parses bucket:<id>", () => {
    expect(parseOutboundTarget("bucket:789")).toEqual({ kind: "bucket", bucketId: "789" });
  });

  it("parses the explicit cold-send form bucket:<b>/recording:<r>", () => {
    expect(parseOutboundTarget("bucket:1/recording:2")).toEqual({
      kind: "recording",
      recordingId: "2",
      bucketId: "1",
    });
  });

  it("rejects non-numeric ids and unknown prefixes", () => {
    expect(parseOutboundTarget("recording:abc")).toBeUndefined();
    expect(parseOutboundTarget("slack:C123")).toBeUndefined();
    expect(parseOutboundTarget("hello world")).toBeUndefined();
  });
});

describe("outbound.resolveTarget", () => {
  it("accepts all four target forms", () => {
    for (const to of ["recording:123", "ping:456", "bucket:789", "bucket:1/recording:2"]) {
      expect(resolveOutboundTarget(to)).toEqual({ ok: true, to });
    }
  });

  it("rejects empty string", () => {
    const result = resolveOutboundTarget("");
    expect(result.ok).toBe(false);
  });

  it("rejects unknown prefix, naming the expected grammar", () => {
    const result = resolveOutboundTarget("slack:C123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("slack:C123");
      expect(result.error).toContain("recording:<id>");
    }
  });

  it("rejects non-numeric ID", () => {
    const result = resolveOutboundTarget("recording:abc");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendBasecampText — real delivery (SPEC §2.5)
// ---------------------------------------------------------------------------

describe("outbound.sendBasecampText", () => {
  it("posts a campfire line for an indexed chat recording", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("111", { bucketId: "10", recordableType: "Chat::Transcript" });
    mockClient.campfires.createLine.mockResolvedValue({ id: 42 });

    const result = await sendBasecampText({
      cfg: makeCfg(accountId),
      to: "recording:111",
      text: "**bold** hello",
      accountId,
    });

    expect(result).toEqual({ messageId: "42", target: { kind: "conversation", id: "recording:111" } });
    expect(mockClient.campfires.createLine).toHaveBeenCalledWith(111, {
      content: "<strong>bold</strong> hello",
      contentType: "text/html",
    });
  });

  it("posts a comment for an indexed non-chat recording", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("222", { bucketId: "10", recordableType: "Todo" });
    mockClient.comments.create.mockResolvedValue({ id: 55 });

    const result = await sendBasecampText({
      cfg: makeCfg(accountId),
      to: "recording:222",
      text: "a reply",
      accountId,
    });

    expect(result).toEqual({ messageId: "55", target: { kind: "conversation", id: "recording:222" } });
    expect(mockClient.comments.create).toHaveBeenCalledWith(222, { content: "a reply" });
    expect(mockClient.campfires.createLine).not.toHaveBeenCalled();
  });

  it("cold-sends a comment for the explicit bucket:<b>/recording:<r> form", async () => {
    const accountId = nextAccountId();
    mockClient.comments.create.mockResolvedValue({ id: 77 });

    const result = await sendBasecampText({
      cfg: makeCfg(accountId),
      to: "bucket:9/recording:333",
      text: "cold",
      accountId,
    });

    expect(result.messageId).toBe("77");
    expect(result.target).toEqual({ kind: "conversation", id: "recording:333" });
    expect(mockClient.comments.create).toHaveBeenCalledWith(333, { content: "cold" });
  });

  it("posts to the project's default chat for bucket:<id> targets via the dock", async () => {
    const accountId = nextAccountId();
    mockClient.projects.get.mockResolvedValue({
      dock: [
        { name: "todoset", id: 1, enabled: true },
        { name: "chat", id: 555, enabled: true },
      ],
    });
    mockClient.campfires.createLine.mockResolvedValue({ id: 88 });

    const result = await sendBasecampText({
      cfg: makeCfg(accountId),
      to: "bucket:20",
      text: "hi project",
      accountId,
    });

    expect(mockClient.projects.get).toHaveBeenCalledWith(20);
    expect(mockClient.campfires.createLine).toHaveBeenCalledWith(555, {
      content: "hi project",
      contentType: "text/html",
    });
    expect(result.target).toEqual({ kind: "conversation", id: "recording:555" });
  });

  it("throws a fix-naming error when the project has no enabled chat", async () => {
    const accountId = nextAccountId();
    mockClient.projects.get.mockResolvedValue({ dock: [{ name: "chat", id: 555, enabled: false }] });

    await expect(sendBasecampText({ cfg: makeCfg(accountId), to: "bucket:21", text: "x", accountId })).rejects.toThrow(
      /no enabled Chat.*bucket:21\/recording:<id>/s,
    );
  });

  it("resolves ping:<id> to the circle transcript", async () => {
    const accountId = nextAccountId();
    mockClient.raw.GET.mockResolvedValue({
      data: { room_url: "https://3.basecamp.com/1/buckets/30/chats/616", people: [{ id: 1 }] },
    });
    mockClient.campfires.createLine.mockResolvedValue({ id: 99 });

    const result = await sendBasecampText({
      cfg: makeCfg(accountId),
      to: "ping:30",
      text: "pong",
      accountId,
    });

    expect(mockClient.campfires.createLine).toHaveBeenCalledWith(616, {
      content: "pong",
      contentType: "text/html",
    });
    expect(result.target).toEqual({ kind: "conversation", id: "ping:30" });
  });

  it("throws PlatformMessageNotDispatchedError naming the cold-send fix for unknown recordings", async () => {
    const accountId = nextAccountId();

    const err = await sendBasecampText({
      cfg: makeCfg(accountId),
      to: "recording:404404",
      text: "x",
      accountId,
    }).then(
      () => undefined,
      (e) => e,
    );

    expect(err).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(err.message).toContain("bucket:<bucketId>/recording:404404");
    expect(mockClient.comments.create).not.toHaveBeenCalled();
    expect(mockClient.campfires.createLine).not.toHaveBeenCalled();
  });

  it("throws for grammar-invalid targets without touching the API", async () => {
    const accountId = nextAccountId();

    await expect(sendBasecampText({ cfg: makeCfg(accountId), to: "slack:C1", text: "x", accountId })).rejects.toThrow(
      PlatformMessageNotDispatchedError,
    );
    expect(mockClient.campfires.createLine).not.toHaveBeenCalled();
  });

  it("enforces virtual-account bucket scoping", async () => {
    const accountId = nextAccountId();
    const cfg = {
      channels: {
        basecamp: {
          accounts: { [accountId]: { personId: "99", token: "t", basecampAccountId: "12345" } },
          virtualAccounts: { scoped: { accountId, bucketId: "10" } },
        },
      },
    } as any;

    await expect(
      sendBasecampText({ cfg, to: "bucket:999/recording:1", text: "x", accountId: "scoped" }),
    ).rejects.toThrow(/scoped to bucket 10/);
    expect(mockClient.comments.create).not.toHaveBeenCalled();
  });

  it("maps a 4xx API rejection to PlatformMessageNotDispatchedError", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("444", { bucketId: "10", recordableType: "Todo" });
    mockClient.comments.create.mockRejectedValue(new MockBasecampError("422 Unprocessable", 422));

    const err = await sendBasecampText({
      cfg: makeCfg(accountId),
      to: "recording:444",
      text: "x",
      accountId,
    }).then(
      () => undefined,
      (e) => e,
    );

    expect(err).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(err.retryable).toBe(false);
  });

  it("rethrows ambiguous network failures without a not-dispatched claim", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("445", { bucketId: "10", recordableType: "Todo" });
    mockClient.comments.create.mockRejectedValue(new TypeError("fetch failed"));

    const err = await sendBasecampText({
      cfg: makeCfg(accountId),
      to: "recording:445",
      text: "x",
      accountId,
    }).then(
      () => undefined,
      (e) => e,
    );

    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(PlatformMessageNotDispatchedError);
  });

  it("records outbound message identity for echo suppression (SPEC §2.12)", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("666", { bucketId: "10", recordableType: "Message" });
    mockClient.comments.create.mockResolvedValue({ id: 6001 });

    await sendBasecampText({ cfg: makeCfg(accountId), to: "recording:666", text: "echo me", accountId });

    expect(
      isRecentOutboundMessageIdentity({
        channel: "basecamp",
        accountId,
        conversationId: "recording:666",
        messageId: "6001",
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sendBasecampMedia — attachment upload + bc-attachment embed (SPEC §2.5)
// ---------------------------------------------------------------------------

describe("outbound.sendBasecampMedia", () => {
  it("uploads and embeds a bc-attachment for comment targets", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("777", { bucketId: "10", recordableType: "Todo" });
    mockClient.attachments.create.mockResolvedValue({ attachable_sgid: "SGID123" });
    mockClient.comments.create.mockResolvedValue({ id: 7001 });

    const mediaReadFile = vi.fn(async () => Buffer.from("png-bytes"));
    const result = await sendBasecampMedia({
      cfg: makeCfg(accountId),
      to: "recording:777",
      text: "see attached",
      mediaUrl: "/tmp/chart.png",
      accountId,
      mediaReadFile,
    });

    expect(mediaReadFile).toHaveBeenCalledWith("/tmp/chart.png");
    expect(mockClient.attachments.create).toHaveBeenCalledWith(expect.any(Uint8Array), "image/png", "chart.png");
    const content = mockClient.comments.create.mock.calls[0]![1].content as string;
    expect(content).toContain('<bc-attachment sgid="SGID123"');
    expect(content).toContain("see attached");
    expect(result.messageId).toBe("7001");
  });

  it("resolves a chat-line target to its parent transcript", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("50001", { bucketId: "10", recordableType: "Chat::Line", parentRecordingId: "50000" });
    mockClient.campfires.createLine.mockResolvedValue({ id: 9101 });

    const result = await sendBasecampText({ cfg: makeCfg(accountId), to: "recording:50001", text: "hi", accountId });

    expect(mockClient.campfires.createLine).toHaveBeenCalledWith(
      50000,
      expect.objectContaining({ content: expect.stringContaining("hi") }),
    );
    expect(result.target).toEqual({ kind: "conversation", id: "recording:50000" });
  });

  it("rejects local media larger than the account's media limit", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("780", { bucketId: "10", recordableType: "Todo" });
    const mediaReadFile = vi.fn(async () => Buffer.alloc(26 * 1024 * 1024));
    await expect(
      sendBasecampMedia({
        cfg: makeCfg(accountId),
        to: "recording:780",
        text: "big local",
        mediaUrl: "/tmp/big.bin",
        accountId,
        mediaReadFile,
      }),
    ).rejects.toThrow(/exceeds the 25 MB limit/);
    expect(mockClient.attachments.create).not.toHaveBeenCalled();
  });

  it("rejects remote media larger than the account's media limit", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("779", { bucketId: "10", recordableType: "Todo" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Buffer.alloc(2 * 1024 * 1024), { status: 200 })),
    );
    try {
      await expect(
        sendBasecampMedia({
          cfg: makeCfg(accountId, { mediaMaxMb: 1 }),
          to: "recording:779",
          text: "huge",
          mediaUrl: "https://example.com/huge.png",
          accountId,
        }),
      ).rejects.toThrow(/exceeds the 1 MB limit/);
      expect(mockClient.attachments.create).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-reads the project dock after the default-chat cache TTL expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const accountId = nextAccountId();
      mockClient.projects.get.mockResolvedValue({ dock: [{ name: "chat", id: 42, enabled: true }] });
      mockClient.campfires.createLine.mockResolvedValue({ id: 1 });

      await sendBasecampText({ cfg: makeCfg(accountId), to: "bucket:77", text: "a", accountId });
      await sendBasecampText({ cfg: makeCfg(accountId), to: "bucket:77", text: "b", accountId });
      expect(mockClient.projects.get).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-01-01T00:06:00Z"));
      mockClient.projects.get.mockResolvedValue({ dock: [{ name: "chat", id: 43, enabled: true }] });
      await sendBasecampText({ cfg: makeCfg(accountId), to: "bucket:77", text: "c", accountId });
      expect(mockClient.projects.get).toHaveBeenCalledTimes(2);
      expect(mockClient.campfires.createLine).toHaveBeenLastCalledWith(43, expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks permanent media fetch failures non-retryable and 5xx retryable", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("782", { bucketId: "10", recordableType: "Todo" });
    const send = (status: number) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("nope", { status })),
      );
      return sendBasecampMedia({
        cfg: makeCfg(accountId),
        to: "recording:782",
        text: "x",
        mediaUrl: "https://example.com/gone.png",
        accountId,
      });
    };
    try {
      await expect(send(404)).rejects.toMatchObject({ retryable: false });
      await expect(send(503)).rejects.toMatchObject({ retryable: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects loopback media URLs (SSRF guard)", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("781", { bucketId: "10", recordableType: "Todo" });
    await expect(
      sendBasecampMedia({
        cfg: makeCfg(accountId),
        to: "recording:781",
        text: "ssrf",
        mediaUrl: "http://127.0.0.1:1/secret",
        accountId,
      }),
    ).rejects.toThrow(/Failed to fetch media/);
    expect(mockClient.attachments.create).not.toHaveBeenCalled();
  });

  it("sends caption + URL as a line for campfire targets (no native chat embeds)", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("888", { bucketId: "10", recordableType: "Chat::Transcript" });
    mockClient.campfires.createLine.mockResolvedValue({ id: 8001 });

    const result = await sendBasecampMedia({
      cfg: makeCfg(accountId),
      to: "recording:888",
      text: "a chart",
      mediaUrl: "https://example.com/chart.png",
      accountId,
    });

    expect(mockClient.attachments.create).not.toHaveBeenCalled();
    const req = mockClient.campfires.createLine.mock.calls[0]![1];
    expect(req.content).toContain("https://example.com/chart.png");
    expect(req.content).toContain("a chart");
    expect(result.messageId).toBe("8001");
  });

  it("throws not-dispatched for local media aimed at a campfire target", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("889", { bucketId: "10", recordableType: "Chat::Transcript" });

    await expect(
      sendBasecampMedia({
        cfg: makeCfg(accountId),
        to: "recording:889",
        text: "x",
        mediaUrl: "/tmp/local.png",
        accountId,
      }),
    ).rejects.toThrow(PlatformMessageNotDispatchedError);
    expect(mockClient.campfires.createLine).not.toHaveBeenCalled();
  });

  it("throws not-dispatched when no media URL is provided", async () => {
    const accountId = nextAccountId();
    await expect(
      sendBasecampMedia({ cfg: makeCfg(accountId), to: "recording:1", text: "x", accountId }),
    ).rejects.toThrow(PlatformMessageNotDispatchedError);
  });

  it("throws not-dispatched when the attachment upload fails", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("890", { bucketId: "10", recordableType: "Todo" });
    mockClient.attachments.create.mockRejectedValue(new Error("upload broke"));

    await expect(
      sendBasecampMedia({
        cfg: makeCfg(accountId),
        to: "recording:890",
        text: "x",
        mediaUrl: "/tmp/f.png",
        accountId,
        mediaReadFile: async () => Buffer.from("d"),
      }),
    ).rejects.toThrow(PlatformMessageNotDispatchedError);
    expect(mockClient.comments.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// chunkMarkdownText — compatibility wrapper over the SDK chunker (SPEC §2.8)
// ---------------------------------------------------------------------------

describe("outbound.chunkMarkdownText", () => {
  const LIMIT = 100;

  it("returns single chunk for short text", () => {
    expect(chunkMarkdownText("Hello world", LIMIT)).toEqual(["Hello world"]);
  });

  it("returns empty array for empty string", () => {
    expect(chunkMarkdownText("", LIMIT)).toEqual([]);
  });

  it("splits on paragraph boundaries within the limit", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const chunks = chunkMarkdownText(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
    }
  });

  it("splits an over-long single paragraph into chunks within the limit", () => {
    const text = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.";
    const chunks = chunkMarkdownText(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it("splits long unbroken word runs within the limit", () => {
    const text = Array(20).fill("longword").join(" ");
    const chunks = chunkMarkdownText(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it("preserves code fences intact when they fit", () => {
    const code = "```\nconst x = 1;\nconst y = 2;\n```";
    const text = `Before code.\n\n${code}\n\nAfter code.`;
    const chunks = chunkMarkdownText(text, 200);
    const joined = chunks.join("\n\n");
    expect(joined).toContain("```\nconst x = 1;");
    expect(joined).toContain("const y = 2;\n```");
  });

  it("never breaks inside a code fence without reopening it", () => {
    const code = `\`\`\`js\n${Array(30).fill("const aLongVariableName = 12345;").join("\n")}\n\`\`\``;
    const chunks = chunkMarkdownText(code, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Every chunk must contain balanced fences (SDK chunker reopens them)
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it("handles text at exactly the limit", () => {
    const text = "x".repeat(100);
    expect(chunkMarkdownText(text, 100)).toEqual([text]);
  });

  it("handles real-world Basecamp 10K limit", () => {
    const paragraphs = Array(50)
      .fill(null)
      .map((_, i) => `Paragraph ${i}: ${"lorem ipsum dolor sit amet ".repeat(8).trim()}.`);
    const text = paragraphs.join("\n\n");
    const chunks = chunkMarkdownText(text, 10000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10000);
    }
    const rejoined = chunks.join("\n\n");
    for (const p of paragraphs) {
      expect(rejoined).toContain(p);
    }
  });
});

// ---------------------------------------------------------------------------
// Outbound adapter contract on the composed channel plugin
// ---------------------------------------------------------------------------

describe("outbound adapter contract", () => {
  it("exposes real sendText and sendMedia on the channel plugin", () => {
    expect(typeof basecampChannel.outbound!.sendText).toBe("function");
    expect(typeof basecampChannel.outbound!.sendMedia).toBe("function");
  });

  it("uses the SDK chunker (chunkerMode markdown, no custom chunker)", () => {
    expect(basecampChannel.outbound!.chunkerMode).toBe("markdown");
    expect(basecampChannel.outbound!.chunker).toBeUndefined();
    expect(basecampChannel.outbound!.textChunkLimit).toBe(10_000);
  });

  it("declares presentation capabilities per SPEC §3.1", () => {
    const caps = basecampChannel.outbound!.presentationCapabilities!;
    expect(caps.supported).toBe(true);
    expect(caps.buttons).toBe(false);
    expect(caps.selects).toBe(false);
    expect(caps.context).toBe(true);
    expect(caps.divider).toBe(true);
    expect(caps.charts).toBe(false);
    expect(caps.tables).toBe(true);
    expect(caps.limits?.text).toEqual({ maxLength: 10_000, encoding: "characters", markdownDialect: "markdown" });
  });

  it("declares durable-final text delivery only", () => {
    expect(basecampChannel.outbound!.deliveryCapabilities).toEqual({ durableFinal: { text: true } });
  });

  it("exposes a message adapter bridged from the composed outbound adapter (SPEC §2.6)", () => {
    const message = basecampChannel.message!;
    expect(message.id).toBe("basecamp");
    expect(typeof message.send?.text).toBe("function");
    expect(typeof message.send?.media).toBe("function");
    // Durable-final capabilities come from the SAME outbound declaration.
    expect(message.durableFinal?.capabilities).toEqual(basecampChannel.outbound!.deliveryCapabilities!.durableFinal);
    expect(message.durableFinal?.capabilities).toEqual({ text: true });
    expect(message.receive).toEqual({
      defaultAckPolicy: "after_agent_dispatch",
      supportedAckPolicies: ["after_agent_dispatch"],
    });
  });

  it("message.send.text delivers through the outbound send path and returns a receipt", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("902", { bucketId: "10", recordableType: "Todo" });
    mockClient.comments.create.mockResolvedValue({ id: 9002 });

    const result = await basecampChannel.message!.send!.text!({
      cfg: makeCfg(accountId),
      to: "recording:902",
      text: "via message adapter",
      accountId,
    } as any);

    expect(mockClient.comments.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ messageId: "9002" });
    expect(result.receipt).toMatchObject({
      primaryPlatformMessageId: "9002",
      platformMessageIds: ["9002"],
      parts: [{ index: 0, kind: "text", platformMessageId: "9002" }],
    });
  });

  it("proves the declared durable-final text capability through the SDK contract verifier", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("903", { bucketId: "10", recordableType: "Todo" });
    mockClient.comments.create.mockResolvedValue({ id: 9003 });

    const results = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "basecamp",
      adapter: basecampChannel.message!,
      proofs: {
        // Text is durable-final only because one API write yields the
        // recording id that the receipt carries back.
        text: async () => {
          const result = await basecampChannel.message!.send!.text!({
            cfg: makeCfg(accountId),
            to: "recording:903",
            text: "proof",
            accountId,
          } as any);
          expect(result.receipt?.primaryPlatformMessageId).toBe("9003");
          expect(mockClient.comments.create).toHaveBeenCalledTimes(1);
        },
      },
    });

    expect(results).toEqual(
      expect.arrayContaining([
        { capability: "text", status: "verified" },
        { capability: "media", status: "not_declared" },
      ]),
    );
  });

  it("declares a configured-binding provider (SPEC §2.21)", () => {
    expect(basecampChannel.conversationBindings).toEqual({ supportsCurrentConversationBinding: false });
    expect(typeof basecampChannel.bindings?.compileConfiguredBinding).toBe("function");
    expect(typeof basecampChannel.bindings?.matchInboundConversation).toBe("function");
    expect(typeof basecampChannel.bindings?.resolveCommandConversation).toBe("function");
  });

  it("stamps the channel id on sendText results via attachedResults", async () => {
    const accountId = nextAccountId();
    const index = await getRecordingIndex(accountId, stateDir);
    index.record("901", { bucketId: "10", recordableType: "Todo" });
    mockClient.comments.create.mockResolvedValue({ id: 9001 });

    const result = await basecampChannel.outbound!.sendText!({
      cfg: makeCfg(accountId),
      to: "recording:901",
      text: "via adapter",
      accountId,
    } as any);

    expect(result).toEqual({
      channel: "basecamp",
      messageId: "9001",
      target: { kind: "conversation", id: "recording:901" },
    });
  });
});
