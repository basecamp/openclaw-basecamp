import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock openclaw/plugin-sdk
// ---------------------------------------------------------------------------

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
  applyAccountNameToChannelSection: (params: {
    cfg: any;
    channelKey: string;
    accountId: string;
    name?: string;
  }) => {
    if (!params.name?.trim()) return params.cfg;
    const section = params.cfg.channels?.[params.channelKey] ?? {};
    const accounts = section.accounts ?? {};
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.channelKey]: {
          ...section,
          accounts: {
            ...accounts,
            [params.accountId]: {
              ...accounts[params.accountId],
              name: params.name.trim(),
            },
          },
        },
      },
    };
  },
  buildChannelConfigSchema: (schema: any) => schema,
  PAIRING_APPROVED_MESSAGE:
    "You have been approved to message this agent.",
}));

// ---------------------------------------------------------------------------
// Mock bcq module
// ---------------------------------------------------------------------------

const mockBcqProfileList = vi.fn();
const mockBcqAuthStatus = vi.fn();
const mockBcqMe = vi.fn();
const mockBcqApiPost = vi.fn();

vi.mock("../src/bcq.js", () => ({
  bcqProfileList: (...args: any[]) => mockBcqProfileList(...args),
  bcqAuthStatus: (...args: any[]) => mockBcqAuthStatus(...args),
  bcqMe: (...args: any[]) => mockBcqMe(...args),
  bcqApiPost: (...args: any[]) => mockBcqApiPost(...args),
}));

// ---------------------------------------------------------------------------
// Mock config module
// ---------------------------------------------------------------------------

vi.mock("../src/config.js", () => ({
  listBasecampAccountIds: (cfg: any) => {
    const accounts = cfg.channels?.basecamp?.accounts;
    if (!accounts || Object.keys(accounts).length === 0) return ["default"];
    return Object.keys(accounts).sort();
  },
  resolveDefaultBasecampAccountId: (cfg: any) => {
    const accounts = cfg.channels?.basecamp?.accounts;
    if (!accounts || Object.keys(accounts).length === 0) return "default";
    const ids = Object.keys(accounts).sort();
    return ids.includes("default") ? "default" : ids[0];
  },
  resolveBasecampAccount: (cfg: any, accountId?: string) => {
    const id = accountId ?? "default";
    const accounts = cfg.channels?.basecamp?.accounts ?? {};
    const acct = accounts[id];
    if (!acct) {
      return {
        accountId: id,
        enabled: false,
        personId: "",
        token: "",
        tokenSource: "none",
        config: { personId: "" },
      };
    }
    let tokenSource = "none";
    if (acct.token) tokenSource = "config";
    else if (acct.tokenFile) tokenSource = "tokenFile";
    else if (acct.bcqProfile) tokenSource = "bcq";
    return {
      accountId: id,
      enabled: acct.enabled !== false,
      personId: acct.personId ?? "",
      displayName: acct.displayName,
      token: acct.token ?? "",
      tokenSource,
      bcqProfile: acct.bcqProfile,
      host: acct.host,
      config: acct,
    };
  },
}));

// ---------------------------------------------------------------------------
// Import adapters under test
// ---------------------------------------------------------------------------

import { basecampOnboardingAdapter } from "../src/adapters/onboarding.js";
import { basecampSetupAdapter } from "../src/adapters/setup.js";
import { basecampStatusAdapter } from "../src/adapters/status.js";
import { basecampPairingAdapter } from "../src/adapters/pairing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

function cfgWithAccounts(accounts: Record<string, Record<string, unknown>>) {
  return cfg({ accounts });
}

