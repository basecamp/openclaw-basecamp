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
import { bcqApiPost } from "../bcq.js";
import { markdownToBasecampHtml } from "./format.js";
import { getBasecampRuntime } from "../runtime.js";
import { resolveBasecampAccount } from "../config.js";

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
  host?: string;
  profile?: string;
}): Promise<{ ok: boolean; recordingId?: string; error?: string }> {
  const { bucketId, transcriptId, content, accountId, host, profile } = params;
  const path = `/buckets/${bucketId}/chats/${transcriptId}/lines.json`;
  const body = JSON.stringify({ content });

  try {
    const result = await bcqApiPost(path, body, accountId, host, profile);
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    return { ok: true, recordingId: String(parsed?.id ?? "") };
  } catch (err) {
    return { ok: false, error: String(err) };
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
  host?: string;
  profile?: string;
}): Promise<{ ok: boolean; commentId?: string; error?: string }> {
  const { bucketId, recordingId, content, accountId, host, profile } = params;
  const path = `/buckets/${bucketId}/recordings/${recordingId}/comments.json`;
  const body = JSON.stringify({ content });

  try {
    const result = await bcqApiPost(path, body, accountId, host, profile);
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    return { ok: true, commentId: String(parsed?.id ?? "") };
  } catch (err) {
    return { ok: false, error: String(err) };
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
  host?: string;
  profile?: string;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const { bucketId, recordingId, recordableType, peerId, content, accountId, host, profile } = params;
  const parsed = parsePeerId(peerId);

  // Chat lines go to the transcript
  if (
    recordableType === "Chat::Transcript" ||
    recordableType === "Chat::Line" ||
    parsed.prefix === "ping"
  ) {
    // Always use recordingId for the transcript ID:
    // - For Chat::Transcript events, recordingId IS the transcript
    // - For Chat::Line events, recordingId is the transcript (parent)
    // - For Pings, recordingId should be the transcript recording ID
    //   (from inbound meta), NOT the circle bucket ID from peer.id
    const transcriptId = recordingId;
    const result = await postCampfireLine({
      bucketId,
      transcriptId,
      content,
      accountId,
      host,
      profile,
    });
    return { ok: result.ok, messageId: result.recordingId, error: result.error };
  }

  // Everything else gets a comment on the recording
  const result = await postComment({
    bucketId,
    recordingId,
    content,
    accountId,
    host,
    profile,
  });
  return { ok: result.ok, messageId: result.commentId, error: result.error };
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

  // Resolve persona account to get host and effective accountId
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

  throw new Error(
    `sendBasecampText: unsupported peer format "${to}". ` +
    `Expected "ping:<id>" or "recording:<id>".`,
  );
}
