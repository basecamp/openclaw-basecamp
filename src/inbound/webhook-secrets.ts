/**
 * Persistent webhook secret store.
 *
 * Basecamp returns webhook secrets only on creation. We must persist them
 * so HMAC verification survives restarts. Each account gets its own store
 * file: `webhook-secrets-{accountId}.json`.
 *
 * Format: { [projectId]: { webhookId, secret, payloadUrl, types } }
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WebhookSecretEntry {
  webhookId: string;
  secret: string;
  payloadUrl: string;
  types: string[];
}

export type WebhookSecretSnapshot = Record<string, WebhookSecretEntry>;

export interface WebhookSecretStore {
  load(): WebhookSecretSnapshot;
  save(snapshot: WebhookSecretSnapshot): void;
}

/**
 * JSON file-backed webhook secret store.
 *
 * Atomic writes via temp+rename. Best-effort persistence — if the write
 * fails, the in-memory state is still authoritative.
 */
export class JsonFileWebhookSecretStore implements WebhookSecretStore {
  constructor(private readonly filePath: string) {}

  load(): WebhookSecretSnapshot {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        return data as WebhookSecretSnapshot;
      }
    } catch {
      // File doesn't exist or is malformed — start fresh
    }
    return {};
  }

  save(snapshot: WebhookSecretSnapshot): void {
    try {
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.webhook-secrets-${Date.now()}.tmp`);
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf-8");
      renameSync(tmp, this.filePath);
    } catch {
      // Best-effort persistence
    }
  }
}

/**
 * In-memory webhook secret registry with optional persistent backing.
 *
 * - get(projectId) → secret string or undefined (for HMAC verification)
 * - getAll() → full snapshot (for lifecycle reconciliation)
 * - set(projectId, entry) → add/update, auto-saves
 * - remove(projectId) → delete, auto-saves
 * - getAllSecrets() → flat array of all secrets (for verification lookup)
 */
export class WebhookSecretRegistry {
  private entries: WebhookSecretSnapshot;
  private store?: WebhookSecretStore;

  constructor(store?: WebhookSecretStore) {
    this.store = store;
    this.entries = store?.load() ?? {};
  }

  get(projectId: string): WebhookSecretEntry | undefined {
    return this.entries[projectId];
  }

  getAll(): WebhookSecretSnapshot {
    return { ...this.entries };
  }

  /**
   * Find a secret by its value. Used for HMAC verification when we don't
   * know which project a webhook payload came from yet.
   */
  findSecret(secret: string): WebhookSecretEntry | undefined {
    for (const entry of Object.values(this.entries)) {
      if (entry.secret === secret) return entry;
    }
    return undefined;
  }

  /**
   * Get all unique secrets. Used to try each secret for HMAC verification
   * when the incoming webhook doesn't identify which project it belongs to.
   */
  getAllSecrets(): string[] {
    const secrets = new Set<string>();
    for (const entry of Object.values(this.entries)) {
      if (entry.secret) secrets.add(entry.secret);
    }
    return [...secrets];
  }

  set(projectId: string, entry: WebhookSecretEntry): void {
    this.entries[projectId] = entry;
    this.store?.save(this.entries);
  }

  remove(projectId: string): void {
    delete this.entries[projectId];
    this.store?.save(this.entries);
  }

  get size(): number {
    return Object.keys(this.entries).length;
  }

  flush(): void {
    this.store?.save(this.entries);
  }
}
