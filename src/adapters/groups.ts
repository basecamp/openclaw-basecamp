/**
 * Basecamp groups adapter — per-bucket behavior configuration (SPEC §2.22).
 *
 * The `buckets` config key stays (PLAN naming), backed by the SDK scope-tree
 * helpers: bucket configs become scope nodes so requireMention and tool
 * policies (including `toolsBySender` / `senderPolicyMode`) resolve through
 * the shared `resolveScopeToolsPolicy` / `resolveScopeRequireMention` logic
 * with exact-bucket → wildcard fallback.
 */

import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import type { ScopeTree } from "openclaw/plugin-sdk/channel-policy";
import { resolveScopeRequireMention, resolveScopeToolsPolicy } from "openclaw/plugin-sdk/channel-policy";
import type { ChannelGroupAdapter } from "../sdk-types.js";
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

/**
 * Project the `buckets` config into the SDK groups scope tree: the wildcard
 * entry becomes `defaults`, every other bucket a scope node keyed by id.
 */
export function buildBasecampScopeTree(cfg: Record<string, unknown>): ScopeTree {
  const { "*": defaults, ...buckets } = getBasecampSection(cfg)?.buckets ?? {};
  const scopes: ScopeTree["scopes"] = {};
  for (const [bucketId, bucket] of Object.entries(buckets)) {
    if (!bucket) continue;
    scopes[bucketId] = {
      requireMention: bucket.requireMention,
      tools: bucket.tools,
      toolsBySender: bucket.toolsBySender,
    };
  }
  return {
    defaults: defaults
      ? {
          requireMention: defaults.requireMention,
          tools: defaults.tools,
          toolsBySender: defaults.toolsBySender,
        }
      : undefined,
    scopes,
  };
}

function extractBucketId(groupId?: string | null): string | undefined {
  if (!groupId) return undefined;
  // groupId may be "bucket:123" or just a recording peer — extract bucket from context
  const match = groupId.match(/^bucket:(\d+)$/);
  return match ? match[1] : undefined;
}

function scopePath(groupId?: string | null): string[] {
  const bucketId = extractBucketId(groupId);
  return bucketId ? [bucketId] : [];
}

export const basecampGroupAdapter: ChannelGroupAdapter = {
  resolveRequireMention: ({ cfg, groupId }) => {
    const tree = buildBasecampScopeTree(cfg as Record<string, unknown>);
    // Undefined when nothing configures it — the caller applies channel defaults.
    const path = scopePath(groupId);
    const configured =
      path.some((key) => Object.hasOwn(tree.scopes, key) && tree.scopes[key]?.requireMention !== undefined) ||
      tree.defaults?.requireMention !== undefined;
    if (!configured) return undefined;
    return resolveScopeRequireMention({ tree, path });
  },

  resolveToolPolicy: (context: ChannelGroupContext) => {
    const tree = buildBasecampScopeTree(context.cfg as Record<string, unknown>);
    return resolveScopeToolsPolicy({
      tree,
      path: scopePath(context.groupId),
      senderPolicyMode: context.senderPolicyMode,
      senderId: context.senderId,
      senderName: context.senderName,
      senderUsername: context.senderUsername,
      senderE164: context.senderE164,
    });
  },
};
