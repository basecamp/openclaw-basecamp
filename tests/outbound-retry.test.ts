import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/bcq.js", () => ({
  bcqApiPost: vi.fn(),
  bcqPost: vi.fn(),
  withRetry: vi.fn(),
  isRetryableError: vi.fn(),
  BcqError: class BcqError extends Error {
    constructor(
      msg: string,
      public exitCode: number | null,
      public stderr: string,
      public command: string[],
    ) {
      super(msg);
      this.name = "BcqError";
    }
  },
  CircuitBreaker: class CircuitBreaker {
    private _open = false;
    isOpen() { return this._open; }
    recordFailure() {}
    recordSuccess() {}
    getState() { return { failures: 0, trippedAt: null }; }
    setOpen(v: boolean) { this._open = v; }
  },
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
import { bcqApiPost, bcqPost, withRetry, isRetryableError, BcqError, CircuitBreaker } from "../src/bcq.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// postCampfireLine
// ---------------------------------------------------------------------------

describe("postCampfireLine", () => {
  it("calls bcqApiPost directly when retries is not set", async () => {
    vi.mocked(bcqApiPost).mockResolvedValue({ id: 42 });

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
    });

    expect(result).toEqual({ ok: true, recordingId: "42" });
    expect(bcqApiPost).toHaveBeenCalledTimes(1);
    expect(withRetry).not.toHaveBeenCalled();
  });

  it("calls withRetry with correct maxAttempts when retries > 0", async () => {
    vi.mocked(withRetry).mockResolvedValue({ id: 99 });

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
      retries: 3,
    });

    expect(result).toEqual({ ok: true, recordingId: "99" });
    expect(withRetry).toHaveBeenCalledTimes(1);
    expect(withRetry).toHaveBeenCalledWith(expect.any(Function), { maxAttempts: 4 });
    expect(bcqApiPost).not.toHaveBeenCalled(); // withRetry wraps it
  });

  it("returns retryable=true on transient BcqError", async () => {
    const err = new (BcqError as any)("timeout", 1, "ETIMEDOUT", ["bcq"]);
    vi.mocked(bcqApiPost).mockRejectedValue(err);
    vi.mocked(isRetryableError).mockReturnValue(true);

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
    });

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("timeout");
  });

  it("returns retryable=false on permanent BcqError", async () => {
    const err = new (BcqError as any)("forbidden", 1, "403 Forbidden", ["bcq"]);
    vi.mocked(bcqApiPost).mockRejectedValue(err);
    vi.mocked(isRetryableError).mockReturnValue(false);

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
    });

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it("returns retryable=false for non-BcqError", async () => {
    vi.mocked(bcqApiPost).mockRejectedValue(new Error("generic error"));

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
    });

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// postComment
// ---------------------------------------------------------------------------

describe("postComment", () => {
  it("calls bcqApiPost directly when retries is not set", async () => {
    vi.mocked(bcqApiPost).mockResolvedValue({ id: 55 });

    const result = await postComment({
      bucketId: "1",
      recordingId: "2",
      content: "A comment",
    });

    expect(result).toEqual({ ok: true, commentId: "55" });
    expect(bcqApiPost).toHaveBeenCalledTimes(1);
    expect(withRetry).not.toHaveBeenCalled();
  });

  it("calls withRetry with correct maxAttempts when retries > 0", async () => {
    vi.mocked(withRetry).mockResolvedValue({ id: 77 });

    const result = await postComment({
      bucketId: "1",
      recordingId: "2",
      content: "A comment",
      retries: 2,
    });

    expect(result).toEqual({ ok: true, commentId: "77" });
    expect(withRetry).toHaveBeenCalledWith(expect.any(Function), { maxAttempts: 3 });
  });

  it("returns retryable on BcqError failure", async () => {
    const err = new (BcqError as any)("fail", 1, "ECONNRESET", ["bcq"]);
    vi.mocked(bcqApiPost).mockRejectedValue(err);
    vi.mocked(isRetryableError).mockReturnValue(true);

    const result = await postComment({
      bucketId: "1",
      recordingId: "2",
      content: "A comment",
    });

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// postReplyToEvent
// ---------------------------------------------------------------------------

describe("postReplyToEvent", () => {
  it("passes retries through to postCampfireLine for Chat::Transcript", async () => {
    vi.mocked(withRetry).mockResolvedValue({ id: 10 });

    const result = await postReplyToEvent({
      bucketId: "1",
      recordingId: "2",
      recordableType: "Chat::Transcript",
      peerId: "recording:2",
      content: "Reply",
      retries: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("10");
    expect(withRetry).toHaveBeenCalledWith(expect.any(Function), { maxAttempts: 3 });
  });

  it("passes retries through to postComment for non-chat types", async () => {
    vi.mocked(withRetry).mockResolvedValue({ id: 20 });

    const result = await postReplyToEvent({
      bucketId: "1",
      recordingId: "2",
      recordableType: "Todo",
      peerId: "recording:2",
      content: "Comment reply",
      retries: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("20");
    expect(withRetry).toHaveBeenCalledWith(expect.any(Function), { maxAttempts: 2 });
  });

  it("returns retryable field from underlying call", async () => {
    const err = new (BcqError as any)("timeout", 1, "ETIMEDOUT", ["bcq"]);
    vi.mocked(bcqApiPost).mockRejectedValue(err);
    vi.mocked(isRetryableError).mockReturnValue(true);

    const result = await postReplyToEvent({
      bucketId: "1",
      recordingId: "2",
      recordableType: "Message",
      peerId: "recording:2",
      content: "Reply",
    });

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker integration
// ---------------------------------------------------------------------------

describe("postCampfireLine with circuit breaker", () => {
  it("uses bcqPost instead of bcqApiPost when circuitBreaker is provided", async () => {
    const cb = new (CircuitBreaker as any)();
    vi.mocked(bcqPost).mockResolvedValue({ data: { id: 100 }, raw: "" });

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
      circuitBreaker: { instance: cb, key: "outbound" },
    });

    expect(result).toEqual({ ok: true, recordingId: "100" });
    expect(bcqPost).toHaveBeenCalledTimes(1);
    expect(bcqApiPost).not.toHaveBeenCalled();
    expect(bcqPost).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        circuitBreaker: { instance: cb, key: "outbound" },
      }),
    );
  });

  it("returns error when bcqPost fails with circuit breaker", async () => {
    const cb = new (CircuitBreaker as any)();
    const err = new (BcqError as any)("Circuit breaker open", null, "", ["bcq"]);
    vi.mocked(bcqPost).mockRejectedValue(err);
    vi.mocked(isRetryableError).mockReturnValue(false);

    const result = await postCampfireLine({
      bucketId: "1",
      transcriptId: "2",
      content: "Hello",
      circuitBreaker: { instance: cb, key: "outbound" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Circuit breaker open");
  });
});

describe("postComment with circuit breaker", () => {
  it("uses bcqPost instead of bcqApiPost when circuitBreaker is provided", async () => {
    const cb = new (CircuitBreaker as any)();
    vi.mocked(bcqPost).mockResolvedValue({ data: { id: 200 }, raw: "" });

    const result = await postComment({
      bucketId: "1",
      recordingId: "2",
      content: "A comment",
      circuitBreaker: { instance: cb, key: "outbound" },
    });

    expect(result).toEqual({ ok: true, commentId: "200" });
    expect(bcqPost).toHaveBeenCalledTimes(1);
    expect(bcqApiPost).not.toHaveBeenCalled();
  });
});
