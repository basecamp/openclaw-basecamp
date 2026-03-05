/**
 * Basecamp agent prompt adapter — channel-specific context hints for agents.
 *
 * Provides Basecamp-specific guidance to agents about peer ID formats,
 * mention conventions, threading model, surface types, and reactions.
 * Hints are context-aware: virtual accounts, personas, and bucket configs
 * produce additional guidance when present.
 */

import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import type { BasecampChannelConfig, ResolvedBasecampAccount } from "../types.js";

// ChannelAgentPromptAdapter is not exported from the SDK, so extract it from ChannelPlugin.
type AgentPromptAdapter = NonNullable<ChannelPlugin<ResolvedBasecampAccount>["agentPrompt"]>;

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

const STATIC_HINTS = [
  "Basecamp peer IDs use the format recording:<id>, bucket:<id>, or ping:<id>.",
  "To @mention someone in Basecamp, use their bc-attachment SGID tag.",
  "Basecamp comments are flat per recording — there are no nested threads.",
  "Basecamp surfaces include: Campfire (real-time chat), Card Table (kanban), " +
    "Todo List, Check-in (recurring questions), Ping (direct messages), " +
    "Message Board, and Documents.",
  "Basecamp supports boost reactions on recordings.",
  "Campfire messages and Ping messages are delivered as chat lines. " +
    "All other surfaces receive comments on the recording.",
];

export const basecampAgentPromptAdapter: AgentPromptAdapter = {
  messageToolHints: ({ cfg, accountId }) => {
    const hints = [...STATIC_HINTS];
    const section = getBasecampSection(cfg);
    if (!section) return hints;

    // Virtual account (project-scoped) context
    if (accountId && section.virtualAccounts?.[accountId]) {
      const va = section.virtualAccounts[accountId];
      hints.push(
        `This account is project-scoped to bucket ${va.bucketId}. ` +
          `Messages are limited to this specific Basecamp project.`,
      );
    }

    // Persona mapping context
    if (section.personas && Object.keys(section.personas).length > 0) {
      hints.push(
        "This channel uses persona mappings — different agents may send " + "as different Basecamp identities.",
      );
    }

    // Bucket-level requireMention settings
    if (section.buckets) {
      const mentionBuckets = Object.entries(section.buckets)
        .filter(([, v]) => v?.requireMention === true)
        .map(([k]) => k);
      if (mentionBuckets.length > 0) {
        hints.push(`Some projects require @mention to trigger the agent: bucket(s) ${mentionBuckets.join(", ")}.`);
      }
    }

    return hints;
  },
};
