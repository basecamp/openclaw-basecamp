import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventDedup } from "../src/inbound/dedup.js";
import type { DedupSource } from "../src/inbound/dedup.js";

describe("EventDedup", () => {
  let dedup: EventDedup;

  beforeEach(() => {
    dedup = new EventDedup({ ttlMs: 5000 });
  });

  describe("primaryKey", () => {
    it("builds source:id strings", () => {
      expect(EventDedup.primaryKey("activity", "123")).toBe("activity:123");
      expect(EventDedup.primaryKey("reading", 456)).toBe("reading:456");
      expect(EventDedup.primaryKey("webhook", "abc")).toBe("webhook:abc");
      expect(EventDedup.primaryKey("direct", 0)).toBe("direct:0");
    });
  });

  describe("secondaryKey", () => {
    it("builds recordingId:action:createdAt strings", () => {
      expect(
        EventDedup.secondaryKey("456", "created", "2025-01-15T10:00:00Z"),
      ).toBe("456:created:2025-01-15T10:00:00Z");

      expect(
        EventDedup.secondaryKey(789, "updated", "2025-06-01T12:30:00Z"),
      ).toBe("789:updated:2025-06-01T12:30:00Z");
    });
  });

  describe("isDuplicate", () => {
    it("returns false on first call (not a duplicate)", () => {
      expect(dedup.isDuplicate("activity:1")).toBe(false);
    });

    it("returns true on second call with the same primary key", () => {
      dedup.isDuplicate("activity:1");
      expect(dedup.isDuplicate("activity:1")).toBe(true);
    });

    it("returns false for different primary keys", () => {
      dedup.isDuplicate("activity:1");
      expect(dedup.isDuplicate("activity:2")).toBe(false);
      expect(dedup.isDuplicate("reading:1")).toBe(false);
    });

    it("cross-source dedup: same secondary key returns true even with different primary", () => {
      const secondary = "456:created:2025-01-15T10:00:00Z";
      expect(dedup.isDuplicate("activity:1", secondary)).toBe(false);
      expect(dedup.isDuplicate("reading:99", secondary)).toBe(true);
    });

    it("returns false after TTL expires", () => {
      vi.useFakeTimers();
      try {
        const d = new EventDedup({ ttlMs: 1000 });
        expect(d.isDuplicate("activity:1")).toBe(false);
        expect(d.isDuplicate("activity:1")).toBe(true);

        vi.advanceTimersByTime(1001);

        expect(d.isDuplicate("activity:1")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("record", () => {
    it("manually records without checking, making future isDuplicate return true", () => {
      dedup.record("activity:42");
      expect(dedup.isDuplicate("activity:42")).toBe(true);
    });

    it("records with a secondary key", () => {
      const secondary = "100:created:2025-01-01T00:00:00Z";
      dedup.record("activity:1", secondary);
      // Same secondary from a different source is a duplicate
      expect(dedup.isDuplicate("webhook:999", secondary)).toBe(true);
    });
  });

  describe("prune", () => {
    it("removes expired entries and keeps fresh ones", () => {
      vi.useFakeTimers();
      try {
        const d = new EventDedup({ ttlMs: 1000 });

        d.record("activity:1");
        d.record("activity:2");

        vi.advanceTimersByTime(500);
        d.record("activity:3");

        vi.advanceTimersByTime(501);
        // activity:1 and activity:2 are now >1000ms old; activity:3 is 501ms old
        d.prune();

        expect(d.size).toBe(1);
        // The surviving entry should still be detected as a duplicate
        expect(d.isDuplicate("activity:3")).toBe(true);
        // Pruned entries should not be duplicates
        expect(d.isDuplicate("activity:1")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cleans up secondary keys that reference expired primaries", () => {
      vi.useFakeTimers();
      try {
        const d = new EventDedup({ ttlMs: 1000 });
        const secondary = "50:created:2025-01-01T00:00:00Z";

        d.record("activity:1", secondary);
        vi.advanceTimersByTime(1001);
        d.prune();

        // Secondary key should be cleaned up, so a new event with the same
        // secondary key should not be flagged as a duplicate
        expect(d.isDuplicate("reading:2", secondary)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("size", () => {
    it("reflects the number of tracked primary entries", () => {
      expect(dedup.size).toBe(0);
      dedup.record("activity:1");
      expect(dedup.size).toBe(1);
      dedup.record("activity:2");
      expect(dedup.size).toBe(2);
      // Recording the same key again updates in place
      dedup.record("activity:1");
      expect(dedup.size).toBe(2);
    });
  });

  describe("clear", () => {
    it("resets everything to 0", () => {
      dedup.record("activity:1");
      dedup.record("activity:2");
      dedup.record("reading:3");
      expect(dedup.size).toBe(3);

      dedup.clear();

      expect(dedup.size).toBe(0);
      // Previously recorded keys should no longer be duplicates
      expect(dedup.isDuplicate("activity:1")).toBe(false);
    });
  });

  describe("auto-prune on insertions", () => {
    it("triggers prune every pruneInterval record() calls", () => {
      vi.useFakeTimers();
      try {
        const d = new EventDedup({ ttlMs: 1000, pruneInterval: 3 });

        // Record 2 entries, then let them expire
        d.record("activity:1");
        d.record("activity:2");
        vi.advanceTimersByTime(1001);

        // These are expired but not yet pruned
        expect(d.size).toBe(2);

        // 3rd insertion triggers auto-prune (insertionCount hits 3)
        d.record("activity:3");

        // After auto-prune, the 2 expired entries are removed,
        // only activity:3 remains
        expect(d.size).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
