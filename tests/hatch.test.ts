import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
}));

vi.mock("../src/bcq.js", () => ({
  bcqMe: vi.fn(),
  bcqProfileList: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  listBasecampAccountIds: vi.fn(),
}));

import { hatchIdentity } from "../src/adapters/hatch.js";
import { bcqMe, bcqProfileList } from "../src/bcq.js";
import { listBasecampAccountIds } from "../src/config.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

function createMockPrompter(responses: Record<string, string>) {
  const selectCalls: string[] = [];
  const textCalls: string[] = [];
  const noteCalls: string[] = [];

  return {
    prompter: {
      select: vi.fn(async ({ message, options }: any) => {
        selectCalls.push(message);
        return responses[message] ?? options[0]?.value ?? "";
      }),
      text: vi.fn(async ({ message }: any) => {
        textCalls.push(message);
        return responses[message] ?? "test-value";
      }),
      note: vi.fn(async () => {}),
    },
    calls: { selectCalls, textCalls, noteCalls },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listBasecampAccountIds).mockReturnValue(["default"]);
});

// ---------------------------------------------------------------------------
// hatchIdentity
// ---------------------------------------------------------------------------

describe("hatchIdentity", () => {
  it("resolves personId from bcqMe and adds account", async () => {
    vi.mocked(bcqProfileList).mockResolvedValue({
      data: ["default"],
      raw: "",
    });
    vi.mocked(bcqMe).mockResolvedValue({
      data: {
        identity: { id: 42, name: "Jeremy", email_address: "j@example.com", attachable_sgid: "sgid://x" },
        accounts: [{ id: 99, name: "Acme" }],
      } as any,
      raw: "",
    });

    const { prompter } = createMockPrompter({
      "Account ID key for this identity (e.g. 'security', 'design-bot')": "security",
      "Map this identity to an agent?": "__skip__",
    });

    const result = await hatchIdentity(cfg({}), prompter);

    expect(result.accountId).toBe("security");
    expect(result.personId).toBe("42");
    // Config should have the new account
    const accounts = (result.cfg.channels as any).basecamp.accounts;
    expect(accounts.security).toBeDefined();
    expect(accounts.security.personId).toBe("42");
    expect(accounts.security.displayName).toBe("Jeremy");
    expect(accounts.security.attachableSgid).toBe("sgid://x");
  });

  it("adds persona mapping when agent ID provided", async () => {
    vi.mocked(bcqProfileList).mockResolvedValue({ data: ["default"], raw: "" });
    vi.mocked(bcqMe).mockResolvedValue({
      data: {
        identity: { id: 10, name: "Bot", email_address: "bot@example.com" },
        accounts: [{ id: 1, name: "Co" }],
      } as any,
      raw: "",
    });

    const { prompter } = createMockPrompter({
      "Account ID key for this identity (e.g. 'security', 'design-bot')": "bot-acct",
      "Map this identity to an agent?": "__enter__",
      "Agent ID to use this identity": "security-agent",
    });

    const result = await hatchIdentity(cfg({}), prompter);

    expect(result.personaMapping).toEqual({
      agentId: "security-agent",
      accountId: "bot-acct",
    });
    const personas = (result.cfg.channels as any).basecamp.personas;
    expect(personas["security-agent"]).toBe("bot-acct");
  });

  it("validates unique account ID", async () => {
    vi.mocked(bcqProfileList).mockResolvedValue({ data: ["default"], raw: "" });
    vi.mocked(bcqMe).mockResolvedValue({
      data: { identity: { id: 1, name: "X", email_address: "x@x.com" }, accounts: [] } as any,
      raw: "",
    });
    vi.mocked(listBasecampAccountIds).mockReturnValue(["default", "existing"]);

    const { prompter } = createMockPrompter({
      "Account ID key for this identity (e.g. 'security', 'design-bot')": "new-one",
      "Map this identity to an agent?": "__skip__",
    });

    // The text validator should reject "existing" — verify via the validate function
    const result = await hatchIdentity(cfg({}), prompter);
    expect(result.accountId).toBe("new-one");

    // Verify the validator was set up correctly
    const textCall = prompter.text.mock.calls.find(
      (c: any) => c[0].message.includes("Account ID key"),
    );
    expect(textCall).toBeDefined();
    const validate = textCall![0].validate;
    expect(validate!("existing")).toContain("already in use");
    expect(validate!("new-one")).toBeUndefined();
  });

  it("handles bcqMe failure gracefully", async () => {
    vi.mocked(bcqProfileList).mockResolvedValue({ data: [], raw: "" });
    vi.mocked(bcqMe).mockRejectedValue(new Error("fail"));

    const { prompter } = createMockPrompter({
      "Basecamp person ID for this identity": "99",
      "Account ID key for this identity (e.g. 'security', 'design-bot')": "manual",
      "Map this identity to an agent?": "__skip__",
    });

    const result = await hatchIdentity(cfg({}), prompter);

    expect(result.personId).toBe("99");
    expect(result.accountId).toBe("manual");
    // Note should have been shown about error
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Could not fetch identity"),
      expect.any(String),
    );
  });
});
