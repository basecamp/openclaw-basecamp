import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBasecampRuntime, setBasecampRuntime } from "../src/runtime.js";

beforeEach(() => {
  setBasecampRuntime({ state: { resolveStateDir: () => "/tmp/test-state" } } as any);
});

afterEach(() => {
  clearBasecampRuntime();
});

vi.mock("../src/bcq.js", () => ({
  bcqAuthStatus: vi.fn(),
  execBcqAuthLogin: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  BasecampConfigSchema: {},
  listBasecampAccountIds: vi.fn(),
  resolveBasecampAccount: vi.fn(),
  resolveBasecampAccountAsync: vi.fn(),
  resolveDefaultBasecampAccountId: vi.fn(),
  resolveBasecampAllowFrom: vi.fn(),
  resolveWebhooksConfig: vi.fn().mockReturnValue({ autoRegister: false, projects: [], deactivateOnStop: false }),
  resolvePollingIntervals: vi.fn(),
  resolveCircuitBreakerConfig: vi.fn(),
  scopeWebhookProjects: vi.fn().mockReturnValue([]),
  resolveAccountForBucket: vi.fn(),
}));

vi.mock("../src/oauth-credentials.js", () => ({
  createTokenManager: vi.fn(),
  clearTokenManagers: vi.fn(),
  clearTokenManager: vi.fn(),
  resolveClientFilePath: vi.fn((p: string) => p.replace(/\.json$/, ".client.json")),
}));

vi.mock("../src/basecamp-client.js", () => ({
  clearClients: vi.fn(),
  clearClient: vi.fn(),
}));

vi.mock("../src/dispatch.js", () => ({
  dispatchBasecampEvent: vi.fn(),
}));

vi.mock("../src/outbound/send.js", () => ({
  sendBasecampText: vi.fn(),
  sendBasecampMedia: vi.fn(),
}));

vi.mock("../src/adapters/outbound.js", () => ({
  resolveOutboundTarget: vi.fn(),
  chunkMarkdownText: vi.fn(),
  BASECAMP_TEXT_CHUNK_LIMIT: 10000,
}));

vi.mock("../src/adapters/onboarding.js", () => ({ basecampSetupWizard: {} }));
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
vi.mock("../src/inbound/webhooks.js", () => ({
  flushWebhookSecrets: vi.fn(),
  getWebhookSecretRegistry: vi.fn().mockReturnValue({}),
}));

vi.mock("../src/inbound/recording-index.js", () => ({
  getRecordingIndex: vi.fn(),
  closeRecordingIndex: vi.fn(),
  closeAllRecordingIndexes: vi.fn(),
}));

vi.mock("../src/inbound/webhook-lifecycle.js", () => ({
  reconcileWebhooks: vi.fn(),
  deactivateWebhooks: vi.fn(),
}));

vi.mock("../src/inbound/poller.js", () => ({
  startCompositePoller: vi.fn(),
}));

vi.mock("../src/inbound/state-dir.js", () => ({
  resolvePluginStateDir: vi.fn().mockReturnValue("/tmp/test-state"),
}));

vi.mock("../src/util.js", () => ({
  withTimeout: vi.fn((p) => p),
}));

// Hoisted: src/channel.ts's import graph now reaches node:fs/promises
// statically (lifecycle adapter), so the factory runs during import.
const { mockUnlink } = vi.hoisted(() => ({ mockUnlink: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: mockUnlink };
});

import { clearClient, clearClients } from "../src/basecamp-client.js";
import { bcqAuthStatus } from "../src/bcq.js";
import { _resetValidationState, basecampChannel } from "../src/channel.js";
import {
  resolveBasecampAccount,
  resolveBasecampAccountAsync,
  resolveWebhooksConfig,
  scopeWebhookProjects,
} from "../src/config.js";
import { dispatchBasecampEvent } from "../src/dispatch.js";
import { startCompositePoller } from "../src/inbound/poller.js";
import { closeRecordingIndex } from "../src/inbound/recording-index.js";
import { deactivateWebhooks, reconcileWebhooks } from "../src/inbound/webhook-lifecycle.js";
import { flushWebhookSecrets } from "../src/inbound/webhooks.js";
import { clearTokenManager, clearTokenManagers, createTokenManager } from "../src/oauth-credentials.js";

