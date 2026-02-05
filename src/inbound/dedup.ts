/**
 * Event deduplication with rolling window.
 *
 * Uses source-prefixed primary keys (activity:123, reading:456) and
 * secondary keys for cross-source collapse (e.g., same recording+action+ts
 * from both activity feed and readings).
 *
 * Phase 1 uses in-memory Map. Sqlite persistence can be added later if needed.
 */

/** Default TTL: 24 hours in milliseconds. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Default prune interval: every 1000 insertions. */
const DEFAULT_PRUNE_INTERVAL = 1000;

interface DedupEntry {
  /** When this entry was first seen. */
  seenAt: number;
  /** Source that first recorded this event. */
  source: string;
}

export interface DedupOptions {
  /** TTL in milliseconds. Entries older than this are pruned. Default: 24h. */
  ttlMs?: number;
  /** How often to prune expired entries (every N insertions). Default: 1000. */
  pruneInterval?: number;
}

export type DedupSource = "activity" | "reading" | "webhook" | "direct";

export class EventDedup {
  private readonly primary = new Map<string, DedupEntry>();
  private readonly secondary = new Map<string, string>(); // secondary → primary key
  private readonly ttlMs: number;
  private readonly pruneInterval: number;
  private insertionCount = 0;

  constructor(opts: DedupOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.pruneInterval = opts.pruneInterval ?? DEFAULT_PRUNE_INTERVAL;
  }

  /**
   * Build a source-prefixed primary key.
   *
   * @example primaryKey("activity", "12345") → "activity:12345"
   */
  static primaryKey(source: DedupSource, eventId: string | number): string {
    return `${source}:${eventId}`;
  }

  /**
   * Build a secondary key for cross-source dedup.
   * Combines recording ID + action + timestamp to collapse the same event
   * seen from multiple sources.
   *
   * @example secondaryKey("456", "created", "2025-01-15T10:00:00Z") → "456:created:2025-01-15T10:00:00Z"
   */
  static secondaryKey(
    recordingId: string | number,
    action: string,
    createdAt: string,
  ): string {
    return `${recordingId}:${action}:${createdAt}`;
  }

  /**
   * Check if an event has been seen. Returns true if duplicate.
   *
   * Checks both the primary key and optional secondary key.
   * If not a duplicate, records the event and returns false.
   */
  isDuplicate(
    primaryKey: string,
    secondaryKey?: string,
  ): boolean {
    const now = Date.now();

    // Check primary key
    const existing = this.primary.get(primaryKey);
    if (existing && now - existing.seenAt < this.ttlMs) {
      return true;
    }

    // Check secondary key (cross-source collapse)
    if (secondaryKey) {
      const mappedPrimary = this.secondary.get(secondaryKey);
      if (mappedPrimary) {
        const mappedEntry = this.primary.get(mappedPrimary);
        if (mappedEntry && now - mappedEntry.seenAt < this.ttlMs) {
          return true;
        }
      }
    }

    // Not a duplicate — record it
    this.record(primaryKey, secondaryKey);
    return false;
  }

  /**
   * Record an event as seen without checking for duplicates.
   */
  record(primaryKey: string, secondaryKey?: string): void {
    const now = Date.now();
    const source = primaryKey.split(":")[0] ?? "unknown";

    this.primary.set(primaryKey, { seenAt: now, source });

    if (secondaryKey) {
      this.secondary.set(secondaryKey, primaryKey);
    }

    this.insertionCount++;
    if (this.insertionCount % this.pruneInterval === 0) {
      this.prune();
    }
  }

  /**
   * Remove entries older than the TTL.
   */
  prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    const expiredPrimaries = new Set<string>();

    for (const [key, entry] of this.primary) {
      if (entry.seenAt < cutoff) {
        this.primary.delete(key);
        expiredPrimaries.add(key);
      }
    }

    // Clean up secondary keys that reference expired primaries
    for (const [secKey, priKey] of this.secondary) {
      if (expiredPrimaries.has(priKey)) {
        this.secondary.delete(secKey);
      }
    }
  }

  /** Number of entries currently tracked. */
  get size(): number {
    return this.primary.size;
  }

  /** Clear all dedup state. */
  clear(): void {
    this.primary.clear();
    this.secondary.clear();
    this.insertionCount = 0;
  }
}
