import { describe, it, expect, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
}));

import {
  listBasecampAccountIds,
  resolveDefaultBasecampAccountId,
  resolveBasecampAccount,
  resolveBasecampAccountAsync,
  resolvePersonaAccountId,
  resolvePollingIntervals,
  resolveBasecampDmPolicy,
  resolveBasecampAllowFrom,
  resolveBasecampBucketAllowFrom,
  resolveAccountForBucket,
} from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand to build a minimal OpenClawConfig-shaped object. */
function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

function cfgWithAccounts(accounts: Record<string, Record<string, unknown>>) {
  return cfg({ accounts });
}

// ---------------------------------------------------------------------------
// listBasecampAccountIds
// ---------------------------------------------------------------------------

describe("listBasecampAccountIds", () => {
  it("returns ['default'] when config is empty", () => {
    expect(listBasecampAccountIds({} as any)).toEqual(["default"]);
  });

  it("returns ['default'] when channels.basecamp exists but has no accounts", () => {
    expect(listBasecampAccountIds(cfg({}))).toEqual(["default"]);
  });

  it("returns ['default'] when accounts is an empty object", () => {
    expect(listBasecampAccountIds(cfgWithAccounts({}))).toEqual(["default"]);
  });

  it("returns the single configured account ID", () => {
    const result = listBasecampAccountIds(
      cfgWithAccounts({ myaccount: { personId: "1" } }),
    );
    expect(result).toEqual(["myaccount"]);
  });

  it("returns multiple account IDs sorted alphabetically", () => {
    const result = listBasecampAccountIds(
      cfgWithAccounts({
        zulu: { personId: "1" },
        alpha: { personId: "2" },
        mike: { personId: "3" },
      }),
    );
    expect(result).toEqual(["alpha", "mike", "zulu"]);
  });

  it("normalizes numeric-like account IDs to strings", () => {
    // normalizeAccountId converts keys to strings; numeric keys in JS objects
    // are already strings, but this ensures the pipeline handles them.
    const result = listBasecampAccountIds(
      cfgWithAccounts({ 123: { personId: "1" } } as any),
    );
    expect(result).toEqual(["123"]);
    expect(typeof result[0]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultBasecampAccountId
// ---------------------------------------------------------------------------

describe("resolveDefaultBasecampAccountId", () => {
  it("returns 'default' when no accounts are configured", () => {
    expect(resolveDefaultBasecampAccountId({} as any)).toBe("default");
  });

  it("returns the only configured account when there is one", () => {
    expect(
      resolveDefaultBasecampAccountId(
        cfgWithAccounts({ solo: { personId: "1" } }),
      ),
    ).toBe("solo");
  });

  it("returns 'default' when it is among multiple accounts", () => {
    expect(
      resolveDefaultBasecampAccountId(
        cfgWithAccounts({
          other: { personId: "1" },
          default: { personId: "2" },
        }),
      ),
    ).toBe("default");
  });

  it("returns the first sorted account when 'default' is absent", () => {
    expect(
      resolveDefaultBasecampAccountId(
        cfgWithAccounts({
          bravo: { personId: "1" },
          alpha: { personId: "2" },
        }),
      ),
    ).toBe("alpha");
  });
});

// ---------------------------------------------------------------------------
// resolveBasecampAccount
// ---------------------------------------------------------------------------

describe("resolveBasecampAccount", () => {
  it("returns a disabled stub when the account is missing", () => {
    const result = resolveBasecampAccount({} as any, "nonexistent");
    expect(result.accountId).toBe("nonexistent");
    expect(result.enabled).toBe(false);
    expect(result.personId).toBe("");
    expect(result.token).toBe("");
    expect(result.tokenSource).toBe("none");
  });

  it("defaults to 'default' account when no accountId is provided", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({ default: { personId: "42", token: "tok" } }),
    );
    expect(result.accountId).toBe("default");
    expect(result.personId).toBe("42");
    expect(result.token).toBe("tok");
    expect(result.tokenSource).toBe("config");
  });

  it("defaults to 'default' account when accountId is null", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({ default: { personId: "42", token: "tok" } }),
      null,
    );
    expect(result.accountId).toBe("default");
    expect(result.token).toBe("tok");
  });

  it("resolves an account with an inline token", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({ prod: { personId: "10", token: "secret123" } }),
      "prod",
    );
    expect(result.accountId).toBe("prod");
    expect(result.enabled).toBe(true);
    expect(result.personId).toBe("10");
    expect(result.token).toBe("secret123");
    expect(result.tokenSource).toBe("config");
  });

  it("trims whitespace from inline token", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({ prod: { personId: "10", token: "  tok  " } }),
      "prod",
    );
    expect(result.token).toBe("tok");
  });

  it("marks tokenSource as 'tokenFile' when only tokenFile is set (token deferred)", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({
        prod: { personId: "10", tokenFile: "~/.secrets/bc-token" },
      }),
      "prod",
    );
    expect(result.token).toBe("");
    expect(result.tokenSource).toBe("tokenFile");
  });

  it("prefers inline token over tokenFile", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({
        prod: {
          personId: "10",
          token: "inline",
          tokenFile: "~/.secrets/bc-token",
        },
      }),
      "prod",
    );
    expect(result.token).toBe("inline");
    expect(result.tokenSource).toBe("config");
  });

  it("threads through bcqProfile field", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({
        dev: {
          personId: "1",
          bcqProfile: "my-dev-profile",
        },
      }),
      "dev",
    );
    expect(result.bcqProfile).toBe("my-dev-profile");
    expect(result.tokenSource).toBe("bcq");
  });

  it("bcqProfile account has empty token (bcq handles auth)", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({
        dev: {
          personId: "1",
          bcqProfile: "my-dev-profile",
        },
      }),
      "dev",
    );
    expect(result.token).toBe("");
    expect(result.tokenSource).toBe("bcq");
  });

  it("explicit token takes precedence over bcqProfile", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({
        dev: {
          personId: "1",
          token: "t",
          bcqProfile: "my-dev-profile",
        },
      }),
      "dev",
    );
    expect(result.token).toBe("t");
    expect(result.tokenSource).toBe("config");
    expect(result.bcqProfile).toBe("my-dev-profile");
  });

  it("returns undefined bcqProfile when not configured", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({
        default: { personId: "1", token: "t" },
      }),
    );
    expect(result.bcqProfile).toBeUndefined();
  });

  it("tokenFile takes precedence over bcqProfile for tokenSource", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({
        prod: {
          personId: "1",
          tokenFile: "~/.secrets/token",
          bcqProfile: "prod-profile",
        },
      }),
      "prod",
    );
    expect(result.tokenSource).toBe("tokenFile");
    expect(result.bcqProfile).toBe("prod-profile");
  });

  it("threads through bcqAccountId in config", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({
        dev: {
          personId: "1",
          token: "t",
          bcqAccountId: "12345",
        },
      }),
      "dev",
    );
    expect(result.config.bcqAccountId).toBe("12345");
  });

  it("returns undefined bcqAccountId when not configured", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({
        default: { personId: "1", token: "t" },
      }),
    );
    expect(result.config.bcqAccountId).toBeUndefined();
  });

  it("resolves displayName from config", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({
        default: { personId: "1", token: "t", displayName: "Bot" },
      }),
    );
    expect(result.displayName).toBe("Bot");
  });

  it("resolves attachableSgid from config", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({
        default: { personId: "1", token: "t", attachableSgid: "sgid://x" },
      }),
    );
    expect(result.attachableSgid).toBe("sgid://x");
  });

  it("resolves personId from config", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({ default: { personId: "999", token: "t" } }),
    );
    expect(result.personId).toBe("999");
  });

  it("treats enabled: false in config as disabled", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({
        default: { personId: "1", token: "t", enabled: false },
      }),
    );
    expect(result.enabled).toBe(false);
  });

  it("treats enabled: true in config as enabled", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({
        default: { personId: "1", token: "t", enabled: true },
      }),
    );
    expect(result.enabled).toBe(true);
  });

  it("defaults enabled to true when not specified", () => {
    const result = resolveBasecampAccount(
      cfgWithAccounts({ default: { personId: "1", token: "t" } }),
    );
    expect(result.enabled).toBe(true);
  });

  it("includes the raw account config in the config field", () => {
    const accountCfg = { personId: "1", token: "t", displayName: "X" };
    const result = resolveBasecampAccount(
      cfgWithAccounts({ default: accountCfg }),
    );
    expect(result.config).toEqual(accountCfg);
  });
});

