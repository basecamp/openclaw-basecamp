import { beforeEach, describe, expect, it, vi } from "vitest";

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
// Import adapters under test (real config + SDK wizard helpers, un-mocked)
// ---------------------------------------------------------------------------

import { basecampSetupWizard } from "../src/adapters/onboarding.js";
import { basecampPairingAdapter } from "../src/adapters/pairing.js";
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

/** listAccountIds callback matching the real config module's behavior. */
function listAccountIds(c: any) {
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

  describe("status (createStandardChannelSetupStatus)", () => {
    it("labels configured and unconfigured states", () => {
      expect(basecampSetupWizard.status.configuredLabel).toBe("configured");
      expect(basecampSetupWizard.status.unconfiguredLabel).toBe("needs setup");
    });

    it("resolveConfigured returns false for empty config", () => {
      expect(basecampSetupWizard.status.resolveConfigured({ cfg: {} as any })).toBe(false);
    });

    it("resolveConfigured returns true when account has token and personId", () => {
      const result = basecampSetupWizard.status.resolveConfigured({
        cfg: cfgWithAccounts({
          default: { personId: "123", token: "tok" },
        }),
      });
      expect(result).toBe(true);
    });

    it("resolveConfigured returns false when account uses only cliProfile (no runtime auth)", () => {
      const result = basecampSetupWizard.status.resolveConfigured({
        cfg: cfgWithAccounts({
          default: { personId: "123", cliProfile: "dev" },
        }),
      });
      expect(result).toBe(false);
    });

    it("resolveConfigured returns false when personId is missing", () => {
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
        listAccountIds,
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
        listAccountIds,
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
        listAccountIds,
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
        listAccountIds,
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
        textAnswers: ["aabbccdd00112233445566778899aabbccddeeff", ""],
        selectAnswers: ["done"],
      });

      // resolveAccountIdForConfigure normalizes the override
      const accountId = await basecampSetupWizard.resolveAccountIdForConfigure!({
        cfg: {} as any,
        prompter: createPrompter(),
        accountOverride: "My Custom ID",
        shouldPromptAccountIds: false,
        listAccountIds,
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
      const accounts = (nextCfg.channels as any).basecamp.accounts;

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
        textAnswers: ["aabbccdd00112233445566778899aabbccddeeff", ""],
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
      expect((nextCfg.channels as any).basecamp.enabled).toBe(true);
      const account = (nextCfg.channels as any).basecamp.accounts.default;
      expect(account.personId).toBe("99");
      expect(account.oauthTokenFile).toBe("/tmp/tokens/default.json");
      expect(account.basecampAccountId).toBe("12345");
      expect(account.cliProfile).toBeUndefined();
      expect(account.oauthClientId).toBeUndefined();
      expect(account.oauthClientSecret).toBeUndefined();
      expect((nextCfg.channels as any).basecamp.oauth?.clientId).toBe("aabbccdd00112233445566778899aabbccddeeff");
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

      const account = (result!.cfg!.channels as any).basecamp.accounts.default;
      expect(account.personId).toBe("42");
      expect(account.oauthTokenFile).toBe("/tmp/tokens/default.json");
      expect(prompter.note).not.toHaveBeenCalledWith(expect.stringContaining("OAuth app"), expect.any(String));
    });

    it("passes prompter.openUrl through to interactiveLogin when present", async () => {
      mockCliProfileListFull.mockRejectedValue(new Error("not installed"));
      mockResolveTokenFilePath.mockReturnValue("/tmp/tokens/default.json");
      mockInteractiveLogin.mockResolvedValue({ accessToken: "tok", tokenType: "Bearer" });
      mockDiscoverIdentity.mockResolvedValue({
        identity: { id: 42, firstName: "J", lastName: "", emailAddress: "j@test.com" },
        accounts: [{ id: 100, name: "Acme", product: "bc3" }],
      });

      const prompter = createPrompter({ selectAnswers: ["done"] });
      prompter.openUrl = vi.fn(async () => {});
      const existingCfg = cfg({
        oauth: { clientId: "aabbccdd00112233445566778899aabbccddeeff" },
      });

      await basecampSetupWizard.finalize!({
        cfg: existingCfg,
        accountId: "default",
        credentialValues: {},
        runtime: {} as any,
        prompter,
        forceAllowFrom: false,
      });

      expect(mockInteractiveLogin).toHaveBeenCalledTimes(1);
      const overrides = mockInteractiveLogin.mock.calls[0]![1];
      expect(typeof overrides.openUrl).toBe("function");
      await overrides.openUrl("https://launchpad.example/authorize");
      expect(prompter.openUrl).toHaveBeenCalledWith("https://launchpad.example/authorize");
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

      const account = (result!.cfg!.channels as any).basecamp.accounts.work;
      expect(account.oauthClientId).toBe("1122334455667788990011223344556677889900");
      expect(account.oauthClientSecret).toBe("per-account-secret");
    });

    it("leaves dmPolicy untouched (pairing is honored by the ingress resolver)", async () => {
      mockCliProfileListFull.mockRejectedValue(new Error("not installed"));
      mockResolveTokenFilePath.mockReturnValue("/tmp/tokens/default.json");
      mockInteractiveLogin.mockResolvedValue({ accessToken: "tok", tokenType: "Bearer" });
      mockDiscoverIdentity.mockResolvedValue({
        identity: { id: 1, firstName: "Bot", lastName: "", emailAddress: "b@t.com" },
        accounts: [{ id: 100, name: "Co", product: "bc3" }],
      });

      const prompter = createPrompter({
        textAnswers: ["aabbccdd00112233445566778899aabbccddeeff", ""],
        selectAnswers: ["done"],
      });

      const result = await basecampSetupWizard.finalize!({
        cfg: cfg({ dmPolicy: "pairing" }),
        accountId: "default",
        credentialValues: {},
        runtime: {} as any,
        prompter,
        forceAllowFrom: false,
      });

      expect((result!.cfg!.channels as any).basecamp.dmPolicy).toBe("pairing");
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
      const account = (nextCfg.channels as any).basecamp.accounts.default;
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
      expect((nextCfg.channels as any).basecamp.oauth).toBeUndefined();
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

      const prompter = createPrompter({
        selectAnswers: ["cli", "done"],
        textAnswers: ["aabbccdd00112233445566778899aabbccddeeff", ""],
      });

      const result = await basecampSetupWizard.finalize!({
        cfg: {} as any,
        accountId: "default",
        credentialValues: {},
        runtime: {} as any,
        prompter,
        forceAllowFrom: false,
      });

      const account = (result!.cfg!.channels as any).basecamp.accounts.default;
      expect(mockInteractiveLogin).toHaveBeenCalled();
      expect(account.oauthTokenFile).toBe("/tmp/tokens/default.json");
      expect(account.personId).toBe("42");
    });
  });

  describe("dmPolicy (createChannelDmPolicy)", () => {
    it("has correct channel and default keys", () => {
      const dp = basecampSetupWizard.dmPolicy!;
      expect(dp.channel).toBe("basecamp");
      expect(dp.policyKey).toBe("channels.basecamp.dmPolicy");
      expect(dp.allowFromKey).toBe("channels.basecamp.allowFrom");
    });

    it("resolveConfigKeys targets the channel root for the default account", () => {
      const keys = basecampSetupWizard.dmPolicy!.resolveConfigKeys!({} as any, "default");
      expect(keys.policyKey).toBe("channels.basecamp.dmPolicy");
      expect(keys.allowFromKey).toBe("channels.basecamp.allowFrom");
    });

    it("resolveConfigKeys targets the account section for named accounts", () => {
      const config = cfgWithAccounts({ work: { personId: "1", token: "t" } });
      const keys = basecampSetupWizard.dmPolicy!.resolveConfigKeys!(config, "work");
      expect(keys.policyKey).toBe("channels.basecamp.accounts.work.dmPolicy");
      expect(keys.allowFromKey).toBe("channels.basecamp.accounts.work.allowFrom");
    });

    it("getCurrent returns 'allowlist' by default", () => {
      expect(basecampSetupWizard.dmPolicy!.getCurrent({} as any)).toBe("allowlist");
    });

    it("getCurrent returns configured channel-level policy", () => {
      expect(basecampSetupWizard.dmPolicy!.getCurrent(cfg({ dmPolicy: "disabled" }))).toBe("disabled");
    });

    it("getCurrent returns per-account policy for named accounts", () => {
      const config = cfg({
        dmPolicy: "open",
        accounts: { work: { personId: "1", token: "t", dmPolicy: "disabled" } },
      });
      expect(basecampSetupWizard.dmPolicy!.getCurrent(config, "work")).toBe("disabled");
    });

    it("setPolicy writes the channel root for the default account", () => {
      const result = basecampSetupWizard.dmPolicy!.setPolicy({} as any, "disabled");
      expect((result.channels as any).basecamp.dmPolicy).toBe("disabled");
    });

    it("setPolicy 'open' adds the wildcard allowFrom entry", () => {
      const result = basecampSetupWizard.dmPolicy!.setPolicy(cfg({ allowFrom: ["42"] }), "open");
      expect((result.channels as any).basecamp.dmPolicy).toBe("open");
      expect((result.channels as any).basecamp.allowFrom).toContain("*");
      expect((result.channels as any).basecamp.allowFrom).toContain("42");
    });

    it("setPolicy writes the account section for named accounts", () => {
      const config = cfgWithAccounts({ work: { personId: "1", token: "t" } });
      const result = basecampSetupWizard.dmPolicy!.setPolicy(config, "disabled", "work");
      expect((result.channels as any).basecamp.accounts.work.dmPolicy).toBe("disabled");
      expect((result.channels as any).basecamp.dmPolicy).toBeUndefined();
    });

    it("promptAllowFrom merges entered person IDs into allowFrom", async () => {
      const prompter = createPrompter({ textAnswers: ["111, 222"] });
      const result = await basecampSetupWizard.dmPolicy!.promptAllowFrom!({
        cfg: cfg({ allowFrom: ["42"] }),
        prompter,
      });
      expect((result.channels as any).basecamp.allowFrom).toEqual(["42", "111", "222"]);
    });

    it("promptAllowFrom strips basecamp:/bc: prefixes and filters non-numeric", async () => {
      const prompter = createPrompter({ textAnswers: ["basecamp:111, BC:222, not-a-number, 333"] });
      const result = await basecampSetupWizard.dmPolicy!.promptAllowFrom!({
        cfg: cfg({ allowFrom: ["42"] }),
        prompter,
      });
      expect((result.channels as any).basecamp.allowFrom).toEqual(["42", "111", "222", "333"]);
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

    it("promptAllowFrom targets the account section for named accounts", async () => {
      const prompter = createPrompter({ textAnswers: ["111"] });
      const config = cfgWithAccounts({ work: { personId: "1", token: "t" } });
      const result = await basecampSetupWizard.dmPolicy!.promptAllowFrom!({
        cfg: config,
        prompter,
        accountId: "work",
      });
      expect((result.channels as any).basecamp.accounts.work.allowFrom).toEqual(["111"]);
    });
  });

  describe("allowFrom section (createAllowFromSection)", () => {
    it("parses numeric person IDs, stripping prefixes", () => {
      const section = basecampSetupWizard.allowFrom!;
      expect(section.parseId("basecamp:123")).toBe("123");
      expect(section.parseId("BC:456")).toBe("456");
      expect(section.parseId("789")).toBe("789");
      expect(section.parseId("nope")).toBeNull();
    });

    it("apply merges entries into the channel-level allowFrom for the default account", async () => {
      const result = await basecampSetupWizard.allowFrom!.apply({
        cfg: cfg({ allowFrom: ["42"] }),
        accountId: "default",
        allowFrom: ["111", "42"],
      });
      expect(((result as any).channels as any).basecamp.allowFrom).toEqual(["42", "111"]);
    });

    it("apply writes per-account allowFrom for named accounts", async () => {
      const result = await basecampSetupWizard.allowFrom!.apply({
        cfg: cfgWithAccounts({ work: { personId: "1", token: "t" } }),
        accountId: "work",
        allowFrom: ["111"],
      });
      expect(((result as any).channels as any).basecamp.accounts.work.allowFrom).toEqual(["111"]);
    });
  });

  describe("disable", () => {
    it("sets enabled to false", () => {
      const result = basecampSetupWizard.disable!(cfg({ enabled: true, accounts: { default: { personId: "1" } } }));
      expect((result.channels as any).basecamp.enabled).toBe(false);
    });
  });

  describe("credentials", () => {
    it("is an empty array", () => {
      expect(basecampSetupWizard.credentials).toEqual([]);
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
