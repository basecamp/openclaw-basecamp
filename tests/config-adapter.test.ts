import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
  buildChannelConfigSchema: (schema: unknown) => ({ schema: {} }),
  setAccountEnabledInConfigSection: vi.fn(({ cfg, sectionKey, accountId, enabled }: any) => {
    const updated = structuredClone(cfg);
    const section = updated.channels?.basecamp;
    if (section?.accounts?.[accountId]) {
      section.accounts[accountId].enabled = enabled;
    }
    return updated;
  }),
  deleteAccountFromConfigSection: vi.fn(({ cfg, sectionKey, accountId }: any) => {
    const updated = structuredClone(cfg);
    const section = updated.channels?.basecamp;
    if (section?.accounts?.[accountId]) {
      delete section.accounts[accountId];
    }
    return updated;
  }),
}));

// Mock runtime for channel.ts gateway imports
vi.mock("../src/runtime.js", () => ({
  getBasecampRuntime: vi.fn(() => ({})),
}));

// Mock outbound send
vi.mock("../src/outbound/send.js", () => ({
  sendBasecampText: vi.fn(),
}));

// Mock dispatch
vi.mock("../src/dispatch.js", () => ({
  dispatchBasecampEvent: vi.fn(),
}));

// Mock Basecamp CLI (auth functions still used by channel.ts)
vi.mock("../src/basecamp-cli.js", () => ({
  cliAuthStatus: vi.fn(),
}));

// Mock basecamp-client (transitive dep via outbound/send.js)
vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => ({})),
  numId: (_label: string, value: string | number) => Number(value),
  rawOrThrow: vi.fn(async (result: any) => result?.data),
  BasecampError: class BasecampError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
  clearClients: vi.fn(),
}));

// Mock adapter imports so channel.ts loads cleanly
vi.mock("../src/adapters/onboarding.js", () => ({ basecampOnboardingAdapter: {} }));
vi.mock("../src/adapters/setup.js", () => ({ basecampSetupAdapter: {} }));
vi.mock("../src/adapters/status.js", () => ({ basecampStatusAdapter: {} }));
vi.mock("../src/adapters/pairing.js", () => ({ basecampPairingAdapter: {} }));
vi.mock("../src/adapters/directory.js", () => ({ basecampDirectoryAdapter: {} }));
vi.mock("../src/adapters/messaging.js", () => ({ basecampMessagingAdapter: {} }));
vi.mock("../src/adapters/resolver.js", () => ({ basecampResolverAdapter: {} }));
vi.mock("../src/adapters/heartbeat.js", () => ({ basecampHeartbeatAdapter: {} }));
vi.mock("../src/adapters/groups.js", () => ({ basecampGroupAdapter: {} }));
vi.mock("../src/adapters/agent-prompt.js", () => ({ basecampAgentPromptAdapter: {} }));

import { basecampChannel } from "../src/channel.js";
import { resolveBasecampAccount } from "../src/config.js";
import type { BasecampChannelConfig, ResolvedBasecampAccount } from "../src/types.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

const mockAccount: ResolvedBasecampAccount = {
  accountId: "work",
  enabled: true,
  personId: "42",
  token: "tok",
  tokenSource: "config",
  cliProfile: "default",
  config: { personId: "42", cliProfile: "default" },
};

const disabledAccount: ResolvedBasecampAccount = {
  ...mockAccount,
  enabled: false,
};

// ---------------------------------------------------------------------------
// isEnabled
// ---------------------------------------------------------------------------

