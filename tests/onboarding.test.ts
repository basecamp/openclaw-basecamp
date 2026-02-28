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
  createDefaultChannelRuntimeState: (accountId: string) => ({
    accountId,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  }),
  buildBaseChannelStatusSummary: (snapshot: Record<string, unknown>) => ({
    configured: snapshot.configured ?? false,
    running: snapshot.running ?? false,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
  }),
}));

// ---------------------------------------------------------------------------
// Mock Basecamp CLI module
// ---------------------------------------------------------------------------

const mockCliProfileList = vi.fn();
const mockCliAuthStatus = vi.fn();

vi.mock("../src/basecamp-cli.js", () => ({
  cliProfileList: (...args: any[]) => mockCliProfileList(...args),
  cliAuthStatus: (...args: any[]) => mockCliAuthStatus(...args),
}));

// ---------------------------------------------------------------------------
// Mock oauth-credentials (for OAuth path)
// ---------------------------------------------------------------------------

const mockInteractiveLogin = vi.fn();
const mockResolveTokenFilePath = vi.fn();

vi.mock("../src/oauth-credentials.js", () => ({
  interactiveLogin: (...args: any[]) => mockInteractiveLogin(...args),
  resolveTokenFilePath: (...args: any[]) => mockResolveTokenFilePath(...args),
}));

// ---------------------------------------------------------------------------
// Mock basecamp-client (for CLI path: cliTokenProvider)
// ---------------------------------------------------------------------------

const mockCliTokenProvider = vi.fn();

vi.mock("../src/basecamp-client.js", () => ({
  cliTokenProvider: (...args: any[]) => mockCliTokenProvider(...args),
  getClient: vi.fn(() => ({
    authorization: { getInfo: vi.fn() },
    projects: { list: vi.fn() },
    raw: { POST: vi.fn() },
  })),
  numId: (_label: string, value: string | number) => Number(value),
  rawOrThrow: vi.fn(async (result: any) => result?.data),
}));

// ---------------------------------------------------------------------------
// Mock @37signals/basecamp/oauth (for discoverIdentity)
// ---------------------------------------------------------------------------

const mockDiscoverIdentity = vi.fn();

