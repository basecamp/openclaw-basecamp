import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (v: string | undefined | null) => (v ?? "").trim() || "default",
  buildChannelConfigSchema: (s: any) => s,
  setAccountEnabledInConfigSection: vi.fn(),
  deleteAccountFromConfigSection: vi.fn(),
}));

vi.mock("../src/basecamp-cli.js", () => ({}));

vi.mock("../src/config.js", () => ({
  BasecampConfigSchema: {},
  listBasecampAccountIds: vi.fn(),
  resolveBasecampAccount: vi.fn(),
  resolveBasecampAccountAsync: vi.fn(),
  resolveDefaultBasecampAccountId: vi.fn(),
  resolveBasecampAllowFrom: vi.fn(),
  resolveWebhooksConfig: vi.fn().mockReturnValue({ autoRegister: false, projects: [] }),
  resolvePollingIntervals: vi.fn(),
  resolveCircuitBreakerConfig: vi.fn(),
}));

vi.mock("../src/runtime.js", () => ({
  getBasecampRuntime: vi.fn(() => ({
    state: { resolveStateDir: () => "/tmp/test-state" },
  })),
}));

vi.mock("../src/dispatch.js", () => ({
  dispatchBasecampEvent: vi.fn(),
}));

vi.mock("../src/outbound/send.js", () => ({
  sendBasecampText: vi.fn(),
}));

vi.mock("../src/adapters/outbound.js", () => ({
  resolveOutboundTarget: vi.fn(),
  chunkMarkdownText: vi.fn(),
  BASECAMP_TEXT_CHUNK_LIMIT: 10000,
}));

vi.mock("../src/adapters/onboarding.js", () => ({ basecampOnboardingAdapter: {} }));
vi.mock("../src/adapters/setup.js", () => ({ basecampSetupAdapter: {} }));
vi.mock("../src/adapters/status.js", () => ({ basecampStatusAdapter: {}, BasecampProbe: {}, BasecampAudit: {} }));
vi.mock("../src/adapters/pairing.js", () => ({ basecampPairingAdapter: {} }));
vi.mock("../src/adapters/directory.js", () => ({ basecampDirectoryAdapter: {} }));
vi.mock("../src/adapters/messaging.js", () => ({ basecampMessagingAdapter: {} }));
vi.mock("../src/adapters/resolver.js", () => ({ basecampResolverAdapter: {} }));
vi.mock("../src/adapters/heartbeat.js", () => ({ basecampHeartbeatAdapter: {} }));
vi.mock("../src/adapters/groups.js", () => ({ basecampGroupAdapter: {} }));
vi.mock("../src/adapters/agent-prompt.js", () => ({ basecampAgentPromptAdapter: {} }));
vi.mock("../src/adapters/security.js", () => ({ basecampSecurityAdapter: {} }));
vi.mock("../src/adapters/mentions.js", () => ({ basecampMentionAdapter: {} }));
vi.mock("../src/adapters/actions.js", () => ({ basecampActionsAdapter: {} }));
vi.mock("../src/adapters/agent-tools.js", () => ({ basecampAgentTools: [] }));

vi.mock("../src/inbound/webhooks.js", () => ({
  flushWebhookSecrets: vi.fn(),
  getWebhookSecretRegistry: vi.fn().mockReturnValue({}),
}));

vi.mock("../src/inbound/dedup-registry.js", () => ({
  getAccountDedup: vi.fn(() => ({ size: 0, isDuplicate: () => false, flush: vi.fn() })),
  closeAccountDedup: vi.fn(),
  closeAllAccountDedup: vi.fn(),
  flushAccountDedup: vi.fn(),
}));

vi.mock("../src/inbound/webhook-lifecycle.js", () => ({
  reconcileWebhooks: vi.fn(),
  deactivateWebhooks: vi.fn(),
}));

// Make poller import throw — startAccount returns early after logging error
// This prevents real poller startup while letting all validation code execute.
vi.mock("../src/inbound/poller.js", () => {
  throw new Error("test: skip poller startup");
});

import { basecampChannel, _resetValidationState } from "../src/channel.js";
import { resolveBasecampAccountAsync } from "../src/config.js";

function makeCtx(cfg: any, accountId = "test") {
  return {
    cfg,
    account: { accountId },
    abortSignal: new AbortController().signal,
    setStatus: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  };
}

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "test",
    enabled: true,
    personId: "42",
    token: "tok",
    tokenSource: "config",
    cliProfile: "default",
    config: { personId: "42", cliProfile: "default", basecampAccountId: "99" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetValidationState();
});

