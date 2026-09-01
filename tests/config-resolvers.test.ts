import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { basecampChannel } from "../src/channel.js";
import {
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
