import { describe, it, expect, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
}));

import { basecampSecurityAdapter } from "../src/adapters/security.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

// ---------------------------------------------------------------------------
// resolveDmPolicy
// ---------------------------------------------------------------------------

describe("security.resolveDmPolicy", () => {
  it("defaults to pairing when no dmPolicy is set", () => {
    const result = basecampSecurityAdapter.resolveDmPolicy({ cfg: cfg({}) });
    expect(result.policy).toBe("pairing");
  });

  it("returns configured dmPolicy", () => {
    const result = basecampSecurityAdapter.resolveDmPolicy({
      cfg: cfg({ dmPolicy: "open" }),
    });
    expect(result.policy).toBe("open");
  });

  it("uses channel-level path for default account", () => {
    const result = basecampSecurityAdapter.resolveDmPolicy({
      cfg: cfg({}),
      accountId: "default",
    });
    expect(result.policyPath).toBe("channels.basecamp.dmPolicy");
    expect(result.allowFromPath).toBe("channels.basecamp.");
  });

  it("uses account-level path for named account", () => {
    const result = basecampSecurityAdapter.resolveDmPolicy({
      cfg: cfg({}),
      accountId: "work",
    });
    expect(result.policyPath).toBe("channels.basecamp.accounts.work.dmPolicy");
    expect(result.allowFromPath).toBe("channels.basecamp.accounts.work.");
  });

  it("returns allowFrom entries", () => {
    const result = basecampSecurityAdapter.resolveDmPolicy({
      cfg: cfg({ allowFrom: [42, "99"] }),
    });
    expect(result.allowFrom).toEqual([42, "99"]);
  });
});

// ---------------------------------------------------------------------------
// collectWarnings
// ---------------------------------------------------------------------------

describe("security.collectWarnings", () => {
  it("returns empty for missing config", async () => {
    const warnings = await basecampSecurityAdapter.collectWarnings({ cfg: {} as any });
    expect(warnings).toEqual([]);
  });

  it("returns empty for healthy config", async () => {
    const warnings = await basecampSecurityAdapter.collectWarnings({
      cfg: cfg({
        dmPolicy: "pairing",
        allowFrom: [42],
        accounts: {
          main: { personId: "42", bcqProfile: "default" },
        },
      }),
    });
    expect(warnings).toEqual([]);
  });

  it("warns on open dmPolicy with no allowFrom", async () => {
    const warnings = await basecampSecurityAdapter.collectWarnings({
      cfg: cfg({ dmPolicy: "open" }),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("open");
    expect(warnings[0]).toContain("allowFrom");
  });

  it("does not warn on open dmPolicy when allowFrom has entries", async () => {
    const warnings = await basecampSecurityAdapter.collectWarnings({
      cfg: cfg({ dmPolicy: "open", allowFrom: [42] }),
    });
    expect(warnings).toEqual([]);
  });

  it("warns on persona referencing non-existent account", async () => {
    const warnings = await basecampSecurityAdapter.collectWarnings({
      cfg: cfg({
        accounts: { main: { personId: "42", bcqProfile: "default" } },
        personas: { "agent-1": "missing" },
      }),
    });
    expect(warnings).toContainEqual(
      expect.stringContaining("agent-1"),
    );
    expect(warnings).toContainEqual(
      expect.stringContaining("missing"),
    );
  });

  it("does not warn on persona referencing existing account", async () => {
    const warnings = await basecampSecurityAdapter.collectWarnings({
      cfg: cfg({
        accounts: { main: { personId: "42", bcqProfile: "default" } },
        personas: { "agent-1": "main" },
      }),
    });
    const personaWarnings = warnings.filter((w) => w.includes("Persona"));
    expect(personaWarnings).toHaveLength(0);
  });

  it("warns on virtual account referencing non-existent backing account", async () => {
    const warnings = await basecampSecurityAdapter.collectWarnings({
      cfg: cfg({
        accounts: { main: { personId: "42", bcqProfile: "default" } },
        virtualAccounts: { "project-x": { accountId: "ghost", bucketId: "123" } },
      }),
    });
    expect(warnings).toContainEqual(
      expect.stringContaining("project-x"),
    );
    expect(warnings).toContainEqual(
      expect.stringContaining("ghost"),
    );
  });

  it("warns on duplicate personId across accounts", async () => {
    const warnings = await basecampSecurityAdapter.collectWarnings({
      cfg: cfg({
        accounts: {
          alpha: { personId: "42", bcqProfile: "default" },
          beta: { personId: "42", token: "tok" },
        },
      }),
    });
    expect(warnings).toContainEqual(
      expect.stringContaining("Person ID 42"),
    );
    expect(warnings).toContainEqual(
      expect.stringContaining("alpha"),
    );
    expect(warnings).toContainEqual(
      expect.stringContaining("beta"),
    );
  });

  it("warns on account with no auth configured", async () => {
    const warnings = await basecampSecurityAdapter.collectWarnings({
      cfg: cfg({
        accounts: {
          broken: { personId: "42" },
        },
      }),
    });
    expect(warnings).toContainEqual(
      expect.stringContaining("broken"),
    );
    expect(warnings).toContainEqual(
      expect.stringContaining("no token"),
    );
  });

  it("does not warn on account with bcqProfile", async () => {
    const warnings = await basecampSecurityAdapter.collectWarnings({
      cfg: cfg({
        accounts: {
          good: { personId: "42", bcqProfile: "default" },
        },
      }),
    });
    const authWarnings = warnings.filter((w) => w.includes("no token"));
    expect(authWarnings).toHaveLength(0);
  });

  it("warns on non-numeric allowFrom entries", async () => {
    const warnings = await basecampSecurityAdapter.collectWarnings({
      cfg: cfg({
        allowFrom: [42, "not-a-number", "99"],
      }),
    });
    expect(warnings).toContainEqual(
      expect.stringContaining("not-a-number"),
    );
    // Only one bad entry
    const formatWarnings = warnings.filter((w) => w.includes("does not look like"));
    expect(formatWarnings).toHaveLength(1);
  });

  it("detects multiple warning types simultaneously", async () => {
    const warnings = await basecampSecurityAdapter.collectWarnings({
      cfg: cfg({
        dmPolicy: "open",
        accounts: {
          main: { personId: "42" },
        },
        personas: { "agent-1": "ghost" },
        allowFrom: ["abc"],
      }),
    });
    // Should have: no-auth on main, bad persona, bad allowFrom
    // (open+allowFrom present = no open-policy warning)
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
});
