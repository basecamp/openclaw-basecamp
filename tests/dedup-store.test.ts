import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventDedup } from "../src/inbound/dedup.js";
import type { DedupStore, DedupSnapshot } from "../src/inbound/dedup-store.js";
import { JsonFileDedupStore } from "../src/inbound/dedup-store.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// In-memory mock store for unit tests
// ---------------------------------------------------------------------------

function mockStore(initial?: DedupSnapshot): DedupStore & { saved: DedupSnapshot | null } {
  const store = {
    saved: null as DedupSnapshot | null,
    _data: initial ?? { primary: {}, secondary: {} },
    load(): DedupSnapshot {
      return this._data;
    },
    save(snapshot: DedupSnapshot): void {
      this.saved = snapshot;
      this._data = snapshot;
    },
  };
  return store;
}

// ---------------------------------------------------------------------------
// EventDedup with persistent store
// ---------------------------------------------------------------------------

describe("EventDedup — persistent store integration", () => {
  it("hydrates state from store on construction", () => {
    const store = mockStore({
      primary: { "activity:1": { seenAt: Date.now(), source: "activity" } },
      secondary: { "100:created:2025-01-01": "activity:1" },
    });

    const dedup = new EventDedup({ ttlMs: 5000, store });
    expect(dedup.size).toBe(1);
    // The hydrated entry should be recognized as a duplicate
    expect(dedup.isDuplicate("activity:1")).toBe(true);
  });

  it("skips expired entries during hydration", () => {
    const store = mockStore({
      primary: { "activity:1": { seenAt: Date.now() - 10000, source: "activity" } },
      secondary: {},
    });

    const dedup = new EventDedup({ ttlMs: 5000, store });
    expect(dedup.size).toBe(0);
    // Expired entry should not be treated as duplicate
    expect(dedup.isDuplicate("activity:1")).toBe(false);
  });

  it("cleans up orphaned secondary keys during hydration", () => {
    const store = mockStore({
      primary: {},
      secondary: { "100:created:2025-01-01": "activity:1" },
    });

    const dedup = new EventDedup({ ttlMs: 5000, store });
    expect(dedup.size).toBe(0);
    // The orphaned secondary key should not cause false positives
    expect(dedup.isDuplicate("reading:99", "100:created:2025-01-01")).toBe(false);
  });

  it("flushes to store on prune interval", () => {
    const store = mockStore();
    const dedup = new EventDedup({ ttlMs: 5000, pruneInterval: 3, store });

    dedup.record("activity:1");
    dedup.record("activity:2");
    expect(store.saved).toBeNull(); // Not flushed yet

    dedup.record("activity:3"); // Triggers prune + flush
    expect(store.saved).not.toBeNull();
    expect(Object.keys(store.saved!.primary)).toHaveLength(3);
  });

  it("explicit flush() saves current state", () => {
    const store = mockStore();
    const dedup = new EventDedup({ ttlMs: 5000, store });

    dedup.record("activity:1");
    dedup.record("activity:2", "sec:key");
    dedup.flush();

    expect(store.saved).not.toBeNull();
    expect(store.saved!.primary["activity:1"]).toBeDefined();
    expect(store.saved!.primary["activity:2"]).toBeDefined();
    expect(store.saved!.secondary["sec:key"]).toBe("activity:2");
  });

  it("flush() is a no-op without a store", () => {
    const dedup = new EventDedup({ ttlMs: 5000 });
    dedup.record("activity:1");
    // Should not throw
    dedup.flush();
  });

  it("survives a simulated restart via store", () => {
    const store = mockStore();

    // First instance: record some events
    const dedup1 = new EventDedup({ ttlMs: 5000, store });
    dedup1.isDuplicate("activity:1");
    dedup1.isDuplicate("reading:2", "100:created:ts");
    dedup1.flush();

    // Second instance: hydrate from store (simulates restart)
    const dedup2 = new EventDedup({ ttlMs: 5000, store });
    expect(dedup2.size).toBe(2);
    expect(dedup2.isDuplicate("activity:1")).toBe(true);
    expect(dedup2.isDuplicate("webhook:99", "100:created:ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JsonFileDedupStore
// ---------------------------------------------------------------------------

describe("JsonFileDedupStore", () => {
  const testDir = join(tmpdir(), `dedup-test-${Date.now()}`);
  const testFile = join(testDir, "dedup.json");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("returns empty snapshot when file does not exist", () => {
    const store = new JsonFileDedupStore(join(testDir, "missing.json"));
    const snapshot = store.load();
    expect(snapshot.primary).toEqual({});
    expect(snapshot.secondary).toEqual({});
  });

  it("saves and loads a snapshot", () => {
    const store = new JsonFileDedupStore(testFile);
    const snapshot: DedupSnapshot = {
      primary: { "activity:1": { seenAt: 123456, source: "activity" } },
      secondary: { "sec:key": "activity:1" },
    };

    store.save(snapshot);
    const loaded = store.load();

    expect(loaded.primary["activity:1"]).toEqual({ seenAt: 123456, source: "activity" });
    expect(loaded.secondary["sec:key"]).toBe("activity:1");
  });

  it("creates parent directories on save", () => {
    const nestedFile = join(testDir, "a", "b", "c", "dedup.json");
    const store = new JsonFileDedupStore(nestedFile);
    const snapshot: DedupSnapshot = {
      primary: { "x:1": { seenAt: 1, source: "x" } },
      secondary: {},
    };

    store.save(snapshot);
    const loaded = store.load();
    expect(loaded.primary["x:1"]).toEqual({ seenAt: 1, source: "x" });
  });

  it("handles malformed JSON gracefully on load", () => {
    writeFileSync(testFile, "not valid json", "utf-8");
    const store = new JsonFileDedupStore(testFile);
    const snapshot = store.load();
    expect(snapshot.primary).toEqual({});
    expect(snapshot.secondary).toEqual({});
  });

  it("handles missing shape fields gracefully on load", () => {
    writeFileSync(testFile, JSON.stringify({ foo: "bar" }), "utf-8");
    const store = new JsonFileDedupStore(testFile);
    const snapshot = store.load();
    expect(snapshot.primary).toEqual({});
    expect(snapshot.secondary).toEqual({});
  });

  it("handles null primary gracefully on load", () => {
    writeFileSync(testFile, JSON.stringify({ primary: null, secondary: {} }), "utf-8");
    const store = new JsonFileDedupStore(testFile);
    const snapshot = store.load();
    expect(snapshot.primary).toEqual({});
    expect(snapshot.secondary).toEqual({});
  });

  it("handles null secondary gracefully on load", () => {
    writeFileSync(testFile, JSON.stringify({ primary: {}, secondary: null }), "utf-8");
    const store = new JsonFileDedupStore(testFile);
    const snapshot = store.load();
    expect(snapshot.primary).toEqual({});
    expect(snapshot.secondary).toEqual({});
  });

  it("end-to-end: dedup survives restart via file store", () => {
    const store = new JsonFileDedupStore(testFile);

    // First lifecycle
    const d1 = new EventDedup({ ttlMs: 60_000, store });
    d1.isDuplicate("activity:100");
    d1.isDuplicate("reading:200", "rec:key");
    d1.flush();

    // Second lifecycle — fresh EventDedup, same file
    const store2 = new JsonFileDedupStore(testFile);
    const d2 = new EventDedup({ ttlMs: 60_000, store: store2 });

    expect(d2.size).toBe(2);
    expect(d2.isDuplicate("activity:100")).toBe(true);
    expect(d2.isDuplicate("webhook:300", "rec:key")).toBe(true);
    // Genuinely new event
    expect(d2.isDuplicate("activity:999")).toBe(false);
  });
});
