import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
}));

// ---------------------------------------------------------------------------
// Mock Basecamp CLI module
// ---------------------------------------------------------------------------

const mockCliMe = vi.fn();
const mockCliProfileList = vi.fn();

vi.mock("../src/basecamp-cli.js", () => ({
  cliMe: (...args: any[]) => mockCliMe(...args),
  cliProfileList: (...args: any[]) => mockCliProfileList(...args),
}));

// ---------------------------------------------------------------------------
// Mock config module
// ---------------------------------------------------------------------------

vi.mock("../src/config.js", () => ({
  listBasecampAccountIds: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock oauth-credentials
// ---------------------------------------------------------------------------

const mockInteractiveLogin = vi.fn();
const mockResolveTokenFilePath = vi.fn();
const mockCreateTokenManager = vi.fn();

vi.mock("../src/oauth-credentials.js", () => ({
  interactiveLogin: (...args: any[]) => mockInteractiveLogin(...args),
  resolveTokenFilePath: (...args: any[]) => mockResolveTokenFilePath(...args),
  createTokenManager: (...args: any[]) => mockCreateTokenManager(...args),
}));

// ---------------------------------------------------------------------------
// Mock @37signals/basecamp/oauth (discoverIdentity)
// ---------------------------------------------------------------------------

const mockDiscoverIdentity = vi.fn();

vi.mock("@37signals/basecamp/oauth", () => ({
  discoverIdentity: (...args: any[]) => mockDiscoverIdentity(...args),
}));

// ---------------------------------------------------------------------------
// Mock @37signals/basecamp (AuthorizationInfo type — only needed at type level)
// ---------------------------------------------------------------------------

vi.mock("@37signals/basecamp", () => ({}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises (for token file relocation)
// ---------------------------------------------------------------------------

const mockRename = vi.fn();
const mockCopyFile = vi.fn();
const mockMkdir = vi.fn();
const mockUnlink = vi.fn();

vi.mock("node:fs/promises", () => ({
  rename: (...args: any[]) => mockRename(...args),
  copyFile: (...args: any[]) => mockCopyFile(...args),
  mkdir: (...args: any[]) => mockMkdir(...args),
  unlink: (...args: any[]) => mockUnlink(...args),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { hatchIdentity } from "../src/adapters/hatch.js";
import { listBasecampAccountIds } from "../src/config.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

function createMockPrompter(responses: Record<string, string>) {
  const selectCalls: string[] = [];
  const textCalls: string[] = [];

  return {
    prompter: {
      select: vi.fn(async ({ message, options }: any) => {
        selectCalls.push(message);
        return responses[message] ?? options[0]?.value ?? "";
      }),
      text: vi.fn(async ({ message }: any) => {
        textCalls.push(message);
        return responses[message] ?? "test-value";
      }),
      note: vi.fn(async () => {}),
    },
    calls: { selectCalls, textCalls },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listBasecampAccountIds).mockReturnValue(["default"]);
  // Default: fs operations succeed (happy path for token file relocation)
  mockMkdir.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
  mockCopyFile.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// hatchIdentity — CLI path
// ---------------------------------------------------------------------------

describe("hatchIdentity — CLI path (chains into OAuth)", () => {
  it("discovers identity via CLI and chains into OAuth for persistent token", async () => {
    mockCliProfileList.mockResolvedValue({ data: ["default"], raw: "" });
    mockCliMe.mockResolvedValue({
      data: {
        identity: { id: 42, name: "Jeremy", email_address: "j@example.com", attachable_sgid: "sgid://x" },
        accounts: [{ id: 99, name: "Acme" }],
      } as any,
      raw: "",
    });
    // OAuth chain-through mocks
    mockInteractiveLogin.mockResolvedValue({
      accessToken: "oauth-tok",
      refreshToken: "oauth-ref",
      tokenType: "Bearer",
    });
    mockDiscoverIdentity.mockResolvedValue({
      identity: { id: 42, firstName: "Jeremy", lastName: "", emailAddress: "j@example.com" },
      accounts: [{ id: 99, name: "Acme", product: "bc3" }],
    });
    mockResolveTokenFilePath.mockImplementation((id: string) => `/tmp/tokens/${id}.json`);

    const { prompter } = createMockPrompter({
      "How do you want to authenticate this identity?": "cli",
      "Account ID key for this identity (e.g. 'security', 'design-bot')": "security",
      "Map this identity to an agent?": "__skip__",
      "OAuth client ID": "test-cid",
      "Client Secret (leave blank to skip)": "",
    });

    const result = await hatchIdentity(cfg({}), prompter);

    expect(result.accountId).toBe("security");
    expect(result.personId).toBe("42");
    const accounts = (result.cfg.channels as any).basecamp.accounts;
    expect(accounts.security).toBeDefined();
    expect(accounts.security.personId).toBe("42");
    expect(accounts.security.displayName).toBe("Jeremy");
    expect(accounts.security.attachableSgid).toBe("sgid://x");
    expect(accounts.security.cliProfile).toBe("default");
    // CLI path chains into OAuth — oauthTokenFile should be set
    expect(accounts.security.oauthTokenFile).toBe("/tmp/tokens/security.json");
    expect(mockInteractiveLogin).toHaveBeenCalled();
  });

  it("adds persona mapping when agent ID provided", async () => {
    mockCliProfileList.mockResolvedValue({ data: ["default"], raw: "" });
    mockCliMe.mockResolvedValue({
      data: {
        identity: { id: 10, name: "Bot", email_address: "bot@example.com" },
        accounts: [{ id: 1, name: "Co" }],
      } as any,
      raw: "",
    });
    mockInteractiveLogin.mockResolvedValue({
      accessToken: "oauth-tok",
      refreshToken: "ref",
      tokenType: "Bearer",
    });
    mockDiscoverIdentity.mockResolvedValue({
      identity: { id: 10, firstName: "Bot", lastName: "", emailAddress: "bot@example.com" },
      accounts: [{ id: 1, name: "Co", product: "bc3" }],
    });
    mockResolveTokenFilePath.mockImplementation((id: string) => `/tmp/tokens/${id}.json`);

    const { prompter } = createMockPrompter({
      "How do you want to authenticate this identity?": "cli",
      "Account ID key for this identity (e.g. 'security', 'design-bot')": "bot-acct",
      "Map this identity to an agent?": "__enter__",
      "Agent ID to use this identity": "security-agent",
      "OAuth client ID": "cid",
      "Client Secret (leave blank to skip)": "",
    });

    const result = await hatchIdentity(cfg({}), prompter);

    expect(result.personaMapping).toEqual({
      agentId: "security-agent",
      accountId: "bot-acct",
    });
    const personas = (result.cfg.channels as any).basecamp.personas;
    expect(personas["security-agent"]).toBe("bot-acct");
  });

  it("validates unique account ID", async () => {
    mockCliProfileList.mockResolvedValue({ data: ["default"], raw: "" });
    mockCliMe.mockResolvedValue({
      data: { identity: { id: 1, name: "X", email_address: "x@x.com" }, accounts: [] } as any,
      raw: "",
    });
    vi.mocked(listBasecampAccountIds).mockReturnValue(["default", "existing"]);
    mockInteractiveLogin.mockResolvedValue({
      accessToken: "oauth-tok",
      refreshToken: "ref",
      tokenType: "Bearer",
    });
    mockDiscoverIdentity.mockResolvedValue({
      identity: { id: 1, firstName: "X", lastName: "", emailAddress: "x@x.com" },
      accounts: [],
    });
    mockResolveTokenFilePath.mockImplementation((id: string) => `/tmp/tokens/${id}.json`);

    const { prompter } = createMockPrompter({
      "How do you want to authenticate this identity?": "cli",
      "Account ID key for this identity (e.g. 'security', 'design-bot')": "new-one",
      "Map this identity to an agent?": "__skip__",
      "OAuth client ID": "cid",
      "Client Secret (leave blank to skip)": "",
    });

    const result = await hatchIdentity(cfg({}), prompter);
    expect(result.accountId).toBe("new-one");

    // Verify the validator was set up correctly
    const textCall = prompter.text.mock.calls.find((c: any) => c[0].message.includes("Account ID key"));
    expect(textCall).toBeDefined();
    const validate = textCall![0].validate;
    expect(validate!("existing")).toContain("already in use");
    expect(validate!("new-one")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hatchIdentity — Browser/OAuth path
// ---------------------------------------------------------------------------

describe("hatchIdentity — Browser/OAuth path", () => {
  it("runs browser auth when no CLI available", async () => {
    mockCliProfileList.mockRejectedValue(new Error("not installed"));
    mockInteractiveLogin.mockResolvedValue({
      accessToken: "tok",
      refreshToken: "ref",
      tokenType: "Bearer",
    });
    mockDiscoverIdentity.mockResolvedValue({
      identity: { id: 55, firstName: "OAuth", lastName: "Bot", emailAddress: "bot@test.com" },
      accounts: [{ id: 200, name: "OAuth Co", product: "bc3" }],
    });
    mockResolveTokenFilePath.mockImplementation((id: string) => `/tmp/tokens/${id}.json`);

    const { prompter } = createMockPrompter({
      "OAuth client ID": "test-cid",
      "Account ID key for this identity (e.g. 'security', 'design-bot')": "oauth-acct",
      "Map this identity to an agent?": "__skip__",
    });

    const baseCfg = cfg({ oauth: { clientId: "existing-cid" } });
    const result = await hatchIdentity(baseCfg, prompter);

    expect(result.accountId).toBe("oauth-acct");
    expect(result.personId).toBe("55");
    const accounts = (result.cfg.channels as any).basecamp.accounts;
    expect(accounts["oauth-acct"].personId).toBe("55");
    expect(accounts["oauth-acct"].basecampAccountId).toBe("200");
    // Token file path uses the final accountId, not a temp key
    expect(accounts["oauth-acct"].oauthTokenFile).toBe("/tmp/tokens/oauth-acct.json");
    // discoverIdentity called with the access token string directly
    expect(mockDiscoverIdentity).toHaveBeenCalledWith("tok");
    // CLI keys should be absent
    expect(accounts["oauth-acct"].cliProfile).toBeUndefined();
  });

  it("prompts for clientId and clientSecret when not configured", async () => {
    mockCliProfileList.mockRejectedValue(new Error("not installed"));
    mockInteractiveLogin.mockResolvedValue({
      accessToken: "tok",
      refreshToken: "ref",
      tokenType: "Bearer",
    });
    mockDiscoverIdentity.mockResolvedValue({
      identity: { id: 10, firstName: "Bot", lastName: "", emailAddress: "b@t.com" },
      accounts: [{ id: 1, name: "Co", product: "bc3" }],
    });
    mockResolveTokenFilePath.mockImplementation((id: string) => `/tmp/tokens/${id}.json`);

    const { prompter } = createMockPrompter({
      "OAuth client ID": "prompted-cid",
      "Client Secret (leave blank to skip)": "prompted-secret",
      "Account ID key for this identity (e.g. 'security', 'design-bot')": "new-acct",
      "Map this identity to an agent?": "__skip__",
    });

    // No channel-level oauth config → should prompt for both clientId and clientSecret
    const result = await hatchIdentity(cfg({}), prompter);

    expect(result.accountId).toBe("new-acct");
    // Check clientId and clientSecret were prompted
    expect(prompter.text).toHaveBeenCalledWith(expect.objectContaining({ message: "OAuth client ID" }));
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Client Secret (leave blank to skip)" }),
    );
    // Token file path uses the final accountId
    const accounts = (result.cfg.channels as any).basecamp.accounts;
    expect(accounts["new-acct"].oauthTokenFile).toBe("/tmp/tokens/new-acct.json");
    // Channel-level oauth should be set with both prompted creds
    expect((result.cfg.channels as any).basecamp.oauth?.clientId).toBe("prompted-cid");
    expect((result.cfg.channels as any).basecamp.oauth?.clientSecret).toBe("prompted-secret");
  });

  it("uses per-account token file path — no cross-identity reuse", async () => {
    mockCliProfileList.mockRejectedValue(new Error("not installed"));
    mockInteractiveLogin.mockResolvedValue({
      accessToken: "tok1",
      refreshToken: "ref",
      tokenType: "Bearer",
    });
    mockDiscoverIdentity.mockResolvedValue({
      identity: { id: 1, firstName: "A", lastName: "", emailAddress: "a@t.com" },
      accounts: [{ id: 1, name: "Co", product: "bc3" }],
    });
    mockResolveTokenFilePath.mockImplementation((id: string) => `/tmp/tokens/${id}.json`);

    const { prompter: p1 } = createMockPrompter({
      "Account ID key for this identity (e.g. 'security', 'design-bot')": "acct-one",
      "Map this identity to an agent?": "__skip__",
    });
    const baseCfg = cfg({ oauth: { clientId: "cid" } });
    const r1 = await hatchIdentity(baseCfg, p1);

    // Second hatch run
    mockInteractiveLogin.mockResolvedValue({
      accessToken: "tok2",
      refreshToken: "ref",
      tokenType: "Bearer",
    });
    vi.mocked(listBasecampAccountIds).mockReturnValue(["default", "acct-one"]);
    const { prompter: p2 } = createMockPrompter({
      "Account ID key for this identity (e.g. 'security', 'design-bot')": "acct-two",
      "Map this identity to an agent?": "__skip__",
    });
    const r2 = await hatchIdentity(baseCfg, p2);

    // Each account gets its own token file path
    const a1 = (r1.cfg.channels as any).basecamp.accounts["acct-one"];
    const a2 = (r2.cfg.channels as any).basecamp.accounts["acct-two"];
    expect(a1.oauthTokenFile).toBe("/tmp/tokens/acct-one.json");
    expect(a2.oauthTokenFile).toBe("/tmp/tokens/acct-two.json");
    expect(a1.oauthTokenFile).not.toBe(a2.oauthTokenFile);
  });
});

// ---------------------------------------------------------------------------
// hatchIdentity — browser auth failure (fail-fast)
// ---------------------------------------------------------------------------

describe("hatchIdentity — browser auth failure", () => {
  it("throws when interactiveLogin fails — no silent broken account", async () => {
    mockCliProfileList.mockRejectedValue(new Error("not installed"));
    mockInteractiveLogin.mockRejectedValue(new Error("login failed"));

    const { prompter } = createMockPrompter({
      "OAuth client ID": "cid",
    });

    await expect(hatchIdentity(cfg({ oauth: { clientId: "cid" } }), prompter)).rejects.toThrow("login failed");
  });

  it("throws when discoverIdentity fails — no silent broken account", async () => {
    mockCliProfileList.mockRejectedValue(new Error("not installed"));
    mockInteractiveLogin.mockResolvedValue({
      accessToken: "tok",
      refreshToken: "ref",
      tokenType: "Bearer",
    });
    mockDiscoverIdentity.mockRejectedValue(new Error("network error"));

    const { prompter } = createMockPrompter({
      "OAuth client ID": "cid",
    });

    await expect(hatchIdentity(cfg({ oauth: { clientId: "cid" } }), prompter)).rejects.toThrow("network error");
  });
});

// ---------------------------------------------------------------------------
// hatchIdentity — token file relocation
// ---------------------------------------------------------------------------

describe("hatchIdentity — token file relocation", () => {
  it("keeps temp path when rename and copy both fail", async () => {
    mockCliProfileList.mockRejectedValue(new Error("not installed"));
    mockInteractiveLogin.mockResolvedValue({
      accessToken: "tok",
      refreshToken: "ref",
      tokenType: "Bearer",
    });
    mockDiscoverIdentity.mockResolvedValue({
      identity: { id: 1, firstName: "A", lastName: "", emailAddress: "a@t.com" },
      accounts: [{ id: 1, name: "Co", product: "bc3" }],
    });
    mockResolveTokenFilePath.mockImplementation((id: string) => `/tmp/tokens/${id}.json`);
    // Both rename and copy fail
    mockRename.mockRejectedValue(new Error("EXDEV"));
    mockCopyFile.mockRejectedValue(new Error("ENOENT"));

    const { prompter } = createMockPrompter({
      "Account ID key for this identity (e.g. 'security', 'design-bot')": "my-acct",
      "Map this identity to an agent?": "__skip__",
    });
    const baseCfg = cfg({ oauth: { clientId: "cid" } });

    const result = await hatchIdentity(baseCfg, prompter);

    const account = (result.cfg.channels as any).basecamp.accounts["my-acct"];
    // oauthTokenFile should use the temp path (file exists there), not the final path
    expect(account.oauthTokenFile).toMatch(/^\/tmp\/tokens\/__hatch_[\da-f-]+__\.json$/);
    expect(account.oauthTokenFile).not.toBe("/tmp/tokens/my-acct.json");
  });

  it("falls back to copy+unlink when rename fails", async () => {
    mockCliProfileList.mockRejectedValue(new Error("not installed"));
    mockInteractiveLogin.mockResolvedValue({
      accessToken: "tok",
      refreshToken: "ref",
      tokenType: "Bearer",
    });
    mockDiscoverIdentity.mockResolvedValue({
      identity: { id: 1, firstName: "A", lastName: "", emailAddress: "a@t.com" },
      accounts: [{ id: 1, name: "Co", product: "bc3" }],
    });
    mockResolveTokenFilePath.mockImplementation((id: string) => `/tmp/tokens/${id}.json`);
    // rename fails, copy succeeds
    mockRename.mockRejectedValue(new Error("EXDEV"));
    mockCopyFile.mockResolvedValue(undefined);

    const { prompter } = createMockPrompter({
      "Account ID key for this identity (e.g. 'security', 'design-bot')": "my-acct",
      "Map this identity to an agent?": "__skip__",
    });
    const baseCfg = cfg({ oauth: { clientId: "cid" } });

    const result = await hatchIdentity(baseCfg, prompter);

    const account = (result.cfg.channels as any).basecamp.accounts["my-acct"];
    // copy succeeded → final path should be used
    expect(account.oauthTokenFile).toBe("/tmp/tokens/my-acct.json");
    // unlink should have been attempted on the temp file
    expect(mockUnlink).toHaveBeenCalled();
  });
});
