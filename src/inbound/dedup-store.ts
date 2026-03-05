/**
 * Persistent dedup store backed by a JSON file.
 *
 * Provides restart-safe event deduplication by flushing the in-memory
 * state to disk periodically and on shutdown. Loads existing state on
 * construction so events processed before a restart are still recognized.
 *
 * The file format is a JSON object with primary and secondary maps:
 *   { primary: { [key]: { seenAt, source } }, secondary: { [key]: primaryKey } }
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DedupStoreEntry {
  seenAt: number;
  source: string;
}

export interface DedupSnapshot {
  primary: Record<string, DedupStoreEntry>;
  secondary: Record<string, string>;
}

export interface DedupStore {
  /** Load persisted state. Returns empty maps if no state exists. */
  load(): DedupSnapshot;
  /** Save current state to persistent storage. */
  save(snapshot: DedupSnapshot): void;
}

/**
 * JSON file-backed dedup store.
 *
 * Reads/writes a single JSON file containing the full dedup state.
 * Not suitable for high-concurrency scenarios, but adequate for a
 * single-process gateway with periodic flush.
 */
export class JsonFileDedupStore implements DedupStore {
  constructor(private readonly filePath: string) {}

  load(): DedupSnapshot {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw);
      // Validate shape — guard against null (typeof null === "object") and arrays
      if (
        data &&
        typeof data === "object" &&
        data.primary !== null &&
        typeof data.primary === "object" &&
        !Array.isArray(data.primary) &&
        data.secondary !== null &&
        typeof data.secondary === "object" &&
        !Array.isArray(data.secondary)
      ) {
        return data as DedupSnapshot;
      }
    } catch {
      // File doesn't exist, is empty, or is malformed — start fresh
    }
    return { primary: {}, secondary: {} };
  }

  save(snapshot: DedupSnapshot): void {
    try {
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      // Atomic write: write to temp file then rename into place.
      // Prevents partial writes from corrupting the store on crash.
      const tmp = join(dir, `.dedup-${Date.now()}.tmp`);
      writeFileSync(tmp, JSON.stringify(snapshot), "utf-8");
      renameSync(tmp, this.filePath);
    } catch {
      // Best-effort persistence — if the write fails (e.g., read-only fs),
      // the in-memory state is still authoritative.
    }
  }
}