/** Creates a minimal WizardPrompter mock. */
function createPrompter(overrides?: {
  selectAnswers?: string[];
  textAnswers?: string[];
  confirmAnswer?: boolean;
}) {
  let selectIdx = 0;
  let textIdx = 0;
  const selectAnswers = overrides?.selectAnswers ?? [];
  const textAnswers = overrides?.textAnswers ?? [];
  return {
    select: vi.fn(async () => selectAnswers[selectIdx++] ?? "default"),
    text: vi.fn(async () => textAnswers[textIdx++] ?? ""),
    confirm: vi.fn(async () => overrides?.confirmAnswer ?? true),
    note: vi.fn(async () => {}),
    multiselect: vi.fn(async () => []),
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    cancel: vi.fn(),
    isCancel: vi.fn(() => false),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as any;
}

// ---------------------------------------------------------------------------
// Onboarding adapter tests
// ---------------------------------------------------------------------------

describe("basecampOnboardingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("channel", () => {
    it("is 'basecamp'", () => {
      expect(basecampOnboardingAdapter.channel).toBe("basecamp");
    });
  });

  describe("getStatus", () => {
    it("returns configured=false for empty config", async () => {
      const result = await basecampOnboardingAdapter.getStatus({
        cfg: {} as any,
        accountOverrides: {},
      });
      expect(result.channel).toBe("basecamp");
      expect(result.configured).toBe(false);
      expect(result.statusLines[0]).toContain("needs setup");
    });

    it("returns configured=true when account has token and personId", async () => {
      const result = await basecampOnboardingAdapter.getStatus({
        cfg: cfgWithAccounts({
          default: { personId: "123", token: "tok" },
        }),
        accountOverrides: {},
      });
      expect(result.configured).toBe(true);
      expect(result.statusLines[0]).toContain("configured");
    });

    it("returns configured=true when account uses bcqProfile", async () => {
      const result = await basecampOnboardingAdapter.getStatus({
        cfg: cfgWithAccounts({
          default: { personId: "123", bcqProfile: "dev" },
        }),
        accountOverrides: {},
      });
      expect(result.configured).toBe(true);
    });

    it("returns configured=false when personId is missing", async () => {
      const result = await basecampOnboardingAdapter.getStatus({
        cfg: cfgWithAccounts({
          default: { token: "tok" },
        }),
        accountOverrides: {},
      });
      expect(result.configured).toBe(false);
    });
  });

  describe("configure", () => {
    it("configures a new account with bcq auth and auto-detected identity", async () => {
      mockBcqProfileList.mockResolvedValue({ data: [] });
      mockBcqAuthStatus.mockResolvedValue({ data: { authenticated: true } });
      mockBcqMe.mockResolvedValue({
        data: {
          accounts: [
            { id: 12345, name: "Test Co" },
          ],
          identity: { id: 99, name: "Bot User", email_address: "bot@test.com" },
        },
      });

      const prompter = createPrompter();
      const result = await basecampOnboardingAdapter.configure({
        cfg: {} as any,
        runtime: {} as any,
        prompter,
        accountOverrides: {},
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      });

      expect(result.cfg.channels.basecamp.enabled).toBe(true);
      const account = result.cfg.channels.basecamp.accounts.default;
      expect(account.personId).toBe("99");
      expect(account.bcqAccountId).toBe("12345");
    });

    it("prompts for person ID when bcq identity unavailable", async () => {
      mockBcqProfileList.mockResolvedValue({ data: [] });
      mockBcqAuthStatus.mockResolvedValue({ data: { authenticated: false } });

      const prompter = createPrompter({ textAnswers: ["42"] });
      const result = await basecampOnboardingAdapter.configure({
        cfg: {} as any,
        runtime: {} as any,
        prompter,
        accountOverrides: {},
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      });

      const account = result.cfg.channels.basecamp.accounts.default;
      expect(account.personId).toBe("42");
    });

    it("allows profile selection when multiple profiles exist", async () => {
      mockBcqProfileList.mockResolvedValue({ data: ["prod", "dev"] });
      mockBcqAuthStatus.mockResolvedValue({ data: { authenticated: true } });
      mockBcqMe.mockResolvedValue({
        data: {
          accounts: [{ id: 100, name: "Acme" }],
          identity: { id: 5, name: "Service", email_address: "svc@test.com" },
        },
      });

      const prompter = createPrompter({ selectAnswers: ["dev"] });
      const result = await basecampOnboardingAdapter.configure({
        cfg: {} as any,
        runtime: {} as any,
        prompter,
        accountOverrides: {},
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      });

      const account = result.cfg.channels.basecamp.accounts.default;
      expect(account.bcqProfile).toBe("dev");
    });

    it("allows Basecamp account selection when multiple bcq accounts exist", async () => {
      mockBcqProfileList.mockResolvedValue({ data: [] });
      mockBcqAuthStatus.mockResolvedValue({ data: { authenticated: true } });
      mockBcqMe.mockResolvedValue({
        data: {
          accounts: [
            { id: 111, name: "Alpha" },
            { id: 222, name: "Beta" },
          ],
          identity: { id: 7, name: "Bot", email_address: "bot@test.com" },
        },
      });

      const prompter = createPrompter({ selectAnswers: ["222"] });
      const result = await basecampOnboardingAdapter.configure({
        cfg: {} as any,
        runtime: {} as any,
        prompter,
        accountOverrides: {},
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      });

      const account = result.cfg.channels.basecamp.accounts.default;
      expect(account.bcqAccountId).toBe("222");
      expect(account.personId).toBe("7");
    });

    it("respects accountOverrides for basecamp", async () => {
      mockBcqProfileList.mockResolvedValue({ data: [] });
      mockBcqAuthStatus.mockResolvedValue({ data: { authenticated: true } });
      mockBcqMe.mockResolvedValue({
        data: {
          accounts: [{ id: 100, name: "Co" }],
          identity: { id: 1, name: "Bot", email_address: "b@t.com" },
        },
      });

      const prompter = createPrompter();
      const result = await basecampOnboardingAdapter.configure({
        cfg: {} as any,
        runtime: {} as any,
        prompter,
        accountOverrides: { basecamp: "my-custom-id" } as any,
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      });

      expect(result.accountId).toBe("my-custom-id");
      expect(result.cfg.channels.basecamp.accounts["my-custom-id"]).toBeDefined();
    });

    it("prompts for OpenClaw account ID when shouldPromptAccountIds is true", async () => {
      mockBcqProfileList.mockResolvedValue({ data: [] });
      mockBcqAuthStatus.mockResolvedValue({ data: { authenticated: true } });
      mockBcqMe.mockResolvedValue({
        data: {
          accounts: [{ id: 100, name: "Co" }],
          identity: { id: 1, name: "Bot", email_address: "b@t.com" },
        },
      });

      // Select answers in order:
      // 1. OpenClaw account ID prompt → "__new__"
      // Text answers:
      // 1. New account ID → "staging"
      const prompter = createPrompter({
        selectAnswers: ["__new__"],
        textAnswers: ["staging"],
      });
      const result = await basecampOnboardingAdapter.configure({
        cfg: {} as any,
        runtime: {} as any,
        prompter,
        accountOverrides: {},
        shouldPromptAccountIds: true,
        forceAllowFrom: false,
      });

      expect(result.accountId).toBe("staging");
    });
  });

  describe("dmPolicy", () => {
    it("has correct channel and keys", () => {
      const dp = basecampOnboardingAdapter.dmPolicy!;
      expect(dp.channel).toBe("basecamp");
      expect(dp.policyKey).toBe("channels.basecamp.dmPolicy");
      expect(dp.allowFromKey).toBe("channels.basecamp.allowFrom");
    });

    it("getCurrent returns 'open' by default", () => {
      const dp = basecampOnboardingAdapter.dmPolicy!;
      expect(dp.getCurrent({} as any)).toBe("open");
    });

    it("getCurrent returns configured policy", () => {
      const dp = basecampOnboardingAdapter.dmPolicy!;
      expect(dp.getCurrent(cfg({ dmPolicy: "closed" }))).toBe("closed");
    });

    it("setPolicy applies the policy to config", () => {
      const dp = basecampOnboardingAdapter.dmPolicy!;
      const result = dp.setPolicy({} as any, "pairing");
      expect(result.channels.basecamp.dmPolicy).toBe("pairing");
    });
  });

  describe("disable", () => {
    it("sets enabled to false", () => {
      const result = basecampOnboardingAdapter.disable!(
        cfg({ enabled: true, accounts: { default: { personId: "1" } } }),
      );
      expect(result.channels.basecamp.enabled).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Setup adapter tests
// ---------------------------------------------------------------------------

describe("basecampSetupAdapter", () => {
  describe("resolveAccountId", () => {
    it("normalizes account ID", () => {
      expect(basecampSetupAdapter.resolveAccountId!({ cfg: {} as any, accountId: "  foo  " })).toBe(
        "foo",
      );
    });

    it("returns 'default' for empty input", () => {
      expect(basecampSetupAdapter.resolveAccountId!({ cfg: {} as any, accountId: "" })).toBe(
        "default",
      );
    });
  });

  describe("applyAccountName", () => {
    it("applies name to channel section", () => {
      const result = basecampSetupAdapter.applyAccountName!({
        cfg: cfg({ accounts: { default: { personId: "1" } } }),
        accountId: "default",
        name: "Bot",
      });
      expect(result.channels.basecamp.accounts.default.name).toBe("Bot");
    });

    it("does nothing when name is empty", () => {
      const input = cfg({ accounts: { default: { personId: "1" } } });
      const result = basecampSetupAdapter.applyAccountName!({
        cfg: input,
        accountId: "default",
        name: "",
      });
      expect(result).toBe(input);
    });
  });

  describe("validateInput", () => {
    it("returns null (no validation errors) for any input", () => {
      expect(
        basecampSetupAdapter.validateInput!({
          cfg: {} as any,
          accountId: "default",
          input: {} as any,
        }),
      ).toBeNull();
    });
  });

  describe("applyAccountConfig", () => {
    it("applies token to account config", () => {
      const result = basecampSetupAdapter.applyAccountConfig({
        cfg: cfg({ accounts: { default: { personId: "1" } } }),
        accountId: "default",
        input: { token: "secret" } as any,
      });
      expect(result.channels.basecamp.accounts.default.token).toBe("secret");
      expect(result.channels.basecamp.enabled).toBe(true);
    });

    it("applies tokenFile to account config", () => {
      const result = basecampSetupAdapter.applyAccountConfig({
        cfg: cfg({ accounts: { prod: { personId: "1" } } }),
        accountId: "prod",
        input: { tokenFile: "/path/to/token" } as any,
      });
      expect(result.channels.basecamp.accounts.prod.tokenFile).toBe("/path/to/token");
    });

    it("applies name via applyAccountNameToChannelSection", () => {
      const result = basecampSetupAdapter.applyAccountConfig({
        cfg: cfg({ accounts: { default: { personId: "1" } } }),
        accountId: "default",
        input: { name: "My Bot" } as any,
      });
      expect(result.channels.basecamp.accounts.default.name).toBe("My Bot");
    });
  });
});

// ---------------------------------------------------------------------------
// Status adapter tests
// ---------------------------------------------------------------------------

describe("basecampStatusAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("defaultRuntime", () => {
    it("has expected shape", () => {
      expect(basecampStatusAdapter.defaultRuntime).toEqual({
        accountId: "default",
        running: false,
        lastStartAt: null,
        lastStopAt: null,
        lastError: null,
      });
    });
  });

  describe("probeAccount", () => {
    it("returns ok when bcq auth is successful", async () => {
      mockBcqAuthStatus.mockResolvedValue({ data: { authenticated: true } });
      const account = {
        accountId: "test",
        bcqProfile: "dev",
        host: undefined,
        config: {},
      } as any;
      const result = await basecampStatusAdapter.probeAccount!({
        account,
        timeoutMs: 5000,
        cfg: {} as any,
      });
      expect(result).toEqual({ ok: true, authenticated: true });
    });

    it("returns not ok when bcq auth fails", async () => {
      mockBcqAuthStatus.mockResolvedValue({ data: { authenticated: false } });
      const account = {
        accountId: "test",
        config: {},
      } as any;
      const result = await basecampStatusAdapter.probeAccount!({
        account,
        timeoutMs: 5000,
        cfg: {} as any,
      });
      expect(result).toEqual({ ok: false, authenticated: false });
    });

    it("handles bcq auth errors gracefully", async () => {
      mockBcqAuthStatus.mockRejectedValue(new Error("bcq not found"));
      const account = { accountId: "test", config: {} } as any;
      const result = await basecampStatusAdapter.probeAccount!({
        account,
        timeoutMs: 5000,
        cfg: {} as any,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("bcq not found");
    });

    it("passes bcqProfile and host to bcqAuthStatus", async () => {
      mockBcqAuthStatus.mockResolvedValue({ data: { authenticated: true } });
      const account = {
        accountId: "test",
        bcqProfile: "prod",
        host: "custom.host",
        config: {},
      } as any;
      await basecampStatusAdapter.probeAccount!({
        account,
        timeoutMs: 5000,
        cfg: {} as any,
      });
      expect(mockBcqAuthStatus).toHaveBeenCalledWith({
        profile: "prod",
        host: "custom.host",
      });
    });
  });

  describe("buildAccountSnapshot", () => {
    it("builds snapshot for configured account", () => {
      const account = {
        accountId: "prod",
        displayName: "Prod Bot",
        enabled: true,
        token: "tok",
        tokenSource: "config",
        bcqProfile: undefined,
        config: {},
      } as any;
      const result = basecampStatusAdapter.buildAccountSnapshot!({
        account,
        cfg: {} as any,
        runtime: { running: true, lastStartAt: "2025-01-01" } as any,
        probe: { ok: true, authenticated: true },
      });
      expect(result.configured).toBe(true);
      expect(result.running).toBe(true);
      expect(result.name).toBe("Prod Bot");
    });

    it("marks unconfigured when no auth method", () => {
      const account = {
        accountId: "empty",
        enabled: true,
        token: "",
        tokenSource: "none",
        config: {},
      } as any;
      const result = basecampStatusAdapter.buildAccountSnapshot!({
        account,
        cfg: {} as any,
      });
      expect(result.configured).toBe(false);
      expect(result.running).toBe(false);
    });

    it("marks configured when bcqProfile is set", () => {
      const account = {
        accountId: "dev",
        enabled: true,
        token: "",
        tokenSource: "bcq",
        bcqProfile: "dev",
        config: { bcqProfile: "dev" },
      } as any;
      const result = basecampStatusAdapter.buildAccountSnapshot!({
        account,
        cfg: {} as any,
      });
      expect(result.configured).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Pairing adapter tests
// ---------------------------------------------------------------------------

describe("basecampPairingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("idLabel", () => {
    it("is 'basecampPersonId'", () => {
      expect(basecampPairingAdapter.idLabel).toBe("basecampPersonId");
    });
  });

  describe("normalizeAllowEntry", () => {
    it("strips 'basecamp:' prefix", () => {
      expect(basecampPairingAdapter.normalizeAllowEntry!("basecamp:123")).toBe("123");
    });

    it("strips 'bc:' prefix (case insensitive)", () => {
      expect(basecampPairingAdapter.normalizeAllowEntry!("BC:456")).toBe("456");
    });

    it("trims whitespace", () => {
      expect(basecampPairingAdapter.normalizeAllowEntry!("  789  ")).toBe("789");
    });

    it("returns raw numeric string as-is", () => {
      expect(basecampPairingAdapter.normalizeAllowEntry!("12345")).toBe("12345");
    });
  });

  describe("notifyApproval", () => {
    it("sends a Ping via bcqApiPost", async () => {
      mockBcqApiPost.mockResolvedValue({});
      const testCfg = cfgWithAccounts({
        default: { personId: "1", token: "tok" },
      });
      await basecampPairingAdapter.notifyApproval!({
        cfg: testCfg,
        id: "42",
      });
      expect(mockBcqApiPost).toHaveBeenCalledTimes(1);
      expect(mockBcqApiPost.mock.calls[0][0]).toContain("/circles/people/42/lines.json");
    });

    it("does not throw on bcqApiPost failure", async () => {
      mockBcqApiPost.mockRejectedValue(new Error("network error"));
      const testCfg = cfgWithAccounts({
        default: { personId: "1", token: "tok" },
      });
      await expect(
        basecampPairingAdapter.notifyApproval!({ cfg: testCfg, id: "42" }),
      ).resolves.toBeUndefined();
    });
  });
});
