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
  /** Observed conversation kind for ping peers (Circle membership decides group vs direct). */
  chatKind?: "direct" | "group";
  /** Parent recording (transcript/commentable) for child events like Chat::Line. */
  parentRecordingId?: string;
  /** Epoch ms of the last event that touched this recording. */
  updatedAt: number;
};

export type RecordingIndex = {
  /** Look up a recording's bucket + type. Undefined when never seen. */
  get(recordingId: string): RecordingIndexEntry | undefined;
  /** Record (or refresh) a recording→bucket mapping. Cheap; call per inbound event. */
  record(
    recordingId: string,
    entry: { bucketId: string; recordableType: string; chatKind?: "direct" | "group"; parentRecordingId?: string },
  ): void;
  /** Persist pending writes. Called on shutdown and periodically by callers. */
  flush(): Promise<void>;
  /** Number of indexed recordings (for pruning/metrics). */
  size(): number;
};

type IndexFile = Record<string, RecordingIndexEntry>;

/** Entries older than this are dropped at load time to bound file growth. */
const MAX_ENTRY_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
/** Unchanged mappings refresh updatedAt at most this often (avoids a write per event). */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

const instances = new Map<string, Promise<RecordingIndex>>();
/** Loaded instances, mirrored for synchronous consumers (messaging grammar). */
const loadedInstances = new Map<string, RecordingIndex>();

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
      const now = Date.now();
      const existing = entries.get(recordingId);
      const unchanged =
        existing &&
        existing.bucketId === entry.bucketId &&
        existing.recordableType === entry.recordableType &&
        existing.chatKind === entry.chatKind &&
        existing.parentRecordingId === entry.parentRecordingId;
      // An active recording must not age out: refresh updatedAt once per
      // interval even when the mapping itself is unchanged.
      if (unchanged && now - existing.updatedAt < REFRESH_INTERVAL_MS) return;
      entries.set(recordingId, { ...entry, updatedAt: now });
      dirty = true;
    },
    flush: async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await writeJsonFileAtomically(filePath, Object.fromEntries(entries));
      } catch (err) {
        // Keep the pending mappings eligible for the next flush attempt.
        dirty = true;
        throw err;
      }
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
    instance = loadIndex(accountId, stateDir).then((index) => {
      // Mirror only when still current (not closed while loading).
      if (instances.get(accountId) === instance) loadedInstances.set(accountId, index);
      return index;
    });
    instances.set(accountId, instance);
  }
  return instance;
}

/**
 * Synchronous cross-account lookup for already-loaded indexes. Used by
 * synchronous SDK hooks (e.g. `messaging.resolveSessionConversation`) that
 * have no account context and cannot await. Returns undefined until an
 * account's index has finished loading, or when the recording is unknown.
 */
export function findRecordingEntrySync(recordingId: string): RecordingIndexEntry | undefined {
  for (const index of loadedInstances.values()) {
    const entry = index.get(recordingId);
    if (entry) return entry;
  }
  return undefined;
}

/** Flush and drop one account's index (account removal / logout). */
export async function closeRecordingIndex(accountId: string): Promise<void> {
  const instance = instances.get(accountId);
  if (!instance) return;
  instances.delete(accountId);
  loadedInstances.delete(accountId);
  await (await instance).flush();
}

/** Flush and drop all indexes (gateway stop / test isolation). */
export async function closeAllRecordingIndexes(): Promise<void> {
  const ids = [...instances.keys()];
  await Promise.all(ids.map((id) => closeRecordingIndex(id)));
}

/**
 * Index everything an inbound message teaches us (SPEC §2.5, §2.20):
 * - the event's own recording,
 * - the routed parent recording when the peer is a different recording
 *   (Chat::Line → transcript, Comment → commentable) so ambient room-event
 *   turns can address their current conversation immediately,
 * - the ping conversation's observed chat kind (group for multi-person
 *   Circles) so outbound session routing matches the inbound session.
 */
export function recordInboundMessageMappings(
  index: RecordingIndex,
  msg: {
    peer: { kind: "dm" | "group"; id: string };
    meta: { bucketId: string; recordingId: string; recordableType: string };
  },
  parent?: { id: string | number; type?: string },
): void {
  const peerRecording = msg.peer.id.match(/^recording:(\d+)$/)?.[1];
  index.record(msg.meta.recordingId, {
    bucketId: msg.meta.bucketId,
    recordableType: msg.meta.recordableType,
    ...(peerRecording && peerRecording !== msg.meta.recordingId ? { parentRecordingId: peerRecording } : {}),
  });

  if (peerRecording && peerRecording !== msg.meta.recordingId) {
    const parentType =
      parent && String(parent.id) === peerRecording && parent.type
        ? parent.type
        : msg.meta.recordableType === "Chat::Line"
          ? "Chat::Transcript"
          : "Message";
    index.record(peerRecording, { bucketId: msg.meta.bucketId, recordableType: parentType });
  }

  if (msg.peer.id.startsWith("ping:")) {
    index.record(msg.peer.id, {
      bucketId: msg.meta.bucketId,
      recordableType: "Chat::Transcript",
      chatKind: msg.peer.kind === "dm" ? "direct" : "group",
    });
  }
}
