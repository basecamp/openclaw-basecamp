import { beforeEach, describe, expect, it, vi } from "vitest";

// cliAuthStatus no longer used by status adapter (uses SDK client for all sources)

const mockClient = {
  authorization: { getInfo: vi.fn() },
  projects: { list: vi.fn() },
};

vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => mockClient),
  numId: (_label: string, value: string | number) => Number(value),
  rawOrThrow: vi.fn(async (r: any) => r?.data),
  BasecampError: class BasecampError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));

vi.mock("../src/config.js", () => ({
  resolveBasecampAccount: vi.fn(),
}));

import type { BasecampAudit, BasecampProbe } from "../src/adapters/status.js";
import { basecampStatusAdapter } from "../src/adapters/status.js";
import { resolveBasecampAccount } from "../src/config.js";
import {
  clearMetrics,
  getAccountMetrics,
  recordCircuitBreakerState,
  recordDedupSize,
  recordIngressAvailable,
  recordIngressUnavailable,
  recordPollAttempt,
  recordPollSuccess,
  recordWebhookDedupSize,
  recordWebhookDispatched,
  recordWebhookDropped,
  recordWebhookError,
  recordWebhookReceived,
} from "../src/metrics.js";
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
  cliProfile: "default",
  config: { personId: "42", cliProfile: "default", basecampAccountId: "99" },
};

beforeEach(() => {
  vi.clearAllMocks();
  clearMetrics();
  vi.mocked(resolveBasecampAccount).mockReturnValue(mockAccount);
});

// ---------------------------------------------------------------------------
// probeAccount — enhanced with personName and accountCount
// ---------------------------------------------------------------------------

describe("probeAccount (enhanced)", () => {
  it("returns personName and accountCount when authenticated", async () => {
    mockClient.authorization.getInfo.mockResolvedValue({
      identity: { id: 42, firstName: "Jeremy", lastName: "", emailAddress: "j@example.com" },
      accounts: [{}, {}],
    });

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

  it("returns ok=false when getInfo fails (config token)", async () => {
    mockClient.authorization.getInfo.mockRejectedValue(new Error("401"));

    const probe = await basecampStatusAdapter.probeAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({}),
    });

    expect(probe.ok).toBe(false);
    expect(probe.personName).toBeUndefined();
  });

  it("returns ok=false when getInfo fails for oauth token (unified auth check)", async () => {
    mockClient.authorization.getInfo.mockRejectedValue(new Error("token expired"));

    const oauthAccount = { ...mockAccount, tokenSource: "oauth" as const, token: "" };

    const probe = await basecampStatusAdapter.probeAccount!({
      account: oauthAccount,
      timeoutMs: 5000,
      cfg: cfg({}),
    });

    expect(probe.ok).toBe(false);
    expect(probe.personName).toBeUndefined();
  });

  it("returns ok=false with error on exception", async () => {
    mockClient.authorization.getInfo.mockRejectedValue(new Error("network"));

    const probe = await basecampStatusAdapter.probeAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({}),
    });

    expect(probe.ok).toBe(false);
    // For config token, getInfo failure → ok=false
  });

  it("handles getInfo failure gracefully for any auth source", async () => {
    mockClient.authorization.getInfo.mockRejectedValue(new Error("fail"));

    const probe = await basecampStatusAdapter.probeAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({}),
    });

    // With unified SDK-based probing, any getInfo failure → not ok
    expect(probe.ok).toBe(false);
    expect(probe.authenticated).toBe(false);
    expect(probe.error).toContain("fail");
  });
});

// ---------------------------------------------------------------------------
// auditAccount
// ---------------------------------------------------------------------------

