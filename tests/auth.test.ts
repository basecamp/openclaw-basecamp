import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
  buildChannelConfigSchema: (schema: unknown) => schema,
}));

vi.mock("../src/bcq.js", () => ({
  bcqAuthStatus: vi.fn(),
  execBcqAuthLogin: vi.fn(),
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
import { execBcqAuthLogin } from "../src/bcq.js";
import { resolveBasecampAccount } from "../src/config.js";

const mockAccount = {
  accountId: "test",
  enabled: true,
  personId: "42",
  token: "tok",
  tokenSource: "config" as const,
  bcqProfile: "myprofile",
  config: { personId: "42", bcqProfile: "myprofile" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveBasecampAccount).mockReturnValue(mockAccount as any);
});

// ---------------------------------------------------------------------------
// auth.login
// ---------------------------------------------------------------------------

describe("auth.login", () => {
  it("calls execBcqAuthLogin with the account's bcqProfile", async () => {
    vi.mocked(execBcqAuthLogin).mockResolvedValue(undefined);

    await basecampChannel.auth!.login!({
      cfg: {} as any,
      accountId: "test",
      runtime: {} as any,
    });

    expect(execBcqAuthLogin).toHaveBeenCalledWith({ profile: "myprofile" });
  });

  it("calls execBcqAuthLogin with undefined profile when account has no bcqProfile", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      ...mockAccount,
      bcqProfile: undefined,
    } as any);
    vi.mocked(execBcqAuthLogin).mockResolvedValue(undefined);

    await basecampChannel.auth!.login!({
      cfg: {} as any,
      accountId: "test",
      runtime: {} as any,
    });

    expect(execBcqAuthLogin).toHaveBeenCalledWith({ profile: undefined });
  });

  it("propagates errors from execBcqAuthLogin", async () => {
    vi.mocked(execBcqAuthLogin).mockRejectedValue(new Error("bcq auth login exited with code 1"));

    await expect(
      basecampChannel.auth!.login!({
        cfg: {} as any,
        accountId: "test",
        runtime: {} as any,
      }),
    ).rejects.toThrow("bcq auth login exited with code 1");
  });

  it("uses default account when accountId is not provided", async () => {
    vi.mocked(execBcqAuthLogin).mockResolvedValue(undefined);

    await basecampChannel.auth!.login!({
      cfg: {} as any,
      runtime: {} as any,
    });

    expect(resolveBasecampAccount).toHaveBeenCalledWith({}, undefined);
    expect(execBcqAuthLogin).toHaveBeenCalled();
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
