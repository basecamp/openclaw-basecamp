import { describe, it, expect, vi } from "vitest";

// Mock transitive dependencies to avoid module resolution issues
vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => ({})),
  numId: (_label: string, value: string | number) => Number(value),
  rawOrThrow: vi.fn(async (result: any) => result?.data),
  BasecampError: class BasecampError extends Error {
    code: string;
    constructor(msg: string, code: string) { super(msg); this.code = code; }
  },
  clearClients: vi.fn(),
}));

// Test the LRU cache directly
import { LruCache, PING_CACHE_MAX } from "../src/outbound/send.js";

describe("LruCache", () => {
  it("stores and retrieves values", () => {
    const cache = new LruCache<string, string>(3);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBe("2");
  });

  it("evicts oldest entry when full", () => {
    const cache = new LruCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // Should evict "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("d")).toBe(4);
    expect(cache.size).toBe(3);
  });

  it("accessing an entry refreshes its position", () => {
    const cache = new LruCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.get("a"); // Refresh "a"
    cache.set("d", 4); // Should evict "b" (oldest untouched)
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("d")).toBe(4);
  });

  it("updating an entry refreshes its position", () => {
    const cache = new LruCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("a", 10); // Update "a" — should refresh position
    cache.set("d", 4); // Should evict "b"
    expect(cache.get("a")).toBe(10);
    expect(cache.get("b")).toBeUndefined();
  });

  it("respects max size at large scale", () => {
    const cache = new LruCache<number, number>(PING_CACHE_MAX);
    for (let i = 0; i < PING_CACHE_MAX + 50; i++) {
      cache.set(i, i * 10);
    }
    expect(cache.size).toBe(PING_CACHE_MAX);
    // First 50 should be evicted
    expect(cache.get(0)).toBeUndefined();
    expect(cache.get(49)).toBeUndefined();
    // Last entry should be present
    expect(cache.get(PING_CACHE_MAX + 49)).toBe((PING_CACHE_MAX + 49) * 10);
  });

  it("handles get on empty cache", () => {
    const cache = new LruCache<string, string>(10);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("PING_CACHE_MAX is 500", () => {
    expect(PING_CACHE_MAX).toBe(500);
  });
});
