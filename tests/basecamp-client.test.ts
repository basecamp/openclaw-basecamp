/**
 * Tests for src/basecamp-client.ts
 *
 * Covers: numId, rawOrThrow, getClient (client caching + account ID resolution),
 * resolveTokenProvider (config, tokenFile, oauth, none).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures these survive vi.mock hoisting
// ---------------------------------------------------------------------------

const { mockCreateBasecampClient, mockErrorFromResponse } = vi.hoisted(() => ({
  mockCreateBasecampClient: vi.fn(() => ({ fake: "client" })),
  mockErrorFromResponse: vi.fn(),
}));

vi.mock("@37signals/basecamp", () => ({
  createBasecampClient: mockCreateBasecampClient,
  errorFromResponse: mockErrorFromResponse,
  BasecampError: class BasecampError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "BasecampError";
    }
  },
}));

vi.mock("../src/basecamp-cli.js", () => ({
  resolveCliBinaryPath: vi.fn(() => "basecamp"),
}));

vi.mock("../src/oauth-credentials.js", () => ({
  createTokenManager: vi.fn(() => ({
    getToken: vi.fn(async () => "oauth-token-abc"),
  })),
}));

const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

import { numId, rawOrThrow, getClient, clearClients } from "../src/basecamp-client.js";
import type { ResolvedBasecampAccount } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<ResolvedBasecampAccount> = {}): ResolvedBasecampAccount {
  return {
    accountId: "test-acct",
    enabled: true,
    personId: "42",
    token: "tok-abc",
    tokenSource: "config",
    config: { personId: "42" },
    ...overrides,
  } as ResolvedBasecampAccount;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  clearClients();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// numId
// ---------------------------------------------------------------------------

describe("numId", () => {
  it("coerces string '42' to 42", () => {
    expect(numId("project", "42")).toBe(42);
  });

  it("passes through a number value", () => {
    expect(numId("project", 7)).toBe(7);
  });

  it("throws on NaN string", () => {
    expect(() => numId("project", "abc")).toThrow('Invalid project ID: "abc"');
  });

  it("throws on Infinity", () => {
    expect(() => numId("project", Infinity)).toThrow("Invalid project ID");
  });

  it("coerces empty string to 0 (Number('') === 0)", () => {
    expect(numId("project", "")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rawOrThrow
// ---------------------------------------------------------------------------

describe("rawOrThrow", () => {
  it("returns data on ok response", async () => {
    const result = {
      data: { id: 1, name: "test" },
      error: undefined,
      response: new Response(null, { status: 200 }),
    };
    await expect(rawOrThrow(result)).resolves.toEqual({ id: 1, name: "test" });
  });

  it("throws on non-ok response via errorFromResponse", async () => {
    const sdkError = new Error("Not Found");
    mockErrorFromResponse.mockResolvedValue(sdkError);

    const response = new Response(null, { status: 404 });
    const result = { data: undefined, error: undefined, response };

    await expect(rawOrThrow(result)).rejects.toBe(sdkError);
    expect(mockErrorFromResponse).toHaveBeenCalledWith(response, undefined);
  });

  it("throws when error field is truthy even if response.ok is true", async () => {
    const sdkError = new Error("validation error");
    mockErrorFromResponse.mockResolvedValue(sdkError);

    const response = new Response(null, { status: 200 });
    const result = { data: undefined, error: { message: "bad" }, response };

    await expect(rawOrThrow(result)).rejects.toBe(sdkError);
  });

  it("passes X-Request-Id to errorFromResponse", async () => {
    const sdkError = new Error("Server Error");
    mockErrorFromResponse.mockResolvedValue(sdkError);

    const headers = new Headers({ "X-Request-Id": "req-xyz-123" });
    const response = new Response(null, { status: 500, headers });
    const result = { data: undefined, error: undefined, response };

    await expect(rawOrThrow(result)).rejects.toBe(sdkError);
    expect(mockErrorFromResponse).toHaveBeenCalledWith(response, "req-xyz-123");
  });
});

// ---------------------------------------------------------------------------
// getClient + resolveNumericAccountId
// ---------------------------------------------------------------------------

describe("getClient", () => {
  it("creates client with basecampAccountId when set", () => {
    const account = makeAccount({
      config: { personId: "42", basecampAccountId: "777" },
    });
    getClient(account);

    expect(mockCreateBasecampClient).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "777" }),
    );
  });

  it("falls back to numeric accountId when no explicit IDs are set", () => {
    const account = makeAccount({
      accountId: "99999",
      config: { personId: "42" },
    });
    getClient(account);

    expect(mockCreateBasecampClient).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "99999" }),
    );
  });

  it("throws on non-numeric accountId with no explicit ID", () => {
    const account = makeAccount({
      accountId: "my-org",
      config: { personId: "42" },
    });

    expect(() => getClient(account)).toThrow(
      'Cannot resolve numeric Basecamp account ID for "my-org"',
    );
  });

  it("returns cached client on second call (same object, factory called once)", () => {
    const account = makeAccount({
      accountId: "cached-test",
      config: { personId: "42", basecampAccountId: "100" },
    });

    const first = getClient(account);
    const second = getClient(account);

    expect(first).toBe(second);
    expect(mockCreateBasecampClient).toHaveBeenCalledTimes(1);
  });

  it("clearClients breaks cache so next call creates a new client", () => {
    const account = makeAccount({
      accountId: "clear-test",
      config: { personId: "42", basecampAccountId: "200" },
    });

    const first = getClient(account);
    clearClients();
    const second = getClient(account);

    expect(first).not.toBe(second);
    expect(mockCreateBasecampClient).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// resolveTokenProvider (verified via accessToken arg to createBasecampClient)
// ---------------------------------------------------------------------------

describe("resolveTokenProvider", () => {
  it('tokenSource "config" passes token string directly', () => {
    const account = makeAccount({
      tokenSource: "config",
      token: "direct-token",
      config: { personId: "42", basecampAccountId: "1" },
    });
    getClient(account);

    expect(mockCreateBasecampClient).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "direct-token" }),
    );
  });

  it('tokenSource "tokenFile" with pre-loaded token passes string directly', () => {
    const account = makeAccount({
      accountId: "tf-preloaded",
      tokenSource: "tokenFile",
      token: "preloaded-file-token",
      config: { personId: "42", basecampAccountId: "2" },
    });
    getClient(account);

    expect(mockCreateBasecampClient).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "preloaded-file-token" }),
    );
  });

  it('tokenSource "tokenFile" without token passes lazy function that reads the file', async () => {
    mockReadFile.mockResolvedValue("  file-token-value  \n");

    const account = makeAccount({
      accountId: "tf-lazy",
      tokenSource: "tokenFile",
      token: "",
      config: { personId: "42", basecampAccountId: "3", tokenFile: "~/tokens/bc.txt" },
    });
    getClient(account);

    const call = mockCreateBasecampClient.mock.calls[0]![0];
    const lazyFn = call.accessToken as () => Promise<string>;
    const token = await lazyFn();

    expect(token).toBe("file-token-value");
    expect(mockReadFile).toHaveBeenCalledWith(
      expect.stringContaining("tokens/bc.txt"),
      "utf-8",
    );
    // ~ should be expanded, not present in the resolved path
    expect(mockReadFile.mock.calls[0][0]).not.toContain("~");
  });

  it("tokenFile lazy fn resolves bare ~ to homedir", async () => {
    mockReadFile.mockResolvedValue("bare-tilde-token");

    const account = makeAccount({
      accountId: "tf-tilde",
      tokenSource: "tokenFile",
      token: "",
      config: { personId: "42", basecampAccountId: "3a", tokenFile: "~" },
    });
    getClient(account);

    const lazyFn = mockCreateBasecampClient.mock.calls[0]![0].accessToken as () => Promise<string>;
    const token = await lazyFn();

    expect(token).toBe("bare-tilde-token");
    // Bare ~ resolves to homedir exactly
    const { homedir } = await import("node:os");
    expect(mockReadFile.mock.calls[0][0]).toBe(homedir());
  });

  it("tokenFile lazy fn resolves absolute paths directly", async () => {
    mockReadFile.mockResolvedValue("abs-token");

    const account = makeAccount({
      accountId: "tf-abs",
      tokenSource: "tokenFile",
      token: "",
      config: { personId: "42", basecampAccountId: "3b", tokenFile: "/etc/tokens/bc.txt" },
    });
    getClient(account);

    const lazyFn = mockCreateBasecampClient.mock.calls[0]![0].accessToken as () => Promise<string>;
    await lazyFn();

    expect(mockReadFile.mock.calls[0][0]).toBe("/etc/tokens/bc.txt");
  });

  it('tokenFile lazy fn throws when tokenFile missing in config', async () => {
    const account = makeAccount({
      accountId: "tf-no-file",
      tokenSource: "tokenFile",
      token: "",
      config: { personId: "42", basecampAccountId: "4" },
    });
    getClient(account);

    const call = mockCreateBasecampClient.mock.calls[0]![0];
    const lazyFn = call.accessToken as () => Promise<string>;
    await expect(lazyFn()).rejects.toThrow('No tokenFile configured for account "tf-no-file"');
  });

  it('tokenSource "oauth" passes an async function that triggers dynamic import', async () => {
    const account = makeAccount({
      accountId: "oauth-source",
      tokenSource: "oauth",
      config: { personId: "42", basecampAccountId: "6" },
    });
    getClient(account);

    const call = mockCreateBasecampClient.mock.calls[0]![0];
    const oauthFn = call.accessToken as () => Promise<string>;
    expect(typeof oauthFn).toBe("function");

    const token = await oauthFn();
    expect(token).toBe("oauth-token-abc");
  });

  it('tokenSource "none" throws', () => {
    const account = makeAccount({
      accountId: "none-source",
      tokenSource: "none",
      config: { personId: "42", basecampAccountId: "7" },
    });

    expect(() => getClient(account)).toThrow(
      'No authentication configured for account "none-source"',
    );
  });
});
