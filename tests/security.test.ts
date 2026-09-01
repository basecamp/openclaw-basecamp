/**
 * Tests: basecampSecurityAdapter (SPEC §2.10, §2.23)
 *
 * DM policy resolution via the SDK scoped resolver (per-account overrides,
 * config paths) and structured SecurityAuditFinding[] collection.
 */
import { describe, expect, it } from "vitest";

import { basecampSecurityAdapter } from "../src/adapters/security.js";
import { resolveBasecampAccount } from "../src/config.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

function dmPolicyFor(config: any, accountId?: string) {
  return basecampSecurityAdapter.resolveDmPolicy!({
    cfg: config,
    accountId,
    account: resolveBasecampAccount(config, accountId),
  })!;
}

// ---------------------------------------------------------------------------
// resolveDmPolicy
// ---------------------------------------------------------------------------

describe("security.resolveDmPolicy", () => {
  it("defaults to allowlist when no dmPolicy is set", () => {
    expect(dmPolicyFor(cfg({})).policy).toBe("allowlist");
  });

  it("returns configured channel-level dmPolicy", () => {
    expect(dmPolicyFor(cfg({ dmPolicy: "open" })).policy).toBe("open");
  });

  it("per-account dmPolicy overrides channel-level policy", () => {
    const config = cfg({
      dmPolicy: "open",
      accounts: { work: { personId: "1", token: "t", dmPolicy: "disabled" } },
    });
    expect(dmPolicyFor(config, "work").policy).toBe("disabled");
  });

  it("named account without overrides inherits channel-level policy", () => {
    const config = cfg({
      dmPolicy: "disabled",
      accounts: { work: { personId: "1", token: "t" } },
    });
    expect(dmPolicyFor(config, "work").policy).toBe("disabled");
  });

  it("uses channel-level paths when policy lives at the channel root", () => {
    const result = dmPolicyFor(cfg({ dmPolicy: "open", allowFrom: ["*"] }), "default");
    expect(result.policyPath).toBe("channels.basecamp.dmPolicy");
    expect(result.allowFromPath).toBe("channels.basecamp.allowFrom");
  });

  it("uses per-account paths when the account declares its own policy", () => {
    const config = cfg({
      accounts: { work: { personId: "1", token: "t", dmPolicy: "allowlist", allowFrom: ["7"] } },
    });
    const result = dmPolicyFor(config, "work");
    expect(result.policyPath).toBe("channels.basecamp.accounts.work.dmPolicy");
    expect(result.allowFromPath).toBe("channels.basecamp.accounts.work.allowFrom");
  });

  it("returns channel-level allowFrom entries", () => {
    const result = dmPolicyFor(cfg({ allowFrom: [42, "99"] }));
    expect(result.allowFrom.map(String)).toEqual(["42", "99"]);
  });

  it("per-account allowFrom overrides channel-level entries", () => {
    const config = cfg({
      allowFrom: ["1"],
      accounts: { work: { personId: "1", token: "t", allowFrom: ["7", "8"] } },
    });
    expect(dmPolicyFor(config, "work").allowFrom.map(String)).toEqual(["7", "8"]);
  });

  it("provides an approve hint naming the allowFrom config", () => {
    expect(dmPolicyFor(cfg({})).approveHint).toContain("allowFrom");
  });
});

// ---------------------------------------------------------------------------
// collectWarnings — structured findings
// ---------------------------------------------------------------------------

const stubAccount = { accountId: "test", personId: "42" } as any;

async function collect(config: any) {
  return (await basecampSecurityAdapter.collectWarnings!({
    cfg: config,
    account: stubAccount,
  })) as Array<{ checkId: string; severity: string; title: string; detail: string }>;
}

