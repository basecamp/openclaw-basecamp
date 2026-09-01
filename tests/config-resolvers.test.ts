import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { basecampChannel } from "../src/channel.js";
import {
  resolveBasecampHistoryLimit,
  resolveCircuitBreakerConfig,
  resolveReconciliationConfig,
  resolveRetryConfig,
  resolveSafetyNetConfig,
  resolveWebhookSecret,
  resolveWebhooksConfig,
} from "../src/config.js";

/** Build a minimal OpenClawConfig-shaped object with a basecamp section. */
function cfgWith(section: Record<string, unknown>): OpenClawConfig {
  return { channels: { basecamp: section } } as unknown as OpenClawConfig;
}

const emptyCfg = cfgWith({});

// ---------------------------------------------------------------------------
// Infra config resolvers: defaults and explicit overrides
// ---------------------------------------------------------------------------

describe("resolveRetryConfig", () => {
  it("returns defaults when unset", () => {
    expect(resolveRetryConfig(emptyCfg)).toEqual({
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      jitter: true,
    });
  });

  it("honors explicit values", () => {
    const cfg = cfgWith({ retry: { maxAttempts: 7, baseDelayMs: 50, maxDelayMs: 500, jitter: false } });
    expect(resolveRetryConfig(cfg)).toEqual({ maxAttempts: 7, baseDelayMs: 50, maxDelayMs: 500, jitter: false });
  });
});

describe("resolveBasecampHistoryLimit", () => {
  it("falls back to the SDK group history default", () => {
    expect(resolveBasecampHistoryLimit(emptyCfg)).toBe(50);
  });

  it("prefers messages.groupChat.historyLimit over the default", () => {
    const cfg = {
      messages: { groupChat: { historyLimit: 12 } },
      channels: { basecamp: {} },
    } as unknown as OpenClawConfig;
    expect(resolveBasecampHistoryLimit(cfg)).toBe(12);
  });

  it("prefers the channel-level value over messages.groupChat", () => {
    const cfg = {
      messages: { groupChat: { historyLimit: 12 } },
      channels: { basecamp: { historyLimit: 20 } },
    } as unknown as OpenClawConfig;
    expect(resolveBasecampHistoryLimit(cfg)).toBe(20);
  });

  it("prefers the account value over the channel value, only for that account", () => {
    const cfg = cfgWith({ historyLimit: 20, accounts: { ops: { historyLimit: 3 }, other: {} } });
    expect(resolveBasecampHistoryLimit(cfg, "ops")).toBe(3);
    expect(resolveBasecampHistoryLimit(cfg, "other")).toBe(20);
    expect(resolveBasecampHistoryLimit(cfg)).toBe(20);
  });

  it("clamps negatives to 0 and floors fractions", () => {
    expect(resolveBasecampHistoryLimit(cfgWith({ historyLimit: -4 }))).toBe(0);
    expect(resolveBasecampHistoryLimit(cfgWith({ historyLimit: 2.9 }))).toBe(2);
    expect(resolveBasecampHistoryLimit(cfgWith({ historyLimit: 0 }))).toBe(0);
  });
});

describe("resolveCircuitBreakerConfig", () => {
  it("returns defaults when unset", () => {
    expect(resolveCircuitBreakerConfig(emptyCfg)).toEqual({ threshold: 5, cooldownMs: 5 * 60 * 1000 });
  });

  it("honors explicit values", () => {
    const cfg = cfgWith({ circuitBreaker: { threshold: 2, cooldownMs: 1234 } });
    expect(resolveCircuitBreakerConfig(cfg)).toEqual({ threshold: 2, cooldownMs: 1234 });
  });
});

describe("resolveWebhookSecret", () => {
  it("is undefined when unset (webhooks disabled)", () => {
    expect(resolveWebhookSecret(emptyCfg)).toBeUndefined();
  });

  it("returns the configured secret", () => {
    expect(resolveWebhookSecret(cfgWith({ webhookSecret: "shh" }))).toBe("shh");
  });
});

