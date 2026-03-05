/**
 * Basecamp groups adapter — per-bucket behavior configuration.
 *
 * Implements ChannelGroupAdapter for resolving requireMention, tool policies,
 * and group intro hints on a per-project (bucket) basis.
 */

import type { ChannelGroupAdapter, ChannelGroupContext } from "openclaw/plugin-sdk";
import type { BasecampBucketConfig, BasecampChannelConfig } from "../types.js";

function getBasecampSection(cfg: Record<string, unknown>): BasecampChannelConfig | undefined {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return channels?.basecamp as BasecampChannelConfig | undefined;
}

/**
 * Resolve bucket config: exact bucket ID match, then "*" wildcard fallback.
 */
export function resolveBasecampBucketConfig(
  cfg: Record<string, unknown>,
  bucketId: string | undefined,
): BasecampBucketConfig | undefined {
  const section = getBasecampSection(cfg);
  const buckets = section?.buckets;
  if (!buckets) return undefined;

  // Exact match
  if (bucketId && buckets[bucketId]) {
    return buckets[bucketId];
  }

  // Wildcard fallback
  return buckets["*"];
}

function extractBucketId(groupId?: string | null): string | undefined {
  if (!groupId) return undefined;
  // groupId may be "bucket:123" or just a recording peer — extract bucket from context
  const match = groupId.match(/^bucket:(\d+)$/);
  return match ? match[1] : undefined;
}

export const basecampGroupAdapter: ChannelGroupAdapter = {
  resolveRequireMention: ({ cfg, groupId }) => {
    const bucketId = extractBucketId(groupId);
    const bucketCfg = resolveBasecampBucketConfig(cfg as Record<string, unknown>, bucketId);
    return bucketCfg?.requireMention;
  },

  resolveToolPolicy: ({ cfg, groupId }) => {
    const bucketId = extractBucketId(groupId);
    const bucketCfg = resolveBasecampBucketConfig(cfg as Record<string, unknown>, bucketId);
    if (!bucketCfg?.tools) return undefined;
    return {
      allow: bucketCfg.tools.allow,
      deny: bucketCfg.tools.deny,
    };
  },

  resolveGroupIntroHint: () =>
    "This is a Basecamp project. Conversations happen across Campfire chats, " +
    "card tables, to-do lists, check-ins, message boards, and documents. " +
    "Use recording:<id>, bucket:<id>, or ping:<id> to reference Basecamp resources.",
};
