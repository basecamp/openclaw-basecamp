/**
 * Outbound delivery adapter for Basecamp.
 *
 * Uses @37signals/basecamp for all Basecamp API writes. Provides:
 * - postCampfireLine: POST /buckets/{id}/chats/{id}/lines.json
 * - postComment: POST /buckets/{id}/recordings/{id}/comments.json
 * - postReplyToEvent: dispatches to the correct endpoint based on recordableType
 * - ChannelOutboundAdapter.sendText for the OpenClaw outbound pipeline
 */

import { type BasecampClient, getClient, numId, rawOrThrow } from "../basecamp-client.js";
import type { CircuitBreaker } from "../circuit-breaker.js";
import { isRetryableError, withCircuitBreaker, withRetry } from "../retry.js";
import type { BasecampRecordableType, ResolvedBasecampAccount } from "../types.js";

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

export interface CircleInfo {
  transcriptId: string | undefined;
  /** Total participant count including the caller (people.length + 1). */
  participantCount: number;
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
  account: ResolvedBasecampAccount,
): Promise<CircleInfo | undefined> {
  const key = circleCacheKey(bucketId, account.accountId);
  const cached = circleInfoCache.get(key);
  if (cached) return cached;
  try {
    const client = getClient(account);
    const data = await rawOrThrow<{ room_url?: string; people?: Array<{ id: number }> }>(
      await client.raw.GET(`/circles/${bucketId}.json` as any, {}),
    );
    const roomUrl = data?.room_url;
    const transcriptId = roomUrl ? /\/chats\/(\d+)/.exec(roomUrl)?.[1] : undefined;
    const participantCount = (data?.people?.length ?? 0) + 1;
    const info: CircleInfo = { transcriptId, participantCount };
    circleInfoCache.set(key, info);
    return info;
  } catch {
    return undefined;
  }
}

/** Convenience: resolve just the transcript ID from the cache. */
async function resolvePingTranscriptCached(
  bucketId: string,
  account: ResolvedBasecampAccount,
): Promise<string | undefined> {
  const info = await resolveCircleInfoCached(bucketId, account);
  return info?.transcriptId;
}

export { circleInfoCache, LruCache, PING_CACHE_MAX };

// ---------------------------------------------------------------------------
// Outbound result types
// ---------------------------------------------------------------------------

type OutboundOk = { ok: true; recordingId?: string; commentId?: string };
type OutboundFail = { ok: false; error: unknown; message: string; retryable?: boolean };
type OutboundResult = OutboundOk | OutboundFail;

// ---------------------------------------------------------------------------
// Helpers — Basecamp API write operations via SDK
// ---------------------------------------------------------------------------

/**
 * Post a line to a Campfire (or Ping) chat transcript.
 * POST /buckets/{bucketId}/chats/{transcriptId}/lines.json
 */
