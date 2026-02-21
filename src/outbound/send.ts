/**
 * Outbound delivery adapter for Basecamp.
 *
 * Phase 1 uses `bcq` for all Basecamp API writes. Provides:
 * - postCampfireLine: POST /buckets/{id}/chats/{id}/lines.json
 * - postComment: POST /buckets/{id}/recordings/{id}/comments.json
 * - postReplyToEvent: dispatches to the correct endpoint based on recordableType
 * - ChannelOutboundAdapter.sendText for the OpenClaw outbound pipeline
 */

import type { BasecampRecordableType } from "../types.js";
import { bcqPost, bcqApiPost, withRetry, isRetryableError, BcqError, bcqGetCircle } from "../bcq.js";
import type { CircuitBreaker, CircleInfo } from "../bcq.js";

// ---------------------------------------------------------------------------
// Circle info cache — LRU-bounded to avoid unbounded growth.
// Stores both transcript ID and participant count from a single API call.
// ---------------------------------------------------------------------------

const PING_CACHE_MAX = 500;

class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      // Evict oldest (first entry in Map iteration order)
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }
}

const circleInfoCache = new LruCache<string, CircleInfo>(PING_CACHE_MAX);

/** Cache key scoped by account to prevent cross-contamination in multi-account deployments. */
function circleCacheKey(bucketId: string, accountId?: string): string {
  return accountId ? `${accountId}:${bucketId}` : bucketId;
}

/**
 * Resolve a Circle (Ping) to its info (transcript ID + participant count).
 * Results are LRU-cached; a single GET /circles/<id>.json call fetches both.
 * Cache is keyed by accountId:bucketId to avoid cross-account contamination.
 */
export async function resolveCircleInfoCached(
  bucketId: string,
  accountId?: string,
  profile?: string,
): Promise<CircleInfo | undefined> {
  const key = circleCacheKey(bucketId, accountId);
  const cached = circleInfoCache.get(key);
  if (cached) return cached;
  try {
    const info = await bcqGetCircle(bucketId, { accountId, profile });
    circleInfoCache.set(key, info);
    return info;
  } catch {
    return undefined;
  }
}

/** Convenience: resolve just the transcript ID from the cache. */
async function resolvePingTranscriptCached(
  bucketId: string,
  accountId?: string,
  profile?: string,
): Promise<string | undefined> {
  const info = await resolveCircleInfoCached(bucketId, accountId, profile);
  return info?.transcriptId;
}

export { LruCache, PING_CACHE_MAX, circleInfoCache };

// ---------------------------------------------------------------------------
// Helpers — Basecamp API write operations via bcq
// ---------------------------------------------------------------------------

/**
 * Post a line to a Campfire (or Ping) chat transcript.
 * POST /buckets/{bucketId}/chats/{transcriptId}/lines.json
 */
export async function postCampfireLine(params: {
  bucketId: string;
  transcriptId: string;
  content: string;
  accountId?: string;
  profile?: string;
  retries?: number;
  circuitBreaker?: { instance: CircuitBreaker; key: string };
  correlationId?: string;
}): Promise<{ ok: boolean; recordingId?: string; retryable?: boolean; error?: string }> {
  const { bucketId, transcriptId, content, accountId, profile, retries, circuitBreaker, correlationId } = params;
  const path = `/buckets/${bucketId}/chats/${transcriptId}/lines.json`;
  const body = JSON.stringify({ content });

  const doPost = () => circuitBreaker
    ? bcqPost(path, { accountId, profile, extraFlags: ["-d", body], circuitBreaker }).then(r => r.data)
    : bcqApiPost(path, body, accountId, profile);

  try {
    const result = retries && retries > 0
      ? await withRetry(doPost, { maxAttempts: retries + 1 })
      : await doPost();
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    console.log(
      `[basecamp:outbound] sent ok — ` +
      `type=campfire recording=${transcriptId} account=${accountId ?? "default"} correlation=${correlationId ?? "none"}`,
    );
    return { ok: true, recordingId: String(parsed?.id ?? "") };
  } catch (err) {
    const retryable = err instanceof BcqError && isRetryableError(err);
    console.warn(
      `[basecamp:outbound] failed — ` +
      `type=campfire recording=${transcriptId} account=${accountId ?? "default"} ` +
      `correlation=${correlationId ?? "none"} retryable=${retryable} error=${String(err)}`,
    );
    return { ok: false, retryable, error: String(err) };
  }
}

/**
 * Post a comment on any commentable recording.
 * POST /buckets/{bucketId}/recordings/{recordingId}/comments.json
 */