describe("resolveWebhooksConfig", () => {
  it("returns defaults when unset", () => {
    expect(resolveWebhooksConfig(emptyCfg)).toEqual({
      payloadUrl: undefined,
      projects: [],
      types: [],
      autoRegister: true,
      deactivateOnStop: false,
    });
  });

  it("honors explicit values", () => {
    const cfg = cfgWith({
      webhooks: {
        payloadUrl: "https://example.test/hook",
        projects: ["1"],
        types: ["Todo"],
        autoRegister: false,
        deactivateOnStop: true,
      },
    });
    expect(resolveWebhooksConfig(cfg)).toEqual({
      payloadUrl: "https://example.test/hook",
      projects: ["1"],
      types: ["Todo"],
      autoRegister: false,
      deactivateOnStop: true,
    });
  });
});

describe("resolveSafetyNetConfig", () => {
  it("returns defaults when unset", () => {
    expect(resolveSafetyNetConfig(emptyCfg)).toEqual({ projects: [], intervalMs: 600_000 });
  });

  it("honors explicit values", () => {
    const cfg = cfgWith({ safetyNet: { projects: ["9"], intervalMs: 1000 } });
    expect(resolveSafetyNetConfig(cfg)).toEqual({ projects: ["9"], intervalMs: 1000 });
  });
});

describe("resolveReconciliationConfig", () => {
  it("returns defaults when unset", () => {
    expect(resolveReconciliationConfig(emptyCfg)).toEqual({
      enabled: true,
      intervalMs: 21_600_000,
      gapThreshold: 3,
    });
  });

  it("honors explicit values", () => {
    const cfg = cfgWith({ reconciliation: { enabled: false, intervalMs: 60_000, gapThreshold: 5 } });
    expect(resolveReconciliationConfig(cfg)).toEqual({ enabled: false, intervalMs: 60_000, gapThreshold: 5 });
  });
});

// ---------------------------------------------------------------------------
// Channel config adapter delegation (basecampChannel.config)
// ---------------------------------------------------------------------------

describe("basecampChannel.config adapter", () => {
  const cfg = cfgWith({
    accounts: {
      work: { personId: "42", tokenFile: "/tmp/token" },
    },
  });

  it("lists and resolves configured accounts", () => {
    const adapter = basecampChannel.config;
    expect(adapter?.listAccountIds?.(cfg)).toEqual(["work"]);
    expect(adapter?.defaultAccountId?.(cfg)).toBe("work");
    const account = adapter?.resolveAccount?.(cfg, "work");
    expect(account?.accountId).toBe("work");
    expect(account?.personId).toBe("42");
  });

  it("reports configured/enabled state and reasons", () => {
    const adapter = basecampChannel.config;
    const account = adapter?.resolveAccount?.(cfg, "work");
    expect(account && adapter?.isConfigured?.(account)).toBe(true);
    expect(account && adapter?.isEnabled?.(account)).toBe(true);
    expect(adapter?.disabledReason?.(account as never)).toBe("Manually disabled");
    expect(adapter?.unconfiguredReason?.(account as never)).toBe("No token or OAuth token file configured");
  });

  it("describes accounts for status output", () => {
    const adapter = basecampChannel.config;
    const account = adapter?.resolveAccount?.(cfg, "work");
    const described = account && adapter?.describeAccount?.(account);
    expect(described).toMatchObject({ accountId: "work", enabled: true, configured: true });
  });
});

describe("group policy resolvers", () => {
  it("defaults groupPolicy to open and groupAllowFrom to empty", async () => {
    const { resolveBasecampGroupAllowFrom, resolveBasecampGroupPolicy } = await import("../src/config.js");
    expect(resolveBasecampGroupPolicy({} as any)).toBe("open");
    expect(resolveBasecampGroupAllowFrom({} as any)).toEqual([]);
  });

  it("prefers per-account group settings over channel-level ones", async () => {
    const { resolveBasecampGroupAllowFrom, resolveBasecampGroupPolicy } = await import("../src/config.js");
    const cfg = {
      channels: {
        basecamp: {
          groupPolicy: "allowlist",
          groupAllowFrom: [1, "2"],
          accounts: { ops: { personId: "9", groupPolicy: "open", groupAllowFrom: ["7"] } },
        },
      },
    } as any;
    expect(resolveBasecampGroupPolicy(cfg)).toBe("allowlist");
    expect(resolveBasecampGroupAllowFrom(cfg)).toEqual(["1", "2"]);
    expect(resolveBasecampGroupPolicy(cfg, "ops")).toBe("open");
    expect(resolveBasecampGroupAllowFrom(cfg, "ops")).toEqual(["7"]);
  });
});
