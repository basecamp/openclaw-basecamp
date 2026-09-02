/**
 * Tests: basecampDoctorAdapter + doctor-contract-api sidecar (SPEC §2.23)
 */
import { describe, expect, it } from "vitest";

import { basecampDoctorAdapter, repairBasecampConfig } from "../src/adapters/doctor.js";
import { legacyConfigRules, normalizeCompatibilityConfig } from "../src/doctor-contract-api.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

describe("basecampDoctorAdapter", () => {
  it("declares topOnly DM fields and route group model", () => {
    expect(basecampDoctorAdapter.dmAllowFromMode).toBe("topOnly");
    expect(basecampDoctorAdapter.groupModel).toBe("route");
  });

  it("does not declare state migrations (intentionally skipped)", () => {
    expect("stateMigrations" in basecampDoctorAdapter).toBe(false);
  });
});

describe("repairBasecampConfig", () => {
  it("is a no-op for missing or healthy config", () => {
    expect(repairBasecampConfig({ cfg: {} as any })).toMatchObject({ changes: [], warnings: [] });

    const healthy = cfg({
      accounts: { main: { personId: "1", token: "t" } },
      personas: { agent: "main" },
    });
    const result = repairBasecampConfig({ cfg: healthy });
    expect(result.changes).toEqual([]);
    expect(result.config).toBe(healthy);
  });

  it("adds the wildcard for account allowFrom overrides under an inherited open policy", () => {
    const result = repairBasecampConfig({
      cfg: cfg({
        dmPolicy: "open",
        allowFrom: ["*"],
        accounts: { main: { personId: "1", allowFrom: ["7"] } },
      }),
    });
    const section = (result.config.channels as any).basecamp;
    expect(section.accounts.main.allowFrom).toEqual(["7", "*"]);
    expect(result.changes.some((c: string) => c.includes("accounts.main.allowFrom"))).toBe(true);
  });

  it("keeps personas that target virtualAccounts aliases", () => {
    const result = repairBasecampConfig({
      cfg: cfg({
        accounts: { main: { personId: "1" } },
        virtualAccounts: { "proj-a": { accountId: "main", bucketId: "42" } },
        personas: { scoped: "proj-a" },
      }),
    });
    const section = (result.config.channels as any).basecamp;
    expect(section.personas).toEqual({ scoped: "proj-a" });
    expect(result.changes).toEqual([]);
  });

  it("removes personas pointing at missing accounts", () => {
    const result = repairBasecampConfig({
      cfg: cfg({
        accounts: { main: { personId: "1", token: "t" } },
        personas: { keeper: "main", dangler: "ghost" },
      }),
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("personas.dangler");
    const section = (result.config.channels as any).basecamp;
    expect(section.personas).toEqual({ keeper: "main" });
  });

  it("adds '*' to allowFrom when channel-level dmPolicy is open", () => {
    const result = repairBasecampConfig({ cfg: cfg({ dmPolicy: "open", allowFrom: ["42"] }) });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("allowFrom");
    const section = (result.config.channels as any).basecamp;
    expect(section.allowFrom).toContain("*");
    expect(section.allowFrom).toContain("42");
  });

  it("adds '*' to a per-account allowFrom when the account dmPolicy is open", () => {
    const result = repairBasecampConfig({
      cfg: cfg({
        accounts: { work: { personId: "1", token: "t", dmPolicy: "open" } },
      }),
    });
    expect(result.changes).toHaveLength(1);
    const section = (result.config.channels as any).basecamp;
    expect(section.accounts.work.allowFrom).toContain("*");
  });

  it("leaves open policies with '*' alone", () => {
    const result = repairBasecampConfig({ cfg: cfg({ dmPolicy: "open", allowFrom: ["*"] }) });
    expect(result.changes).toEqual([]);
  });

  it("warns about cliProfile-only accounts without mutating them", () => {
    const config = cfg({
      accounts: { dev: { personId: "1", cliProfile: "dev" } },
    });
    const result = repairBasecampConfig({ cfg: config });
    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain("accounts.dev");
    expect(result.warnings![0]).toContain("cliProfile");
    expect(result.config).toBe(config);
  });

  it("does not mutate the input config object", () => {
    const config = cfg({ dmPolicy: "open", allowFrom: ["42"] });
    repairBasecampConfig({ cfg: config });
    expect((config.channels as any).basecamp.allowFrom).toEqual(["42"]);
  });
});

describe("doctor adapter surfaces", () => {
  it("repairConfig delegates to repairBasecampConfig", () => {
    const result = basecampDoctorAdapter.repairConfig!({
      cfg: cfg({ dmPolicy: "open" }),
      doctorFixCommand: "openclaw doctor --fix",
    }) as { changes: string[] };
    expect(result.changes).toHaveLength(1);
  });

  it("collectPreviewWarnings names the fix command without mutating", async () => {
    const config = cfg({ dmPolicy: "open", allowFrom: ["42"] });
    const warnings = await basecampDoctorAdapter.collectPreviewWarnings!({
      cfg: config,
      doctorFixCommand: "openclaw doctor --fix",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("openclaw doctor --fix");
    expect((config.channels as any).basecamp.allowFrom).toEqual(["42"]);
  });
});

describe("doctor-contract-api sidecar", () => {
  it("exports no legacy config rules", () => {
    expect(legacyConfigRules).toEqual([]);
  });

  it("normalizeCompatibilityConfig applies the shared repair", () => {
    const result = normalizeCompatibilityConfig({
      cfg: cfg({ personas: { dangler: "ghost" } }),
    });
    expect(result.changes).toHaveLength(1);
    expect((result.config.channels as any).basecamp.personas).toEqual({});
  });
});
