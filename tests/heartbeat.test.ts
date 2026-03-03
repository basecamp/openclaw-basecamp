import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
}));

const mockGetInfo = vi.fn();
vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => ({
    authorization: { getInfo: mockGetInfo },
  })),
}));

vi.mock("../src/config.js", () => ({
  resolveBasecampAccount: vi.fn(),
}));

import { basecampHeartbeatAdapter } from "../src/adapters/heartbeat.js";
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
  cliProfile: "default",
  config: { personId: "42", cliProfile: "default" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveBasecampAccount).mockReturnValue(mockAccount as any);
});

// ---------------------------------------------------------------------------
// checkReady
// ---------------------------------------------------------------------------

describe("heartbeat.checkReady", () => {
  it("returns ok when SDK auth check succeeds", async () => {
    mockGetInfo.mockResolvedValue({
      identity: { id: 42, firstName: "Jeremy", lastName: "" },
      accounts: [{}],
    });

    const result = await basecampHeartbeatAdapter.checkReady!({
      cfg: cfg({}),
      accountId: "test",
    });

    expect(result.ok).toBe(true);
  });

  it("returns not ok when SDK auth check fails", async () => {
    mockGetInfo.mockRejectedValue(new Error("401 Unauthorized"));

    const result = await basecampHeartbeatAdapter.checkReady!({
      cfg: cfg({}),
      accountId: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Auth check failed");
  });

  it("returns not ok when no auth configured", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      ...mockAccount,
      token: "",
      tokenSource: "none" as const,
      cliProfile: undefined,
    } as any);

    const result = await basecampHeartbeatAdapter.checkReady!({
      cfg: cfg({}),
      accountId: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("No authentication configured");
  });

  it("returns ok for OAuth account when token is valid", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      ...mockAccount,
      token: "",
      tokenSource: "oauth" as const,
      cliProfile: undefined,
      oauthClientId: "client123",
      config: { personId: "42", oauthTokenFile: "/tmp/token.json" },
    } as any);
    mockGetInfo.mockResolvedValue({
      identity: { id: 42, firstName: "Bot", lastName: "" },
      accounts: [],
    });

    const result = await basecampHeartbeatAdapter.checkReady!({
      cfg: cfg({}),
      accountId: "test",
    });

    expect(result.ok).toBe(true);
  });

  it("returns not ok on network error", async () => {
    mockGetInfo.mockRejectedValue(new Error("timeout"));

    const result = await basecampHeartbeatAdapter.checkReady!({
      cfg: cfg({}),
      accountId: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Auth check failed");
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