describe("auditAccount", () => {
  it("counts accessible projects", async () => {
    mockClient.projects.list.mockResolvedValue([
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
    mockClient.projects.list.mockResolvedValue([]);
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
      expect.objectContaining({ kind: "config", message: expect.stringContaining("agent-2") }),
    );
  });

  it("reports API failure as error", async () => {
    mockClient.projects.list.mockRejectedValue(new Error("forbidden"));

    const audit = await basecampStatusAdapter.auditAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({ accounts: { test: { personId: "42" } } }),
    });

    expect(audit.projectsAccessible).toBe(0);
    expect(audit.errors).toContainEqual(
      expect.objectContaining({ kind: "runtime", message: expect.stringContaining("Failed to verify project access") }),
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

  it("returns empty for authenticated running accounts", () => {
    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        running: true,
        configured: true,
        enabled: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
      },
    ]);

    expect(issues).toHaveLength(0);
  });

  it("flags configured-but-never-started accounts", () => {
    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        configured: true,
        enabled: true,
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
      },
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("runtime");
    expect(issues[0]!.message).toContain("never started");
  });

  it("does not flag stopped accounts that have started before", () => {
    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        configured: true,
        enabled: true,
        running: false,
        lastStartAt: Date.now() - 60_000,
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
      },
    ]);

    expect(issues).toHaveLength(0);
  });

  it("can report both auth and runtime issues for different accounts", () => {
    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "unauthed",
        probe: { ok: false, authenticated: false },
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
      },
      {
        accountId: "never-started",
        configured: true,
        enabled: true,
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
      },
    ]);

    expect(issues).toHaveLength(2);
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain("auth");
    expect(kinds).toContain("runtime");
  });

  it("emits migration nudge for cliProfile-only accounts (tokenSource none)", () => {
    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "legacy",
        tokenSource: "none",
        cliProfile: "default",
        configured: false,
        enabled: true,
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
      },
    ]);

    const nudge = issues.filter((i) => i.message.includes("CLI profile only"));
    expect(nudge).toHaveLength(1);
    expect(nudge[0]!.kind).toBe("config");
    expect(nudge[0]!.fix).toContain("openclaw channels add");
    expect(nudge[0]!.fix).toContain("legacy");
  });

  it("does not emit migration nudge when tokenSource is not none", () => {
    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "good",
        tokenSource: "oauth",
        cliProfile: "default",
        configured: true,
        enabled: true,
        running: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
      },
    ]);

    const nudge = issues.filter((i) => i.message.includes("CLI profile only"));
    expect(nudge).toHaveLength(0);
  });

  it("does not emit migration nudge when no cliProfile", () => {
    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "empty",
        tokenSource: "none",
        configured: false,
        enabled: true,
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
      },
    ]);

    const nudge = issues.filter((i) => i.message.includes("CLI profile only"));
    expect(nudge).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// Operational metrics in probe
// ---------------------------------------------------------------------------

describe("probeAccount operational metrics", () => {
  it("attaches metrics snapshot to probe when available", async () => {
    mockClient.authorization.getInfo.mockResolvedValue({
      identity: { id: 42, firstName: "Jeremy", lastName: "", emailAddress: "j@example.com" },
      accounts: [{}],
    });

    // Seed some metrics for the test account
    recordPollAttempt("test", "activity");
    recordPollSuccess("test", "activity", 5);
    recordWebhookReceived("test");

    const probe = await basecampStatusAdapter.probeAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({}),
    });

    expect(probe.metrics).toBeDefined();
    expect(probe.metrics!.poller.activity.pollCount).toBe(1);
    expect(probe.metrics!.poller.activity.dispatchCount).toBe(5);
    expect(probe.metrics!.webhook.receivedCount).toBe(1);
  });

  it("returns undefined metrics when no data recorded", async () => {
    mockClient.authorization.getInfo.mockResolvedValue({
      identity: { id: 42, firstName: "Jeremy", lastName: "", emailAddress: "j@example.com" },
      accounts: [],
    });

    const probe = await basecampStatusAdapter.probeAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({}),
    });

    expect(probe.metrics).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Operational metrics in audit
// ---------------------------------------------------------------------------

