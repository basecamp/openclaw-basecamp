import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (v: string | undefined | null) => (v ?? "").trim() || "default",
  jsonResult: (payload: unknown) => ({ ok: true, result: payload }),
  readStringParam: (params: Record<string, unknown>, key: string, opts?: { required?: boolean; label?: string }) => {
    const val = params[key];
    if (opts?.required && (val === undefined || val === null || val === "")) {
      throw new Error(`Missing required parameter: ${opts.label ?? key}`);
    }
    return typeof val === "string" ? val : undefined;
  },
}));

const mockClient = {
  boosts: { createForRecording: vi.fn() },
};

vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => mockClient),
  numId: (_label: string, value: string | number) => Number(value),
  rawOrThrow: vi.fn(async (r: any) => r?.data),
  BasecampError: class BasecampError extends Error {
    code: string;
    constructor(msg: string, code: string) { super(msg); this.code = code; }
  },
}));

vi.mock("../src/outbound/send.js", () => ({
  postCampfireLine: vi.fn(),
  postComment: vi.fn(),
}));

vi.mock("../src/outbound/format.js", () => ({
  markdownToBasecampHtml: vi.fn((t: string) => `<p>${t}</p>`),
}));

vi.mock("../src/config.js", () => ({
  resolveBasecampAccount: vi.fn(() => ({
    accountId: "test-acct",
    enabled: true,
    personId: "999",
    token: "tok-test",
    tokenSource: "config",
    bcqProfile: "test-profile",
    config: { personId: "999", bcqAccountId: undefined },
  })),
}));