export async function postComment(params: {
  bucketId: string;
  recordingId: string;
  content: string;
  accountId?: string;
  profile?: string;
  retries?: number;
  circuitBreaker?: { instance: CircuitBreaker; key: string };
  correlationId?: string;
}): Promise<{ ok: boolean; commentId?: string; retryable?: boolean; error?: string }> {
  const { bucketId, recordingId, content, accountId, profile, retries, circuitBreaker, correlationId } = params;
  const path = `/buckets/${bucketId}/recordings/${recordingId}/comments.json`;
  const body = JSON.stringify({ content });

  const doPost = () => circuitBreaker
    ? bcqPost(path, { accountId, profile, extraFlags: ["-d", body], circuitBreaker }).then(r => r.data)
    : bcqApiPost(path, body, accountId, profile);

  try {
    const result = retries && retries > 0
      ? await withRetry(doPost, { maxAttempts: retries + 1 })
      : await doPost();
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    console.log(
      `[basecamp:outbound] sent ok — ` +
      `type=comment recording=${recordingId} account=${accountId ?? "default"} correlation=${correlationId ?? "none"}`,
    );
    return { ok: true, commentId: String(parsed?.id ?? "") };
  } catch (err) {
    const retryable = err instanceof BcqError && isRetryableError(err);
    console.warn(
      `[basecamp:outbound] failed — ` +
      `type=comment recording=${recordingId} account=${accountId ?? "default"} ` +
      `correlation=${correlationId ?? "none"} retryable=${retryable} error=${String(err)}`,
    );
    return { ok: false, retryable, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Dispatch reply to the correct Basecamp endpoint
// ---------------------------------------------------------------------------

/**
 * Parse a peer ID to extract the Basecamp IDs.
 * Peer IDs follow conventions: "recording:<id>", "ping:<id>", "bucket:<id>"
 */
function parsePeerId(peerId: string): { prefix: string; id: string } {
  const idx = peerId.indexOf(":");
  if (idx === -1) return { prefix: "", id: peerId };
  return { prefix: peerId.slice(0, idx), id: peerId.slice(idx + 1) };
}

/**
 * Post a reply based on the recordable type of the event.
 *
 * - Chat::Transcript / Chat::Line → postCampfireLine to the transcript
 * - Comment / any other commentable → postComment on the parent recording
 */
export async function postReplyToEvent(params: {
  bucketId: string;
  recordingId: string;
  recordableType: BasecampRecordableType;
  peerId: string;
  content: string;
  accountId?: string;
  profile?: string;
  retries?: number;
  circuitBreaker?: { instance: CircuitBreaker; key: string };
  correlationId?: string;
}): Promise<{ ok: boolean; messageId?: string; retryable?: boolean; error?: string }> {
  const { bucketId, recordingId, recordableType, peerId, content, accountId, profile, retries, circuitBreaker, correlationId } = params;
  const parsed = parsePeerId(peerId);

  // Pings: resolve the transcript ID from the circle's bucket ID
  if (parsed.prefix === "ping") {
    const transcriptId = await resolvePingTranscriptCached(bucketId, accountId, profile);
    if (!transcriptId) {
      return { ok: false, error: `Could not resolve Ping transcript for circle bucket=${bucketId}` };
    }
    const result = await postCampfireLine({
      bucketId,
      transcriptId,
      content,
      accountId,
      profile,
      retries,
      circuitBreaker,
      correlationId,
    });
    return { ok: result.ok, messageId: result.recordingId, retryable: result.retryable, error: result.error };
  }

  // For child events (Chat::Line, Comment), the peer points to the parent
  // recording (transcript or commentable). Use it as the outbound target
  // so replies land on the right thread.
  const peerTarget = parsePeerId(peerId);
  const parentId = peerTarget.prefix === "recording" ? peerTarget.id : undefined;

  // Chat lines go to the transcript
  if (
    recordableType === "Chat::Transcript" ||
    recordableType === "Chat::Line"
  ) {
    const transcriptId = parentId ?? recordingId;
    const result = await postCampfireLine({
      bucketId,
      transcriptId,
      content,
      accountId,
      profile,
      retries,
      circuitBreaker,
      correlationId,
    });
    return { ok: result.ok, messageId: result.recordingId, retryable: result.retryable, error: result.error };
  }

  // Everything else gets a comment on the recording
  const targetRecordingId = parentId ?? recordingId;
  const result = await postComment({
    bucketId,
    recordingId: targetRecordingId,
    content,
    accountId,
    profile,
    retries,
    circuitBreaker,
    correlationId,
  });
  return { ok: result.ok, messageId: result.commentId, retryable: result.retryable, error: result.error };
}

// ---------------------------------------------------------------------------
// OpenClaw ChannelOutboundAdapter.sendText / sendMedia
// ---------------------------------------------------------------------------

/**
 * Basecamp does not support direct outbound delivery via the SDK pipeline.
 * Agent replies flow through the dispatch bridge (dispatchBasecampEvent →
 * postReplyToEvent). This stub satisfies the SDK contract so outbound is
 * not treated as unconfigured (which causes opaque "Outbound not configured").
 */
export async function sendBasecampText(params: {
  to: string;
  text: string;
  accountId?: string | null;
}): Promise<{ channel: "basecamp"; messageId: string }> {
  throw new Error(
    `Basecamp does not support direct outbound delivery to "${params.to}". ` +
    `Agent replies flow through the dispatch bridge (dispatchBasecampEvent → postReplyToEvent).`,
  );
}

export async function sendBasecampMedia(params: {
  to: string;
  text: string;
  mediaUrl?: string;
  accountId?: string | null;
}): Promise<{ channel: "basecamp"; messageId: string }> {
  throw new Error(
    `Basecamp does not support direct media delivery to "${params.to}". ` +
    `Media sharing is available via agent tools (basecamp_api_write).`,
  );
}
