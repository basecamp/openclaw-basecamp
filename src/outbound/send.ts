/**
 * Outbound delivery adapter for Basecamp.
 *
 * Uses @37signals/basecamp for all Basecamp API writes. Provides:
 * - postCampfireLine: POST /buckets/{id}/chats/{id}/lines.json
 * - postComment: POST /buckets/{id}/recordings/{id}/comments.json
 * - postReplyToEvent: dispatches to the correct endpoint based on recordableType
 * - ChannelOutboundAdapter.sendText for the OpenClaw outbound pipeline
 */

import { recordOutboundMessageIdentity } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { parseOutboundTarget } from "../adapters/outbound.js";
import { getClient, isBasecampError, numId, rawOrThrow } from "../basecamp-client.js";
import type { CircuitBreaker } from "../circuit-breaker.js";
import { resolveBasecampAccount } from "../config.js";
import { getRecordingIndex } from "../inbound/recording-index.js";
import { isRetryableError, withCircuitBreaker, withRetry } from "../retry.js";
import type { BasecampRecordableType, ResolvedBasecampAccount } from "../types.js";
import { markdownToBasecampHtml } from "./format.js";

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

  clear(): void {
    this.map.clear();
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
  const { transcriptId, content, account, retries, circuitBreaker, correlationId } = params;
  const { accountId } = account;

  const doPost = async () => {
    const client = getClient(account);
    // content_type: text/html — without it the API escapes all rich-text tags
    // and renders the raw markup as plain text (probed 2026-08-31).
    return client.campfires.createLine(numId("campfire", transcriptId), { content, contentType: "text/html" });
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
    return { ok: true, recordingId: String(result.id) };
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
  const { recordingId, content, account, retries, circuitBreaker, correlationId } = params;
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
    return { ok: true, commentId: String(result.id) };
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
// Default project chat (Campfire) resolution — for bucket:<id> targets
// ---------------------------------------------------------------------------

const defaultChatCache = new LruCache<string, string>(PING_CACHE_MAX);

/**
 * Resolve a project's default chat (Campfire) transcript ID from its dock.
 * Mirrors src/inbound/dock-cache.ts (which is scoped to safety-net tool IDs
 * and does not expose the chat tool). Cached per account:bucket.
 */
export async function resolveDefaultChatCached(
  bucketId: string,
  account: ResolvedBasecampAccount,
): Promise<string | undefined> {
  const key = circleCacheKey(bucketId, account.accountId);
  const cached = defaultChatCache.get(key);
  if (cached) return cached;
  try {
    const client = getClient(account);
    const project = await client.projects.get(numId("project", bucketId));
    const dock: Array<{ name: string; id: number; enabled?: boolean }> = (project as any)?.dock ?? [];
    const chat = dock.find((item) => item.name === "chat" && item.enabled !== false);
    if (!chat) return undefined;
    const chatId = String(chat.id);
    defaultChatCache.set(key, chatId);
    return chatId;
  } catch {
    return undefined;
  }
}

/** Clear the default-chat cache. Exported for tests. */
export function clearDefaultChatCache(): void {
  defaultChatCache.clear();
}

// ---------------------------------------------------------------------------
// Send-target resolution — maps a parsed target to a concrete API surface
// ---------------------------------------------------------------------------

type ResolvedSendTarget = {
  surface: "campfire" | "comment";
  bucketId: string;
  /** Transcript ID for campfire sends; recording ID for comment sends. */
  targetId: string;
  /** Canonical conversation/peer id used for delivery results + echo suppression. */
  conversationId: string;
};

/** Recordable types whose replies are Campfire lines rather than comments. */
function isChatSurface(recordableType: string): boolean {
  return recordableType === "Chat::Transcript" || recordableType === "Chat::Line";
}

function notDispatched(message: string, options?: { cause?: unknown; retryable?: boolean }): never {
  throw new PlatformMessageNotDispatchedError(message, {
    cause: options?.cause ?? undefined,
    retryable: options?.retryable ?? false,
  });
}

/**
 * Resolve an outbound target string to a concrete send surface.
 * Throws PlatformMessageNotDispatchedError (provably unsent) on any miss,
 * with a message naming the fix.
 */
async function resolveSendTarget(to: string, account: ResolvedBasecampAccount): Promise<ResolvedSendTarget> {
  const parsed = parseOutboundTarget(to);
  if (!parsed) {
    notDispatched(
      `Invalid Basecamp target "${to}". ` +
        `Expected recording:<id>, ping:<id>, bucket:<id>, or bucket:<id>/recording:<id>`,
    );
  }

  // Enforce virtual-account bucket scoping before any API call.
  const targetBucket = parsed.bucketId;
  if (account.scopedBucketId && targetBucket && targetBucket !== String(account.scopedBucketId)) {
    notDispatched(
      `Account "${account.accountId}" is scoped to bucket ${account.scopedBucketId}; ` +
        `cannot send to bucket ${targetBucket}`,
    );
  }

  if (parsed.kind === "ping") {
    const transcriptId = await resolvePingTranscriptCached(parsed.bucketId, account);
    if (!transcriptId) {
      notDispatched(
        `Could not resolve the Ping chat for circle bucket ${parsed.bucketId}. ` +
          `Ensure the service account is a member of this Ping (circle).`,
      );
    }
    return {
      surface: "campfire",
      bucketId: parsed.bucketId,
      targetId: transcriptId,
      conversationId: `ping:${parsed.bucketId}`,
    };
  }

  if (parsed.kind === "bucket") {
    const chatId = await resolveDefaultChatCached(parsed.bucketId, account);
    if (!chatId) {
      notDispatched(
        `Project (bucket) ${parsed.bucketId} has no enabled Chat (Campfire) tool for a bucket:<id> send. ` +
          `Enable Chat on the project or target a recording directly with bucket:${parsed.bucketId}/recording:<id>.`,
      );
    }
    return {
      surface: "campfire",
      bucketId: parsed.bucketId,
      targetId: chatId,
      conversationId: `recording:${chatId}`,
    };
  }

  // recording:<id> — consult the recording→bucket index (populated by inbound)
  const index = await getRecordingIndex(account.accountId);
  const entry = index.get(parsed.recordingId);
  if (entry) {
    if (account.scopedBucketId && entry.bucketId !== String(account.scopedBucketId)) {
      notDispatched(
        `Account "${account.accountId}" is scoped to bucket ${account.scopedBucketId}; ` +
          `recording ${parsed.recordingId} belongs to bucket ${entry.bucketId}`,
      );
    }
    return {
      surface: isChatSurface(entry.recordableType) ? "campfire" : "comment",
      bucketId: entry.bucketId,
      targetId: parsed.recordingId,
      conversationId: `recording:${parsed.recordingId}`,
    };
  }

  if (parsed.bucketId) {
    // Cold send with explicit bucket: the recordable type is unknown, so post
    // a comment — every non-chat recordable accepts comments, and chat
    // transcripts are addressable via bucket:<id> (default chat) instead.
    return {
      surface: "comment",
      bucketId: parsed.bucketId,
      targetId: parsed.recordingId,
      conversationId: `recording:${parsed.recordingId}`,
    };
  }

  notDispatched(
    `Unknown recording ${parsed.recordingId} for account "${account.accountId}" — ` +
      `no recording→bucket mapping has been observed yet. ` +
      `Use the explicit form bucket:<bucketId>/recording:${parsed.recordingId} for cold sends.`,
  );
}

/** Map a failed OutboundResult to a thrown error per §2.5 (failures throw). */
function throwSendFailure(failure: OutboundFail, target: ResolvedSendTarget): never {
  const err = failure.error;
  if (isBasecampError(err) && err.httpStatus !== undefined) {
    // A 4xx response proves the server rejected the write — nothing was posted.
    if (err.httpStatus === 429) {
      notDispatched(`Basecamp rate-limited the send to ${target.conversationId}`, { cause: err, retryable: true });
    }
    if (err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 408) {
      notDispatched(`Basecamp rejected the send to ${target.conversationId}: ${failure.message}`, { cause: err });
    }
  }
  // Ambiguous (network error, 5xx, timeout): never claim not-dispatched.
  if (err instanceof Error) throw err;
  throw new Error(failure.message);
}

function recordSendIdentity(account: ResolvedBasecampAccount, target: ResolvedSendTarget, messageId: string): void {
  // Producer side of echo suppression (SPEC §2.12): the inbound side checks
  // isRecentOutboundMessageIdentity before dispatching a turn.
  recordOutboundMessageIdentity({
    channel: "basecamp",
    accountId: account.accountId,
    conversationId: target.conversationId,
    messageId,
  });
}

// ---------------------------------------------------------------------------
// OpenClaw ChannelOutboundAdapter.sendText / sendMedia (SPEC §2.5)
// ---------------------------------------------------------------------------

/** Delivery-shaped result without the channel id (attachedResults stamps it). */
type BasecampDeliveryResult = { messageId: string; target: { kind: "conversation"; id: string } };

async function postToTarget(
  target: ResolvedSendTarget,
  content: string,
  account: ResolvedBasecampAccount,
): Promise<BasecampDeliveryResult> {
  if (target.surface === "campfire") {
    const result = await postCampfireLine({
      bucketId: target.bucketId,
      transcriptId: target.targetId,
      content,
      account,
    });
    if (!result.ok) throwSendFailure(result, target);
    const messageId = result.recordingId ?? "";
    recordSendIdentity(account, target, messageId);
    return { messageId, target: { kind: "conversation", id: target.conversationId } };
  }

  const result = await postComment({
    bucketId: target.bucketId,
    recordingId: target.targetId,
    content,
    account,
  });
  if (!result.ok) throwSendFailure(result, target);
  const messageId = result.commentId ?? "";
  recordSendIdentity(account, target, messageId);
  return { messageId, target: { kind: "conversation", id: target.conversationId } };
}

/**
 * Real outbound text delivery for the shared `message` tool, cron/heartbeat
 * announce, and `openclaw message send`. Resolves the target grammar, converts
 * Markdown to Basecamp HTML, and posts a Campfire line or comment.
 */
export async function sendBasecampText(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  accountId?: string | null;
}): Promise<BasecampDeliveryResult> {
  const account = resolveBasecampAccount(params.cfg, params.accountId);
  const target = await resolveSendTarget(params.to, account);
  const content = markdownToBasecampHtml(params.text);
  return postToTarget(target, content, account);
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

const MEDIA_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  txt: "text/plain",
  json: "application/json",
  zip: "application/zip",
};

function mediaNameAndType(mediaUrl: string): { name: string; contentType: string } {
  const path = /^https?:\/\//.test(mediaUrl) ? new URL(mediaUrl).pathname : mediaUrl;
  const name = path.split("/").filter(Boolean).pop() || "attachment";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return { name, contentType: MEDIA_CONTENT_TYPES[ext] ?? "application/octet-stream" };
}

async function loadMediaBytes(params: {
  mediaUrl: string;
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<{ data: Uint8Array; contentType: string; name: string }> {
  const { mediaUrl, mediaReadFile } = params;
  const { name, contentType } = mediaNameAndType(mediaUrl);
  if (/^https?:\/\//.test(mediaUrl)) {
    const response = await fetch(mediaUrl);
    if (!response.ok) {
      notDispatched(`Failed to fetch media from ${mediaUrl}: HTTP ${response.status}`, { retryable: true });
    }
    const headerType = response.headers.get("content-type")?.split(";")[0]?.trim();
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      contentType: headerType || contentType,
      name,
    };
  }
  const buffer = mediaReadFile
    ? await mediaReadFile(mediaUrl)
    : await (await import("node:fs/promises")).readFile(mediaUrl);
  return { data: new Uint8Array(buffer), contentType, name };
}

/**
 * Real outbound media delivery.
 *
 * Comment surfaces embed the file natively: upload via POST /attachments.json,
 * then reference the attachable_sgid with a <bc-attachment> tag in the comment
 * body. Campfire lines reject <bc-attachment> (API validation error, probed
 * 2026-08-31), so chat targets get the caption plus the media URL, which
 * Basecamp autolinks — local files cannot be delivered to chat targets.
 */
export async function sendBasecampMedia(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  mediaUrl?: string;
  accountId?: string | null;
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<BasecampDeliveryResult> {
  const { to, text, mediaUrl } = params;
  if (!mediaUrl) {
    notDispatched(`No media URL provided for Basecamp media send to "${to}"`);
  }

  const account = resolveBasecampAccount(params.cfg, params.accountId);
  const target = await resolveSendTarget(to, account);

  if (target.surface === "campfire") {
    if (!/^https?:\/\//.test(mediaUrl)) {
      notDispatched(
        `Basecamp chat lines cannot embed uploaded files, and "${mediaUrl}" is not a shareable URL. ` +
          `Send media to a commentable recording (recording:<id>) instead.`,
      );
    }
    const caption = text.trim();
    const content = markdownToBasecampHtml(caption ? `${caption}\n${mediaUrl}` : mediaUrl);
    return postToTarget(target, content, account);
  }

  const media = await loadMediaBytes({ mediaUrl, mediaReadFile: params.mediaReadFile });
  let sgid: string | undefined;
  try {
    const client = getClient(account);
    const uploaded = await client.attachments.create(media.data, media.contentType, media.name);
    sgid = uploaded?.attachable_sgid;
  } catch (err) {
    // Upload failed before any message was posted — provably unsent.
    notDispatched(`Failed to upload media "${media.name}" to Basecamp: ${String(err)}`, {
      cause: err,
      retryable: isRetryableError(err),
    });
  }
  if (!sgid) {
    notDispatched(`Basecamp attachment upload for "${media.name}" returned no attachable_sgid`);
  }

  const escapedName = media.name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const attachmentTag =
    `<bc-attachment sgid="${sgid}" content-type="${media.contentType}" ` + `filename="${escapedName}"></bc-attachment>`;
  const caption = text.trim() ? markdownToBasecampHtml(text) : "";
  return postToTarget(target, caption ? `${caption}<br>${attachmentTag}` : attachmentTag, account);
}
