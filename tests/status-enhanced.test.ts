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
  bcqMe: vi.fn(),
  bcqApiGet: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  resolveBasecampAccount: vi.fn(),
}));

import { basecampStatusAdapter } from "../src/adapters/status.js";
import type { BasecampProbe } from "../src/adapters/status.js";
import { bcqAuthStatus, bcqMe, bcqApiGet } from "../src/bcq.js";
import { resolveBasecampAccount } from "../src/config.js";
import type { ResolvedBasecampAccount } from "../src/types.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

const mockAccount: ResolvedBasecampAccount = {
  accountId: "test",
  enabled: true,
  personId: "42",
  token: "tok",
  tokenSource: "config",
  bcqProfile: "default",
  config: { personId: "42", bcqProfile: "default", bcqAccountId: "99" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveBasecampAccount).mockReturnValue(mockAccount);
});

// ---------------------------------------------------------------------------
// probeAccount — enhanced with personName and accountCount
// ---------------------------------------------------------------------------

describe("probeAccount (enhanced)", () => {
  it("returns personName and accountCount when authenticated", async () => {
    vi.mocked(bcqAuthStatus).mockResolvedValue({
      data: { authenticated: true },
      raw: "",
    });
    vi.mocked(bcqMe).mockResolvedValue({
      data: { name: "Jeremy", accounts: [{}, {}] },
      raw: "",
    } as any);

    const probe = await basecampStatusAdapter.probeAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({}),
    });

    expect(probe.ok).toBe(true);
    expect(probe.authenticated).toBe(true);
    expect(probe.personName).toBe("Jeremy");
    expect(probe.accountCount).toBe(2);
  });

  it("returns ok=false when not authenticated", async () => {
    vi.mocked(bcqAuthStatus).mockResolvedValue({
      data: { authenticated: false },
      raw: "",
    });

    const probe = await basecampStatusAdapter.probeAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({}),
    });

    expect(probe.ok).toBe(false);
    expect(probe.personName).toBeUndefined();
  });

  it("returns ok=false with error on exception", async () => {
    vi.mocked(bcqAuthStatus).mockRejectedValue(new Error("network"));

    const probe = await basecampStatusAdapter.probeAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({}),
    });

    expect(probe.ok).toBe(false);
    expect(probe.error).toContain("network");
  });

  it("handles bcqMe failure gracefully", async () => {
    vi.mocked(bcqAuthStatus).mockResolvedValue({
      data: { authenticated: true },
      raw: "",
    });
    vi.mocked(bcqMe).mockRejectedValue(new Error("fail"));

    const probe = await basecampStatusAdapter.probeAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({}),
    });

    expect(probe.ok).toBe(true);
    expect(probe.personName).toBeUndefined();
    expect(probe.accountCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// auditAccount
// ---------------------------------------------------------------------------

describe("auditAccount", () => {
  it("counts accessible projects", async () => {
    vi.mocked(bcqApiGet).mockResolvedValue([
      { id: 1, name: "P1" },
      { id: 2, name: "P2" },
    ]);

    const audit = await basecampStatusAdapter.auditAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({
        accounts: { test: { personId: "42", token: "tok" } },
      }),
    });

    expect(audit.projectsAccessible).toBe(2);
  });

  it("validates persona mappings", async () => {
    vi.mocked(bcqApiGet).mockResolvedValue([]);
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      ...mockAccount,
      token: "tok",
    });

    const audit = await basecampStatusAdapter.auditAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({
        accounts: {
          test: { personId: "42", token: "tok" },
          other: { personId: "43", token: "tok2" },
        },
        personas: { "agent-1": "other", "agent-2": "missing" },
      }),
    });

    expect(audit.personasMapped).toBe(2);
    expect(audit.personasValid).toBe(1);
    expect(audit.errors).toContainEqual(
      expect.stringContaining("agent-2"),
    );
  });

  it("reports API failure as error", async () => {
    vi.mocked(bcqApiGet).mockRejectedValue(new Error("forbidden"));

    const audit = await basecampStatusAdapter.auditAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({ accounts: { test: { personId: "42" } } }),
    });

    expect(audit.projectsAccessible).toBe(0);
    expect(audit.errors).toContainEqual(
      expect.stringContaining("Failed to verify project access"),
    );
  });
});

// ---------------------------------------------------------------------------
// collectStatusIssues
// ---------------------------------------------------------------------------

describe("collectStatusIssues", () => {
  it("flags unauthenticated accounts", () => {
    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
        probe: { ok: false, authenticated: false },
      },
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("auth");
  });

  it("returns empty for authenticated accounts", () => {
    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        running: true,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
      },
    ]);

    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveAccountState
// ---------------------------------------------------------------------------

describe("resolveAccountState", () => {
  it("returns disabled when not enabled", () => {
    expect(
      basecampStatusAdapter.resolveAccountState!({
        account: { ...mockAccount, enabled: false },
        cfg: cfg({}),
        configured: true,
        enabled: false,
      }),
    ).toBe("disabled");
  });

  it("returns not configured when not configured", () => {
    expect(
      basecampStatusAdapter.resolveAccountState!({
        account: mockAccount,
        cfg: cfg({}),
        configured: false,
        enabled: true,
      }),
    ).toBe("not configured");
  });

  it("returns configured when enabled and configured", () => {
    expect(
      basecampStatusAdapter.resolveAccountState!({
        account: mockAccount,
        cfg: cfg({}),
        configured: true,
        enabled: true,
      }),
    ).toBe("configured");
  });
});

// ---------------------------------------------------------------------------
// buildAccountSnapshot
// ---------------------------------------------------------------------------

describe("buildAccountSnapshot (enhanced)", () => {
  it("includes personName and accountCount from probe", () => {
    const probe: BasecampProbe = {
      ok: true,
      authenticated: true,
      personName: "Jeremy",
      accountCount: 3,
    };

    const snapshot = basecampStatusAdapter.buildAccountSnapshot!({
      account: mockAccount,
      cfg: cfg({}),
      probe,
    });

    expect(snapshot.personName).toBe("Jeremy");
    expect(snapshot.accountCount).toBe(3);
  });
});
