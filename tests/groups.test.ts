import { describe, expect, it } from "vitest";
import { basecampGroupAdapter, resolveBasecampBucketConfig } from "../src/adapters/groups.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

// ---------------------------------------------------------------------------
// resolveBasecampBucketConfig
// ---------------------------------------------------------------------------

describe("resolveBasecampBucketConfig", () => {
  it("returns exact match", () => {
    const result = resolveBasecampBucketConfig(cfg({ buckets: { "123": { requireMention: true } } }), "123");
    expect(result).toEqual({ requireMention: true });
  });

  it("falls back to wildcard", () => {
    const result = resolveBasecampBucketConfig(cfg({ buckets: { "*": { requireMention: false } } }), "999");
    expect(result).toEqual({ requireMention: false });
  });

  it("prefers exact match over wildcard", () => {
    const result = resolveBasecampBucketConfig(
      cfg({
        buckets: {
          "123": { requireMention: true },
          "*": { requireMention: false },
        },
      }),
      "123",
    );
    expect(result?.requireMention).toBe(true);
  });

  it("returns undefined when no buckets configured", () => {
    const result = resolveBasecampBucketConfig(cfg({}), "123");
    expect(result).toBeUndefined();
  });

  it("returns undefined when bucketId not found and no wildcard", () => {
    const result = resolveBasecampBucketConfig(cfg({ buckets: { "456": { requireMention: true } } }), "123");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveRequireMention
// ---------------------------------------------------------------------------

describe("groups.resolveRequireMention", () => {
  it("returns value from exact bucket config", () => {
    const result = basecampGroupAdapter.resolveRequireMention!({
      cfg: cfg({ buckets: { "123": { requireMention: true } } }),
      groupId: "bucket:123",
    } as any);
    expect(result).toBe(true);
  });

  it("returns value from wildcard", () => {
    const result = basecampGroupAdapter.resolveRequireMention!({
      cfg: cfg({ buckets: { "*": { requireMention: false } } }),
      groupId: "bucket:999",
    } as any);
    expect(result).toBe(false);
  });

  it("returns undefined for non-bucket groupId", () => {
    const result = basecampGroupAdapter.resolveRequireMention!({
      cfg: cfg({ buckets: { "123": { requireMention: true } } }),
      groupId: "recording:456",
    } as any);
    expect(result).toBeUndefined();
  });

  it("returns undefined when no buckets configured", () => {
    const result = basecampGroupAdapter.resolveRequireMention!({
      cfg: cfg({}),
      groupId: "bucket:123",
    } as any);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveToolPolicy
// ---------------------------------------------------------------------------

describe("groups.resolveToolPolicy", () => {
  it("returns tool policy from bucket config", () => {
    const result = basecampGroupAdapter.resolveToolPolicy!({
      cfg: cfg({
        buckets: {
          "123": { tools: { allow: ["read"], deny: ["write"] } },
        },
      }),
      groupId: "bucket:123",
    } as any);

    expect(result).toEqual({ allow: ["read"], deny: ["write"] });
  });

  it("returns undefined when no tools configured", () => {
    const result = basecampGroupAdapter.resolveToolPolicy!({
      cfg: cfg({ buckets: { "123": { requireMention: true } } }),
      groupId: "bucket:123",
    } as any);

    expect(result).toBeUndefined();
  });

  it("wildcard bucket tools apply via scope-tree defaults", () => {
    const result = basecampGroupAdapter.resolveToolPolicy!({
      cfg: cfg({ buckets: { "*": { tools: { allow: ["read"] } } } }),
      groupId: "bucket:999",
    } as any);

    expect(result).toEqual({ allow: ["read"] });
  });

  it("applies toolsBySender overlays for matching senders (SPEC §2.22)", () => {
    const config = cfg({
      buckets: {
        "123": {
          tools: { allow: ["read"] },
          toolsBySender: { "777": { allow: ["read", "write"] } },
        },
      },
    });

    const matched = basecampGroupAdapter.resolveToolPolicy!({
      cfg: config,
      groupId: "bucket:123",
      senderId: "777",
    } as any);
    expect(matched).toEqual({ allow: ["read", "write"] });

    const unmatched = basecampGroupAdapter.resolveToolPolicy!({
      cfg: config,
      groupId: "bucket:123",
      senderId: "888",
    } as any);
    expect(unmatched).toEqual({ allow: ["read"] });
  });

  it("senderPolicyMode 'never' skips wildcard toolsBySender but keeps base tools", () => {
    const config = cfg({
      buckets: {
        "*": {
          tools: { allow: ["read"] },
          toolsBySender: { "*": { allow: ["read", "write", "admin"] } },
        },
      },
    });

    const result = basecampGroupAdapter.resolveToolPolicy!({
      cfg: config,
      groupId: "bucket:123",
      senderId: "777",
      senderPolicyMode: "never",
    } as any);

    // Sender overlay skipped; base tools restriction preserved.
    expect(result).toEqual({ allow: ["read"] });
  });
});
