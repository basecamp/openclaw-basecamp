import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

// Mock @37signals/basecamp OAuth exports (these are being built in parallel)
vi.mock("@37signals/basecamp/oauth", () => {
  const mockGetToken = vi.fn().mockResolvedValue("access-token-123");
  const MockTokenManager = vi.fn().mockImplementation(() => ({
    getToken: mockGetToken,
  }));
  const MockFileTokenStore = vi.fn().mockImplementation((path: string) => ({
    path,
  }));
  const mockPerformInteractiveLogin = vi.fn().mockResolvedValue({
    accessToken: "new-access-token",
    refreshToken: "new-refresh-token",
    tokenType: "Bearer",
  });
  return {
    TokenManager: MockTokenManager,
    FileTokenStore: MockFileTokenStore,
    performInteractiveLogin: mockPerformInteractiveLogin,
    refreshToken: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
}));

import {
  resolveTokenFilePath,
  createTokenManager,
  clearTokenManagers,
  interactiveLogin,
} from "../src/oauth-credentials.js";
import { TokenManager, FileTokenStore, performInteractiveLogin, refreshToken } from "@37signals/basecamp/oauth";
import type { ResolvedBasecampAccount } from "../src/types.js";

function makeAccount(overrides?: Partial<ResolvedBasecampAccount>): ResolvedBasecampAccount {
  return {
    accountId: "work",
    enabled: true,
    personId: "42",
    token: "",
    tokenSource: "oauth",
    oauthClientId: "test-client-id",
    oauthClientSecret: "test-client-secret",
    config: {
      personId: "42",
      oauthTokenFile: "/tmp/tokens/work.json",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveTokenFilePath
// ---------------------------------------------------------------------------

describe("resolveTokenFilePath", () => {
  it("uses stateDir when provided", () => {
    const result = resolveTokenFilePath("acme", "/var/data/state");
    expect(result).toBe(join("/var/data/state", "tokens", "acme.json"));
  });

  it("uses default path when stateDir is omitted", () => {
    const result = resolveTokenFilePath("acme");
    const expected = join(
      homedir(),
      ".local",
      "share",
      "openclaw",
      "basecamp",
      "tokens",
      "acme.json",
    );
    expect(result).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// createTokenManager
// ---------------------------------------------------------------------------

describe("createTokenManager", () => {
  beforeEach(() => {
    clearTokenManagers();
    vi.mocked(TokenManager).mockClear();
    vi.mocked(FileTokenStore).mockClear();
  });

  it("creates a TokenManager with the account's oauthTokenFile", () => {
    const account = makeAccount();
    const tm = createTokenManager(account);
    expect(tm).toBeTruthy();
    expect(FileTokenStore).toHaveBeenCalledWith("/tmp/tokens/work.json");
    expect(TokenManager).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshToken,
        tokenEndpoint: "https://launchpad.37signals.com/authorization/token",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        useLegacyFormat: true,
      }),
    );
  });

  it("returns cached instance for same accountId", () => {
    const account = makeAccount();
    const tm1 = createTokenManager(account);
    const tm2 = createTokenManager(account);
    expect(tm1).toBe(tm2);
    expect(TokenManager).toHaveBeenCalledTimes(1);
  });

  it("creates separate instances for different accountIds", () => {
    const a1 = makeAccount({ accountId: "work" });
    const a2 = makeAccount({ accountId: "personal" });
    const tm1 = createTokenManager(a1);
    const tm2 = createTokenManager(a2);
    expect(tm1).not.toBe(tm2);
    expect(TokenManager).toHaveBeenCalledTimes(2);
  });

  it("uses default path when oauthTokenFile is not set", () => {
    const account = makeAccount({
      config: { personId: "42" },
    });
    createTokenManager(account);
    const expectedPath = join(
      homedir(),
      ".local",
      "share",
      "openclaw",
      "basecamp",
      "tokens",
      "work.json",
    );
    expect(FileTokenStore).toHaveBeenCalledWith(expectedPath);
  });
});

// ---------------------------------------------------------------------------
// interactiveLogin
// ---------------------------------------------------------------------------

describe("interactiveLogin", () => {
  beforeEach(() => {
    vi.mocked(performInteractiveLogin).mockClear();
    vi.mocked(FileTokenStore).mockClear();
  });

  it("calls performInteractiveLogin with correct params", async () => {
    const account = makeAccount();
    const token = await interactiveLogin(account);
    expect(token).toEqual({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      tokenType: "Bearer",
    });
    expect(performInteractiveLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        useLegacyFormat: true,
      }),
    );
  });

  it("uses override clientId when provided", async () => {
    const account = makeAccount();
    await interactiveLogin(account, { clientId: "override-id" });
    expect(performInteractiveLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "override-id",
        clientSecret: "test-client-secret",
      }),
    );
  });

  it("throws when no clientId is available", async () => {
    const account = makeAccount({
      oauthClientId: undefined,
    });
    await expect(interactiveLogin(account)).rejects.toThrow("No OAuth clientId");
  });
});
