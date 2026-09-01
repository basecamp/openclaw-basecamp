import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBasecampRuntime, setBasecampRuntime } from "../src/runtime.js";

// Mock @37signals/basecamp OAuth exports (these are being built in parallel)
vi.mock("@37signals/basecamp/oauth", () => {
  const mockGetToken = vi.fn().mockResolvedValue("access-token-123");
  // biome-ignore lint/complexity/useArrowFunction: vitest 4.1 requires `function` for constructible mocks
  const MockTokenManager = vi.fn().mockImplementation(function () {
    return { getToken: mockGetToken };
  });
  // biome-ignore lint/complexity/useArrowFunction: vitest 4.1 requires `function` for constructible mocks
  const MockFileTokenStore = vi.fn().mockImplementation(function (path: string) {
    return { path };
  });
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
  afterEach(() => {
    clearBasecampRuntime();
  });

  it("uses stateDir when provided", () => {
    const result = resolveTokenFilePath("acme", "/var/data/state");
    expect(result).toBe(join("/var/data/state", "tokens", "acme.json"));
  });

  it("defaults under the plugin state dir when the runtime is set (SPEC decision 4)", () => {
    const base = mkdtempSync(join(tmpdir(), "bc-oauth-state-"));
    try {
      setBasecampRuntime({ state: { resolveStateDir: () => base } } as any);
      const result = resolveTokenFilePath("acme");
      expect(result).toBe(join(base, "plugins", "basecamp", "tokens", "acme.json"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("falls back to the legacy home path when no runtime is available", () => {
    const result = resolveTokenFilePath("acme");
    const expected = join(homedir(), ".local", "share", "openclaw", "basecamp", "tokens", "acme.json");
    expect(result).toBe(expected);
  });

  it("migrates a legacy token (and companion client file) to the new default path once", () => {
    const legacyDir = join(homedir(), ".local", "share", "openclaw", "basecamp", "tokens");
    const legacyToken = join(legacyDir, "migrate-me.json");
    const legacyClient = join(legacyDir, "migrate-me.client.json");
    const base = mkdtempSync(join(tmpdir(), "bc-oauth-migrate-"));
    try {
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(legacyToken, JSON.stringify({ accessToken: "legacy-token" }));
      writeFileSync(legacyClient, JSON.stringify({ clientId: "aabbccdd00112233445566778899aabbccddeeff" }));
      setBasecampRuntime({ state: { resolveStateDir: () => base } } as any);

      const result = resolveTokenFilePath("migrate-me");
      expect(result).toBe(join(base, "plugins", "basecamp", "tokens", "migrate-me.json"));
      expect(JSON.parse(readFileSync(result, "utf-8"))).toEqual({ accessToken: "legacy-token" });
      expect(JSON.parse(readFileSync(result.replace(/\.json$/, ".client.json"), "utf-8"))).toEqual({
        clientId: "aabbccdd00112233445566778899aabbccddeeff",
      });
      // Courtesy copy, not a move: the legacy file stays put.
      expect(JSON.parse(readFileSync(legacyToken, "utf-8"))).toEqual({ accessToken: "legacy-token" });
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(legacyToken, { force: true });
      rmSync(legacyClient, { force: true });
    }
  });

  it("does not overwrite an existing token at the new path", () => {
    const legacyDir = join(homedir(), ".local", "share", "openclaw", "basecamp", "tokens");
    const legacyToken = join(legacyDir, "keep-new.json");
    const base = mkdtempSync(join(tmpdir(), "bc-oauth-keep-"));
    try {
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(legacyToken, JSON.stringify({ accessToken: "old" }));
      setBasecampRuntime({ state: { resolveStateDir: () => base } } as any);
      const newPath = join(base, "plugins", "basecamp", "tokens", "keep-new.json");
      mkdirSync(join(base, "plugins", "basecamp", "tokens"), { recursive: true });
      writeFileSync(newPath, JSON.stringify({ accessToken: "new" }));

      const result = resolveTokenFilePath("keep-new");
      expect(result).toBe(newPath);
      expect(JSON.parse(readFileSync(newPath, "utf-8"))).toEqual({ accessToken: "new" });
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(legacyToken, { force: true });
    }
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

  afterEach(() => {
    rmSync("/tmp/tokens/work.client.json", { force: true });
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

  it("persists client credentials to companion file after login", async () => {
    const tokenDir = mkdtempSync(join(tmpdir(), "oc-test-"));
    const tokenFile = join(tokenDir, "work.json");
    try {
      const account = makeAccount({ config: { personId: "42", oauthTokenFile: tokenFile } });
      await interactiveLogin(account);
      const clientData = JSON.parse(readFileSync(join(tokenDir, "work.client.json"), "utf-8"));
      expect(clientData).toEqual({
        clientId: "aabbccdd00112233445566778899aabbccddeeff",
        clientSecret: "test-client-secret",
      });
    } finally {
      rmSync(tokenDir, { recursive: true, force: true });
    }
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
    rmSync("/tmp/tokens/work.client.json", { force: true });
    vi.mocked(TokenManager).mockClear();
    vi.mocked(FileTokenStore).mockClear();
  });

  it("throws when oauthClientId is missing and no persisted client", () => {
    const account = makeAccount({ oauthClientId: undefined, oauthClientSecret: undefined });
    expect(() => createTokenManager(account)).toThrow(/No OAuth client configured/);
  });

  it("throws when oauthClientId is invalid (DCR placeholder)", () => {
    const account = makeAccount({ oauthClientId: "dcr-id", oauthClientSecret: "stale" });
    expect(() => createTokenManager(account)).toThrow(/No OAuth client configured/);
  });

  it("uses persisted client file when account has no client configured", () => {
    const tokenDir = mkdtempSync(join(tmpdir(), "oc-test-"));
    const tokenFile = join(tokenDir, "test.json");
    const clientFile = join(tokenDir, "test.client.json");
    writeFileSync(
      clientFile,
      JSON.stringify({
        clientId: "aabbccdd00112233445566778899aabbccddeeff",
        clientSecret: "persisted-secret",
      }),
    );
    try {
      const account = makeAccount({
        oauthClientId: undefined,
        oauthClientSecret: undefined,
        config: { personId: "42", oauthTokenFile: tokenFile },
      });
      createTokenManager(account);
      expect(TokenManager).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: "aabbccdd00112233445566778899aabbccddeeff",
          clientSecret: "persisted-secret",
        }),
      );
    } finally {
      rmSync(tokenDir, { recursive: true, force: true });
    }
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
