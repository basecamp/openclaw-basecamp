import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
}));

import {
  listBasecampAccountIds,
  resolveBasecampAccount,
  resolveProjectScope,
} from "../src/config.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

// ---------------------------------------------------------------------------
// resolveProjectScope
// ---------------------------------------------------------------------------

describe("resolveProjectScope", () => {
  it("returns accountId and bucketId for a virtual account", () => {
    const result = resolveProjectScope(
      cfg({
        virtualAccounts: {
          "design-project": { accountId: "primary", bucketId: "12345" },
        },
      }),
      "design-project",
    );

    expect(result).toEqual({ accountId: "primary", bucketId: "12345" });
  });

  it("returns undefined for non-existent scope", () => {
    const result = resolveProjectScope(cfg({}), "nonexistent");
    expect(result).toBeUndefined();
  });

  it("returns undefined when virtualAccounts is empty", () => {
    const result = resolveProjectScope(
      cfg({ virtualAccounts: {} }),
      "anything",
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listBasecampAccountIds — includes virtual accounts
// ---------------------------------------------------------------------------

describe("listBasecampAccountIds (with virtual accounts)", () => {
  it("includes virtual account keys alongside real account keys", () => {
    const result = listBasecampAccountIds(
      cfg({
        accounts: { primary: { personId: "1" } },
        virtualAccounts: {
          "design-project": { accountId: "primary", bucketId: "12345" },
        },
      }),
    );

    expect(result).toContain("primary");
    expect(result).toContain("design-project");
  });

  it("sorts all IDs alphabetically", () => {
    const result = listBasecampAccountIds(
      cfg({
        accounts: { zulu: { personId: "1" } },
        virtualAccounts: {
          alpha: { accountId: "zulu", bucketId: "1" },
        },
      }),
    );

    expect(result).toEqual(["alpha", "zulu"]);
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

  it("inherits token and bcqProfile from real account", () => {
    const result = resolveBasecampAccount(
      cfg({
        accounts: {
          primary: { personId: "42", bcqProfile: "prod" },
        },
        virtualAccounts: {
          scoped: { accountId: "primary", bucketId: "999" },
        },
      }),
      "scoped",
    );

    expect(result.bcqProfile).toBe("prod");
    expect(result.tokenSource).toBe("bcq");
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
  // This test verifies the resolveProjectScopeAccountId logic in dispatch.ts
  // by testing the config-level helpers that feed into it.

  it("resolveProjectScope matches by bucketId for routing", () => {
    const config = cfg({
      accounts: { primary: { personId: "1" } },
      virtualAccounts: {
        "design": { accountId: "primary", bucketId: "456" },
        "eng": { accountId: "primary", bucketId: "789" },
      },
    });

    expect(resolveProjectScope(config, "design")?.bucketId).toBe("456");
    expect(resolveProjectScope(config, "eng")?.bucketId).toBe("789");
    expect(resolveProjectScope(config, "marketing")).toBeUndefined();
  });
});
