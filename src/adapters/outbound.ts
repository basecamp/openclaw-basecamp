/**
 * Basecamp outbound adapter helpers — target validation and chunking.
 *
 * Target grammar (SPEC §2.5):
 *   recording:<id>            — reply to a known recording (recording→bucket index)
 *   ping:<id>                 — Circle (Ping) chat, id = circle bucket id
 *   bucket:<id>               — Campfire line to the project's default chat
 *   bucket:<b>/recording:<r>  — cold send to a recording with explicit bucket
 *
 * Chunking is delegated to the SDK core chunker (chunkerMode: "markdown" +
 * textChunkLimit on the outbound adapter, SPEC §2.8); the compatibility
 * wrapper below exists only for src/dispatch.ts.
 */

import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";

/** Basecamp's per-message character limit. Shared by channel config and dispatch. */
export const BASECAMP_TEXT_CHUNK_LIMIT = 10_000;

/**
 * Parsed form of an outbound target string.
 *
 * Grammar:
 *   recording:<id>                — reply to a known recording (resolved via
 *                                   the recording→bucket index)
 *   bucket:<b>/recording:<r>      — cold send to a recording with explicit bucket
 *   bucket:<id>                   — Campfire line to the project's default chat
 *   ping:<id>                     — line to a Circle (Ping) chat, id = circle bucket id
 */
export type ParsedOutboundTarget =
  | { kind: "recording"; recordingId: string; bucketId?: string }
  | { kind: "ping"; bucketId: string }
  | { kind: "bucket"; bucketId: string };

/** Parse an outbound target string. Undefined when the grammar does not match. */
export function parseOutboundTarget(to: string): ParsedOutboundTarget | undefined {
  const cold = /^bucket:(\d+)\/recording:(\d+)$/.exec(to);
  if (cold) return { kind: "recording", recordingId: cold[2]!, bucketId: cold[1]! };
  const simple = /^(recording|ping|bucket):(\d+)$/.exec(to);
  if (!simple) return undefined;
  const id = simple[2]!;
  switch (simple[1]) {
    case "recording":
      return { kind: "recording", recordingId: id };
    case "ping":
      return { kind: "ping", bucketId: id };
    default:
      return { kind: "bucket", bucketId: id };
  }
}

export type ResolveTargetResult = { ok: true; to: string } | { ok: false; error: string };

/**
 * Validate an outbound target for direct sendText/sendMedia delivery.
 * Grammar-level validation only — index lookups and API resolution happen
 * inside the send path (sendBasecampText / sendBasecampMedia), which throws
 * PlatformMessageNotDispatchedError with a fix-naming message on a miss.
 */
export function resolveOutboundTarget(to: string): ResolveTargetResult {
  if (!to) {
    return { ok: false, error: "Target is empty" };
  }
  const parsed = parseOutboundTarget(to);
  if (parsed) {
    return { ok: true, to };
  }
  return {
    ok: false,
    error:
      `Invalid Basecamp target "${to}". ` +
      `Expected recording:<id>, ping:<id>, bucket:<id>, or bucket:<id>/recording:<id>`,
  };
}

/**
 * Compatibility wrapper around the SDK core markdown chunker.
 *
 * The bespoke paragraph/sentence/word splitter this file used to implement is
 * superseded by the SDK chunker (fence-aware, paragraph-preferring in
 * "newline" mode). Only src/dispatch.ts still calls this directly; the SDK
 * outbound pipeline chunks via `chunkerMode: "markdown"` + `textChunkLimit`
 * and does not use this function. Remove once the inbound turn kernel
 * (SPEC §2.2) replaces the dispatch bridge's manual chunk loop.
 */
export function chunkMarkdownText(text: string, limit: number): string[] {
  return chunkMarkdownTextWithMode(text, limit, "newline");
}
