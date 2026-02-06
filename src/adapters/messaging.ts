/**
 * Basecamp messaging adapter — target normalization and display formatting.
 *
 * Implements ChannelMessagingAdapter for normalizing Basecamp peer IDs
 * (recording:<id>, bucket:<id>, ping:<id>) and formatting them for display.
 */

import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk";

const PEER_PATTERN = /^(recording|bucket|ping):\d+$/;

export const basecampMessagingAdapter: ChannelMessagingAdapter = {
  normalizeTarget: (raw) => {
    // Already in canonical form
    if (PEER_PATTERN.test(raw)) return raw;

    // Bare numeric → recording:<id>
    if (/^\d+$/.test(raw)) return `recording:${raw}`;

    // Strip basecamp: prefix and recurse
    if (raw.startsWith("basecamp:")) {
      const stripped = raw.slice("basecamp:".length);
      if (PEER_PATTERN.test(stripped)) return stripped;
      if (/^\d+$/.test(stripped)) return `recording:${stripped}`;
    }

    return undefined;
  },

  targetResolver: {
    looksLikeId: (raw) => {
      if (PEER_PATTERN.test(raw)) return true;
      if (/^\d+$/.test(raw)) return true;
      if (raw.startsWith("basecamp:")) {
        const stripped = raw.slice("basecamp:".length);
        return PEER_PATTERN.test(stripped) || /^\d+$/.test(stripped);
      }
      return false;
    },
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
};