vi.mock("@37signals/basecamp/oauth", () => ({
  discoverIdentity: (...args: any[]) => mockDiscoverIdentity(...args),
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
    const section = cfg.channels?.basecamp ?? {};
    const acct = accounts[id];
    if (!acct) {
      return {
        accountId: id,
        enabled: false,
        personId: "",
        token: "",
        tokenSource: "none",
        oauthClientId: section.oauth?.clientId,
        oauthClientSecret: section.oauth?.clientSecret,
        config: { personId: "" },
      };
    }
    let tokenSource = "none";
    if (acct.token) tokenSource = "config";
    else if (acct.tokenFile) tokenSource = "tokenFile";
    else if (acct.oauthTokenFile) tokenSource = "oauth";
    else if (acct.cliProfile) tokenSource = "cli";
    return {
      accountId: id,
      enabled: acct.enabled !== false,
      personId: acct.personId ?? "",
      displayName: acct.displayName,
      token: acct.token ?? "",
      tokenSource,
      cliProfile: acct.cliProfile,
      oauthClientId: acct.oauthClientId ?? section.oauth?.clientId,
      oauthClientSecret: acct.oauthClientSecret ?? section.oauth?.clientSecret,
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

    it("returns configured=true when account uses cliProfile", async () => {
      const result = await basecampOnboardingAdapter.getStatus({
        cfg: cfgWithAccounts({
          default: { personId: "123", cliProfile: "dev" },
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

  describe("configure — OAuth path", () => {
    it("configures a new account via OAuth when no CLI profiles available", async () => {
      // No CLI → auto-selects OAuth
      mockCliProfileList.mockRejectedValue(new Error("not installed"));
      mockResolveTokenFilePath.mockReturnValue("/tmp/tokens/default.json");
      mockInteractiveLogin.mockResolvedValue({
        accessToken: "new-access-token",
        refreshToken: "new-refresh",
        tokenType: "Bearer",
      });
      mockDiscoverIdentity.mockResolvedValue({
        identity: { id: 99, firstName: "Bot", lastName: "User", emailAddress: "bot@test.com" },
        accounts: [{ id: 12345, name: "Test Co", product: "bc3" }],
      });

      // Prompter answers:
      // 1. text: clientId
      // 2. text: clientSecret (empty)
      // 3. select: "What would you like to do?" → "done"
      const prompter = createPrompter({
        textAnswers: ["test-client-id", ""],
        selectAnswers: ["done"],
      });

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
      expect(account.oauthTokenFile).toBe("/tmp/tokens/default.json");
      expect(account.basecampAccountId).toBe("12345");
      // CLI keys should be absent
      expect(account.cliProfile).toBeUndefined();
      // Prompted creds go to channel-level only, NOT account-level
      expect(account.oauthClientId).toBeUndefined();
      expect(account.oauthClientSecret).toBeUndefined();
      // Channel-level oauth should be set from prompted creds
      expect(result.cfg.channels.basecamp.oauth?.clientId).toBe("test-client-id");
    });

    it("uses existing channel-level OAuth clientId without prompting", async () => {
      mockCliProfileList.mockRejectedValue(new Error("not installed"));
      mockResolveTokenFilePath.mockReturnValue("/tmp/tokens/default.json");
      mockInteractiveLogin.mockResolvedValue({
        accessToken: "tok",
        refreshToken: "ref",
        tokenType: "Bearer",
      });
      mockDiscoverIdentity.mockResolvedValue({
        identity: { id: 42, firstName: "Jeremy", lastName: "", emailAddress: "j@test.com" },
        accounts: [{ id: 100, name: "Acme", product: "bc3" }],
      });

      // No text prompts for clientId needed — it comes from channel-level config
      const prompter = createPrompter({
        selectAnswers: ["done"],
      });

      const existingCfg = cfg({
        oauth: { clientId: "existing-client", clientSecret: "existing-secret" },
      });

      const result = await basecampOnboardingAdapter.configure({
        cfg: existingCfg,
        runtime: {} as any,
        prompter,
        accountOverrides: {},
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      });

      const account = result.cfg.channels.basecamp.accounts.default;
      expect(account.personId).toBe("42");
      expect(account.oauthTokenFile).toBe("/tmp/tokens/default.json");
      // Should NOT have prompted for clientId — no text calls for it
      expect(prompter.note).not.toHaveBeenCalledWith(
        expect.stringContaining("OAuth app"),
        expect.any(String),
      );
    });
  });

  describe("configure — CLI path", () => {
    it("configures account via CLI profile selection", async () => {
      mockCliProfileList.mockResolvedValue({ data: ["prod", "dev"] });
      mockCliAuthStatus.mockResolvedValue({ data: { authenticated: true } });
      mockCliTokenProvider.mockReturnValue(async () => "cli-access-token");
      mockDiscoverIdentity.mockResolvedValue({
        identity: { id: 5, firstName: "Service", lastName: "", emailAddress: "svc@test.com" },
        accounts: [{ id: 100, name: "Acme", product: "bc3" }],
      });

      // Select answers in order:
      // 1. Auth method: "cli"
      // 2. Profile: "dev"
      // 3. "What would you like to do?" → "done"
      const prompter = createPrompter({
        selectAnswers: ["cli", "dev", "done"],
      });

      const result = await basecampOnboardingAdapter.configure({
        cfg: {} as any,
        runtime: {} as any,
        prompter,
        accountOverrides: {},
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      });

      const account = result.cfg.channels.basecamp.accounts.default;
      expect(account.cliProfile).toBe("dev");
      expect(account.personId).toBe("5");
      expect(account.basecampAccountId).toBe("100");
      // OAuth keys should be absent
      expect(account.oauthTokenFile).toBeUndefined();
      expect(account.oauthClientId).toBeUndefined();
    });

    it("prompts for person ID when CLI auth fails", async () => {
      mockCliProfileList.mockResolvedValue({ data: ["default"] });
      mockCliAuthStatus.mockResolvedValue({ data: { authenticated: false } });

      // Select: auth method → "cli", then "What would you like to do?" → "done"
      // Text: personId prompt
      const prompter = createPrompter({
        selectAnswers: ["cli", "done"],
        textAnswers: ["42"],
      });

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
  });

  describe("configure — auth-method cleanup", () => {
    it("clears cliProfile when switching to OAuth", async () => {
      mockCliProfileList.mockRejectedValue(new Error("not installed"));
      mockResolveTokenFilePath.mockReturnValue("/tmp/tokens/default.json");
      mockInteractiveLogin.mockResolvedValue({
        accessToken: "tok",
        refreshToken: "ref",
        tokenType: "Bearer",
      });
      mockDiscoverIdentity.mockResolvedValue({
        identity: { id: 10, firstName: "Bot", lastName: "", emailAddress: "b@t.com" },
        accounts: [{ id: 1, name: "Co", product: "bc3" }],
      });

      const prompter = createPrompter({
        textAnswers: ["client-id", ""],
        selectAnswers: ["done"],
      });

      // Start with a config that has cliProfile set
      const existingCfg = cfgWithAccounts({
        default: { personId: "10", cliProfile: "old-profile" },
      });

      const result = await basecampOnboardingAdapter.configure({
        cfg: existingCfg,
        runtime: {} as any,
        prompter,
        accountOverrides: {},
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      });

      const account = result.cfg.channels.basecamp.accounts.default;
      expect(account.oauthTokenFile).toBe("/tmp/tokens/default.json");
      // cliProfile should be cleared
      expect(account.cliProfile).toBeUndefined();
    });

    it("clears OAuth keys when switching to CLI", async () => {
      mockCliProfileList.mockResolvedValue({ data: ["dev"] });
      mockCliAuthStatus.mockResolvedValue({ data: { authenticated: true } });
      mockCliTokenProvider.mockReturnValue(async () => "cli-token");
      mockDiscoverIdentity.mockResolvedValue({
        identity: { id: 10, firstName: "Bot", lastName: "", emailAddress: "b@t.com" },
        accounts: [{ id: 1, name: "Co", product: "bc3" }],
      });

      // Select: auth method → "cli", profile → "dev" (auto-selected for single), "done"
      const prompter = createPrompter({
        selectAnswers: ["cli", "done"],
      });

      // Start with OAuth-configured account
      const existingCfg = cfgWithAccounts({
        default: {
          personId: "10",
          oauthTokenFile: "/old/path.json",
          oauthClientId: "old-id",
          oauthClientSecret: "old-secret",
        },
      });

      const result = await basecampOnboardingAdapter.configure({
        cfg: existingCfg,
        runtime: {} as any,
        prompter,
        accountOverrides: {},
        shouldPromptAccountIds: false,
        forceAllowFrom: false,
      });

      const account = result.cfg.channels.basecamp.accounts.default;
      expect(account.cliProfile).toBe("dev");
      // OAuth keys should be cleared
      expect(account.oauthTokenFile).toBeUndefined();
      expect(account.oauthClientId).toBeUndefined();
      expect(account.oauthClientSecret).toBeUndefined();
    });
  });

  describe("configure — general", () => {
    it("respects accountOverrides for basecamp", async () => {
      mockCliProfileList.mockRejectedValue(new Error("not installed"));
      mockResolveTokenFilePath.mockReturnValue("/tmp/tokens/my-custom-id.json");
      mockInteractiveLogin.mockResolvedValue({
        accessToken: "tok",
        refreshToken: "ref",
        tokenType: "Bearer",
      });
      mockDiscoverIdentity.mockResolvedValue({
        identity: { id: 1, firstName: "Bot", lastName: "", emailAddress: "b@t.com" },
        accounts: [{ id: 100, name: "Co", product: "bc3" }],
      });

      const prompter = createPrompter({
        textAnswers: ["client-id", ""],
        selectAnswers: ["done"],
      });

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
      mockCliProfileList.mockRejectedValue(new Error("not installed"));
      mockResolveTokenFilePath.mockReturnValue("/tmp/tokens/staging.json");
      mockInteractiveLogin.mockResolvedValue({
        accessToken: "tok",
        refreshToken: "ref",
        tokenType: "Bearer",
      });
      mockDiscoverIdentity.mockResolvedValue({
        identity: { id: 1, firstName: "Bot", lastName: "", emailAddress: "b@t.com" },
        accounts: [{ id: 100, name: "Co", product: "bc3" }],
      });

      // Select answers in order:
      // 1. OpenClaw account ID prompt → "__new__"
      // 2. "What would you like to do?" → "done"
      // Text answers:
      // 1. New account ID → "staging"
      // 2. clientId → "cid"
      // 3. clientSecret → ""
      const prompter = createPrompter({
        selectAnswers: ["__new__", "done"],
        textAnswers: ["staging", "cid", ""],
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

    it("getCurrent returns 'pairing' by default", () => {
      const dp = basecampOnboardingAdapter.dmPolicy!;
      expect(dp.getCurrent({} as any)).toBe("pairing");
    });

    it("getCurrent returns configured policy", () => {
      const dp = basecampOnboardingAdapter.dmPolicy!;
      expect(dp.getCurrent(cfg({ dmPolicy: "disabled" }))).toBe("disabled");
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
  const mockGetInfo = vi.fn();
  const mockProjectsList = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-mock getClient for each test since we need fresh mockGetInfo
    const { getClient } = vi.mocked(await import("../src/basecamp-client.js"));
    vi.mocked(getClient).mockReturnValue({
      authorization: { getInfo: mockGetInfo },
      projects: { list: mockProjectsList },
      raw: { POST: vi.fn() },
    } as any);
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
    it("returns ok when SDK identity resolves", async () => {
      mockGetInfo.mockResolvedValue({
        identity: { firstName: "Jeremy", lastName: "" },
        accounts: [{ id: 1, name: "Test" }],
      });
      const account = {
        accountId: "test",
        tokenSource: "config",
        token: "tok",
        config: {},
      } as any;
      const result = await basecampStatusAdapter.probeAccount!({
        account,
        timeoutMs: 5000,
        cfg: {} as any,
      });
      expect(result.ok).toBe(true);
      expect(result.authenticated).toBe(true);
      expect(result.personName).toBe("Jeremy");
      expect(result.accountCount).toBe(1);
    });

    it("returns not ok when SDK getInfo fails", async () => {
      mockGetInfo.mockRejectedValue(new Error("401 Unauthorized"));
      const account = {
        accountId: "test",
        tokenSource: "cli",
        config: {},
      } as any;
      const result = await basecampStatusAdapter.probeAccount!({
        account,
        timeoutMs: 5000,
        cfg: {} as any,
      });
      expect(result.ok).toBe(false);
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain("401");
    });

    it("handles SDK auth errors gracefully for config accounts", async () => {
      mockGetInfo.mockRejectedValue(new Error("network error"));
      const account = { accountId: "test", tokenSource: "config", token: "tok", config: {} } as any;
      const result = await basecampStatusAdapter.probeAccount!({
        account,
        timeoutMs: 5000,
        cfg: {} as any,
      });
      expect(result.ok).toBe(false);
      expect(result.authenticated).toBe(false);
    });

    it("returns not ok for any token source when SDK identity fails", async () => {
      mockGetInfo.mockRejectedValue(new Error("connection refused"));
      const account = {
        accountId: "test",
        tokenSource: "cli",
        cliProfile: "dev",
        config: {},
      } as any;
      const result = await basecampStatusAdapter.probeAccount!({
        account,
        timeoutMs: 5000,
        cfg: {} as any,
      });
      expect(result.ok).toBe(false);
      expect(result.authenticated).toBe(false);
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
        cliProfile: undefined,
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

    it("marks configured when cliProfile is set", () => {
      const account = {
        accountId: "dev",
        enabled: true,
        token: "",
        tokenSource: "cli",
        cliProfile: "dev",
        config: { cliProfile: "dev" },
      } as any;
      const result = basecampStatusAdapter.buildAccountSnapshot!({
        account,
        cfg: {} as any,
      });
      expect(result.configured).toBe(true);
    });

    it("marks configured when oauthTokenFile is set", () => {
      const account = {
        accountId: "oauth-acct",
        enabled: true,
        token: "",
        tokenSource: "oauth",
        config: { oauthTokenFile: "/tmp/tokens/oauth-acct.json" },
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
    it("sends a Ping via SDK client raw POST", async () => {
      const mockRawPOST = vi.fn().mockResolvedValue({ data: {}, response: { ok: true } });
      const { getClient } = vi.mocked(await import("../src/basecamp-client.js"));
      vi.mocked(getClient).mockReturnValue({
        authorization: { getInfo: vi.fn() },
        projects: { list: vi.fn() },
        raw: { POST: mockRawPOST },
      } as any);

      const testCfg = cfgWithAccounts({
        default: { personId: "1", token: "tok" },
      });
      await basecampPairingAdapter.notifyApproval!({
        cfg: testCfg,
        id: "42",
      });
      expect(mockRawPOST).toHaveBeenCalledTimes(1);
      expect(mockRawPOST.mock.calls[0][0]).toContain("/circles/people/42/lines.json");
    });

    it("does not throw on SDK client failure", async () => {
      const mockRawPOST = vi.fn().mockRejectedValue(new Error("network error"));
      const { getClient } = vi.mocked(await import("../src/basecamp-client.js"));
      vi.mocked(getClient).mockReturnValue({
        authorization: { getInfo: vi.fn() },
        projects: { list: vi.fn() },
        raw: { POST: mockRawPOST },
      } as any);

      const testCfg = cfgWithAccounts({
        default: { personId: "1", token: "tok" },
      });
      await expect(
        basecampPairingAdapter.notifyApproval!({ cfg: testCfg, id: "42" }),
      ).resolves.toBeUndefined();
    });
  });
});