describe("security.collectWarnings", () => {
  it("returns empty for missing config", async () => {
    expect(await collect({} as any)).toEqual([]);
  });

  it("returns empty for healthy config", async () => {
    const findings = await collect(
      cfg({
        dmPolicy: "pairing",
        allowFrom: [42],
        accounts: {
          main: { personId: "42", token: "tok" },
        },
      }),
    );
    expect(findings).toEqual([]);
  });

  it("emits a critical finding for open dmPolicy with no allowFrom", async () => {
    const findings = await collect(cfg({ dmPolicy: "open" }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: "basecamp.dm.open-without-allowfrom",
      severity: "critical",
    });
    expect(findings[0]!.detail).toContain("open");
    expect(findings[0]!.detail).toContain("allowFrom");
  });

  it("does not flag open dmPolicy when allowFrom has entries", async () => {
    expect(await collect(cfg({ dmPolicy: "open", allowFrom: [42] }))).toEqual([]);
  });

  it("flags persona referencing non-existent account", async () => {
    const findings = await collect(
      cfg({
        accounts: { main: { personId: "42", token: "tok" } },
        personas: { "agent-1": "missing" },
      }),
    );
    const personaFindings = findings.filter((f) => f.checkId === "basecamp.personas.dangling");
    expect(personaFindings).toHaveLength(1);
    expect(personaFindings[0]!.detail).toContain("agent-1");
    expect(personaFindings[0]!.detail).toContain("missing");
  });

  it("does not flag persona referencing existing account", async () => {
    const findings = await collect(
      cfg({
        accounts: { main: { personId: "42", token: "tok" } },
        personas: { "agent-1": "main" },
      }),
    );
    expect(findings.filter((f) => f.checkId === "basecamp.personas.dangling")).toEqual([]);
  });

  it("flags virtual account referencing non-existent backing account", async () => {
    const findings = await collect(
      cfg({
        accounts: { main: { personId: "42", token: "tok" } },
        virtualAccounts: { scope1: { accountId: "ghost", bucketId: "123" } },
      }),
    );
    const vaFindings = findings.filter((f) => f.checkId === "basecamp.virtual-accounts.dangling");
    expect(vaFindings).toHaveLength(1);
    expect(vaFindings[0]!.detail).toContain("scope1");
    expect(vaFindings[0]!.detail).toContain("ghost");
  });

  it("flags duplicate personId across accounts", async () => {
    const findings = await collect(
      cfg({
        accounts: {
          a: { personId: "42", token: "t1" },
          b: { personId: "42", token: "t2" },
        },
      }),
    );
    const dupFindings = findings.filter((f) => f.checkId === "basecamp.accounts.duplicate-person-id");
    expect(dupFindings).toHaveLength(1);
    expect(dupFindings[0]!.detail).toContain("42");
    expect(dupFindings[0]!.detail).toContain("a");
    expect(dupFindings[0]!.detail).toContain("b");
  });

  it("flags account with no auth configured", async () => {
    const findings = await collect(
      cfg({
        accounts: { broken: { personId: "42" } },
      }),
    );
    const authFindings = findings.filter((f) => f.checkId === "basecamp.accounts.no-auth");
    expect(authFindings).toHaveLength(1);
    expect(authFindings[0]!.detail).toContain("broken");
  });

  it("flags account with only cliProfile (no runtime auth)", async () => {
    const findings = await collect(
      cfg({
        accounts: { dev: { personId: "42", cliProfile: "dev" } },
      }),
    );
    expect(findings.filter((f) => f.checkId === "basecamp.accounts.no-auth")).toHaveLength(1);
  });

  it("flags non-numeric allowFrom entries", async () => {
    const findings = await collect(cfg({ allowFrom: ["42", "not-a-number"] }));
    const formatFindings = findings.filter((f) => f.checkId === "basecamp.allowfrom.non-numeric");
    expect(formatFindings).toHaveLength(1);
    expect(formatFindings[0]!.detail).toContain("not-a-number");
    expect(formatFindings[0]!.severity).toBe("info");
  });

  it("does not flag the wildcard allowFrom entry", async () => {
    const findings = await collect(cfg({ dmPolicy: "open", allowFrom: ["*"] }));
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectAuditFindings
// ---------------------------------------------------------------------------

describe("security.collectAuditFindings", () => {
  it("returns the same structured findings as collectWarnings", async () => {
    const config = cfg({
      accounts: { main: { personId: "42", token: "tok" } },
      personas: { "agent-1": "missing" },
    });
    const findings = await basecampSecurityAdapter.collectAuditFindings!({
      cfg: config,
      account: stubAccount,
      sourceConfig: config,
      orderedAccountIds: ["main"],
      hasExplicitAccountPath: true,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: "basecamp.personas.dangling",
      severity: "warn",
      title: expect.any(String),
    });
  });
});
