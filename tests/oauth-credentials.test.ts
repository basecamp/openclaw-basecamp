import { homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { FileTokenStore, performInteractiveLogin, refreshToken, TokenManager } from "@37signals/basecamp/oauth";
import {
  clearTokenManagers,
  createTokenManager,
  interactiveLogin,
  isValidLaunchpadClientId,
  resolveTokenFilePath,
} from "../src/oauth-credentials.js";
import type { ResolvedBasecampAccount } from "../src/types.js";

function makeAccount(overrides?: Partial<ResolvedBasecampAccount>): ResolvedBasecampAccount {
  return {
    accountId: "work",
    enabled: true,
    personId: "42",
    token: "",
    tokenSource: "oauth",
    oauthClientId: "aabbccdd00112233445566778899aabbccddeeff",
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
    const expected = join(homedir(), ".local", "share", "openclaw", "basecamp", "tokens", "acme.json");
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
        clientId: "aabbccdd00112233445566778899aabbccddeeff",
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
    const expectedPath = join(homedir(), ".local", "share", "openclaw", "basecamp", "tokens", "work.json");
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
        clientId: "aabbccdd00112233445566778899aabbccddeeff",
        clientSecret: "test-client-secret",
        useLegacyFormat: true,
      }),
    );
  });

  it("uses valid override clientId and clientSecret as a pair", async () => {
    const overrideId = "ff00112233445566778899aabbccddeeff001122";
    const account = makeAccount();
    await interactiveLogin(account, { clientId: overrideId, clientSecret: "override-secret" });
    expect(performInteractiveLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: overrideId,
        clientSecret: "override-secret",
      }),
    );
  });

  it("uses valid override clientId with undefined secret when only clientId overridden", async () => {
    const overrideId = "ff00112233445566778899aabbccddeeff001122";
    const account = makeAccount();
    await interactiveLogin(account, { clientId: overrideId });
    expect(performInteractiveLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: overrideId,
        clientSecret: undefined,
      }),
    );
  });

  it("throws when no client configured", async () => {
    const account = makeAccount({
      oauthClientId: undefined,
      oauthClientSecret: undefined,
    });
    await expect(interactiveLogin(account)).rejects.toThrow(/No OAuth client configured/);
  });

  it("throws when clientId is invalid (DCR placeholder)", async () => {
    const account = makeAccount({
      oauthClientId: "dcr-id",
      oauthClientSecret: "stale-secret",
    });
    await expect(interactiveLogin(account)).rejects.toThrow(/No OAuth client configured/);
  });

  it("validates override clientId — invalid override falls through to account", async () => {
    const account = makeAccount();
    await interactiveLogin(account, { clientId: "dcr-id", clientSecret: "bad-secret" });
    expect(performInteractiveLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "aabbccdd00112233445566778899aabbccddeeff",
        clientSecret: "test-client-secret",
      }),
    );
  });

  it("uses env vars when account has no client configured", async () => {
    const envId = "ff00112233445566778899aabbccddeeff001122";
    process.env.LAUNCHPAD_CLIENT_ID = envId;
    process.env.LAUNCHPAD_CLIENT_SECRET = "env-secret";
    try {
      const account = makeAccount({ oauthClientId: undefined, oauthClientSecret: undefined });
      await interactiveLogin(account);
      expect(performInteractiveLogin).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: envId,
          clientSecret: "env-secret",
        }),
      );
    } finally {
      delete process.env.LAUNCHPAD_CLIENT_ID;
      delete process.env.LAUNCHPAD_CLIENT_SECRET;
    }
  });
});

// ---------------------------------------------------------------------------
// isValidLaunchpadClientId
// ---------------------------------------------------------------------------

describe("isValidLaunchpadClientId", () => {
  it("accepts valid 40-char hex", () => {
    expect(isValidLaunchpadClientId("aabbccdd00112233445566778899aabbccddeeff")).toBe(true);
  });

  it("rejects undefined", () => {
    expect(isValidLaunchpadClientId(undefined)).toBe(false);
  });

  it("rejects short strings", () => {
    expect(isValidLaunchpadClientId("dcr-id")).toBe(false);
  });

  it("rejects uppercase hex", () => {
    expect(isValidLaunchpadClientId("AABBCCDD00112233445566778899AABBCCDDEEFF")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createTokenManager — fallback
// ---------------------------------------------------------------------------

describe("createTokenManager fallback", () => {
  beforeEach(() => {
    clearTokenManagers();
    vi.mocked(TokenManager).mockClear();
    vi.mocked(FileTokenStore).mockClear();
  });

  it("throws when oauthClientId is missing", () => {
    const account = makeAccount({ oauthClientId: undefined, oauthClientSecret: undefined });
    expect(() => createTokenManager(account)).toThrow(/No OAuth client configured/);
  });

  it("throws when oauthClientId is invalid (DCR placeholder)", () => {
    const account = makeAccount({ oauthClientId: "dcr-id", oauthClientSecret: "stale" });
    expect(() => createTokenManager(account)).toThrow(/No OAuth client configured/);
  });

  it("uses env vars when account has no client configured", () => {
    const envId = "ff00112233445566778899aabbccddeeff001122";
    process.env.LAUNCHPAD_CLIENT_ID = envId;
    process.env.LAUNCHPAD_CLIENT_SECRET = "env-secret";
    try {
      const account = makeAccount({ oauthClientId: undefined, oauthClientSecret: undefined });
      createTokenManager(account);
      expect(TokenManager).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: envId,
          clientSecret: "env-secret",
        }),
      );
    } finally {
      delete process.env.LAUNCHPAD_CLIENT_ID;
      delete process.env.LAUNCHPAD_CLIENT_SECRET;
    }
  });
});
