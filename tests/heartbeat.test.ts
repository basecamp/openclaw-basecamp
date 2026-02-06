import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
}));

vi.mock("../src/bcq.js", () => ({
  bcqAuthStatus: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  resolveBasecampAccount: vi.fn(),
}));

import { basecampHeartbeatAdapter } from "../src/adapters/heartbeat.js";
import { bcqAuthStatus } from "../src/bcq.js";
import { resolveBasecampAccount } from "../src/config.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

const mockAccount = {
  accountId: "test",
  enabled: true,
  personId: "42",
  token: "tok",
  tokenSource: "config" as const,
  bcqProfile: "default",
  config: { personId: "42", bcqProfile: "default" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveBasecampAccount).mockReturnValue(mockAccount as any);
});

// ---------------------------------------------------------------------------
// checkReady
// ---------------------------------------------------------------------------

describe("heartbeat.checkReady", () => {
  it("returns ok when authenticated", async () => {
    vi.mocked(bcqAuthStatus).mockResolvedValue({
      data: { authenticated: true },
      raw: "",
    });

    const result = await basecampHeartbeatAdapter.checkReady!({
      cfg: cfg({}),
      accountId: "test",
    });

    expect(result.ok).toBe(true);
  });

  it("returns not ok when not authenticated", async () => {
    vi.mocked(bcqAuthStatus).mockResolvedValue({
      data: { authenticated: false },
      raw: "",
    });

    const result = await basecampHeartbeatAdapter.checkReady!({
      cfg: cfg({}),
      accountId: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not authenticated");
  });

  it("returns not ok when no token or profile", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      ...mockAccount,
      token: "",
      bcqProfile: undefined,
    } as any);

    const result = await basecampHeartbeatAdapter.checkReady!({
      cfg: cfg({}),
      accountId: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("No bcq profile or token");
  });

  it("returns not ok on auth check failure", async () => {
    vi.mocked(bcqAuthStatus).mockRejectedValue(new Error("timeout"));

    const result = await basecampHeartbeatAdapter.checkReady!({
      cfg: cfg({}),
      accountId: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("auth check failed");
  });
});

// ---------------------------------------------------------------------------
// resolveRecipients
// ---------------------------------------------------------------------------

describe("heartbeat.resolveRecipients", () => {
  it("returns explicit recipient", () => {
    const result = basecampHeartbeatAdapter.resolveRecipients!({
      cfg: cfg({}),
      opts: { to: "ping:42" },
    });

    expect(result.recipients).toEqual(["ping:42"]);
    expect(result.source).toBe("explicit");
  });

  it("returns empty when only allowFrom is available (person IDs cannot be mapped to ping peers)", () => {
    const result = basecampHeartbeatAdapter.resolveRecipients!({
      cfg: cfg({ allowFrom: ["100", "200"] }),
    });

    // allowFrom contains person IDs, but ping peers require circle bucket IDs.
    // Without an API call we can't map them, so recipients is empty.
    expect(result.recipients).toEqual([]);
    expect(result.source).toBe("none");
  });

  it("returns empty when no recipients available", () => {
    const result = basecampHeartbeatAdapter.resolveRecipients!({
      cfg: cfg({}),
    });

    expect(result.recipients).toEqual([]);
    expect(result.source).toBe("none");
  });
});
