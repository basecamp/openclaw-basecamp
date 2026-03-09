import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
}));

import { listBasecampAccountIds, resolveBasecampAccount } from "../src/config.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

// ---------------------------------------------------------------------------
// listBasecampAccountIds — includes virtual accounts
// ---------------------------------------------------------------------------

describe("listBasecampAccountIds (with virtual accounts)", () => {
  it("excludes virtual account keys (they are routing aliases, not workers)", () => {
    const result = listBasecampAccountIds(
      cfg({
        accounts: { primary: { personId: "1" } },
        virtualAccounts: {
          "design-project": { accountId: "primary", bucketId: "12345" },
        },
      }),
    );

    expect(result).toContain("primary");
    expect(result).not.toContain("design-project");
  });

  it("returns only concrete account IDs sorted alphabetically", () => {
    const result = listBasecampAccountIds(
      cfg({
        accounts: { zulu: { personId: "1" } },
        virtualAccounts: {
          alpha: { accountId: "zulu", bucketId: "1" },
        },
      }),
    );

    expect(result).toEqual(["zulu"]);
  });
});

// ---------------------------------------------------------------------------
// resolveBasecampAccount — virtual accounts
// ---------------------------------------------------------------------------

describe("resolveBasecampAccount (virtual accounts)", () => {
  it("resolves virtual account to real account with scopedBucketId", () => {
    const result = resolveBasecampAccount(
      cfg({
        accounts: {
          primary: { personId: "42", token: "tok" },
        },
        virtualAccounts: {
          "design-project": { accountId: "primary", bucketId: "12345" },
        },
      }),
      "design-project",
    );

    expect(result.accountId).toBe("design-project");
    expect(result.personId).toBe("42");
    expect(result.token).toBe("tok");
    expect(result.scopedBucketId).toBe("12345");
  });

  it("inherits token and cliProfile from real account", () => {
    const result = resolveBasecampAccount(
      cfg({
        accounts: {
          primary: { personId: "42", token: "tok", cliProfile: "prod" },
        },
        virtualAccounts: {
          scoped: { accountId: "primary", bucketId: "999" },
        },
      }),
      "scoped",
    );

    expect(result.cliProfile).toBe("prod");
    expect(result.tokenSource).toBe("config");
  });

  it("returns disabled stub when backing account missing", () => {
    const result = resolveBasecampAccount(
      cfg({
        virtualAccounts: {
          scoped: { accountId: "missing", bucketId: "123" },
        },
      }),
      "scoped",
    );

    // The backing account doesn't exist, so we get a disabled stub
    expect(result.accountId).toBe("scoped");
    expect(result.enabled).toBe(false);
    expect(result.scopedBucketId).toBe("123");
  });
});

// ---------------------------------------------------------------------------
// Dispatch project-scope routing
// ---------------------------------------------------------------------------

describe("dispatch project-scope routing", () => {
  it("resolveBasecampAccount resolves virtual accounts by key for routing", () => {
    const config = cfg({
      accounts: { primary: { personId: "1", token: "tok" } },
      virtualAccounts: {
        design: { accountId: "primary", bucketId: "456" },
        eng: { accountId: "primary", bucketId: "789" },
      },
    });

    expect(resolveBasecampAccount(config, "design").scopedBucketId).toBe("456");
    expect(resolveBasecampAccount(config, "eng").scopedBucketId).toBe("789");
    expect(resolveBasecampAccount(config, "marketing").scopedBucketId).toBeUndefined();
  });
});