describe("auditAccount operational metrics", () => {
  it("includes poller lag in audit", async () => {
    mockClient.projects.list.mockResolvedValue([]);

    // Simulate successful polls with known timestamps
    recordPollSuccess("test", "activity", 1);
    recordPollSuccess("test", "readings", 2);
    // assignments never polled — should be null

    const audit = await basecampStatusAdapter.auditAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({ accounts: { test: { personId: "42" } } }),
    });

    expect(audit.pollerLag).toBeDefined();
    // Activity and readings should have a lag >= 0 (just polled)
    expect(audit.pollerLag!.activity).toBeTypeOf("number");
    expect(audit.pollerLag!.activity).toBeGreaterThanOrEqual(0);
    expect(audit.pollerLag!.readings).toBeTypeOf("number");
    // Assignments never polled
    expect(audit.pollerLag!.assignments).toBeNull();
  });

  it("includes webhook stats in audit", async () => {
    mockClient.projects.list.mockResolvedValue([]);

    recordWebhookReceived("test");
    recordWebhookReceived("test");
    recordWebhookDispatched("test");
    recordWebhookDropped("test");
    recordWebhookError("test");

    const audit = await basecampStatusAdapter.auditAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({ accounts: { test: { personId: "42" } } }),
    });

    expect(audit.webhookStats).toEqual({
      received: 2,
      dispatched: 1,
      dropped: 1,
      errors: 1,
    });
  });

  it("includes dedup sizes in audit", async () => {
    mockClient.projects.list.mockResolvedValue([]);

    recordDedupSize("test", 100);
    recordWebhookDedupSize("test", 25);

    const audit = await basecampStatusAdapter.auditAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({ accounts: { test: { personId: "42" } } }),
    });

    expect(audit.dedupSize).toBe(100);
    expect(audit.webhookDedupSize).toBe(25);
  });

  it("includes circuit breaker state in audit", async () => {
    mockClient.projects.list.mockResolvedValue([]);

    recordCircuitBreakerState("test", "outbound", {
      state: "open",
      failures: 5,
      trippedAt: Date.now(),
    });

    const audit = await basecampStatusAdapter.auditAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({ accounts: { test: { personId: "42" } } }),
    });

    expect(audit.circuitBreakers).toBeDefined();
    expect(audit.circuitBreakers!["outbound"]).toEqual({
      state: "open",
      failures: 5,
    });
  });

  it("omits circuit breakers when none recorded", async () => {
    mockClient.projects.list.mockResolvedValue([]);

    recordPollAttempt("test", "activity");

    const audit = await basecampStatusAdapter.auditAccount!({
      account: mockAccount,
      timeoutMs: 5000,
      cfg: cfg({ accounts: { test: { personId: "42" } } }),
    });

    expect(audit.circuitBreakers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collectStatusIssues — operational issues
// ---------------------------------------------------------------------------

describe("collectStatusIssues (operational)", () => {
  it("flags lagging poller sources", () => {
    const audit: BasecampAudit = {
      projectsAccessible: 1,
      personasMapped: 0,
      personasValid: 0,
      errors: [],
      pollerLag: {
        activity: 700, // > 600s threshold
        readings: 30,
        assignments: null,
      },
    };

    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        running: true,
        configured: true,
        enabled: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
        audit,
      },
    ]);

    const lagIssues = issues.filter((i) => i.message.includes("lagging"));
    expect(lagIssues).toHaveLength(1);
    expect(lagIssues[0]!.message).toContain("activity");
    expect(lagIssues[0]!.message).toContain("700s");
  });

  it("flags open circuit breakers", () => {
    const audit: BasecampAudit = {
      projectsAccessible: 1,
      personasMapped: 0,
      personasValid: 0,
      errors: [],
      circuitBreakers: {
        outbound: { state: "open", failures: 5 },
        "api-read": { state: "closed", failures: 0 },
      },
    };

    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        running: true,
        configured: true,
        enabled: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
        audit,
      },
    ]);

    const cbIssues = issues.filter((i) => i.message.includes("Circuit breaker"));
    expect(cbIssues).toHaveLength(1);
    expect(cbIssues[0]!.message).toContain("outbound");
    expect(cbIssues[0]!.message).toContain("5 failures");
  });

  it("does not flag closed circuit breakers or healthy pollers", () => {
    const audit: BasecampAudit = {
      projectsAccessible: 1,
      personasMapped: 0,
      personasValid: 0,
      errors: [],
      pollerLag: { activity: 60, readings: 30, assignments: 120 },
      circuitBreakers: { outbound: { state: "closed", failures: 0 } },
    };

    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        running: true,
        configured: true,
        enabled: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
        audit,
      },
    ]);

    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PF-004: collectStatusIssues — missing personId
// ---------------------------------------------------------------------------