function makeCtx(cfg: any, accountId = "test") {
  let status: Record<string, unknown> = { accountId };
  return {
    cfg,
    accountId,
    account: { accountId },
    abortSignal: new AbortController().signal,
    getStatus: vi.fn(() => status),
    setStatus: vi.fn((next: Record<string, unknown>) => {
      status = next;
    }),
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  };
}

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "test",
    enabled: true,
    personId: "42",
    token: "tok",
    tokenSource: "config",
    bcqProfile: undefined,
    config: { personId: "42", basecampAccountId: "99" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetValidationState();
  vi.mocked(startCompositePoller).mockResolvedValue(undefined);
  vi.mocked(resolveBasecampAccountAsync).mockResolvedValue(makeAccount() as any);
  vi.mocked(resolveWebhooksConfig).mockReturnValue({
    autoRegister: false,
    projects: [],
    deactivateOnStop: false,
  } as any);
  vi.mocked(scopeWebhookProjects).mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Phase 4: OAuth validation
// ---------------------------------------------------------------------------

describe("phase 4: OAuth validation", () => {
  it("validates token on startup for OAuth tokenSource", async () => {
    vi.mocked(resolveBasecampAccountAsync).mockResolvedValue(makeAccount({ tokenSource: "oauth", token: "" }) as any);
    vi.mocked(createTokenManager).mockReturnValue({
      getToken: vi.fn().mockResolvedValue("valid"),
    } as any);

    const ctx = makeCtx({});
    await basecampChannel.gateway!.startAccount!(ctx as any);

    expect(createTokenManager).toHaveBeenCalled();
  });

  it("throws and publishes a blocked lifecycle when OAuth validation fails", async () => {
    vi.mocked(resolveBasecampAccountAsync).mockResolvedValue(makeAccount({ tokenSource: "oauth", token: "" }) as any);
    vi.mocked(createTokenManager).mockReturnValue({
      getToken: vi.fn().mockRejectedValue(new Error("expired")),
    } as any);

    const ctx = makeCtx({});
    await expect(basecampChannel.gateway!.startAccount!(ctx as any)).rejects.toThrow("OAuth token invalid");

    expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining("OAuth token invalid"));
    // setStatus(running:true) should never be called
    const runningCalls = ctx.setStatus.mock.calls.filter((c: any[]) => c[0]?.running === true);
    expect(runningCalls).toHaveLength(0);
    // Blocked lifecycle patch with the operator-facing reason
    expect(ctx.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: "blocked",
        terminalDisconnect: true,
        lastError: expect.stringContaining("OAuth token invalid"),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 6-7: Early return guards
// ---------------------------------------------------------------------------

describe("phase 6-7: fatal config guards", () => {
  it("throws for tokenSource 'none'", async () => {
    vi.mocked(resolveBasecampAccountAsync).mockResolvedValue(
      makeAccount({ tokenSource: "none", token: "", bcqProfile: undefined }) as any,
    );

    const ctx = makeCtx({});
    await expect(basecampChannel.gateway!.startAccount!(ctx as any)).rejects.toThrow("no authentication configured");

    expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining("no authentication configured"));
    expect(ctx.setStatus).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "blocked" }));
    expect(startCompositePoller).not.toHaveBeenCalled();
  });

  it("throws when no token, no bcqProfile, not oauth", async () => {
    vi.mocked(resolveBasecampAccountAsync).mockResolvedValue(
      makeAccount({ tokenSource: "tokenFile", token: "", bcqProfile: undefined }) as any,
    );

    const ctx = makeCtx({});
    await expect(basecampChannel.gateway!.startAccount!(ctx as any)).rejects.toThrow("no token");

    expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining("no token"));
    expect(ctx.setStatus).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "blocked" }));
    expect(startCompositePoller).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 11: Webhook reconciliation
// ---------------------------------------------------------------------------

describe("phase 11: webhook reconciliation", () => {
  it("calls reconcileWebhooks when autoRegister is true", async () => {
    vi.mocked(resolveWebhooksConfig).mockReturnValue({
      autoRegister: true,
      payloadUrl: "https://example.com/wh",
      projects: ["1"],
      deactivateOnStop: false,
    } as any);
    vi.mocked(scopeWebhookProjects).mockReturnValue(["1"]);
    vi.mocked(reconcileWebhooks).mockImplementation(async (_opts: any, _registry: any, log: any) => {
      // Exercise the per-account log adapter startAccount hands over.
      log?.info("probe", { n: 1 });
      log?.warn("probe");
      log?.error("probe");
      log?.debug("probe");
      return { created: ["1"], existing: [], recovered: [], failed: [] } as any;
    });

    const ctx = makeCtx({});
    await basecampChannel.gateway!.startAccount!(ctx as any);

    expect(reconcileWebhooks).toHaveBeenCalled();
    expect(ctx.log.info).toHaveBeenCalledWith(expect.stringContaining("probe"));
    expect(ctx.log.warn).toHaveBeenCalledWith(expect.stringContaining("probe"));
  });

  it("swallows reconcileWebhooks error and continues startup", async () => {
    vi.mocked(resolveWebhooksConfig).mockReturnValue({
      autoRegister: true,
      payloadUrl: "https://example.com/wh",
      projects: ["1"],
      deactivateOnStop: false,
    } as any);
    vi.mocked(scopeWebhookProjects).mockReturnValue(["1"]);
    vi.mocked(reconcileWebhooks).mockRejectedValue(new Error("network"));

    const ctx = makeCtx({});
    await basecampChannel.gateway!.startAccount!(ctx as any);

    expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining("webhook reconciliation failed"));
    expect(startCompositePoller).toHaveBeenCalled();
  });

  it("passes webhookActiveProjects built from reconciliation result to poller", async () => {
    vi.mocked(resolveWebhooksConfig).mockReturnValue({
      autoRegister: true,
      payloadUrl: "https://example.com/wh",
      projects: ["1", "2", "3"],
      deactivateOnStop: false,
    } as any);
    vi.mocked(scopeWebhookProjects).mockReturnValue(["1", "2", "3"]);
    vi.mocked(reconcileWebhooks).mockResolvedValue({
      created: ["1"],
      existing: ["2"],
      recovered: ["3"],
      failed: [],
    } as any);

    const ctx = makeCtx({});
    await basecampChannel.gateway!.startAccount!(ctx as any);

    const pollerOpts = vi.mocked(startCompositePoller).mock.calls[0]![0] as any;
    expect(pollerOpts.webhookActiveProjects).toEqual(new Set(["1", "2", "3"]));
  });
});