// ---------------------------------------------------------------------------
// PF-002: Config-hash re-validation on config change
// ---------------------------------------------------------------------------

describe("PF-002: config-hash re-validation", () => {
  it("re-validates persona mappings when config changes", async () => {
    // Validation happens before auth check
    vi.mocked(resolveBasecampAccountAsync).mockResolvedValue(makeAccount() as any);

    // First call: config with bad persona mapping
    const cfg1 = {
      channels: {
        basecamp: {
          accounts: { test: { personId: "42", token: "tok" } },
          personas: { "agent-1": "nonexistent-account" },
        },
      },
    };
    const ctx1 = makeCtx(cfg1);
    await basecampChannel.gateway!.startAccount!(ctx1 as any);

    // Should warn about the bad persona
    expect(ctx1.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('persona "agent-1"'),
    );

    // Second call: same config → should NOT re-validate
    const ctx2 = makeCtx(cfg1);
    await basecampChannel.gateway!.startAccount!(ctx2 as any);

    const personaWarns2 = vi.mocked(ctx2.log.warn).mock.calls.filter(
      (c) => String(c[0]).includes("persona"),
    );
    expect(personaWarns2).toHaveLength(0);

    // Third call: different config → should re-validate
    const cfg3 = {
      channels: {
        basecamp: {
          accounts: { test: { personId: "42", token: "tok" } },
          personas: { "agent-2": "also-missing" },
        },
      },
    };
    const ctx3 = makeCtx(cfg3);
    await basecampChannel.gateway!.startAccount!(ctx3 as any);

    expect(ctx3.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('persona "agent-2"'),
    );
  });

  it("re-validates when accounts change even if personas are the same", async () => {
    vi.mocked(resolveBasecampAccountAsync).mockResolvedValue(makeAccount() as any);

    // Config where persona target exists
    const cfg1 = {
      channels: {
        basecamp: {
          accounts: { test: {}, other: {} },
          personas: { "agent-1": "other" },
        },
      },
    };
    const ctx1 = makeCtx(cfg1);
    await basecampChannel.gateway!.startAccount!(ctx1 as any);

    // Now remove the "other" account — persona should fail validation
    const cfg2 = {
      channels: {
        basecamp: {
          accounts: { test: {} },
          personas: { "agent-1": "other" },
        },
      },
    };
    const ctx2 = makeCtx(cfg2);
    await basecampChannel.gateway!.startAccount!(ctx2 as any);

    expect(ctx2.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('persona "agent-1"'),
    );
  });
});

// ---------------------------------------------------------------------------
// PF-003: basecampAccountId startup warning
// ---------------------------------------------------------------------------

describe("PF-003: basecampAccountId startup warning", () => {
  it("warns when basecampAccountId cannot be resolved for non-numeric accountId", async () => {
    // Account with non-numeric ID and no explicit basecampAccountId
    vi.mocked(resolveBasecampAccountAsync).mockResolvedValue(
      makeAccount({
        accountId: "my-org",
        config: { personId: "42", cliProfile: "default" },
      }) as any,
    );
    const ctx = makeCtx({}, "my-org");
    await basecampChannel.gateway!.startAccount!(ctx as any);

    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Basecamp account ID could not be resolved"),
    );
    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("my-org"),
    );
  });

  it("does not warn when accountId is numeric (implicit basecampAccountId)", async () => {
    vi.mocked(resolveBasecampAccountAsync).mockResolvedValue(
      makeAccount({
        accountId: "12345",
        config: { personId: "42", cliProfile: "default" },
      }) as any,
    );
    const ctx = makeCtx({}, "12345");
    await basecampChannel.gateway!.startAccount!(ctx as any);

    const accountIdWarns = vi.mocked(ctx.log.warn).mock.calls.filter(
      (c) => String(c[0]).includes("Basecamp account ID"),
    );
    expect(accountIdWarns).toHaveLength(0);
  });

  it("does not warn when explicit basecampAccountId is configured", async () => {
    vi.mocked(resolveBasecampAccountAsync).mockResolvedValue(
      makeAccount({
        accountId: "my-org",
        config: { personId: "42", cliProfile: "default", basecampAccountId: "99" },
      }) as any,
    );
    const ctx = makeCtx({}, "my-org");
    await basecampChannel.gateway!.startAccount!(ctx as any);

    const accountIdWarns = vi.mocked(ctx.log.warn).mock.calls.filter(
      (c) => String(c[0]).includes("Basecamp account ID"),
    );
    expect(accountIdWarns).toHaveLength(0);
  });
});
