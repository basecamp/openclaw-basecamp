import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
}));

import { scopeWebhookProjects } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

// ---------------------------------------------------------------------------
// scopeWebhookProjects — startup-time webhook project scoping
// ---------------------------------------------------------------------------

describe("scopeWebhookProjects", () => {
  it("includes mapped project when owner matches accountId", () => {
    const config = cfg({
      accounts: { "acct-a": { personId: "1" }, "acct-b": { personId: "2" } },
      virtualAccounts: {
        "scope-a": { accountId: "acct-a", bucketId: "100" },
      },
    });

    const result = scopeWebhookProjects({
      cfg: config,
      projects: ["100"],
      accountId: "acct-a",
    });

    expect(result).toEqual(["100"]);
  });

  it("excludes mapped project when owner does not match accountId", () => {
    const config = cfg({
      accounts: { "acct-a": { personId: "1" }, "acct-b": { personId: "2" } },
      virtualAccounts: {
        "scope-b": { accountId: "acct-b", bucketId: "100" },
      },
    });

    const result = scopeWebhookProjects({
      cfg: config,
      projects: ["100"],
      accountId: "acct-a",
    });

    expect(result).toEqual([]);
  });

  it("skips unmapped project in multi-account mode and warns", () => {
    const config = cfg({
      accounts: { "acct-a": { personId: "1" }, "acct-b": { personId: "2" } },
    });
    const log = { warn: vi.fn() };

    const result = scopeWebhookProjects({
      cfg: config,
      projects: ["999"],
      accountId: "acct-a",
      log,
    });

    expect(result).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain("skipping unmapped webhook project 999");
  });

  it("allows unmapped project in single-account mode", () => {
    const config = cfg({
      accounts: { default: { personId: "1" } },
    });

    const result = scopeWebhookProjects({
      cfg: config,
      projects: ["999"],
      accountId: "default",
    });

    expect(result).toEqual(["999"]);
  });

  it("filters mixed mapped/unmapped projects correctly in multi-account mode", () => {
    const config = cfg({
      accounts: { "acct-a": { personId: "1" }, "acct-b": { personId: "2" } },
      virtualAccounts: {
        "scope-a": { accountId: "acct-a", bucketId: "100" },
        "scope-b": { accountId: "acct-b", bucketId: "200" },
      },
    });

    const result = scopeWebhookProjects({
      cfg: config,
      projects: ["100", "200", "300"],
      accountId: "acct-a",
    });

    // 100 → acct-a (match), 200 → acct-b (no match), 300 → unmapped (multi-account: skip)
    expect(result).toEqual(["100"]);
  });
});
