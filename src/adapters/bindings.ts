/**
 * Configured-binding provider (SPEC §2.21).
 *
 * Formalizes project-level bindings: an `agents.bindings[]` rule whose
 * `match.peer.id` is `bucket:<id>` matches every conversation inside that
 * project — `recording:<id>` conversations whose parent is the bucket (from
 * the inbound event's parent peer, or the recording→bucket index for cold
 * lookups) and the bucket conversation itself. Exact recording bindings win
 * over bucket bindings via `matchPriority`.
 *
 * Peer grammar stays `recording:<id>` / `bucket:<id>` / `ping:<id>` (PLAN
 * peer model); `basecamp:`/`bc:` prefixes and bare recording ids are
 * normalized the same way the messaging adapter normalizes targets.
 */

import { stripChannelTargetPrefix } from "openclaw/plugin-sdk/channel-core";
import { findRecordingEntrySync } from "../inbound/recording-index.js";
import type { ChannelConfiguredBindingProvider } from "../sdk-types.js";

/** Exact conversation match (recording, bucket, or ping binding on itself). */
export const BINDING_MATCH_PRIORITY_EXACT = 2;
/** Bucket binding matched through a recording's parent project. */
export const BINDING_MATCH_PRIORITY_BUCKET = 1;

const PEER_PATTERN = /^(recording|bucket|ping):\d+$/;

/** Normalize a raw binding/conversation id to canonical peer form. */
export function normalizeBindingConversationId(raw: string): string | undefined {
  const stripped = stripChannelTargetPrefix(raw.trim(), "basecamp", "bc");
  if (PEER_PATTERN.test(stripped)) return stripped;
  if (/^\d+$/.test(stripped)) return `recording:${stripped}`;
  return undefined;
}

/** Owning bucket conversation for a recording peer, when the index has seen it. */
function resolveIndexedParent(conversationId: string): string | undefined {
  const match = conversationId.match(/^recording:(\d+)$/);
  if (!match) return undefined;
  const entry = findRecordingEntrySync(match[1]);
  return entry ? `bucket:${entry.bucketId}` : undefined;
}

/** Canonical conversation ref: normalized id plus its bucket parent when known. */
function toConversationRef(
  raw: string,
  parentConversationId?: string,
): { conversationId: string; parentConversationId?: string } | null {
  const conversationId = normalizeBindingConversationId(raw);
  if (!conversationId) return null;
  const parent =
    (parentConversationId ? normalizeBindingConversationId(parentConversationId) : undefined) ??
    resolveIndexedParent(conversationId);
  return parent ? { conversationId, parentConversationId: parent } : { conversationId };
}

export const basecampBindingsProvider: ChannelConfiguredBindingProvider = {
  // Buckets and pings are top-level conversations that are their own parent;
  // recordings carry an explicit bucket parent whenever it is known.
  selfParentConversationByDefault: true,

  compileConfiguredBinding: ({ conversationId }) => toConversationRef(conversationId),

  matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) => {
    const incoming = toConversationRef(conversationId, parentConversationId);
    if (!incoming) return null;

    if (incoming.conversationId === compiledBinding.conversationId) {
      return { ...incoming, matchPriority: BINDING_MATCH_PRIORITY_EXACT };
    }

    const bindsBucket = compiledBinding.conversationId.startsWith("bucket:");
    if (bindsBucket && incoming.parentConversationId === compiledBinding.conversationId) {
      return { ...incoming, matchPriority: BINDING_MATCH_PRIORITY_BUCKET };
    }

    return null;
  },

  // Command conversations resolve from the originating target first, then
  // the command's explicit target, then the session fallback — the same
  // order core uses for other chat channels.
  resolveCommandConversation: ({ originatingTo, commandTo, fallbackTo }) => {
    for (const candidate of [originatingTo, commandTo, fallbackTo]) {
      if (!candidate) continue;
      const ref = toConversationRef(candidate);
      if (ref) return ref;
    }
    return null;
  },
};
