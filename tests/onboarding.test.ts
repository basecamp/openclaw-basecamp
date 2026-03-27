import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock openclaw/plugin-sdk
// ---------------------------------------------------------------------------

vi.mock("openclaw/plugin-sdk", () => ({
  buildChannelConfigSchema: (schema: any) => schema,
  PAIRING_APPROVED_MESSAGE: "You have been approved to message this agent.",
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

vi.mock("openclaw/plugin-sdk/account-id", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    if (!trimmed) return "default";
    return trimmed.toLowerCase().replace(/\s+/g, "-");
  },
}));

vi.mock("openclaw/plugin-sdk/setup", () => ({
  applyAccountNameToChannelSection: (params: { cfg: any; channelKey: string; accountId: string; name?: string }) => {
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
}));
vi.mock("openclaw/plugin-sdk/channel-setup", () => ({}));

vi.mock("openclaw/plugin-sdk/channel-runtime", () => ({}));

vi.mock("openclaw/plugin-sdk/channel-status", () => ({
  PAIRING_APPROVED_MESSAGE: "You have been approved to message this agent.",
}));

vi.mock("openclaw/plugin-sdk/core", () => ({
  applyAccountNameToChannelSection: (params: { cfg: any; channelKey: string; accountId: string; name?: string }) => {
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
}));

// ---------------------------------------------------------------------------
// Mock Basecamp CLI module
// ---------------------------------------------------------------------------

const mockCliProfileList = vi.fn();
const mockCliProfileListFull = vi.fn();
const mockExtractCliBootstrapToken = vi.fn();
const mockExportCliCredentials = vi.fn();

vi.mock("../src/basecamp-cli.js", () => ({
  cliProfileList: (...args: any[]) => mockCliProfileList(...args),
  cliProfileListFull: (...args: any[]) => mockCliProfileListFull(...args),
  extractCliBootstrapToken: (...args: any[]) => mockExtractCliBootstrapToken(...args),
  exportCliCredentials: (...args: any[]) => mockExportCliCredentials(...args),
}));

// ---------------------------------------------------------------------------
// Mock oauth-credentials (for OAuth path)
// ---------------------------------------------------------------------------

const mockInteractiveLogin = vi.fn();
const mockResolveTokenFilePath = vi.fn();

vi.mock("../src/oauth-credentials.js", () => ({
  interactiveLogin: (...args: any[]) => mockInteractiveLogin(...args),
  resolveTokenFilePath: (...args: any[]) => mockResolveTokenFilePath(...args),
  isValidLaunchpadClientId: (id: string | undefined) => !!id && /^[0-9a-f]{40}$/.test(id),
  OAUTH_SETUP_GUIDANCE: "test guidance",
}));

// ---------------------------------------------------------------------------
// Mock basecamp-client
// ---------------------------------------------------------------------------

vi.mock("../src/basecamp-client.js", () => ({
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
const mockFileTokenStoreSave = vi.fn().mockResolvedValue(undefined);

vi.mock("@37signals/basecamp/oauth", () => ({
  discoverIdentity: (...args: any[]) => mockDiscoverIdentity(...args),
  FileTokenStore: class {
    constructor(public path: string) {}
    save = mockFileTokenStoreSave;
  },
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

import { basecampSetupWizard } from "../src/adapters/onboarding.js";
import { basecampPairingAdapter } from "../src/adapters/pairing.js";
import { basecampSetupAdapter } from "../src/adapters/setup.js";
import { basecampStatusAdapter } from "../src/adapters/status.js";

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

/** Mock listAccountIds matching the mock config module's behavior. */
function mockListAccountIds(c: any) {
  const accounts = c.channels?.basecamp?.accounts;
  if (!accounts || Object.keys(accounts).length === 0) return ["default"];
  return Object.keys(accounts).sort();
}

/** Creates a minimal WizardPrompter mock. */
function createPrompter(overrides?: { selectAnswers?: string[]; textAnswers?: string[]; confirmAnswer?: boolean }) {
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
    progress: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  } as any;
}

// ---------------------------------------------------------------------------
// Setup wizard tests
// ---------------------------------------------------------------------------

describe("basecampSetupWizard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("channel", () => {
    it("is 'basecamp'", () => {
      expect(basecampSetupWizard.channel).toBe("basecamp");
    });
  });

  describe("status.resolveConfigured", () => {
    it("returns false for empty config", () => {
      const result = basecampSetupWizard.status.resolveConfigured({ cfg: {} as any });
      expect(result).toBe(false);
    });

    it("returns true when account has token and personId", () => {
      const result = basecampSetupWizard.status.resolveConfigured({
        cfg: cfgWithAccounts({
          default: { personId: "123", token: "tok" },
        }),
      });
      expect(result).toBe(true);
    });

    it("returns false when account uses only cliProfile (no runtime auth)", () => {
      const result = basecampSetupWizard.status.resolveConfigured({
        cfg: cfgWithAccounts({
          default: { personId: "123", cliProfile: "dev" },
        }),
      });
      expect(result).toBe(false);
    });

    it("returns false when personId is missing", () => {
      const result = basecampSetupWizard.status.resolveConfigured({
        cfg: cfgWithAccounts({
          default: { token: "tok" },
        }),
      });
      expect(result).toBe(false);
    });
  });

  describe("resolveAccountIdForConfigure", () => {
    it("returns default account ID when no override and no prompt", async () => {
      const prompter = createPrompter();
      const result = await basecampSetupWizard.resolveAccountIdForConfigure!({
        cfg: {} as any,
        prompter,
        shouldPromptAccountIds: false,
        listAccountIds: mockListAccountIds,
        defaultAccountId: "default",
      });
      expect(result).toBe("default");
    });

    it("normalizes account override", async () => {
      const prompter = createPrompter();
      const result = await basecampSetupWizard.resolveAccountIdForConfigure!({
        cfg: {} as any,
        prompter,
        accountOverride: "My Custom ID",
        shouldPromptAccountIds: false,
        listAccountIds: mockListAccountIds,
        defaultAccountId: "default",
      });
      expect(result).toBe("my-custom-id");
    });

    it("normalizes prompted account ID", async () => {
      const prompter = createPrompter({
        selectAnswers: ["__new__"],
        textAnswers: ["Staging Bot"],
      });
      const result = await basecampSetupWizard.resolveAccountIdForConfigure!({
        cfg: {} as any,
        prompter,
        shouldPromptAccountIds: true,
        listAccountIds: mockListAccountIds,
        defaultAccountId: "default",
      });
      expect(result).toBe("staging-bot");
    });

    it("normalizes selected existing account ID", async () => {
      const prompter = createPrompter({
        selectAnswers: ["work"],
      });
      const result = await basecampSetupWizard.resolveAccountIdForConfigure!({
        cfg: cfgWithAccounts({ work: { personId: "1" } }),
        prompter,
        shouldPromptAccountIds: true,
        listAccountIds: mockListAccountIds,
        defaultAccountId: "default",
      });
      expect(result).toBe("work");
    });
  });

  describe("resolveAccountIdForConfigure — round-trip", () => {
    it("mixed-case override produces config key that matches runtime lookup", async () => {
      mockCliProfileListFull.mockRejectedValue(new Error("not installed"));
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

      // resolveAccountIdForConfigure normalizes the override
      const accountId = await basecampSetupWizard.resolveAccountIdForConfigure!({
        cfg: {} as any,
        prompter: createPrompter(),
        accountOverride: "My Custom ID",
        shouldPromptAccountIds: false,
        listAccountIds: mockListAccountIds,
        defaultAccountId: "default",
      });
      expect(accountId).toBe("my-custom-id");

      // finalize uses that normalized ID as config key
      const result = await basecampSetupWizard.finalize!({
        cfg: {} as any,
        accountId,
        credentialValues: {},
        runtime: {} as any,
        prompter,
        forceAllowFrom: false,
      });

      const nextCfg = result!.cfg!;
      const accounts = nextCfg.channels.basecamp.accounts;

      // Config key is normalized — no raw "My Custom ID" key
      expect(accounts["My Custom ID"]).toBeUndefined();
      expect(accounts["my-custom-id"]).toBeDefined();
      expect(accounts["my-custom-id"].personId).toBe("1");
    });
  });

  describe("finalize — OAuth path", () => {
    it("configures a new account via OAuth when no CLI profiles available", async () => {
      mockCliProfileListFull.mockRejectedValue(new Error("not installed"));
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

      const prompter = createPrompter({
        textAnswers: ["test-client-id", ""],
        selectAnswers: ["done"],
      });

      const result = await basecampSetupWizard.finalize!({
        cfg: {} as any,
        accountId: "default",
        credentialValues: {},
        runtime: {} as any,
        prompter,
        forceAllowFrom: false,
      });

      const nextCfg = result!.cfg!;
      expect(nextCfg.channels.basecamp.enabled).toBe(true);
      const account = nextCfg.channels.basecamp.accounts.default;
      expect(account.personId).toBe("99");
      expect(account.oauthTokenFile).toBe("/tmp/tokens/default.json");
      expect(account.basecampAccountId).toBe("12345");
      expect(account.cliProfile).toBeUndefined();
      expect(account.oauthClientId).toBeUndefined();
      expect(account.oauthClientSecret).toBeUndefined();
      expect(nextCfg.channels.basecamp.oauth?.clientId).toBe("test-client-id");
    });

    it("uses existing channel-level OAuth clientId without prompting", async () => {
      mockCliProfileListFull.mockRejectedValue(new Error("not installed"));
      mockResolveTokenFilePath.mockReturnValue("/tmp/tokens/default.json");
      mockInteractiveLogin.mockResolvedValue({ accessToken: "tok", refreshToken: "ref", tokenType: "Bearer" });
      mockDiscoverIdentity.mockResolvedValue({
        identity: { id: 42, firstName: "Jeremy", lastName: "", emailAddress: "j@test.com" },
        accounts: [{ id: 100, name: "Acme", product: "bc3" }],
      });

      const prompter = createPrompter({ selectAnswers: ["done"] });
      const existingCfg = cfg({
        oauth: { clientId: "aabbccdd00112233445566778899aabbccddeeff", clientSecret: "existing-secret" },
      });

      const result = await basecampSetupWizard.finalize!({
        cfg: existingCfg,
        accountId: "default",
        credentialValues: {},
        runtime: {} as any,
        prompter,
        forceAllowFrom: false,
      });

      const account = result!.cfg!.channels.basecamp.accounts.default;
      expect(account.personId).toBe("42");
      expect(account.oauthTokenFile).toBe("/tmp/tokens/default.json");
      expect(prompter.note).not.toHaveBeenCalledWith(expect.stringContaining("OAuth app"), expect.any(String));
    });

    it("preserves per-account oauthClientId when not prompting for new credentials", async () => {
      mockCliProfileListFull.mockRejectedValue(new Error("not installed"));
      mockResolveTokenFilePath.mockReturnValue("/tmp/tokens/work.json");
      mockInteractiveLogin.mockResolvedValue({ accessToken: "tok", refreshToken: "ref", tokenType: "Bearer" });
      mockDiscoverIdentity.mockResolvedValue({
        identity: { id: 42, firstName: "Jeremy", lastName: "", emailAddress: "j@test.com" },
        accounts: [{ id: 100, name: "Acme", product: "bc3" }],
      });

      const prompter = createPrompter({ selectAnswers: ["done"] });
      const existingCfg = cfg({
        oauth: { clientId: "channel-client" },
        accounts: {
          work: {
            personId: "42",
            oauthTokenFile: "/tmp/tokens/work.json",
            oauthClientId: "1122334455667788990011223344556677889900",
            oauthClientSecret: "per-account-secret",
          },
        },
      });

      const result = await basecampSetupWizard.finalize!({
        cfg: existingCfg,
        accountId: "work",
        credentialValues: {},
        runtime: {} as any,
        prompter,
        forceAllowFrom: false,
      });

      const account = result!.cfg!.channels.basecamp.accounts.work;
      expect(account.oauthClientId).toBe("1122334455667788990011223344556677889900");
      expect(account.oauthClientSecret).toBe("per-account-secret");
    });
  });

  describe("finalize — CLI path", () => {
    it("discovers identity via CLI and imports credentials", async () => {
      mockCliProfileListFull.mockResolvedValue({
        data: [
          { name: "prod", base_url: "https://3.basecampapi.com", authenticated: true },
          { name: "dev", base_url: "http://3.basecamp.localhost:3001", authenticated: true },
        ],
      });
      mockExtractCliBootstrapToken.mockResolvedValue("cli-access-token");
      mockDiscoverIdentity.mockResolvedValue({
        identity: { id: 5, firstName: "Service", lastName: "", emailAddress: "svc@test.com" },
        accounts: [{ id: 100, name: "Acme", product: "bc3" }],
      });
      mockResolveTokenFilePath.mockReturnValue("/tmp/tokens/default.json");
      mockExportCliCredentials.mockReturnValue({
        accessToken: "cli-access-token",
        refreshToken: "cli-refresh-token",
        expiresAt: 1770188269,
        clientId: "aabbccddee00112233445566778899aabbccddee",
        clientSecret: "",
      });

      const prompter = createPrompter({ selectAnswers: ["cli", "dev", "done"] });

      const result = await basecampSetupWizard.finalize!({
        cfg: {} as any,
        accountId: "default",
        credentialValues: {},
        runtime: {} as any,
        prompter,
        forceAllowFrom: false,
      });

      const nextCfg = result!.cfg!;
      const account = nextCfg.channels.basecamp.accounts.default;
      expect(account.cliProfile).toBe("dev");
      expect(account.personId).toBe("5");
      expect(account.basecampAccountId).toBe("100");
      expect(account.oauthTokenFile).toBe("/tmp/tokens/default.json");
      expect(account.oauthClientId).toBe("aabbccddee00112233445566778899aabbccddee");
      expect(mockInteractiveLogin).not.toHaveBeenCalled();
      expect(mockFileTokenStoreSave).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "cli-access-token",
          refreshToken: "cli-refresh-token",
          tokenType: "Bearer",
          expiresAt: new Date(1770188269 * 1000),
        }),
      );
      expect(mockExportCliCredentials).toHaveBeenCalledWith("http://3.basecamp.localhost:3001");
      expect(nextCfg.channels.basecamp.oauth).toBeUndefined();
    });

    it("falls back to OAuth when CLI credential import fails", async () => {
      mockCliProfileListFull.mockResolvedValue({
        data: [{ name: "dev", base_url: "http://3.basecamp.localhost:3001", authenticated: true }],
      });
      mockExtractCliBootstrapToken.mockResolvedValue("cli-bootstrap-token");
      mockExportCliCredentials.mockReturnValue(null);
      mockResolveTokenFilePath.mockReturnValue("/tmp/tokens/default.json");
      mockInteractiveLogin.mockResolvedValue({ accessToken: "oauth-token", tokenType: "Bearer" });
      mockDiscoverIdentity.mockResolvedValue({
        identity: { id: 42, firstName: "Bot", lastName: "", emailAddress: "b@t.com" },
        accounts: [{ id: 100, name: "Co", product: "bc3" }],
      });

      const prompter = createPrompter({ selectAnswers: ["cli", "done"], textAnswers: ["fallback-client", ""] });

      const result = await basecampSetupWizard.finalize!({
        cfg: {} as any,
        accountId: "default",
        credentialValues: {},
        runtime: {} as any,
        prompter,
        forceAllowFrom: false,
      });

      const account = result!.cfg!.channels.basecamp.accounts.default;
      expect(mockInteractiveLogin).toHaveBeenCalled();
      expect(account.oauthTokenFile).toBe("/tmp/tokens/default.json");
      expect(account.personId).toBe("42");
    });
  });

  describe("dmPolicy", () => {
    it("has correct channel and keys", () => {
      const dp = basecampSetupWizard.dmPolicy!;
      expect(dp.channel).toBe("basecamp");
      expect(dp.policyKey).toBe("channels.basecamp.dmPolicy");
      expect(dp.allowFromKey).toBe("channels.basecamp.allowFrom");
    });

    it("getCurrent returns 'allowlist' by default", () => {
      expect(basecampSetupWizard.dmPolicy!.getCurrent({} as any)).toBe("allowlist");
    });

    it("getCurrent returns configured policy", () => {
      expect(basecampSetupWizard.dmPolicy!.getCurrent(cfg({ dmPolicy: "disabled" }))).toBe("disabled");
    });

    it("setPolicy applies the policy to config", () => {
      const result = basecampSetupWizard.dmPolicy!.setPolicy({} as any, "pairing");
      expect(result.channels.basecamp.dmPolicy).toBe("pairing");
    });

    it("promptAllowFrom is defined", () => {
      expect(basecampSetupWizard.dmPolicy!.promptAllowFrom).toBeDefined();
    });

    it("promptAllowFrom merges entered person IDs into allowFrom", async () => {
      const prompter = createPrompter({ textAnswers: ["111, 222"] });
      const result = await basecampSetupWizard.dmPolicy!.promptAllowFrom!({
        cfg: cfg({ allowFrom: ["42"] }),
        prompter,
      });
      expect(result.channels.basecamp.allowFrom).toEqual(["42", "111", "222"]);
    });

    it("promptAllowFrom strips basecamp:/bc: prefixes and filters non-numeric", async () => {
      const prompter = createPrompter({ textAnswers: ["basecamp:111, BC:222, not-a-number, 333"] });
      const result = await basecampSetupWizard.dmPolicy!.promptAllowFrom!({
        cfg: cfg({ allowFrom: ["42"] }),
        prompter,
      });
      expect(result.channels.basecamp.allowFrom).toEqual(["42", "111", "222", "333"]);
    });

    it("promptAllowFrom preserves config when input is empty", async () => {
      const prompter = createPrompter({ textAnswers: [""] });
      const input = cfg({ allowFrom: ["42"] });
      const result = await basecampSetupWizard.dmPolicy!.promptAllowFrom!({ cfg: input, prompter });
      expect(result).toBe(input);
    });

    it("promptAllowFrom preserves config when all entries are non-numeric", async () => {
      const prompter = createPrompter({ textAnswers: ["abc, def"] });
      const input = cfg({ allowFrom: ["42"] });
      const result = await basecampSetupWizard.dmPolicy!.promptAllowFrom!({ cfg: input, prompter });
      expect(result).toBe(input);
    });
  });

  describe("disable", () => {
    it("sets enabled to false", () => {
      const result = basecampSetupWizard.disable!(cfg({ enabled: true, accounts: { default: { personId: "1" } } }));
      expect(result.channels.basecamp.enabled).toBe(false);
    });
  });

  describe("credentials", () => {
    it("is an empty array", () => {
      expect(basecampSetupWizard.credentials).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Setup adapter tests
// ---------------------------------------------------------------------------

describe("basecampSetupAdapter", () => {
  describe("resolveAccountId", () => {
    it("normalizes account ID", () => {
      expect(basecampSetupAdapter.resolveAccountId!({ cfg: {} as any, accountId: "  foo  " })).toBe("foo");
    });

    it("returns 'default' for empty input", () => {
      expect(basecampSetupAdapter.resolveAccountId!({ cfg: {} as any, accountId: "" })).toBe("default");
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
      const result = basecampSetupAdapter.applyAccountName!({ cfg: input, accountId: "default", name: "" });
      expect(result).toBe(input);
    });
  });

  describe("validateInput", () => {
    it("returns null for any input", () => {
      expect(
        basecampSetupAdapter.validateInput!({ cfg: {} as any, accountId: "default", input: {} as any }),
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
      const result = await basecampStatusAdapter.probeAccount!({
        account: { accountId: "test", tokenSource: "config", token: "tok", config: {} } as any,
        timeoutMs: 5000,
        cfg: {} as any,
      });
      expect(result.ok).toBe(true);
      expect(result.authenticated).toBe(true);
    });

    it("returns not ok when SDK getInfo fails", async () => {
      mockGetInfo.mockRejectedValue(new Error("401 Unauthorized"));
      const result = await basecampStatusAdapter.probeAccount!({
        account: { accountId: "test", tokenSource: "config", token: "tok", config: {} } as any,
        timeoutMs: 5000,
        cfg: {} as any,
      });
      expect(result.ok).toBe(false);
      expect(result.authenticated).toBe(false);
    });
  });

  describe("buildAccountSnapshot", () => {
    it("builds snapshot for configured account", () => {
      const result = basecampStatusAdapter.buildAccountSnapshot!({
        account: {
          accountId: "prod",
          displayName: "Prod Bot",
          enabled: true,
          token: "tok",
          tokenSource: "config",
          config: {},
        } as any,
        cfg: {} as any,
        runtime: { running: true, lastStartAt: "2025-01-01" } as any,
        probe: { ok: true, authenticated: true },
      });
      expect(result.configured).toBe(true);
      expect(result.running).toBe(true);
    });

    it("marks unconfigured when no auth method", () => {
      const result = basecampStatusAdapter.buildAccountSnapshot!({
        account: { accountId: "empty", enabled: true, token: "", tokenSource: "none", config: {} } as any,
        cfg: {} as any,
      });
      expect(result.configured).toBe(false);
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

  describe("normalizeAllowEntry", () => {
    it("strips 'basecamp:' prefix", () => {
      expect(basecampPairingAdapter.normalizeAllowEntry!("basecamp:123")).toBe("123");
    });

    it("strips 'bc:' prefix (case insensitive)", () => {
      expect(basecampPairingAdapter.normalizeAllowEntry!("BC:456")).toBe("456");
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

      await basecampPairingAdapter.notifyApproval!({
        cfg: cfgWithAccounts({ default: { personId: "1", token: "tok" } }),
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

      await expect(
        basecampPairingAdapter.notifyApproval!({
          cfg: cfgWithAccounts({ default: { personId: "1", token: "tok" } }),
          id: "42",
        }),
      ).resolves.toBeUndefined();
    });
  });
});
