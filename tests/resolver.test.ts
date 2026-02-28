import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
}));

const mockClient = {
  people: { list: vi.fn() },
  projects: { list: vi.fn() },
};

vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => mockClient),
  numId: (_label: string, value: string | number) => Number(value),
  rawOrThrow: vi.fn(async (r: any) => r?.data),
  BasecampError: class BasecampError extends Error {
    code: string;
    constructor(msg: string, code: string) { super(msg); this.code = code; }
  },
}));

vi.mock("../src/config.js", () => ({
  resolveBasecampAccount: vi.fn(),
}));

import { basecampResolverAdapter } from "../src/adapters/resolver.js";
import { resolveBasecampAccount } from "../src/config.js";

const mockAccount = {
  accountId: "test",
  enabled: true,
  personId: "1",
  token: "tok",
  tokenSource: "config" as const,
  cliProfile: "default",
  config: { personId: "1", cliProfile: "default", basecampAccountId: "99" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveBasecampAccount).mockReturnValue(mockAccount as any);
});

const people = [
  { id: 10, name: "Alice Smith", email_address: "alice@example.com" },
  { id: 20, name: "Bob Jones", email_address: "bob@example.com" },
  { id: 30, name: "Carol Davis", email_address: "carol@example.com" },
];

const projects = [
  { id: 100, name: "Design Project" },
  { id: 200, name: "Engineering" },
  { id: 300, name: "Marketing Campaign" },
];

// ---------------------------------------------------------------------------
// resolveTargets — users
// ---------------------------------------------------------------------------

describe("resolver.resolveTargets (users)", () => {
  it("resolves by exact ID", async () => {
    mockClient.people.list.mockResolvedValue(people);

    const results = await basecampResolverAdapter.resolveTargets({
      cfg: {} as any,
      inputs: ["10"],
      kind: "user",
      runtime: {} as any,
    });

    expect(results).toEqual([
      { input: "10", resolved: true, id: "10", name: "Alice Smith" },
    ]);
  });

  it("resolves by exact name (case-insensitive)", async () => {
    mockClient.people.list.mockResolvedValue(people);

    const results = await basecampResolverAdapter.resolveTargets({
      cfg: {} as any,
      inputs: ["bob jones"],
      kind: "user",
      runtime: {} as any,
    });

    expect(results).toEqual([
      { input: "bob jones", resolved: true, id: "20", name: "Bob Jones" },
    ]);
  });

  it("resolves by partial name", async () => {
    mockClient.people.list.mockResolvedValue(people);

    const results = await basecampResolverAdapter.resolveTargets({
      cfg: {} as any,
      inputs: ["carol"],
      kind: "user",
      runtime: {} as any,
    });

    expect(results).toEqual([
      { input: "carol", resolved: true, id: "30", name: "Carol Davis" },
    ]);
  });

  it("resolves by email prefix", async () => {
    mockClient.people.list.mockResolvedValue(people);

    const results = await basecampResolverAdapter.resolveTargets({
      cfg: {} as any,
      inputs: ["alice@"],
      kind: "user",
      runtime: {} as any,
    });

    expect(results).toEqual([
      { input: "alice@", resolved: true, id: "10", name: "Alice Smith" },
    ]);
  });

  it("returns unresolved for no match", async () => {
    mockClient.people.list.mockResolvedValue(people);

    const results = await basecampResolverAdapter.resolveTargets({
      cfg: {} as any,
      inputs: ["nobody"],
      kind: "user",
      runtime: {} as any,
    });

    expect(results).toEqual([{ input: "nobody", resolved: false }]);
  });

  it("handles API failure", async () => {
    mockClient.people.list.mockRejectedValue(new Error("fail"));

    const results = await basecampResolverAdapter.resolveTargets({
      cfg: {} as any,
      inputs: ["alice"],
      kind: "user",
      runtime: {} as any,
    });

    expect(results).toEqual([
      { input: "alice", resolved: false, note: "Failed to fetch people list" },
    ]);
  });

  it("resolves multiple inputs in one call", async () => {
    mockClient.people.list.mockResolvedValue(people);

    const results = await basecampResolverAdapter.resolveTargets({
      cfg: {} as any,
      inputs: ["10", "bob", "nonexistent"],
      kind: "user",
      runtime: {} as any,
    });

    expect(results).toHaveLength(3);
    expect(results[0]!.resolved).toBe(true);
    expect(results[1]!.resolved).toBe(true);
    expect(results[2]!.resolved).toBe(false);
    // Fetch only called once
    expect(mockClient.people.list).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// resolveTargets — groups
// ---------------------------------------------------------------------------

describe("resolver.resolveTargets (groups)", () => {
  it("resolves by bucket ID", async () => {
    mockClient.projects.list.mockResolvedValue(projects);

    const results = await basecampResolverAdapter.resolveTargets({
      cfg: {} as any,
      inputs: ["100"],
      kind: "group",
      runtime: {} as any,
    });

    expect(results).toEqual([
      { input: "100", resolved: true, id: "bucket:100", name: "Design Project" },
    ]);
  });

  it("resolves by bucket:<id> prefix", async () => {
    mockClient.projects.list.mockResolvedValue(projects);

    const results = await basecampResolverAdapter.resolveTargets({
      cfg: {} as any,
      inputs: ["bucket:200"],
      kind: "group",
      runtime: {} as any,
    });

    expect(results).toEqual([
      { input: "bucket:200", resolved: true, id: "bucket:200", name: "Engineering" },
    ]);
  });

  it("resolves by project name", async () => {
    mockClient.projects.list.mockResolvedValue(projects);

    const results = await basecampResolverAdapter.resolveTargets({
      cfg: {} as any,
      inputs: ["marketing"],
      kind: "group",
      runtime: {} as any,
    });

    expect(results).toEqual([
      { input: "marketing", resolved: true, id: "bucket:300", name: "Marketing Campaign" },
    ]);
  });

  it("returns unresolved for no match", async () => {
    mockClient.projects.list.mockResolvedValue(projects);

    const results = await basecampResolverAdapter.resolveTargets({
      cfg: {} as any,
      inputs: ["nonexistent"],
      kind: "group",
      runtime: {} as any,
    });

    expect(results).toEqual([{ input: "nonexistent", resolved: false }]);
  });
});