// ---------------------------------------------------------------------------
// resolveBasecampAccountAsync
// ---------------------------------------------------------------------------

describe("resolveBasecampAccountAsync", () => {
  it("returns same result as sync for inline token", async () => {
    const config = cfgWithAccounts({
      default: { personId: "1", token: "tok" },
    });
    const sync = resolveBasecampAccount(config);
    const async_ = await resolveBasecampAccountAsync(config);
    expect(async_.token).toBe(sync.token);
    expect(async_.tokenSource).toBe(sync.tokenSource);
  });

  it("falls back to tokenSource 'none' when tokenFile is unreadable", async () => {
    const result = await resolveBasecampAccountAsync(
      cfgWithAccounts({
        default: {
          personId: "1",
          tokenFile: "/nonexistent/path/to/token",
        },
      }),
    );
    expect(result.token).toBe("");
    expect(result.tokenSource).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// resolvePersonaAccountId
// ---------------------------------------------------------------------------

describe("resolvePersonaAccountId", () => {
  it("returns the mapped account ID for a known agent", () => {
    const result = resolvePersonaAccountId(
      cfg({ personas: { "agent-alpha": "account-one" } }),
      "agent-alpha",
    );
    expect(result).toBe("account-one");
  });

  it("returns undefined for an unmapped agent", () => {
    const result = resolvePersonaAccountId(
      cfg({ personas: { "agent-alpha": "account-one" } }),
      "agent-beta",
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when no personas section exists", () => {
    const result = resolvePersonaAccountId(cfg({}), "agent-alpha");
    expect(result).toBeUndefined();
  });

  it("returns undefined when config is empty", () => {
    const result = resolvePersonaAccountId({} as any, "agent-alpha");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolvePollingIntervals
// ---------------------------------------------------------------------------

describe("resolvePollingIntervals", () => {
  it("returns defaults when config is empty", () => {
    const result = resolvePollingIntervals({});
    expect(result).toEqual({
      activityIntervalMs: 120_000,
      readingsIntervalMs: 60_000,
      assignmentsIntervalMs: 300_000,
    });
  });

  it("returns defaults when polling section is absent", () => {
    const result = resolvePollingIntervals(cfg({}));
    expect(result).toEqual({
      activityIntervalMs: 120_000,
      readingsIntervalMs: 60_000,
      assignmentsIntervalMs: 300_000,
    });
  });

  it("overrides activityIntervalMs", () => {
    const result = resolvePollingIntervals(
      cfg({ polling: { activityIntervalMs: 30_000 } }),
    );
    expect(result.activityIntervalMs).toBe(30_000);
    expect(result.readingsIntervalMs).toBe(60_000);
    expect(result.assignmentsIntervalMs).toBe(300_000);
  });

  it("overrides readingsIntervalMs", () => {
    const result = resolvePollingIntervals(
      cfg({ polling: { readingsIntervalMs: 10_000 } }),
    );
    expect(result.readingsIntervalMs).toBe(10_000);
  });

  it("overrides all intervals at once", () => {
    const result = resolvePollingIntervals(
      cfg({
        polling: {
          activityIntervalMs: 1000,
          readingsIntervalMs: 2000,
          assignmentsIntervalMs: 4000,
        },
      }),
    );
    expect(result).toEqual({
      activityIntervalMs: 1000,
      readingsIntervalMs: 2000,
      assignmentsIntervalMs: 4000,
    });
  });
});

// ---------------------------------------------------------------------------
// resolveBasecampDmPolicy
// ---------------------------------------------------------------------------

describe("resolveBasecampDmPolicy", () => {
  it("defaults to 'pairing' when config is empty", () => {
    expect(resolveBasecampDmPolicy({} as any)).toBe("pairing");
  });

  it("defaults to 'pairing' when dmPolicy is not set", () => {
    expect(resolveBasecampDmPolicy(cfg({}))).toBe("pairing");
  });

  it("returns 'disabled' when configured", () => {
    expect(resolveBasecampDmPolicy(cfg({ dmPolicy: "disabled" }))).toBe("disabled");
  });

  it("returns 'pairing' when configured", () => {
    expect(resolveBasecampDmPolicy(cfg({ dmPolicy: "pairing" }))).toBe(
      "pairing",
    );
  });

  it("returns 'open' when explicitly configured", () => {
    expect(resolveBasecampDmPolicy(cfg({ dmPolicy: "open" }))).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// resolveBasecampAllowFrom
// ---------------------------------------------------------------------------

describe("resolveBasecampAllowFrom", () => {
  it("returns an empty array when config is empty", () => {
    expect(resolveBasecampAllowFrom({} as any)).toEqual([]);
  });

  it("returns an empty array when allowFrom is not set", () => {
    expect(resolveBasecampAllowFrom(cfg({}))).toEqual([]);
  });

  it("returns string entries as-is", () => {
    expect(
      resolveBasecampAllowFrom(cfg({ allowFrom: ["100", "200"] })),
    ).toEqual(["100", "200"]);
  });

  it("coerces numeric entries to strings", () => {
    expect(
      resolveBasecampAllowFrom(cfg({ allowFrom: [100, 200] })),
    ).toEqual(["100", "200"]);
  });

  it("handles mixed string and number entries", () => {
    expect(
      resolveBasecampAllowFrom(cfg({ allowFrom: ["abc", 42, "def"] })),
    ).toEqual(["abc", "42", "def"]);
  });
});

// ---------------------------------------------------------------------------
// resolveBasecampBucketAllowFrom
// ---------------------------------------------------------------------------

describe("resolveBasecampBucketAllowFrom", () => {
  it("returns undefined when no buckets configured", () => {
    expect(resolveBasecampBucketAllowFrom(cfg({}), "456")).toBeUndefined();
  });

  it("returns string array from exact bucket match", () => {
    expect(
      resolveBasecampBucketAllowFrom(
        cfg({ buckets: { "456": { allowFrom: ["100", "200"] } } }),
        "456",
      ),
    ).toEqual(["100", "200"]);
  });

  it("falls back to wildcard", () => {
    expect(
      resolveBasecampBucketAllowFrom(
        cfg({ buckets: { "*": { allowFrom: ["111"] } } }),
        "456",
      ),
    ).toEqual(["111"]);
  });

  it("coerces numbers to strings", () => {
    expect(
      resolveBasecampBucketAllowFrom(
        cfg({ buckets: { "456": { allowFrom: [100, 200] } } }),
        "456",
      ),
    ).toEqual(["100", "200"]);
  });

  it("exact match takes precedence over wildcard", () => {
    expect(
      resolveBasecampBucketAllowFrom(
        cfg({
          buckets: {
            "456": { allowFrom: ["777"] },
            "*": { allowFrom: ["111"] },
          },
        }),
        "456",
      ),
    ).toEqual(["777"]);
  });
});

// ---------------------------------------------------------------------------
// resolveAccountForBucket
// ---------------------------------------------------------------------------

describe("resolveAccountForBucket", () => {
  it("returns concrete account ID (not alias key) for mapped bucket", () => {
    const config = cfg({
      accounts: { "acct-123": { personId: "1" } },
      virtualAccounts: {
        "project-x": { accountId: "acct-123", bucketId: "456" },
      },
    });
    // Should return the concrete account "acct-123", not the alias "project-x"
    expect(resolveAccountForBucket(config, "456")).toBe("acct-123");
  });

  it("returns undefined for unmapped bucket", () => {
    const config = cfg({
      accounts: { "acct-123": { personId: "1" } },
      virtualAccounts: {
        "project-x": { accountId: "acct-123", bucketId: "456" },
      },
    });
    expect(resolveAccountForBucket(config, "999")).toBeUndefined();
  });

  it("returns undefined when no virtualAccounts configured", () => {
    const config = cfg({ accounts: { "default": { personId: "1" } } });
    expect(resolveAccountForBucket(config, "456")).toBeUndefined();
  });

  it("returns undefined for empty config", () => {
    expect(resolveAccountForBucket(cfg(), "456")).toBeUndefined();
  });

  it("resolves first matching virtualAccount when multiple exist", () => {
    const config = cfg({
      accounts: { "a1": { personId: "1" }, "a2": { personId: "2" } },
      virtualAccounts: {
        "proj-a": { accountId: "a1", bucketId: "100" },
        "proj-b": { accountId: "a2", bucketId: "200" },
      },
    });
    expect(resolveAccountForBucket(config, "100")).toBe("a1");
    expect(resolveAccountForBucket(config, "200")).toBe("a2");
  });
});