// ---------------------------------------------------------------------------
// Phase 12: onEvent closure
// ---------------------------------------------------------------------------

describe("phase 12: onEvent closure", () => {
  it("filters self-messages (sender.id === personId)", async () => {
    let capturedOnEvent: any;
    let resolvePoller: () => void;
    vi.mocked(startCompositePoller).mockImplementation(async (opts: any) => {
      capturedOnEvent = opts.onEvent;
      await new Promise<void>((r) => {
        resolvePoller = r;
      });
    });

    const ctx = makeCtx({});
    const startPromise = basecampChannel.gateway!.startAccount!(ctx as any);
    await new Promise((r) => setTimeout(r, 0));

    const msg = { sender: { id: "42" } };
    const result = await capturedOnEvent!(msg);

    expect(result).toBe(false);
    expect(dispatchBasecampEvent).not.toHaveBeenCalled();

    resolvePoller!();
    await startPromise;
  });

  it("dispatches non-self messages", async () => {
    let capturedOnEvent: any;
    let resolvePoller: () => void;
    vi.mocked(startCompositePoller).mockImplementation(async (opts: any) => {
      capturedOnEvent = opts.onEvent;
      await new Promise<void>((r) => {
        resolvePoller = r;
      });
    });
    vi.mocked(dispatchBasecampEvent).mockResolvedValue(true);

    const ctx = makeCtx({});
    const startPromise = basecampChannel.gateway!.startAccount!(ctx as any);
    await new Promise((r) => setTimeout(r, 0));

    const msg = { sender: { id: "99" } };
    const result = await capturedOnEvent!(msg);

    expect(result).toBe(true);
    expect(dispatchBasecampEvent).toHaveBeenCalledWith(msg, expect.objectContaining({ account: expect.any(Object) }));

    resolvePoller!();
    await startPromise;
  });
});

// ---------------------------------------------------------------------------
// Phase 13: Status
// ---------------------------------------------------------------------------

