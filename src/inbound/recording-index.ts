/**
 * Recording → bucket index (SPEC §2.5 target grammar, §2.15 storage).
 *
 * Maps recordingId → { bucketId, recordableType } so cold outbound sends to
 * `recording:<id>` targets can resolve the owning bucket without an inbound
 * event in hand. Populated by every inbound path (poller sources + webhooks)
 * and consumed by outbound target resolution and
 * `messaging.resolveSessionConversation`.
 *
 * Storage: SDK atomic JSON under `<stateDir>/recording-index-<accountId>.json`
 * (plugin-owned state; keyed stores are trust-gated for non-official installs).
 *
 * Shared touchpoint between WP3 (writes) and WP4 (reads) — keep this API
 * stable; extend rather than reshape.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolvePluginStateDir } from "./state-dir.js";

export type RecordingIndexEntry = {
  bucketId: string;
  recordableType: string;
  /** Epoch ms of the last event that touched this recording. */
  updatedAt: number;
};

export type RecordingIndex = {
  /** Look up a recording's bucket + type. Undefined when never seen. */
  get(recordingId: string): RecordingIndexEntry | undefined;
  /** Record (or refresh) a recording→bucket mapping. Cheap; call per inbound event. */
  record(recordingId: string, entry: { bucketId: string; recordableType: string }): void;
  /** Persist pending writes. Called on shutdown and periodically by callers. */
  flush(): Promise<void>;
  /** Number of indexed recordings (for pruning/metrics). */
  size(): number;
};

type IndexFile = Record<string, RecordingIndexEntry>;

/** Entries older than this are dropped at load time to bound file growth. */
const MAX_ENTRY_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

const instances = new Map<string, Promise<RecordingIndex>>();

function indexFilePath(accountId: string, stateDir?: string): string {
  const dir = stateDir ?? resolvePluginStateDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, `recording-index-${accountId}.json`);
}

async function loadIndex(accountId: string, stateDir?: string): Promise<RecordingIndex> {
  const filePath = indexFilePath(accountId, stateDir);
  const { value } = await readJsonFileWithFallback<IndexFile>(filePath, {});
  const cutoff = Date.now() - MAX_ENTRY_AGE_MS;
  const entries = new Map<string, RecordingIndexEntry>(
    Object.entries(value).filter(([, entry]) => entry.updatedAt >= cutoff),
  );
  let dirty = false;

  return {
    get: (recordingId) => entries.get(recordingId),
    record: (recordingId, entry) => {
      const existing = entries.get(recordingId);
      if (existing && existing.bucketId === entry.bucketId && existing.recordableType === entry.recordableType) {
        return;
      }
      entries.set(recordingId, { ...entry, updatedAt: Date.now() });
      dirty = true;
    },
    flush: async () => {
      if (!dirty) return;
      dirty = false;
      await writeJsonFileAtomically(filePath, Object.fromEntries(entries));
    },
    size: () => entries.size,
  };
}

/**
 * Per-account singleton accessor. `stateDir` is only honored on first open
 * (tests pass a temp dir; runtime callers omit it).
 */
export function getRecordingIndex(accountId: string, stateDir?: string): Promise<RecordingIndex> {
  let instance = instances.get(accountId);
  if (!instance) {
    instance = loadIndex(accountId, stateDir);
    instances.set(accountId, instance);
  }
  return instance;
}

/** Flush and drop one account's index (account removal / logout). */
export async function closeRecordingIndex(accountId: string): Promise<void> {
  const instance = instances.get(accountId);
  if (!instance) return;
  instances.delete(accountId);
  await (await instance).flush();
}

/** Flush and drop all indexes (gateway stop / test isolation). */
export async function closeAllRecordingIndexes(): Promise<void> {
  const ids = [...instances.keys()];
  await Promise.all(ids.map((id) => closeRecordingIndex(id)));
}
