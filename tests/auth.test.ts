import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
  buildChannelConfigSchema: (schema: unknown) => schema,
}));

vi.mock("../src/basecamp-cli.js", () => ({}));

vi.mock("../src/oauth-credentials.js", () => ({
  interactiveLogin: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  BasecampConfigSchema: {},
  listBasecampAccountIds: vi.fn(),
  resolveBasecampAccount: vi.fn(),
  resolveBasecampAccountAsync: vi.fn(),
  resolveDefaultBasecampAccountId: vi.fn(),
}));

vi.mock("../src/runtime.js", () => ({
  getBasecampRuntime: vi.fn(),
}));

vi.mock("../src/outbound/send.js", () => ({
  sendBasecampText: vi.fn(),
}));

vi.mock("../src/dispatch.js", () => ({
  dispatchBasecampEvent: vi.fn(),
}));

vi.mock("../src/adapters/onboarding.js", () => ({
  basecampOnboardingAdapter: {},
}));

vi.mock("../src/adapters/setup.js", () => ({
  basecampSetupAdapter: {},
}));

vi.mock("../src/adapters/status.js", () => ({
  basecampStatusAdapter: {},
}));

vi.mock("../src/adapters/pairing.js", () => ({
  basecampPairingAdapter: {},
}));

vi.mock("../src/adapters/directory.js", () => ({
  basecampDirectoryAdapter: {},
}));

vi.mock("../src/adapters/messaging.js", () => ({
  basecampMessagingAdapter: {},
}));

vi.mock("../src/adapters/resolver.js", () => ({
  basecampResolverAdapter: {},
}));

vi.mock("../src/adapters/heartbeat.js", () => ({
  basecampHeartbeatAdapter: {},
}));

vi.mock("../src/adapters/groups.js", () => ({
  basecampGroupAdapter: {},
}));

vi.mock("../src/adapters/agent-prompt.js", () => ({
  basecampAgentPromptAdapter: {},
}));

import { basecampChannel } from "../src/channel.js";
import { interactiveLogin } from "../src/oauth-credentials.js";
import { resolveBasecampAccount } from "../src/config.js";

const oauthAccount = {
  accountId: "oauth-test",
  enabled: true,
  personId: "42",
  token: "",
  tokenSource: "oauth" as const,
  oauthClientId: "client123",
  config: { personId: "42", oauthTokenFile: "/tmp/token.json" },
};

const configAccount = {
  accountId: "config-test",
  enabled: true,
  personId: "42",
  token: "inline-token",
  tokenSource: "config" as const,
  config: { personId: "42", token: "inline-token" },
};

const tokenFileAccount = {
  accountId: "file-test",
  enabled: true,
  personId: "42",
  token: "file-token",
  tokenSource: "tokenFile" as const,
  config: { personId: "42", tokenFile: "/path/to/token" },
};

const noneAccount = {
  accountId: "none-test",
  enabled: true,
  personId: "42",
  token: "",
  tokenSource: "none" as const,
  config: { personId: "42" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// auth.login
// ---------------------------------------------------------------------------

describe("auth.login", () => {
  it("routes to interactiveLogin for OAuth accounts", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue(oauthAccount as any);
    vi.mocked(interactiveLogin).mockResolvedValue({} as any);

    await basecampChannel.auth!.login!({
      cfg: {} as any,
      accountId: "oauth-test",
      runtime: {} as any,
    });

    expect(interactiveLogin).toHaveBeenCalledWith(oauthAccount);
  });

  it("throws for config (inline token) accounts", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue(configAccount as any);

    await expect(
      basecampChannel.auth!.login!({
        cfg: {} as any,
        accountId: "config-test",
        runtime: {} as any,
      }),
    ).rejects.toThrow("inline token");
  });

  it("throws for tokenFile accounts", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue(tokenFileAccount as any);

    await expect(
      basecampChannel.auth!.login!({
        cfg: {} as any,
        accountId: "file-test",
        runtime: {} as any,
      }),
    ).rejects.toThrow("token file");
  });

  it("throws for unconfigured accounts", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue(noneAccount as any);

    await expect(
      basecampChannel.auth!.login!({
        cfg: {} as any,
        accountId: "none-test",
        runtime: {} as any,
      }),
    ).rejects.toThrow("No authentication configured");
  });

  it("propagates errors from interactiveLogin", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue(oauthAccount as any);
    vi.mocked(interactiveLogin).mockRejectedValue(new Error("Port 14923 is in use"));

    await expect(
      basecampChannel.auth!.login!({
        cfg: {} as any,
        accountId: "oauth-test",
        runtime: {} as any,
      }),
    ).rejects.toThrow("Port 14923 is in use");
  });

  it("uses default account when accountId is not provided", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue(oauthAccount as any);
    vi.mocked(interactiveLogin).mockResolvedValue({} as any);

    await basecampChannel.auth!.login!({
      cfg: {} as any,
      runtime: {} as any,
    });

    expect(resolveBasecampAccount).toHaveBeenCalledWith({}, undefined);
    expect(interactiveLogin).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// elevated.allowFromFallback
// ---------------------------------------------------------------------------

describe("elevated.allowFromFallback", () => {
  it("returns undefined (no automatic fallback)", () => {
    const result = basecampChannel.elevated!.allowFromFallback!({
      cfg: {} as any,
      accountId: "test",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined regardless of config contents", () => {
    const result = basecampChannel.elevated!.allowFromFallback!({
      cfg: { channels: { basecamp: { allowFrom: [1, 2, 3] } } } as any,
      accountId: null,
    });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

describe("commands", () => {
  it("enforces owner for commands", () => {
    expect(basecampChannel.commands!.enforceOwnerForCommands).toBe(true);
  });

  it("skips when config is empty", () => {
    expect(basecampChannel.commands!.skipWhenConfigEmpty).toBe(true);
  });
});