describe("phase 13: lifecycle status patches", () => {
  it("publishes lifecycle 'starting' first", async () => {
    const ctx = makeCtx({});
    await basecampChannel.gateway!.startAccount!(ctx as any);

    expect(ctx.setStatus.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ accountId: "test", lifecycle: "starting" }),
    );
  });

  it("publishes a ready patch (running + lifecycle 'ready') before poller starts", async () => {
    // Exercise the log adapter startAccount hands the poller.
    vi.mocked(startCompositePoller).mockImplementation(async (opts: any) => {
      opts.log?.info("poller-log");
      opts.log?.warn("poller-log");
      opts.log?.debug("poller-log");
      opts.log?.error("poller-log");
    });

    const ctx = makeCtx({});
    await basecampChannel.gateway!.startAccount!(ctx as any);

    expect(ctx.log.debug).toHaveBeenCalledWith("poller-log");

    expect(ctx.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "test",
        running: true,
        connected: true,
        lifecycle: "ready",
        lastError: null,
        lastStartAt: expect.any(Number),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 15: Finally block
// ---------------------------------------------------------------------------

describe("phase 15: finally block", () => {
  it("calls deactivateWebhooks when deactivateOnStop is true", async () => {
    // First call (startup): autoRegister false
    // Second call (finally): deactivateOnStop true
    vi.mocked(resolveWebhooksConfig)
      .mockReturnValueOnce({ autoRegister: false, projects: [], deactivateOnStop: false } as any)
      .mockReturnValue({ deactivateOnStop: true, payloadUrl: "https://example.com/wh", projects: ["1"] } as any);
    vi.mocked(deactivateWebhooks).mockImplementation(async (_opts: any, _registry: any, log: any) => {
      log?.info("deactivated");
      log?.warn("deactivated");
      log?.error("deactivated");
      log?.debug("deactivated");
    });

    const ctx = makeCtx({});
    await basecampChannel.gateway!.startAccount!(ctx as any);

    expect(deactivateWebhooks).toHaveBeenCalled();
    expect(ctx.log.info).toHaveBeenCalledWith(expect.stringContaining("deactivated"));
  });

  it("does not call deactivateWebhooks when deactivateOnStop is false", async () => {
    vi.mocked(resolveWebhooksConfig).mockReturnValue({
      autoRegister: false,
      projects: [],
      deactivateOnStop: false,
    } as any);

    const ctx = makeCtx({});
    await basecampChannel.gateway!.startAccount!(ctx as any);

    expect(deactivateWebhooks).not.toHaveBeenCalled();
  });

  it("closes the recording index", async () => {
    const ctx = makeCtx({});
    await basecampChannel.gateway!.startAccount!(ctx as any);

    expect(closeRecordingIndex).toHaveBeenCalledWith("test");
  });

  it("calls flushWebhookSecrets", async () => {
    const ctx = makeCtx({});
    await basecampChannel.gateway!.startAccount!(ctx as any);

    expect(flushWebhookSecrets).toHaveBeenCalled();
  });

  it("publishes a stopped patch (running=false, lifecycle 'stopped')", async () => {
    const ctx = makeCtx({});
    await basecampChannel.gateway!.startAccount!(ctx as any);

    expect(ctx.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "test",
        running: false,
        connected: false,
        lifecycle: "stopped",
        lastStopAt: expect.any(Number),
      }),
    );
  });

  it("runs cleanup even when poller throws", async () => {
    vi.mocked(startCompositePoller).mockRejectedValue(new Error("poller crash"));

    const ctx = makeCtx({});
    await basecampChannel.gateway!.startAccount!(ctx as any).catch(() => {});

    expect(closeRecordingIndex).toHaveBeenCalledWith("test");
    expect(flushWebhookSecrets).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// config + auth adapter surface
// ---------------------------------------------------------------------------

describe("config adapter surface", () => {
  it("delegates account listing and resolution to config helpers", () => {
    (basecampChannel.config.listAccountIds as any)({});
    (basecampChannel.config.resolveAccount as any)({}, "test");
    (basecampChannel.config as any).defaultAccountId({});

    expect(vi.mocked(resolveBasecampAccount)).toHaveBeenCalledWith({}, "test");
  });

  it("describes accounts with derived configured state", () => {
    const account = makeAccount({ config: { personId: "42", tokenFile: "/tok" } });
    const described = (basecampChannel.config.describeAccount as any)(account);

    expect(described).toEqual(
      expect.objectContaining({ accountId: "test", enabled: true, configured: true, tokenSource: "config" }),
    );
    expect((basecampChannel.config.isConfigured as any)(account)).toBe(true);
    expect((basecampChannel.config.isEnabled as any)(account)).toBe(true);
    expect((basecampChannel.config as any).disabledReason()).toBe("Manually disabled");
    expect((basecampChannel.config as any).unconfiguredReason()).toContain("No token");
  });

  it("formats allowFrom entries as person labels", () => {
    const formatted = (basecampChannel.config as any).formatAllowFrom({ allowFrom: ["1", "2"] });
    expect(formatted).toEqual(["Person 1", "Person 2"]);
  });

  it("deleteAccount removes the account and any personas pointing at it", () => {
    const cfg = {
      channels: {
        basecamp: {
          accounts: { gone: { personId: "1" }, kept: { personId: "2" } },
          personas: { "agent-a": "gone", "agent-b": "kept" },
        },
      },
    };

    const updated = (basecampChannel.config as any).deleteAccount({ cfg, accountId: "gone" });

    expect(updated.channels.basecamp.accounts.gone).toBeUndefined();
    expect(updated.channels.basecamp.personas).toEqual({ "agent-b": "kept" });
  });

  it("elevated.allowFromFallback yields undefined", () => {
    expect((basecampChannel as any).elevated.allowFromFallback()).toBeUndefined();
  });
});

describe("auth.login guidance", () => {
  it("rejects inline-token accounts with config guidance", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue(makeAccount({ tokenSource: "config" }) as any);
    await expect((basecampChannel as any).auth.login({ cfg: {}, accountId: "test" })).rejects.toThrow("inline token");
  });

  it("rejects tokenFile accounts with file guidance", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue(
      makeAccount({ tokenSource: "tokenFile", config: { tokenFile: "/tok" } }) as any,
    );
    await expect((basecampChannel as any).auth.login({ cfg: {}, accountId: "test" })).rejects.toThrow("token file");
  });

  it("rejects unconfigured accounts with setup guidance", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue(makeAccount({ tokenSource: "none" }) as any);
    await expect((basecampChannel as any).auth.login({ cfg: {}, accountId: "test" })).rejects.toThrow(
      "No authentication configured",
    );
  });
});

// ---------------------------------------------------------------------------
// stopAccount
// ---------------------------------------------------------------------------

describe("stopAccount", () => {
  it("flushes per-account state and publishes a stopped patch", async () => {
    const ctx = makeCtx({});
    await basecampChannel.gateway!.stopAccount!(ctx as any);

    expect(flushWebhookSecrets).toHaveBeenCalled();
    expect(ctx.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "test",
        running: false,
        connected: false,
        lifecycle: "stopped",
        lastStopAt: expect.any(Number),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// logoutAccount
// ---------------------------------------------------------------------------

describe("logoutAccount", () => {
  it("deletes token file, evicts caches, and closes the recording index", async () => {
    mockUnlink.mockResolvedValue(undefined);
    vi.mocked(resolveBasecampAccount).mockReturnValue(
      makeAccount({ config: { personId: "42", oauthTokenFile: "/tmp/token.json" } }) as any,
    );

    const result = await basecampChannel.gateway!.logoutAccount!({
      accountId: "test",
      cfg: {},
    } as any);

    expect(result).toEqual({ cleared: true, loggedOut: true });
    expect(mockUnlink).toHaveBeenCalledWith("/tmp/token.json");
    expect(clearTokenManager).toHaveBeenCalledWith("test");
    expect(clearClient).toHaveBeenCalledWith("test");
    expect(closeRecordingIndex).toHaveBeenCalledWith("test");
  });

  it("returns cleared=true when token file already gone (ENOENT)", async () => {
    mockUnlink.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    vi.mocked(resolveBasecampAccount).mockReturnValue(
      makeAccount({ config: { personId: "42", oauthTokenFile: "/tmp/gone.json" } }) as any,
    );

    const result = await basecampChannel.gateway!.logoutAccount!({
      accountId: "test",
      cfg: {},
    } as any);

    expect(result).toEqual({ cleared: true, loggedOut: true });
  });

  it("returns cleared=false when no oauthTokenFile configured", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue(makeAccount({ config: { personId: "42" } }) as any);

    const result = await basecampChannel.gateway!.logoutAccount!({
      accountId: "test",
      cfg: {},
    } as any);

    expect(result).toEqual({ cleared: false, loggedOut: false });
    expect(clearTokenManager).toHaveBeenCalledWith("test");
    expect(clearClient).toHaveBeenCalledWith("test");
    expect(closeRecordingIndex).toHaveBeenCalledWith("test");
  });

  it("non-ENOENT unlink error propagates", async () => {
    mockUnlink.mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    vi.mocked(resolveBasecampAccount).mockReturnValue(
      makeAccount({ config: { personId: "42", oauthTokenFile: "/tmp/noperm.json" } }) as any,
    );

    await expect(
      basecampChannel.gateway!.logoutAccount!({
        accountId: "test",
        cfg: {},
      } as any),
    ).rejects.toThrow("EACCES");
  });
});