describe("collectStatusIssues (personId)", () => {
  it("flags accounts where personIdSet is false", () => {
    const audit: BasecampAudit = {
      projectsAccessible: 1,
      personasMapped: 0,
      personasValid: 0,
      errors: [],
      personIdSet: false,
    };

    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "no-person",
        running: true,
        configured: true,
        enabled: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
        audit,
      },
    ]);

    const personIdIssues = issues.filter((i) => i.message.includes("personId"));
    expect(personIdIssues).toHaveLength(1);
    expect(personIdIssues[0]!.kind).toBe("config");
    expect(personIdIssues[0]!.message).toContain("self-message filtering disabled");
    expect(personIdIssues[0]!.fix).toContain("no-person");
  });

  it("does not flag accounts where personIdSet is true", () => {
    const audit: BasecampAudit = {
      projectsAccessible: 1,
      personasMapped: 0,
      personasValid: 0,
      errors: [],
      personIdSet: true,
    };

    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "has-person",
        running: true,
        configured: true,
        enabled: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
        audit,
      },
    ]);

    const personIdIssues = issues.filter((i) => i.message.includes("personId"));
    expect(personIdIssues).toHaveLength(0);
  });

  it("does not flag when audit is absent", () => {
    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "no-audit",
        running: true,
        configured: true,
        enabled: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
      },
    ]);

    const personIdIssues = issues.filter((i) => i.message.includes("personId"));
    expect(personIdIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PF-005: collectStatusIssues — audit.errors surfaced
// ---------------------------------------------------------------------------

describe("collectStatusIssues (audit.errors)", () => {
  it("surfaces config-kind audit errors as config issues", () => {
    const audit: BasecampAudit = {
      projectsAccessible: 1,
      personasMapped: 1,
      personasValid: 0,
      errors: [{ kind: "config", message: 'Persona "agent-1" \u2192 account "missing": account does not exist' }],
      personIdSet: true,
    };

    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        running: true,
        configured: true,
        enabled: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
        audit,
      },
    ]);

    const errorIssues = issues.filter((i) => i.message.includes("Persona"));
    expect(errorIssues).toHaveLength(1);
    expect(errorIssues[0]!.kind).toBe("config");
    expect(errorIssues[0]!.message).toContain("agent-1");
  });

  it("surfaces runtime-kind audit errors as runtime issues", () => {
    const audit: BasecampAudit = {
      projectsAccessible: 0,
      personasMapped: 0,
      personasValid: 0,
      errors: [{ kind: "runtime", message: "Failed to verify project access: Error: forbidden" }],
      personIdSet: true,
    };

    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        running: true,
        configured: true,
        enabled: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
        audit,
      },
    ]);

    const errorIssues = issues.filter((i) => i.message.includes("Failed to verify"));
    expect(errorIssues).toHaveLength(1);
    expect(errorIssues[0]!.kind).toBe("runtime");
  });

  it("surfaces multiple audit errors", () => {
    const audit: BasecampAudit = {
      projectsAccessible: 0,
      personasMapped: 2,
      personasValid: 0,
      errors: [
        { kind: "config", message: 'Persona "a" \u2192 account "x": no auth' },
        { kind: "config", message: 'Persona "b" \u2192 account "y": does not exist' },
        { kind: "runtime", message: "Failed to verify project access: timeout" },
      ],
      personIdSet: true,
    };

    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        running: true,
        configured: true,
        enabled: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
        audit,
      },
    ]);

    const configIssues = issues.filter((i) => i.kind === "config");
    const runtimeIssues = issues.filter((i) => i.kind === "runtime");
    expect(configIssues.length).toBe(2);
    expect(runtimeIssues.length).toBe(1);
  });

  it("handles empty audit.errors gracefully", () => {
    const audit: BasecampAudit = {
      projectsAccessible: 1,
      personasMapped: 0,
      personasValid: 0,
      errors: [],
      personIdSet: true,
    };

    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        running: true,
        configured: true,
        enabled: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
        audit,
      },
    ]);

    expect(issues).toHaveLength(0);
  });

  it("PF-006: surfaces unknownKindCount as runtime issue", () => {
    const audit: BasecampAudit = {
      projectsAccessible: 1,
      personasMapped: 0,
      personasValid: 0,
      errors: [],
      personIdSet: true,
      unknownKindCount: 5,
      lastUnknownKind: "future_quantum_created",
    };

    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        running: true,
        configured: true,
        enabled: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
        audit,
      },
    ]);

    const unknownIssues = issues.filter((i) => i.message.includes("unknown kind"));
    expect(unknownIssues.length).toBe(1);
    expect(unknownIssues[0].kind).toBe("runtime");
    expect(unknownIssues[0].message).toContain("5 event(s)");
    expect(unknownIssues[0].message).toContain("future_quantum_created");
  });

  it("PF-006: no unknownKind issue when count is 0", () => {
    const audit: BasecampAudit = {
      projectsAccessible: 1,
      personasMapped: 0,
      personasValid: 0,
      errors: [],
      personIdSet: true,
      unknownKindCount: 0,
      lastUnknownKind: null,
    };

    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        running: true,
        configured: true,
        enabled: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
        audit,
      },
    ]);

    const unknownIssues = issues.filter((i) => i.message.includes("unknown kind"));
    expect(unknownIssues.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Computed snapshot: lifecycle overrides + transport activity + ingress
// ---------------------------------------------------------------------------

describe("buildAccountSnapshot (computed lifecycle)", () => {
  it("carries the gateway-published lifecycle through the snapshot", () => {
    const snapshot = basecampStatusAdapter.buildAccountSnapshot!({
      account: mockAccount,
      cfg: cfg({}),
      runtime: { accountId: "test", running: true, lifecycle: "ready" },
      probe: { ok: true, authenticated: true },
    }) as Record<string, unknown>;

    expect(snapshot.lifecycle).toBe("ready");
    expect(snapshot.running).toBe(true);
    expect(snapshot.tokenSource).toBe("config");
  });

  it("overrides lifecycle to 'blocked' when the probe shows an auth failure", () => {
    const snapshot = basecampStatusAdapter.buildAccountSnapshot!({
      account: mockAccount,
      cfg: cfg({}),
      runtime: { accountId: "test", running: true, lifecycle: "ready" },
      probe: { ok: false, authenticated: false, error: "401" },
    }) as Record<string, unknown>;

    expect(snapshot.lifecycle).toBe("blocked");
  });

  it("overrides lifecycle to 'recovering' while a circuit breaker is open", () => {
    recordCircuitBreakerState("test", "activity", { state: "open", failures: 5, trippedAt: Date.now() });

    const snapshot = basecampStatusAdapter.buildAccountSnapshot!({
      account: mockAccount,
      cfg: cfg({}),
      runtime: { accountId: "test", running: true, lifecycle: "ready" },
      probe: { ok: true, authenticated: true },
    }) as Record<string, unknown>;

    expect(snapshot.lifecycle).toBe("recovering");
  });

  it("does not report 'recovering' when the account is not running", () => {
    recordCircuitBreakerState("test", "activity", { state: "open", failures: 5, trippedAt: Date.now() });

    const snapshot = basecampStatusAdapter.buildAccountSnapshot!({
      account: mockAccount,
      cfg: cfg({}),
      runtime: { accountId: "test", running: false, lifecycle: "stopped" },
      probe: { ok: true, authenticated: true },
    }) as Record<string, unknown>;

    expect(snapshot.lifecycle).toBe("stopped");
  });

  it("derives lastTransportActivityAt from poller ticks", () => {
    const before = Date.now();
    recordPollSuccess("test", "activity", 1);

    const snapshot = basecampStatusAdapter.buildAccountSnapshot!({
      account: mockAccount,
      cfg: cfg({}),
      runtime: { accountId: "test", running: true },
      probe: { ok: true, authenticated: true },
    }) as Record<string, unknown>;

    expect(snapshot.lastTransportActivityAt).toBeGreaterThanOrEqual(before);
  });

  it("sets ingressUnavailable when webhook ingress is recorded broken", () => {
    recordIngressUnavailable("test", "webhook reconciliation failed");

    const snapshot = basecampStatusAdapter.buildAccountSnapshot!({
      account: mockAccount,
      cfg: cfg({}),
      runtime: { accountId: "test", running: true },
      probe: { ok: true, authenticated: true },
    }) as Record<string, unknown>;

    expect(snapshot.ingressUnavailable).toBe(true);
  });

  it("clears ingressUnavailable after recovery", () => {
    recordIngressUnavailable("test", "boom");
    recordIngressAvailable("test");

    const snapshot = basecampStatusAdapter.buildAccountSnapshot!({
      account: mockAccount,
      cfg: cfg({}),
      runtime: { accountId: "test", running: true },
      probe: { ok: true, authenticated: true },
    }) as Record<string, unknown>;

    expect(snapshot.ingressUnavailable).toBeUndefined();
  });
});

describe("collectStatusIssues (ingress + CLI strings)", () => {
  it("surfaces ingressUnavailable as a runtime issue", () => {
    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        configured: true,
        enabled: true,
        running: true,
        ingressUnavailable: true,
        lastStartAt: Date.now(),
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
      },
    ]);

    const ingress = issues.filter((i) => i.message.includes("Webhook ingress unavailable"));
    expect(ingress).toHaveLength(1);
    expect(ingress[0]!.kind).toBe("runtime");
  });

  it("points never-started accounts at `openclaw gateway` (not `openclaw start`)", () => {
    const issues = basecampStatusAdapter.collectStatusIssues!([
      {
        accountId: "test",
        configured: true,
        enabled: true,
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
      },
    ]);

    const neverStarted = issues.find((i) => i.message.includes("never started"));
    expect(neverStarted?.fix).toContain("openclaw gateway");
    expect(neverStarted?.fix).not.toContain("`openclaw start`");
  });
});

