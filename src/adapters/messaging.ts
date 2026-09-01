/**
 * Basecamp messaging adapter — target grammar and session routing (SPEC §2.20).
 *
 * Peer IDs stay `recording:<id>` / `bucket:<id>` / `ping:<id>` (PLAN peer
 * model). The adapter declares the channel's target prefixes, infers chat
 * type before directory lookup, resolves session conversations with
 * bucket-parent candidates (via the recording index), and builds outbound
 * session routes with the canonical SDK helper.
 */

import { buildChannelOutboundSessionRoute, stripChannelTargetPrefix } from "openclaw/plugin-sdk/channel-core";
import { findRecordingEntrySync } from "../inbound/recording-index.js";
import type { ChannelMessagingAdapter } from "../sdk-types.js";

const PEER_PATTERN = /^(recording|bucket|ping):\d+$/;

/** Normalize a raw target to canonical peer form, or undefined when invalid. */
function normalizeBasecampTarget(raw: string): string | undefined {
  const stripped = stripChannelTargetPrefix(raw.trim(), "basecamp", "bc");
  if (PEER_PATTERN.test(stripped)) return stripped;
  // Bare numeric → recording:<id>
  if (/^\d+$/.test(stripped)) return `recording:${stripped}`;
  return undefined;
}

export const basecampMessagingAdapter: ChannelMessagingAdapter = {
  /** Provider prefixes accepted in explicit targets (SPEC §2.20). */
  targetPrefixes: ["basecamp", "bc"],

  normalizeTarget: (raw) => normalizeBasecampTarget(raw),

  /**
   * Chat-type inference before directory lookup: pings are direct
   * conversations, recordings and buckets are group surfaces.
   */
  inferTargetChatType: ({ to }) => {
    const normalized = normalizeBasecampTarget(to);
    if (!normalized) return undefined;
    return normalized.startsWith("ping:") ? "direct" : "group";
  },

  /**
   * Canonical session-conversation grammar: a recording conversation's parent
   * is its owning bucket (project), resolved through the recording index so
   * project-level bindings and inheritance work for any recording the inbound
   * fabric has seen. Candidates are ordered narrowest → broadest.
   */
  resolveSessionConversation: ({ rawId }) => {
    const normalized = normalizeBasecampTarget(rawId) ?? rawId;
    const match = normalized.match(/^recording:(\d+)$/);
    if (!match) return { id: normalized };

    const entry = findRecordingEntrySync(match[1]);
    if (!entry) return { id: normalized };

    const bucketConversationId = `bucket:${entry.bucketId}`;
    return {
      id: normalized,
      baseConversationId: bucketConversationId,
      parentConversationCandidates: [bucketConversationId],
    };
  },

  targetResolver: {
    looksLikeId: (raw) => normalizeBasecampTarget(raw) !== undefined,
    hint: "recording:<id> | bucket:<id> | ping:<id>",
  },

  formatTargetDisplay: ({ target }) => {
    const match = target.match(/^(recording|bucket|ping):(\d+)$/);
    if (!match) return target;

    const [, kind, id] = match;
    switch (kind) {
      case "recording":
        return `Recording ${id}`;
      case "bucket":
        return `Project ${id}`;
      case "ping":
        return `Ping ${id}`;
      default:
        return target;
    }
  },

  /**
   * Provider session-route builder (SPEC §2.20): pings route as direct
   * conversations, recordings/buckets as groups. Inbound delivery uses the
   * same canonical peer IDs, so the recipient session is exact.
   */
  resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
    const normalized = normalizeBasecampTarget(target);
    if (!normalized) return null;

    const chatType = normalized.startsWith("ping:") ? ("direct" as const) : ("group" as const);
    return buildChannelOutboundSessionRoute({
      cfg,
      agentId,
      channel: "basecamp",
      accountId,
      recipientSessionExact: true,
      peer: { kind: chatType, id: normalized },
      chatType,
      from: `basecamp:${normalized}`,
      to: normalized,
    });
  },
};