import { basecampActionsAdapter } from "../src/adapters/actions.js";
import { postCampfireLine, postComment } from "../src/outbound/send.js";
import { markdownToBasecampHtml } from "../src/outbound/format.js";
import { resolveBasecampAccount } from "../src/config.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function actionCtx(overrides: Record<string, unknown> = {}) {
  return {
    channel: "basecamp" as const,
    action: "send" as const,
    cfg: { channels: { basecamp: { accounts: { "test-acct": { personId: "999" } } } } },
    params: {},
    accountId: "test-acct",
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// listActions
// ---------------------------------------------------------------------------

describe("actions.listActions", () => {
  it("returns supported action names", () => {
    const actions = basecampActionsAdapter.listActions!({ cfg: {} as any });
    expect(actions).toEqual(["send", "react"]);
  });
});

// ---------------------------------------------------------------------------
// supportsAction
// ---------------------------------------------------------------------------

describe("actions.supportsAction", () => {
  it("returns true for send", () => {
    expect(basecampActionsAdapter.supportsAction!({ action: "send" })).toBe(true);
  });

  it("returns true for react", () => {
    expect(basecampActionsAdapter.supportsAction!({ action: "react" })).toBe(true);
  });

  it("returns false for unsupported actions", () => {
    expect(basecampActionsAdapter.supportsAction!({ action: "delete" })).toBe(false);
    expect(basecampActionsAdapter.supportsAction!({ action: "edit" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// supportsButtons / supportsCards
// ---------------------------------------------------------------------------

describe("actions.supportsButtons", () => {
  it("returns false", () => {
    expect(basecampActionsAdapter.supportsButtons!({ cfg: {} as any })).toBe(false);
  });
});

describe("actions.supportsCards", () => {
  it("returns false", () => {
    expect(basecampActionsAdapter.supportsCards!({ cfg: {} as any })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractToolSend
// ---------------------------------------------------------------------------

describe("actions.extractToolSend", () => {
  it("extracts to and accountId from args", () => {
    const result = basecampActionsAdapter.extractToolSend!({
      args: { to: "recording:123", accountId: "acct-1" },
    });
    expect(result).toEqual({ to: "recording:123", accountId: "acct-1" });
  });

  it("extracts to without accountId", () => {
    const result = basecampActionsAdapter.extractToolSend!({
      args: { to: "ping:456" },
    });
    expect(result).toEqual({ to: "ping:456", accountId: undefined });
  });

  it("returns null when to is missing", () => {
    expect(basecampActionsAdapter.extractToolSend!({ args: {} })).toBeNull();
  });

  it("returns null when to is empty string", () => {
    expect(basecampActionsAdapter.extractToolSend!({ args: { to: "" } })).toBeNull();
  });

  it("returns null when to is not a string", () => {
    expect(basecampActionsAdapter.extractToolSend!({ args: { to: 123 } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleAction — send (campfire line)
// ---------------------------------------------------------------------------

describe("actions.handleAction — send campfire line", () => {
  it("posts a campfire line when transcriptId is provided", async () => {
    vi.mocked(postCampfireLine).mockResolvedValue({ ok: true, recordingId: "42" });

    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({
        params: { bucketId: "1", transcriptId: "2", text: "Hello campfire" },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: true, target: "campfire", recordingId: "42" },
    });
    expect(postCampfireLine).toHaveBeenCalledWith({
      bucketId: "1",
      transcriptId: "2",
      content: "<p>Hello campfire</p>",
      account: expect.objectContaining({ accountId: "test-acct" }),
    });
    expect(markdownToBasecampHtml).toHaveBeenCalledWith("Hello campfire");
  });

  it("prefers transcriptId over recordingId when both provided", async () => {
    vi.mocked(postCampfireLine).mockResolvedValue({ ok: true, recordingId: "50" });

    await basecampActionsAdapter.handleAction!(
      actionCtx({
        params: { bucketId: "1", transcriptId: "2", recordingId: "3", text: "Hello" },
      }),
    );

    expect(postCampfireLine).toHaveBeenCalled();
    expect(postComment).not.toHaveBeenCalled();
  });

  it("returns error from failed campfire post", async () => {
    vi.mocked(postCampfireLine).mockResolvedValue({ ok: false, message: "timeout", error: new Error("timeout") });

    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({
        params: { bucketId: "1", transcriptId: "2", text: "Hello" },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: false, target: "campfire", error: "timeout" },
    });
  });
});

// ---------------------------------------------------------------------------
// handleAction — send (comment)
// ---------------------------------------------------------------------------

describe("actions.handleAction — send comment", () => {
  it("posts a comment when recordingId is provided (no transcriptId)", async () => {
    vi.mocked(postComment).mockResolvedValue({ ok: true, commentId: "77" });

    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({
        params: { bucketId: "1", recordingId: "3", text: "A comment" },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: true, target: "comment", commentId: "77" },
    });
    expect(postComment).toHaveBeenCalledWith({
      bucketId: "1",
      recordingId: "3",
      content: "<p>A comment</p>",
      account: expect.objectContaining({ accountId: "test-acct" }),
    });
  });

  it("returns error from failed comment post", async () => {
    vi.mocked(postComment).mockResolvedValue({ ok: false, message: "403 Forbidden", error: new Error("403 Forbidden") });

    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({
        params: { bucketId: "1", recordingId: "3", text: "A comment" },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: false, target: "comment", error: "403 Forbidden" },
    });
  });
});

// ---------------------------------------------------------------------------
// handleAction — send validation errors
// ---------------------------------------------------------------------------

describe("actions.handleAction — send validation", () => {
  it("throws when bucketId is missing", async () => {
    await expect(
      basecampActionsAdapter.handleAction!(
        actionCtx({ params: { transcriptId: "2", text: "Hello" } }),
      ),
    ).rejects.toThrow(/Bucket ID/);
  });

  it("throws when text is missing", async () => {
    await expect(
      basecampActionsAdapter.handleAction!(
        actionCtx({ params: { bucketId: "1", transcriptId: "2" } }),
      ),
    ).rejects.toThrow(/Message text/);
  });

  it("returns error when neither transcriptId nor recordingId is provided", async () => {
    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({ params: { bucketId: "1", text: "Hello" } }),
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: false, error: expect.stringContaining("transcriptId") },
    });
  });
});

// ---------------------------------------------------------------------------
// handleAction — send dry run
// ---------------------------------------------------------------------------

describe("actions.handleAction — send dryRun", () => {
  it("returns preview without posting for campfire", async () => {
    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({
        params: { bucketId: "1", transcriptId: "2", text: "Hello" },
        dryRun: true,
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({
        ok: true,
        dryRun: true,
        target: "campfire",
        bucketId: "1",
        transcriptId: "2",
      }),
    });
    expect(postCampfireLine).not.toHaveBeenCalled();
    expect(postComment).not.toHaveBeenCalled();
  });

  it("returns preview without posting for comment", async () => {
    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({
        params: { bucketId: "1", recordingId: "3", text: "Hello" },
        dryRun: true,
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({
        ok: true,
        dryRun: true,
        target: "comment",
        bucketId: "1",
        recordingId: "3",
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// handleAction — unsupported action
// ---------------------------------------------------------------------------

describe("actions.handleAction — unsupported action", () => {
  it("returns error for unsupported action", async () => {
    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({ action: "delete" }),
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: false, error: "Unsupported action: delete" },
    });
  });
});

// ---------------------------------------------------------------------------
// handleAction — account resolution with scopedBucketId
// ---------------------------------------------------------------------------

describe("actions.handleAction — bucket scoping", () => {
  it("rejects send when bucket does not match scoped account", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      accountId: "scoped-acct",
      enabled: true,
      personId: "999",
      token: "tok-test",
      tokenSource: "config",
      bcqProfile: "test-profile",
      scopedBucketId: 42,
      config: { personId: "999", bcqAccountId: undefined },
    } as any);

    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({
        params: { bucketId: "99", transcriptId: "2", text: "Hello" },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: {
        ok: false,
        error: expect.stringContaining("scoped to bucket 42"),
      },
    });
    expect(postCampfireLine).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleAction — react (boost)
// ---------------------------------------------------------------------------

describe("actions.handleAction — react", () => {
  beforeEach(() => {
    // Reset to default account (no bcqAccountId override, no scoping)
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      accountId: "test-acct",
      enabled: true,
      personId: "999",
      token: "tok-test",
      tokenSource: "config",
      bcqProfile: "test-profile",
      config: { personId: "999", bcqAccountId: undefined },
    } as any);
  });

  it("posts a boost with emoji", async () => {
    mockClient.boosts.createForRecording.mockResolvedValue({ id: 55 });

    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({
        action: "react",
        params: { bucketId: "1", recordingId: "500", emoji: "🎉" },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: true, target: "boost", boostId: 55 },
    });
    expect(mockClient.boosts.createForRecording).toHaveBeenCalledWith(
      1,
      500,
      { content: "🎉" },
    );
  });

  it("defaults emoji to thumbs up", async () => {
    mockClient.boosts.createForRecording.mockResolvedValue({ id: 56 });

    await basecampActionsAdapter.handleAction!(
      actionCtx({
        action: "react",
        params: { bucketId: "1", recordingId: "500" },
      }),
    );

    expect(mockClient.boosts.createForRecording).toHaveBeenCalledWith(
      1,
      500,
      { content: "👍" },
    );
  });

  it("returns error on API failure", async () => {
    mockClient.boosts.createForRecording.mockRejectedValue(new Error("503 Unavailable"));

    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({
        action: "react",
        params: { bucketId: "1", recordingId: "500", emoji: "👍" },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: false, error: "Error: 503 Unavailable" },
    });
  });

  it("throws on missing bucketId", async () => {
    await expect(
      basecampActionsAdapter.handleAction!(
        actionCtx({
          action: "react",
          params: { recordingId: "500" },
        }),
      ),
    ).rejects.toThrow(/Bucket ID/i);
  });

  it("throws on missing recordingId", async () => {
    await expect(
      basecampActionsAdapter.handleAction!(
        actionCtx({
          action: "react",
          params: { bucketId: "1" },
        }),
      ),
    ).rejects.toThrow(/Recording ID/i);
  });
});

// ---------------------------------------------------------------------------
// handleAction — react bucket scoping
// ---------------------------------------------------------------------------

describe("actions.handleAction — react bucket scoping", () => {
  it("rejects react when bucket does not match scoped account", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      accountId: "scoped-acct",
      enabled: true,
      personId: "999",
      token: "tok-test",
      tokenSource: "config",
      bcqProfile: "test-profile",
      scopedBucketId: 42,
      config: { personId: "999", bcqAccountId: undefined },
    } as any);

    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({
        action: "react",
        params: { bucketId: "99", recordingId: "500", emoji: "👍" },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: {
        ok: false,
        error: expect.stringContaining("scoped to bucket 42"),
      },
    });
    expect(mockClient.boosts.createForRecording).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleAction — react dry run
// ---------------------------------------------------------------------------

describe("actions.handleAction — react dryRun", () => {
  beforeEach(() => {
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      accountId: "test-acct",
      enabled: true,
      personId: "999",
      token: "tok-test",
      tokenSource: "config",
      bcqProfile: "test-profile",
      config: { personId: "999", bcqAccountId: undefined },
    } as any);
  });

  it("returns preview without posting boost", async () => {
    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({
        action: "react",
        params: { bucketId: "1", recordingId: "500", emoji: "🎉" },
        dryRun: true,
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: expect.objectContaining({
        ok: true,
        dryRun: true,
        target: "boost",
        bucketId: "1",
        recordingId: "500",
        emoji: "🎉",
      }),
    });
    expect(mockClient.boosts.createForRecording).not.toHaveBeenCalled();
  });
});
