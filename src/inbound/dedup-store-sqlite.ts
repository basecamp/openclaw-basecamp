/**
 * SQLite-backed dedup store using node:sqlite (DatabaseSync).
 *
 * Per-account database file: dedup-{accountId}.sqlite in the plugin state dir.
 * Provides transactional persistence, WAL mode, and migration from legacy
 * JSON dedup files.
 *
 * Requires Node 22.5+ (node:sqlite). Missing module fails at import time
 * with a clear error — this is intentional (platform prerequisite).
 */

import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DedupSnapshot, DedupStore, DedupStoreEntry } from "./dedup-store.js";

export class DedupDb {
  private readonly db: DatabaseSync;
  readonly path: string;
  private closed = false;

  constructor(dbPath: string) {
    this.path = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dedup_primary (
        key      TEXT PRIMARY KEY,
        seen_at  INTEGER NOT NULL,
        source   TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS dedup_secondary (
        key          TEXT PRIMARY KEY,
        primary_key  TEXT NOT NULL
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS dedup_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;

      INSERT OR IGNORE INTO dedup_meta VALUES ('schema_version', '1');
    `);
  }

  /**
   * Migrate from legacy JSON dedup files into this SQLite database.
   *
   * Three-gate check:
   * 1. If migrated_json flag exists → skip (already migrated).
   * 2. If migrated_json missing but DB has rows → set flag, skip import.
   * 3. Otherwise: import from JSON files in one transaction.
   */
  migrateFromJson(legacyPaths: string[]): void {
    // Gate 1: already migrated?
    const flagRow = this.db.prepare("SELECT value FROM dedup_meta WHERE key = 'migrated_json'").get() as
      | { value: string }
      | undefined;
    if (flagRow) return;

    // Gate 2: DB already populated by normal save()?
    const countRow = this.db.prepare("SELECT COUNT(*) AS cnt FROM dedup_primary").get() as { cnt: number };
    if (countRow.cnt > 0) {
      this.db.exec("INSERT OR REPLACE INTO dedup_meta VALUES ('migrated_json', '1')");
      return;
    }

    // Gate 3: import from JSON files
    const combined: DedupSnapshot = { primary: {}, secondary: {} };
    const validPaths: string[] = [];

    for (const filePath of legacyPaths) {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw);
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
          // Merge — INSERT OR IGNORE semantics: first file wins on conflict
          for (const [k, v] of Object.entries(data.primary as Record<string, DedupStoreEntry>)) {
            if (!(k in combined.primary)) {
              combined.primary[k] = v;
            }
          }
          for (const [k, v] of Object.entries(data.secondary as Record<string, string>)) {
            if (!(k in combined.secondary)) {
              combined.secondary[k] = v;
            }
          }
          validPaths.push(filePath);
        }
      } catch {
        // File missing, empty, or malformed — skip
      }
    }

    const hasCombinedData = Object.keys(combined.primary).length > 0 || Object.keys(combined.secondary).length > 0;

    if (!hasCombinedData && validPaths.length === 0) {
      // No JSON files found or all empty — just set the flag
      this.db.exec("INSERT OR REPLACE INTO dedup_meta VALUES ('migrated_json', '1')");
      return;
    }

    // Single transaction: insert all + set meta flag
    try {
      this.db.exec("BEGIN");
      this._insertSnapshot(combined);
      this.db.exec("INSERT OR REPLACE INTO dedup_meta VALUES ('migrated_json', '1')");
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      console.warn("[dedup-store-sqlite] JSON migration transaction failed:", err);
      return; // Leave JSON files intact for retry
    }

    // Success — rename JSON files to .migrated
    for (const filePath of validPaths) {
      try {
        renameSync(filePath, `${filePath}.migrated`);
      } catch {
        // Best-effort rename
      }
    }
  }

  /** Non-transactional bulk write. Caller provides transaction context. */
  private _insertSnapshot(snapshot: DedupSnapshot): void {
    this.db.exec("DELETE FROM dedup_primary");
    this.db.exec("DELETE FROM dedup_secondary");

    const insertPrimary = this.db.prepare("INSERT INTO dedup_primary (key, seen_at, source) VALUES (?, ?, ?)");
    for (const [key, entry] of Object.entries(snapshot.primary)) {
      insertPrimary.run(key, entry.seenAt, entry.source);
    }

    const insertSecondary = this.db.prepare("INSERT INTO dedup_secondary (key, primary_key) VALUES (?, ?)");
    for (const [key, primaryKey] of Object.entries(snapshot.secondary)) {
      insertSecondary.run(key, primaryKey);
    }
  }

  createStore(): SqliteDedupStore {
    return new SqliteDedupStore(this.db);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Idempotent — ignore close errors
    }
  }
}

export class SqliteDedupStore implements DedupStore {
  constructor(private readonly db: DatabaseSync) {}

  load(): DedupSnapshot {
    try {
      const primary: Record<string, DedupStoreEntry> = {};
      const secondary: Record<string, string> = {};

      const pRows = this.db.prepare("SELECT key, seen_at, source FROM dedup_primary").all() as Array<{
        key: string;
        seen_at: number;
        source: string;
      }>;
      for (const row of pRows) {
        primary[row.key] = { seenAt: row.seen_at, source: row.source };
      }

      const sRows = this.db.prepare("SELECT key, primary_key FROM dedup_secondary").all() as Array<{
        key: string;
        primary_key: string;
      }>;
      for (const row of sRows) {
        secondary[row.key] = row.primary_key;
      }

      return { primary, secondary };
    } catch {
      return { primary: {}, secondary: {} };
    }
  }

  save(snapshot: DedupSnapshot): void {
    try {
      this._saveOrThrow(snapshot);
    } catch {
      // Best-effort persistence
    }
  }

  private _saveOrThrow(snapshot: DedupSnapshot): void {
    this.db.exec("BEGIN");
    try {
      this._insertSnapshot(snapshot);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /** Non-transactional bulk write. Caller provides transaction context. */
  private _insertSnapshot(snapshot: DedupSnapshot): void {
    this.db.exec("DELETE FROM dedup_primary");
    this.db.exec("DELETE FROM dedup_secondary");

    const insertPrimary = this.db.prepare("INSERT INTO dedup_primary (key, seen_at, source) VALUES (?, ?, ?)");
    for (const [key, entry] of Object.entries(snapshot.primary)) {
      insertPrimary.run(key, entry.seenAt, entry.source);
    }

    const insertSecondary = this.db.prepare("INSERT INTO dedup_secondary (key, primary_key) VALUES (?, ?)");
    for (const [key, primaryKey] of Object.entries(snapshot.secondary)) {
      insertSecondary.run(key, primaryKey);
    }
  }
}

/**
 * Open (or create) a per-account dedup SQLite database.
 */
export function openDedupDb(dbPath: string): DedupDb {
  return new DedupDb(dbPath);
}