export async function postCampfireLine(params: {
  bucketId: string;
  transcriptId: string;
  content: string;
  account: ResolvedBasecampAccount;
  retries?: number;
  circuitBreaker?: { instance: CircuitBreaker; key: string };
  correlationId?: string;
}): Promise<OutboundResult> {
  const { bucketId, transcriptId, content, account, retries, circuitBreaker, correlationId } = params;
  const { accountId } = account;

  const doPost = async () => {
    const client = getClient(account);
    return client.campfires.createLine(numId("campfire", transcriptId), { content });
  };

  const wrappedPost = circuitBreaker
    ? () => withCircuitBreaker(circuitBreaker.instance, circuitBreaker.key, doPost)
    : doPost;

  try {
    const result =
      retries && retries > 0 ? await withRetry(wrappedPost, { maxAttempts: retries + 1 }) : await wrappedPost();
    console.log(
      `[basecamp:outbound] sent ok — ` +
        `type=campfire recording=${transcriptId} account=${accountId} correlation=${correlationId ?? "none"}`,
    );
    return { ok: true, recordingId: String((result as any)?.id ?? "") };
  } catch (err) {
    const retryable = isRetryableError(err);
    console.warn(
      `[basecamp:outbound] failed — ` +
        `type=campfire recording=${transcriptId} account=${accountId} ` +
        `correlation=${correlationId ?? "none"} retryable=${retryable} error=${String(err)}`,
    );
    return { ok: false, error: err, message: String(err), retryable };
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
  account: ResolvedBasecampAccount;
  retries?: number;
  circuitBreaker?: { instance: CircuitBreaker; key: string };
  correlationId?: string;
}): Promise<OutboundResult> {
  const { bucketId, recordingId, content, account, retries, circuitBreaker, correlationId } = params;
  const { accountId } = account;

  const doPost = async () => {
    const client = getClient(account);
    return client.comments.create(numId("recording", recordingId), { content });
  };

  const wrappedPost = circuitBreaker
    ? () => withCircuitBreaker(circuitBreaker.instance, circuitBreaker.key, doPost)
    : doPost;

  try {
    const result =
      retries && retries > 0 ? await withRetry(wrappedPost, { maxAttempts: retries + 1 }) : await wrappedPost();
    console.log(
      `[basecamp:outbound] sent ok — ` +
        `type=comment recording=${recordingId} account=${accountId} correlation=${correlationId ?? "none"}`,
    );
    return { ok: true, commentId: String((result as any)?.id ?? "") };
  } catch (err) {
    const retryable = isRetryableError(err);
    console.warn(
      `[basecamp:outbound] failed — ` +
        `type=comment recording=${recordingId} account=${accountId} ` +
        `correlation=${correlationId ?? "none"} retryable=${retryable} error=${String(err)}`,
    );
    return { ok: false, error: err, message: String(err), retryable };
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
  account: ResolvedBasecampAccount;
  retries?: number;
  circuitBreaker?: { instance: CircuitBreaker; key: string };
  correlationId?: string;
}): Promise<{ ok: boolean; messageId?: string; retryable?: boolean; error?: unknown; message?: string }> {
  const { bucketId, recordingId, recordableType, peerId, content, account, retries, circuitBreaker, correlationId } =
    params;
  const parsed = parsePeerId(peerId);

  // Pings: resolve the transcript ID from the circle's bucket ID
  if (parsed.prefix === "ping") {
    const transcriptId = await resolvePingTranscriptCached(bucketId, account);
    if (!transcriptId) {
      return { ok: false, message: `Could not resolve Ping transcript for circle bucket=${bucketId}` };
    }
    const result = await postCampfireLine({
      bucketId,
      transcriptId,
      content,
      account,
      retries,
      circuitBreaker,
      correlationId,
    });
    if (result.ok) return { ok: true, messageId: result.recordingId };
    return { ok: false, error: result.error, message: result.message, retryable: result.retryable };
  }

  // For child events (Chat::Line, Comment), the peer points to the parent
  // recording (transcript or commentable). Use it as the outbound target
  // so replies land on the right thread.
  const peerTarget = parsePeerId(peerId);
  const parentId = peerTarget.prefix === "recording" ? peerTarget.id : undefined;

  // Chat lines go to the transcript
  if (recordableType === "Chat::Transcript" || recordableType === "Chat::Line") {
    const transcriptId = parentId ?? recordingId;
    const result = await postCampfireLine({
      bucketId,
      transcriptId,
      content,
      account,
      retries,
      circuitBreaker,
      correlationId,
    });
    if (result.ok) return { ok: true, messageId: result.recordingId };
    return { ok: false, error: result.error, message: result.message, retryable: result.retryable };
  }

  // Everything else gets a comment on the recording
  const targetRecordingId = parentId ?? recordingId;
  const result = await postComment({
    bucketId,
    recordingId: targetRecordingId,
    content,
    account,
    retries,
    circuitBreaker,
    correlationId,
  });
  if (result.ok) return { ok: true, messageId: result.commentId };
  return { ok: false, error: result.error, message: result.message, retryable: result.retryable };
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
