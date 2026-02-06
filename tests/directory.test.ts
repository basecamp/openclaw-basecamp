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
  bcqApiGet: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  resolveBasecampAccount: vi.fn(),
}));

import { basecampDirectoryAdapter } from "../src/adapters/directory.js";
import { bcqMe, bcqApiGet } from "../src/bcq.js";
import { resolveBasecampAccount } from "../src/config.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

const mockAccount = {
  accountId: "test",
  enabled: true,
  personId: "1",
  token: "tok",
  tokenSource: "config" as const,
  bcqProfile: "default",
  config: { personId: "1", bcqProfile: "default", bcqAccountId: "99" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveBasecampAccount).mockReturnValue(mockAccount as any);
});

// ---------------------------------------------------------------------------
// self
// ---------------------------------------------------------------------------

describe("directory.self", () => {
  it("returns entry from bcqMe", async () => {
    vi.mocked(bcqMe).mockResolvedValue({
      data: { id: 42, name: "Jeremy", email_address: "j@example.com" },
      raw: "",
    });

    const result = await basecampDirectoryAdapter.self!({
      cfg: cfg({ accounts: { test: { personId: "1" } } }),
      accountId: "test",
      runtime: {} as any,
    });

    expect(result).toEqual({
      kind: "user",
      id: "42",
      name: "Jeremy",
      handle: "j@example.com",
    });
  });

  it("returns null when bcqMe fails", async () => {
    vi.mocked(bcqMe).mockRejectedValue(new Error("fail"));

    const result = await basecampDirectoryAdapter.self!({
      cfg: cfg({ accounts: { test: { personId: "1" } } }),
      accountId: "test",
      runtime: {} as any,
    });

    expect(result).toBeNull();
  });

  it("returns null when account has no token or profile", async () => {
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      ...mockAccount,
      token: "",
      bcqProfile: undefined,
    } as any);

    const result = await basecampDirectoryAdapter.self!({
      cfg: cfg({}),
      accountId: "test",
      runtime: {} as any,
    });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listPeers
// ---------------------------------------------------------------------------

describe("directory.listPeers", () => {
  it("returns allowFrom entries and account personIds", async () => {
    const result = await basecampDirectoryAdapter.listPeers!({
      cfg: cfg({
        allowFrom: ["100", "200"],
        accounts: {
          primary: { personId: "300", displayName: "Bot" },
        },
      }),
      runtime: {} as any,
    });

    expect(result).toEqual([
      { kind: "user", id: "100", name: undefined },
      { kind: "user", id: "200", name: undefined },
      { kind: "user", id: "300", name: "Bot" },
    ]);
  });

  it("returns empty when no config", async () => {
    const result = await basecampDirectoryAdapter.listPeers!({
      cfg: cfg({}),
      runtime: {} as any,
    });

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listPeersLive
// ---------------------------------------------------------------------------

describe("directory.listPeersLive", () => {
  it("returns people from API", async () => {
    vi.mocked(bcqApiGet).mockResolvedValue([
      { id: 1, name: "Alice", email_address: "alice@example.com", avatar_url: "https://a.png" },
      { id: 2, name: "Bob", email_address: "bob@example.com" },
    ]);

    const result = await basecampDirectoryAdapter.listPeersLive!({
      cfg: cfg({ accounts: { test: {} } }),
      accountId: "test",
      runtime: {} as any,
    });

    expect(result).toEqual([
      { kind: "user", id: "1", name: "Alice", handle: "alice@example.com", avatarUrl: "https://a.png" },
      { kind: "user", id: "2", name: "Bob", handle: "bob@example.com", avatarUrl: undefined },
    ]);
  });

  it("filters by query", async () => {
    vi.mocked(bcqApiGet).mockResolvedValue([
      { id: 1, name: "Alice", email_address: "alice@example.com" },
      { id: 2, name: "Bob", email_address: "bob@example.com" },
    ]);

    const result = await basecampDirectoryAdapter.listPeersLive!({
      cfg: cfg({ accounts: { test: {} } }),
      accountId: "test",
      query: "ali",
      runtime: {} as any,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Alice");
  });

  it("returns empty on API failure", async () => {
    vi.mocked(bcqApiGet).mockRejectedValue(new Error("fail"));

    const result = await basecampDirectoryAdapter.listPeersLive!({
      cfg: cfg({ accounts: { test: {} } }),
      accountId: "test",
      runtime: {} as any,
    });

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listGroupsLive
// ---------------------------------------------------------------------------

describe("directory.listGroupsLive", () => {
  it("returns projects from API with bucket: prefix", async () => {
    vi.mocked(bcqApiGet).mockResolvedValue([
      { id: 100, name: "Design Project" },
      { id: 200, name: "Engineering" },
    ]);

    const result = await basecampDirectoryAdapter.listGroupsLive!({
      cfg: cfg({ accounts: { test: {} } }),
      accountId: "test",
      runtime: {} as any,
    });

    expect(result).toEqual([
      { kind: "group", id: "bucket:100", name: "Design Project" },
      { kind: "group", id: "bucket:200", name: "Engineering" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// listGroupMembers
// ---------------------------------------------------------------------------

describe("directory.listGroupMembers", () => {
  it("fetches members for bucket:<id> group", async () => {
    vi.mocked(bcqApiGet).mockResolvedValue([
      { id: 5, name: "Carol", email_address: "carol@example.com" },
    ]);

    const result = await basecampDirectoryAdapter.listGroupMembers!({
      cfg: cfg({ accounts: { test: {} } }),
      accountId: "test",
      groupId: "bucket:123",
      runtime: {} as any,
    });

    expect(bcqApiGet).toHaveBeenCalledWith("/buckets/123/people.json", "99", "default");
    expect(result).toEqual([
      { kind: "user", id: "5", name: "Carol", handle: "carol@example.com", avatarUrl: undefined },
    ]);
  });

  it("returns empty for non-bucket groupId", async () => {
    const result = await basecampDirectoryAdapter.listGroupMembers!({
      cfg: cfg({ accounts: { test: {} } }),
      accountId: "test",
      groupId: "recording:456",
      runtime: {} as any,
    });

    expect(result).toEqual([]);
    expect(bcqApiGet).not.toHaveBeenCalled();
  });
});