describe("config.isEnabled", () => {
  it("returns true for enabled account", () => {
    expect(basecampChannel.config.isEnabled!(mockAccount, cfg({}))).toBe(true);
  });

  it("returns false for disabled account", () => {
    expect(basecampChannel.config.isEnabled!(disabledAccount, cfg({}))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// disabledReason / unconfiguredReason
// ---------------------------------------------------------------------------

describe("config.disabledReason", () => {
  it("returns reason string", () => {
    const reason = basecampChannel.config.disabledReason!(disabledAccount, cfg({}));
    expect(reason).toContain("disabled");
  });
});

describe("config.unconfiguredReason", () => {
  it("returns reason string", () => {
    const reason = basecampChannel.config.unconfiguredReason!(mockAccount, cfg({}));
    expect(reason).toContain("token");
    expect(reason).toContain("OAuth");
  });
});

// ---------------------------------------------------------------------------
// setAccountEnabled
// ---------------------------------------------------------------------------

describe("config.setAccountEnabled", () => {
  it("disables an account", () => {
    const original = cfg({
      accounts: { work: { personId: "42", cliProfile: "default" } },
    });
    const updated = basecampChannel.config.setAccountEnabled!({
      cfg: original,
      accountId: "work",
      enabled: false,
    });
    const section = updated.channels?.basecamp as BasecampChannelConfig;
    expect(section.accounts?.work?.enabled).toBe(false);
  });

  it("enables an account", () => {
    const original = cfg({
      accounts: { work: { personId: "42", enabled: false } },
    });
    const updated = basecampChannel.config.setAccountEnabled!({
      cfg: original,
      accountId: "work",
      enabled: true,
    });
    const section = updated.channels?.basecamp as BasecampChannelConfig;
    expect(section.accounts?.work?.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deleteAccount
// ---------------------------------------------------------------------------

describe("config.deleteAccount", () => {
  it("removes account entry", () => {
    const original = cfg({
      accounts: {
        work: { personId: "42", cliProfile: "default" },
        personal: { personId: "43", token: "tok2" },
      },
    });
    const updated = basecampChannel.config.deleteAccount!({
      cfg: original,
      accountId: "work",
    });
    const section = updated.channels?.basecamp as BasecampChannelConfig;
    expect(section.accounts?.work).toBeUndefined();
    expect(section.accounts?.personal).toBeTruthy();
  });

  it("cleans up persona references to deleted account", () => {
    const original = cfg({
      accounts: {
        work: { personId: "42", cliProfile: "default" },
        other: { personId: "43", token: "tok2" },
      },
      personas: { "agent-1": "work", "agent-2": "other" },
    });
    const updated = basecampChannel.config.deleteAccount!({
      cfg: original,
      accountId: "work",
    });
    const section = updated.channels?.basecamp as BasecampChannelConfig;
    expect(section.personas?.["agent-1"]).toBeUndefined();
    expect(section.personas?.["agent-2"]).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// resolveAllowFrom
// ---------------------------------------------------------------------------

describe("config.resolveAllowFrom", () => {
  it("returns channel-level allowFrom", () => {
    const result = basecampChannel.config.resolveAllowFrom!({
      cfg: cfg({ allowFrom: ["42", "99"] }),
    });
    expect(result).toEqual(["42", "99"]);
  });

  it("returns empty when no allowFrom configured", () => {
    const result = basecampChannel.config.resolveAllowFrom!({
      cfg: cfg({}),
    });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatAllowFrom
// ---------------------------------------------------------------------------

describe("config.formatAllowFrom", () => {
  it("formats person IDs for display", () => {
    const result = basecampChannel.config.formatAllowFrom!({
      cfg: cfg({}),
      allowFrom: [42, "99"],
    });
    expect(result).toEqual(["Person 42", "Person 99"]);
  });

  it("returns empty array for empty input", () => {
    const result = basecampChannel.config.formatAllowFrom!({
      cfg: cfg({}),
      allowFrom: [],
    });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// configSchema.uiHints
// ---------------------------------------------------------------------------

describe("configSchema.uiHints", () => {
  it("defines uiHints", () => {
    expect(basecampChannel.configSchema?.uiHints).toBeTruthy();
  });

  it("marks token fields as sensitive", () => {
    const hints = basecampChannel.configSchema!.uiHints!;
    expect(hints["accounts.*.tokenFile"]?.sensitive).toBe(true);
    expect(hints["accounts.*.token"]?.sensitive).toBe(true);
  });

  it("marks advanced fields appropriately", () => {
    const hints = basecampChannel.configSchema!.uiHints!;
    expect(hints["personas"]?.advanced).toBe(true);
    expect(hints["virtualAccounts"]?.advanced).toBe(true);
    expect(hints["buckets"]?.advanced).toBe(true);
  });

  it("includes label and help for all hints", () => {
    const hints = basecampChannel.configSchema!.uiHints!;
    for (const [key, hint] of Object.entries(hints)) {
      expect(hint.label, `${key} missing label`).toBeTruthy();
      expect(hint.help, `${key} missing help`).toBeTruthy();
    }
  });

  it("dmPolicy help text matches SDK vocabulary", () => {
    const hints = basecampChannel.configSchema!.uiHints!;
    const help = hints["dmPolicy"]?.help ?? "";
    expect(help).toContain("pairing");
    expect(help).toContain("allowlist");
    expect(help).toContain("open");
    expect(help).toContain("disabled");
    expect(help).not.toContain("closed");
  });

  it("marks OAuth fields as sensitive", () => {
    const hints = basecampChannel.configSchema!.uiHints!;
    expect(hints["accounts.*.oauthTokenFile"]?.sensitive).toBe(true);
    expect(hints["accounts.*.oauthClientSecret"]?.sensitive).toBe(true);
    expect(hints["oauth.clientSecret"]?.sensitive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveBasecampAccount — OAuth token source
// ---------------------------------------------------------------------------

describe("resolveBasecampAccount — OAuth", () => {
  it("resolves tokenSource 'oauth' when oauthTokenFile is set", () => {
    const result = resolveBasecampAccount(
      cfg({
        accounts: {
          work: { personId: "42", oauthTokenFile: "/tmp/tokens/work.json" },
        },
      }),
      "work",
    );
    expect(result.tokenSource).toBe("oauth");
  });

  it("oauthTokenFile takes priority over cliProfile", () => {
    const result = resolveBasecampAccount(
      cfg({
        accounts: {
          work: {
            personId: "42",
            oauthTokenFile: "/tmp/tokens/work.json",
            cliProfile: "default",
          },
        },
      }),
      "work",
    );
    expect(result.tokenSource).toBe("oauth");
  });

  it("tokenFile takes priority over oauthTokenFile", () => {
    const result = resolveBasecampAccount(
      cfg({
        accounts: {
          work: {
            personId: "42",
            tokenFile: "/tmp/bearer.txt",
            oauthTokenFile: "/tmp/tokens/work.json",
          },
        },
      }),
      "work",
    );
    expect(result.tokenSource).toBe("tokenFile");
  });

  it("inline token takes priority over everything", () => {
    const result = resolveBasecampAccount(
      cfg({
        accounts: {
          work: {
            personId: "42",
            token: "inline-tok",
            tokenFile: "/tmp/bearer.txt",
            oauthTokenFile: "/tmp/tokens/work.json",
            cliProfile: "default",
          },
        },
      }),
      "work",
    );
    expect(result.tokenSource).toBe("config");
    expect(result.token).toBe("inline-tok");
  });

  it("resolves oauthClientId from per-account config", () => {
    const result = resolveBasecampAccount(
      cfg({
        accounts: {
          work: {
            personId: "42",
            oauthTokenFile: "/tmp/tok.json",
            oauthClientId: "per-account-id",
          },
        },
      }),
      "work",
    );
    expect(result.oauthClientId).toBe("per-account-id");
  });

  it("resolves oauthClientId from channel-level oauth fallback", () => {
    const result = resolveBasecampAccount(
      cfg({
        accounts: {
          work: {
            personId: "42",
            oauthTokenFile: "/tmp/tok.json",
          },
        },
        oauth: { clientId: "channel-level-id", clientSecret: "channel-secret" },
      }),
      "work",
    );
    expect(result.oauthClientId).toBe("channel-level-id");
    expect(result.oauthClientSecret).toBe("channel-secret");
  });

  it("per-account oauthClientId overrides channel-level", () => {
    const result = resolveBasecampAccount(
      cfg({
        accounts: {
          work: {
            personId: "42",
            oauthTokenFile: "/tmp/tok.json",
            oauthClientId: "override-id",
          },
        },
        oauth: { clientId: "channel-level-id" },
      }),
      "work",
    );
    expect(result.oauthClientId).toBe("override-id");
  });

  it("basecampAccountId field is preserved in config", () => {
    const result = resolveBasecampAccount(
      cfg({
        accounts: {
          work: {
            personId: "42",
            cliProfile: "default",
            basecampAccountId: "99999",
          },
        },
      }),
      "work",
    );
    expect(result.config.basecampAccountId).toBe("99999");
  });
});

// ---------------------------------------------------------------------------
// isConfigured — OAuth
// ---------------------------------------------------------------------------

describe("config.isConfigured — OAuth", () => {
  it("returns true when oauthTokenFile is set", () => {
    const oauthAccount: ResolvedBasecampAccount = {
      accountId: "work",
      enabled: true,
      personId: "42",
      token: "",
      tokenSource: "oauth",
      config: { personId: "42", oauthTokenFile: "/tmp/tok.json" },
    };
    expect(basecampChannel.config.isConfigured!(oauthAccount, cfg({}))).toBe(true);
  });

  it("returns false when nothing is configured", () => {
    const emptyAccount: ResolvedBasecampAccount = {
      accountId: "work",
      enabled: true,
      personId: "42",
      token: "",
      tokenSource: "none",
      config: { personId: "42" },
    };
    expect(basecampChannel.config.isConfigured!(emptyAccount, cfg({}))).toBe(false);
  });
});
