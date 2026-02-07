import { describe, it, expect, vi } from "vitest";

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (value: string | undefined | null): string => {
    const trimmed = (value ?? "").trim();
    return trimmed || "default";
  },
}));

import { basecampMentionAdapter } from "../src/adapters/mentions.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

const mockCtx = { Body: "test", From: "basecamp:42" } as any;

// ---------------------------------------------------------------------------
// stripPatterns
// ---------------------------------------------------------------------------

describe("mentions.stripPatterns", () => {
  it("returns pattern for agent display name", () => {
    const patterns = basecampMentionAdapter.stripPatterns!({
      ctx: mockCtx,
      cfg: cfg({
        accounts: { main: { personId: "42", displayName: "Coworker" } },
      }),
      agentId: "main",
    });
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toContain("Coworker");
  });

  it("returns pattern matching specific account when agentId provided", () => {
    const patterns = basecampMentionAdapter.stripPatterns!({
      ctx: mockCtx,
      cfg: cfg({
        accounts: {
          alpha: { personId: "1", displayName: "Alice" },
          beta: { personId: "2", displayName: "Bob" },
        },
      }),
      agentId: "beta",
    });
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toContain("Bob");
  });

  it("resolves persona mapping: agentId → accountId → displayName", () => {
    const patterns = basecampMentionAdapter.stripPatterns!({
      ctx: mockCtx,
      cfg: cfg({
        accounts: {
          "service-acct": { personId: "1", displayName: "Helper Bot" },
        },
        personas: {
          "my-agent": "service-acct",
        },
      }),
      agentId: "my-agent",
    });
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toContain("Helper Bot");
  });

  it("returns empty array when no displayName configured", () => {
    const patterns = basecampMentionAdapter.stripPatterns!({
      ctx: mockCtx,
      cfg: cfg({ accounts: { main: { personId: "42" } } }),
    });
    expect(patterns).toEqual([]);
  });

  it("returns empty array when no config", () => {
    const patterns = basecampMentionAdapter.stripPatterns!({
      ctx: mockCtx,
      cfg: undefined,
    });
    expect(patterns).toEqual([]);
  });

  it("escapes regex special characters in name", () => {
    const patterns = basecampMentionAdapter.stripPatterns!({
      ctx: mockCtx,
      cfg: cfg({
        accounts: { main: { personId: "42", displayName: "Agent (v2.0)" } },
      }),
      agentId: "main",
    });
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toContain("\\(");
    expect(patterns[0]).toContain("\\)");
    expect(patterns[0]).toContain("\\.");
  });
});

// ---------------------------------------------------------------------------
// stripMentions
// ---------------------------------------------------------------------------

describe("mentions.stripMentions", () => {
  it("strips agent name from start of message", () => {
    const result = basecampMentionAdapter.stripMentions!({
      text: "Coworker can you review this?",
      ctx: mockCtx,
      cfg: cfg({
        accounts: { main: { personId: "42", displayName: "Coworker" } },
      }),
      agentId: "main",
    });
    expect(result).toBe("can you review this?");
  });

  it("strips agent name with colon separator", () => {
    const result = basecampMentionAdapter.stripMentions!({
      text: "Coworker: please help",
      ctx: mockCtx,
      cfg: cfg({
        accounts: { main: { personId: "42", displayName: "Coworker" } },
      }),
      agentId: "main",
    });
    expect(result).toBe("please help");
  });

  it("strips agent name with comma separator", () => {
    const result = basecampMentionAdapter.stripMentions!({
      text: "Coworker, what do you think?",
      ctx: mockCtx,
      cfg: cfg({
        accounts: { main: { personId: "42", displayName: "Coworker" } },
      }),
      agentId: "main",
    });
    expect(result).toBe("what do you think?");
  });

  it("is case-insensitive", () => {
    const result = basecampMentionAdapter.stripMentions!({
      text: "coworker can you review?",
      ctx: mockCtx,
      cfg: cfg({
        accounts: { main: { personId: "42", displayName: "Coworker" } },
      }),
      agentId: "main",
    });
    expect(result).toBe("can you review?");
  });

  it("preserves text when name appears mid-message", () => {
    const result = basecampMentionAdapter.stripMentions!({
      text: "Hey tell Coworker about this",
      ctx: mockCtx,
      cfg: cfg({
        accounts: { main: { personId: "42", displayName: "Coworker" } },
      }),
    });
    expect(result).toBe("Hey tell Coworker about this");
  });

  it("returns text unchanged when no displayName configured", () => {
    const result = basecampMentionAdapter.stripMentions!({
      text: "Hello there",
      ctx: mockCtx,
      cfg: cfg({ accounts: { main: { personId: "42" } } }),
    });
    expect(result).toBe("Hello there");
  });

  it("returns text unchanged when no config", () => {
    const result = basecampMentionAdapter.stripMentions!({
      text: "Hello there",
      ctx: mockCtx,
      cfg: undefined,
    });
    expect(result).toBe("Hello there");
  });

  it("handles empty text", () => {
    const result = basecampMentionAdapter.stripMentions!({
      text: "",
      ctx: mockCtx,
      cfg: cfg({
        accounts: { main: { personId: "42", displayName: "Coworker" } },
      }),
    });
    expect(result).toBe("");
  });

  it("strips persona-mapped display name via agentId → accountId", () => {
    const result = basecampMentionAdapter.stripMentions!({
      text: "Helper Bot can you help?",
      ctx: mockCtx,
      cfg: cfg({
        accounts: {
          "service-acct": { personId: "1", displayName: "Helper Bot" },
        },
        personas: {
          "my-agent": "service-acct",
        },
      }),
      agentId: "my-agent",
    });
    expect(result).toBe("can you help?");
  });
});