// ---------------------------------------------------------------------------
// buildChannelSummary + formatCapabilitiesProbe + logSelfId
// ---------------------------------------------------------------------------

describe("buildChannelSummary", () => {
  it("builds a token summary with stable null defaults", async () => {
    const summary = await basecampStatusAdapter.buildChannelSummary!({
      account: mockAccount,
      cfg: cfg({}),
      defaultAccountId: "test",
      snapshot: {
        accountId: "test",
        configured: true,
        tokenSource: "config",
        running: true,
        lastStartAt: 123,
        lastStopAt: null,
        lastError: null,
        probe: { ok: true, authenticated: true },
      },
    });

    expect(summary).toEqual(
      expect.objectContaining({
        configured: true,
        tokenSource: "config",
        running: true,
        lastStartAt: 123,
        lastStopAt: null,
        lastError: null,
        lastProbeAt: null,
      }),
    );
  });
});

describe("formatCapabilitiesProbe", () => {
  it("shows identity and account count", () => {
    const lines = basecampStatusAdapter.formatCapabilitiesProbe!({
      probe: { ok: true, authenticated: true, personName: "Jeremy", accountCount: 2 },
    });

    expect(lines[0]).toEqual({ text: "Authenticated as Jeremy", tone: "success" });
    expect(lines[1]).toEqual({ text: "2 Basecamp account(s) visible", tone: "muted" });
  });

  it("shows poller lag, breaker, and ingress warnings from the metrics snapshot", () => {
    recordPollSuccess("test", "activity", 1);
    recordCircuitBreakerState("test", "activity", { state: "open", failures: 7, trippedAt: Date.now() });
    recordIngressUnavailable("test", "route down");

    const lines = basecampStatusAdapter.formatCapabilitiesProbe!({
      probe: { ok: true, authenticated: true, personName: "J", metrics: getAccountMetrics("test") },
    });

    const texts = lines.map((l) => l.text);
    expect(texts.some((t) => t.includes("Poller lag —"))).toBe(true);
    expect(texts.some((t) => t.includes("Circuit breaker activity: open (7 failures)"))).toBe(true);
    expect(texts.some((t) => t.includes("Webhook ingress unavailable: route down"))).toBe(true);
  });

  it("shows the auth failure when unauthenticated", () => {
    const lines = basecampStatusAdapter.formatCapabilitiesProbe!({
      probe: { ok: false, authenticated: false, error: "401 Unauthorized" },
    });

    expect(lines[0]).toEqual({ text: "Not authenticated: 401 Unauthorized", tone: "error" });
  });
});

describe("logSelfId", () => {
  it("logs identity through the runtime env", () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    basecampStatusAdapter.logSelfId!({ account: mockAccount, cfg: cfg({}), runtime: runtime as any });

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("identity:"));
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("personId=42"));
  });
});
