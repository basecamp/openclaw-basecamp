import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClient = {
  projects: { list: vi.fn() },
  people: { list: vi.fn(), listForProject: vi.fn() },
  authorization: { getInfo: vi.fn() },
  campfires: { createLine: vi.fn() },
  comments: { create: vi.fn() },
  reports: { progress: vi.fn() },
  raw: {
    GET: vi.fn(),
    POST: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
  },
};

vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => mockClient),
  numId: (_label: string, value: string | number) => Number(value),
  rawOrThrow: vi.fn(async (result: any) => result?.data),
  BasecampError: class BasecampError extends Error {
    code: string;
    constructor(msg: string, code: string) { super(msg); this.code = code; }
  },
  clearClients: vi.fn(),
}));
vi.mock("../src/outbound/format.js", () => ({
  markdownToBasecampHtml: vi.fn((t: string) => t),
}));
vi.mock("../src/runtime.js", () => ({
  getBasecampRuntime: vi.fn(),
}));
vi.mock("../src/config.js", () => ({
  resolveBasecampAccount: vi.fn(),
}));

import { postCampfireLine, postComment, postReplyToEvent } from "../src/outbound/send.js";
import type { ResolvedBasecampAccount } from "../src/types.js";

const TEST_ACCOUNT: ResolvedBasecampAccount = {
  accountId: "test-account",
  enabled: true,
  personId: "99",
  token: "test-token",
  tokenSource: "config" as const,
  config: { personId: "99", basecampAccountId: "12345" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// postCampfireLine
// ---------------------------------------------------------------------------

describe("postCampfireLine", () => {
  it("calls client.campfires.createLine and returns ok", async () => {
    mockClient.campfires.createLine.mockResolvedValue({ id: 42 });

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
      account: TEST_ACCOUNT,
    });

    expect(result).toEqual({ ok: true, recordingId: "42" });
    expect(mockClient.campfires.createLine).toHaveBeenCalledTimes(1);
    expect(mockClient.campfires.createLine).toHaveBeenCalledWith(1, 2, { content: "Hello" });
  });

  it("retries on retryable TypeError and succeeds", async () => {
    mockClient.campfires.createLine
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ id: 99 });

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
      account: TEST_ACCOUNT,
      retries: 3,
    });

    expect(result).toEqual({ ok: true, recordingId: "99" });
    expect(mockClient.campfires.createLine).toHaveBeenCalledTimes(2);
  });

  it("returns retryable=true on TypeError with fetch message", async () => {
    mockClient.campfires.createLine.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
      account: TEST_ACCOUNT,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
    }
  });

  it("returns retryable=false on non-retryable Error", async () => {
    mockClient.campfires.createLine.mockRejectedValue(new Error("403 Forbidden"));

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
      account: TEST_ACCOUNT,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
    }
  });

  it("returns retryable=false for non-TypeError", async () => {
    mockClient.campfires.createLine.mockRejectedValue(new Error("generic error"));

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
      account: TEST_ACCOUNT,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// postComment
// ---------------------------------------------------------------------------

describe("postComment", () => {
  it("calls client.comments.create and returns ok", async () => {
    mockClient.comments.create.mockResolvedValue({ id: 55 });

    const result = await postComment({
      bucketId: "1",
      recordingId: "2",
      content: "A comment",
      account: TEST_ACCOUNT,
    });

    expect(result).toEqual({ ok: true, commentId: "55" });
    expect(mockClient.comments.create).toHaveBeenCalledTimes(1);
    expect(mockClient.comments.create).toHaveBeenCalledWith(1, 2, { content: "A comment" });
  });

  it("retries on retryable TypeError and succeeds", async () => {
    mockClient.comments.create
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ id: 77 });

    const result = await postComment({
      bucketId: "1",
      recordingId: "2",
      content: "A comment",
      account: TEST_ACCOUNT,
      retries: 2,
    });

    expect(result).toEqual({ ok: true, commentId: "77" });
    expect(mockClient.comments.create).toHaveBeenCalledTimes(2);
  });

  it("returns retryable on TypeError failure", async () => {
    mockClient.comments.create.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await postComment({
      bucketId: "1",
      recordingId: "2",
      content: "A comment",
      account: TEST_ACCOUNT,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// postReplyToEvent
// ---------------------------------------------------------------------------

describe("postReplyToEvent", () => {
  it("posts campfire line for Chat::Transcript and returns messageId", async () => {
    mockClient.campfires.createLine.mockResolvedValue({ id: 10 });

    const result = await postReplyToEvent({
      bucketId: "1",
      recordingId: "2",
      recordableType: "Chat::Transcript",
      peerId: "recording:2",
      content: "Reply",
      account: TEST_ACCOUNT,
      retries: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("10");
  });

  it("posts comment for non-chat types and returns messageId", async () => {
    mockClient.comments.create.mockResolvedValue({ id: 20 });

    const result = await postReplyToEvent({
      bucketId: "1",
      recordingId: "2",
      recordableType: "Todo",
      peerId: "recording:2",
      content: "Comment reply",
      account: TEST_ACCOUNT,
      retries: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("20");
  });

  it("returns retryable field from underlying call", async () => {
    mockClient.comments.create.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await postReplyToEvent({
      bucketId: "1",
      recordingId: "2",
      recordableType: "Message",
      peerId: "recording:2",
      content: "Reply",
      account: TEST_ACCOUNT,
    });

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker integration
// ---------------------------------------------------------------------------

describe("postCampfireLine with circuit breaker", () => {
  it("calls createLine through circuit breaker", async () => {
    const { CircuitBreaker } = await import("../src/circuit-breaker.js");
    const cb = new CircuitBreaker();
    mockClient.campfires.createLine.mockResolvedValue({ id: 100 });

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
      account: TEST_ACCOUNT,
      circuitBreaker: { instance: cb, key: "outbound" },
    });

    expect(result).toEqual({ ok: true, recordingId: "100" });
    expect(mockClient.campfires.createLine).toHaveBeenCalledTimes(1);
  });

  it("returns error when circuit breaker is open", async () => {
    const { CircuitBreaker } = await import("../src/circuit-breaker.js");
    const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
    cb.recordFailure("outbound"); // trips at threshold=1

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
      account: TEST_ACCOUNT,
      circuitBreaker: { instance: cb, key: "outbound" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Circuit breaker open");
    }
  });
});

describe("postComment with circuit breaker", () => {
  it("calls create through circuit breaker", async () => {
    const { CircuitBreaker } = await import("../src/circuit-breaker.js");
    const cb = new CircuitBreaker();
    mockClient.comments.create.mockResolvedValue({ id: 200 });

    const result = await postComment({
      bucketId: "1",
      recordingId: "2",
      content: "A comment",
      account: TEST_ACCOUNT,
      circuitBreaker: { instance: cb, key: "outbound" },
    });

    expect(result).toEqual({ ok: true, commentId: "200" });
    expect(mockClient.comments.create).toHaveBeenCalledTimes(1);
  });
});
