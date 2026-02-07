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
  readNumberParam: (params: Record<string, unknown>, key: string, opts?: { required?: boolean; label?: string }) => {
    const val = params[key];
    if (opts?.required && val === undefined) {
      throw new Error(`Missing required parameter: ${opts.label ?? key}`);
    }
    return typeof val === "number" ? val : undefined;
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
    expect(actions).toEqual(["send"]);
  });
});

// ---------------------------------------------------------------------------
// supportsAction
// ---------------------------------------------------------------------------

describe("actions.supportsAction", () => {
  it("returns true for send", () => {
    expect(basecampActionsAdapter.supportsAction!({ action: "send" })).toBe(true);
  });

  it("returns false for unsupported actions", () => {
    expect(basecampActionsAdapter.supportsAction!({ action: "react" })).toBe(false);
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
      result: { ok: true, target: "campfire", recordingId: "42", error: undefined },
    });
    expect(postCampfireLine).toHaveBeenCalledWith({
      bucketId: "1",
      transcriptId: "2",
      content: "<p>Hello campfire</p>",
      accountId: "test-acct",
      profile: "test-profile",
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
    vi.mocked(postCampfireLine).mockResolvedValue({ ok: false, error: "bcq timeout" });

    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({
        params: { bucketId: "1", transcriptId: "2", text: "Hello" },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: false, target: "campfire", recordingId: undefined, error: "bcq timeout" },
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
      result: { ok: true, target: "comment", commentId: "77", error: undefined },
    });
    expect(postComment).toHaveBeenCalledWith({
      bucketId: "1",
      recordingId: "3",
      content: "<p>A comment</p>",
      accountId: "test-acct",
      profile: "test-profile",
    });
  });

  it("returns error from failed comment post", async () => {
    vi.mocked(postComment).mockResolvedValue({ ok: false, error: "403 Forbidden" });

    const result = await basecampActionsAdapter.handleAction!(
      actionCtx({
        params: { bucketId: "1", recordingId: "3", text: "A comment" },
      }),
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: false, target: "comment", commentId: undefined, error: "403 Forbidden" },
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
      actionCtx({ action: "react" }),
    );

    expect(result).toEqual({
      ok: true,
      result: { ok: false, error: "Unsupported action: react" },
    });
  });
});

// ---------------------------------------------------------------------------
// handleAction — account resolution with bcqAccountId
// ---------------------------------------------------------------------------

describe("actions.handleAction — bcqAccountId override", () => {
  it("uses bcqAccountId when set on account config", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      accountId: "test-acct",
      enabled: true,
      personId: "999",
      token: "tok-test",
      tokenSource: "config",
      bcqProfile: "test-profile",
      config: { personId: "999", bcqAccountId: "override-id" },
    } as any);

    vi.mocked(postCampfireLine).mockResolvedValue({ ok: true, recordingId: "88" });

    await basecampActionsAdapter.handleAction!(
      actionCtx({
        params: { bucketId: "1", transcriptId: "2", text: "Hello" },
      }),
    );

    expect(postCampfireLine).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "override-id" }),
    );
  });
});
