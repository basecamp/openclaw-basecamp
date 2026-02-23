/**
 * Shared per-account EventDedup registry.
 *
 * One EventDedup instance per accountId, backed by a per-account SQLite DB.
 * Used by both the poller and webhook handler — provides live cross-source
 * dedup via shared primary/secondary key space.
 *
 * Fail-open: if SQLite can't be opened, falls back to in-memory EventDedup
 * (no persistence). The in-memory instance is cached to prevent retry storms.
 * closeAccountDedup() evicts the cache, allowing recovery on next access.
 */

import { join } from "node:path";
import { EventDedup } from "./dedup.js";
import { openDedupDb } from "./dedup-store-sqlite.js";
import type { DedupDb } from "./dedup-store-sqlite.js";
import { resolvePluginStateDir } from "./state-dir.js";

const registry = new Map<string, { dedup: EventDedup; db?: DedupDb; stateDir: string }>();

export function getAccountDedup(accountId: string): EventDedup {
  const currentStateDir = resolvePluginStateDir();
  const existing = registry.get(accountId);

  if (existing && existing.stateDir === currentStateDir) return existing.dedup;

  // State dir changed (e.g. runtime became available after fallback) — close old entry
  if (existing) {
    existing.dedup.flush();
    existing.db?.close();
    registry.delete(accountId);
  }

  try {
    const dbPath = join(currentStateDir, `dedup-${accountId}.sqlite`);
    const db = openDedupDb(dbPath);

    db.migrateFromJson([
      join(currentStateDir, `dedup-${accountId}.json`),
      join(currentStateDir, `webhook-dedup-${accountId}.json`),
    ]);

    const store = db.createStore();
    const dedup = new EventDedup({ store });
    registry.set(accountId, { dedup, db, stateDir: currentStateDir });
    return dedup;
  } catch (err) {
    // Fail-open: degrade to in-memory dedup so webhook/poller stays alive.
    console.warn(
      `[dedup-registry] SQLite open/migrate failed for account ${accountId}, falling back to in-memory dedup:`,
      err,
    );
    const dedup = new EventDedup();
    registry.set(accountId, { dedup, db: undefined, stateDir: currentStateDir });
    return dedup;
  }
}

export function flushAccountDedup(accountId: string): void {
  registry.get(accountId)?.dedup.flush();
}

export function closeAccountDedup(accountId: string): void {
  const entry = registry.get(accountId);
  if (!entry) return;
  entry.dedup.flush();
  entry.db?.close();
  registry.delete(accountId);
}

export function closeAllAccountDedup(): void {
  for (const [id] of registry) closeAccountDedup(id);
}
