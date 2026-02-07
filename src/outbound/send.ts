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
import { bcqApiPost, withRetry, isRetryableError, BcqError, bcqResolvePingTranscript } from "../bcq.js";
import { markdownToBasecampHtml } from "./format.js";
import { getBasecampRuntime } from "../runtime.js";
import { resolveBasecampAccount } from "../config.js";

// ---------------------------------------------------------------------------
// Ping transcript cache — avoids re-fetching /circles/<id>.json per reply
// ---------------------------------------------------------------------------

const pingTranscriptCache = new Map<string, string>();

async function resolvePingTranscriptCached(
  bucketId: string,
  accountId?: string,
  profile?: string,
): Promise<string | undefined> {
  const cached = pingTranscriptCache.get(bucketId);
  if (cached) return cached;
  const transcriptId = await bcqResolvePingTranscript(bucketId, { accountId, profile });
  if (transcriptId) pingTranscriptCache.set(bucketId, transcriptId);
  return transcriptId;
}

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
}): Promise<{ ok: boolean; recordingId?: string; retryable?: boolean; error?: string }> {
  const { bucketId, transcriptId, content, accountId, profile, retries } = params;
  const path = `/buckets/${bucketId}/chats/${transcriptId}/lines.json`;
  const body = JSON.stringify({ content });

  const doPost = () => bcqApiPost(path, body, accountId, profile);

  try {
    const result = retries && retries > 0
      ? await withRetry(doPost, { maxAttempts: retries + 1 })
      : await doPost();
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    console.log(
      `[basecamp:outbound] sent ok — ` +
      `type=campfire recording=${transcriptId} account=${accountId ?? "default"}`,
    );
    return { ok: true, recordingId: String(parsed?.id ?? "") };
  } catch (err) {
    const retryable = err instanceof BcqError && isRetryableError(err);
    console.warn(
      `[basecamp:outbound] failed — ` +
      `type=campfire recording=${transcriptId} account=${accountId ?? "default"} ` +
      `retryable=${retryable} error=${String(err)}`,
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
}): Promise<{ ok: boolean; commentId?: string; retryable?: boolean; error?: string }> {
  const { bucketId, recordingId, content, accountId, profile, retries } = params;
  const path = `/buckets/${bucketId}/recordings/${recordingId}/comments.json`;
  const body = JSON.stringify({ content });

  const doPost = () => bcqApiPost(path, body, accountId, profile);

  try {
    const result = retries && retries > 0
      ? await withRetry(doPost, { maxAttempts: retries + 1 })
      : await doPost();
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    console.log(
      `[basecamp:outbound] sent ok — ` +
      `type=comment recording=${recordingId} account=${accountId ?? "default"}`,
    );
    return { ok: true, commentId: String(parsed?.id ?? "") };
  } catch (err) {
    const retryable = err instanceof BcqError && isRetryableError(err);
    console.warn(
      `[basecamp:outbound] failed — ` +
      `type=comment recording=${recordingId} account=${accountId ?? "default"} ` +
      `retryable=${retryable} error=${String(err)}`,
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
}): Promise<{ ok: boolean; messageId?: string; retryable?: boolean; error?: string }> {
  const { bucketId, recordingId, recordableType, peerId, content, accountId, profile, retries } = params;
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
  });
  return { ok: result.ok, messageId: result.commentId, retryable: result.retryable, error: result.error };
}

// ---------------------------------------------------------------------------
// OpenClaw ChannelOutboundAdapter.sendText
// ---------------------------------------------------------------------------

/**
 * Send text to a Basecamp peer.
 *
 * The `to` field in the outbound context is the peer ID
 * (e.g. "recording:123", "ping:456"). We need to resolve the bucket ID
 * and determine the correct endpoint.
 */
export async function sendBasecampText(params: {
  to: string;
  text: string;
  accountId?: string | null;
}): Promise<{ channel: "basecamp"; messageId: string }> {
  const runtime = getBasecampRuntime();
  const cfg = runtime.config.loadConfig();
  const { to, text } = params;

  // Resolve persona account to get effective accountId
  const effectiveAccountId = params.accountId ?? undefined;
  const account = resolveBasecampAccount(cfg, effectiveAccountId);

  // Parse the peer ID to determine target
  const parsed = parsePeerId(to);

  // sendBasecampText operates with limited context — only a peer ID string,
  // no bucketId. The dispatch bridge (dispatch.ts → postReplyToEvent) has
  // full context and is the primary outbound path. This function handles
  // ChannelOutboundAdapter.sendText for direct CLI messaging.

  if (parsed.prefix === "ping") {
    // Pings: peer ID is ping:<circleBucketId>. We can't resolve the
    // transcript recording ID from just the circle bucket ID without
    // an additional API call. For now, reject with a clear error.
    throw new Error(
      `sendBasecampText: cannot send to ping peer "${to}" directly. ` +
      `Ping replies require transcript context (use dispatch bridge instead).`,
    );
  }

  if (parsed.prefix === "recording") {
    // We don't have the bucketId from just the peer ID. Without it,
    // the API path is invalid. Reject clearly rather than 404 at runtime.
    throw new Error(
      `sendBasecampText: cannot resolve bucketId for recording peer "${to}". ` +
      `Direct sendText to recording: peers is not yet supported. ` +
      `Use the dispatch bridge (dispatchBasecampEvent) for replies.`,
    );
  }

  if (parsed.prefix === "bucket") {
    throw new Error(
      `sendBasecampText: cannot send to bucket peer "${to}" directly. ` +
      `Bucket peers represent a project scope, not a specific conversation. ` +
      `Use a recording: or ping: peer, or the dispatch bridge for replies.`,
    );
  }

  throw new Error(
    `sendBasecampText: unsupported peer format "${to}". ` +
    `Expected "recording:<id>", "ping:<id>", or "bucket:<id>".`,
  );
}
