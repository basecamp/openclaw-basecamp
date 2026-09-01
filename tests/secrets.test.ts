/**
 * Tests: basecampSecrets channel secret contract (SPEC §2.10)
 *
 * Registry entries advertise where SecretRefs may live; the runtime collector
 * turns configured refs into deferred assignments the host resolves into the
 * runtime config snapshot.
 */
import { describe, expect, it } from "vitest";

import { basecampSecrets } from "../src/channel-setup.js";

type FakeContext = {
  sourceConfig: any;
  env: NodeJS.ProcessEnv;
  cache: Map<string, unknown>;
  warnings: Array<{ code: string; path: string; message: string }>;
  warningKeys: Set<string>;
  assignments: Array<{ path: string; ref: { source: string; provider: string; id: string } }>;
};

function createContext(sourceConfig: any): FakeContext {
  return {
    sourceConfig,
    env: {},
    cache: new Map(),
    warnings: [],
    warningKeys: new Set(),
    assignments: [],
  };
}

function collect(config: any) {
  const context = createContext(config);
  basecampSecrets.collectRuntimeConfigAssignments!({ config, defaults: undefined, context: context as any });
  return context;
}

const ref = (id: string) => ({ source: "env" as const, provider: "default", id });

describe("basecampSecrets.secretTargetRegistryEntries", () => {
  it("registers account token, account oauthClientSecret, channel webhookSecret, and oauth.clientSecret", () => {
    const patterns = basecampSecrets.secretTargetRegistryEntries!.map((e) => e.pathPattern);
    expect(patterns).toContain("channels.basecamp.accounts.*.token");
    expect(patterns).toContain("channels.basecamp.accounts.*.oauthClientSecret");
    expect(patterns).toContain("channels.basecamp.webhookSecret");
    expect(patterns).toContain("channels.basecamp.oauth.clientSecret");
  });

  it("declares secret_input shape for every entry", () => {
    for (const entry of basecampSecrets.secretTargetRegistryEntries!) {
      expect(entry.secretShape).toBe("secret_input");
    }
  });
});

describe("basecampSecrets.collectRuntimeConfigAssignments", () => {
  it("collects per-account token and oauthClientSecret refs", () => {
    const config = {
      channels: {
        basecamp: {
          accounts: {
            work: { personId: "1", token: ref("WORK_TOKEN"), oauthClientSecret: ref("WORK_OAUTH") },
          },
        },
      },
    };
    const context = collect(config);
    const paths = context.assignments.map((a) => a.path).sort();
    expect(paths).toEqual([
      "channels.basecamp.accounts.work.oauthClientSecret",
      "channels.basecamp.accounts.work.token",
    ]);
  });

  it("collects the channel-level webhookSecret ref", () => {
    const config = {
      channels: {
        basecamp: {
          webhookSecret: ref("HOOK"),
          accounts: { work: { personId: "1", token: "literal" } },
        },
      },
    };
    const context = collect(config);
    expect(context.assignments.map((a) => a.path)).toContain("channels.basecamp.webhookSecret");
  });

  it("collects the nested oauth.clientSecret ref", () => {
    const config = {
      channels: {
        basecamp: {
          oauth: { clientId: "abc", clientSecret: ref("OAUTH_SECRET") },
          accounts: { work: { personId: "1", token: "literal" } },
        },
      },
    };
    const context = collect(config);
    expect(context.assignments.map((a) => a.path)).toContain("channels.basecamp.oauth.clientSecret");
  });

  it("ignores literal string values (no assignment needed)", () => {
    const config = {
      channels: {
        basecamp: {
          webhookSecret: "plain",
          accounts: { work: { personId: "1", token: "plain" } },
        },
      },
    };
    expect(collect(config).assignments).toEqual([]);
  });

  it("warns instead of assigning for refs on a disabled account", () => {
    const config = {
      channels: {
        basecamp: {
          accounts: {
            off: { personId: "1", enabled: false, token: ref("OFF_TOKEN") },
          },
        },
      },
    };
    const context = collect(config);
    expect(context.assignments).toEqual([]);
    expect(context.warnings.some((w) => w.path === "channels.basecamp.accounts.off.token")).toBe(true);
  });

  it("does nothing when the channel is not configured", () => {
    expect(collect({}).assignments).toEqual([]);
  });
});
