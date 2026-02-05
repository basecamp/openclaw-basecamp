import { describe, it, expect } from "vitest";
import { basecampGroupAdapter } from "../src/adapters/groups.js";
import { resolveBasecampBucketConfig } from "../src/adapters/groups.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

// ---------------------------------------------------------------------------
// resolveBasecampBucketConfig
// ---------------------------------------------------------------------------

describe("resolveBasecampBucketConfig", () => {
  it("returns exact match", () => {
    const result = resolveBasecampBucketConfig(
      cfg({ buckets: { "123": { requireMention: true } } }),
      "123",
    );
    expect(result).toEqual({ requireMention: true });
  });

  it("falls back to wildcard", () => {
    const result = resolveBasecampBucketConfig(
      cfg({ buckets: { "*": { requireMention: false } } }),
      "999",
    );
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
    const result = resolveBasecampBucketConfig(
      cfg({ buckets: { "456": { requireMention: true } } }),
      "123",
    );
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
});

// ---------------------------------------------------------------------------
// resolveGroupIntroHint
// ---------------------------------------------------------------------------

describe("groups.resolveGroupIntroHint", () => {
  it("returns non-empty Basecamp context string", () => {
    const hint = basecampGroupAdapter.resolveGroupIntroHint!({
      cfg: cfg({}),
    } as any);

    expect(hint).toBeTruthy();
    expect(hint).toContain("Basecamp");
    expect(hint).toContain("Campfire");
  });
});
