/**
 * Basecamp mentions adapter — strip @mention artifacts from inbound text.
 *
 * Basecamp @mentions use `<bc-attachment sgid="...">Name</bc-attachment>`
 * HTML tags. The inbound pipeline strips HTML to plain text before the agent
 * sees it, but the mentioned person's name remains inline. This adapter
 * strips the agent's own display name when it appears as a mention artifact
 * at the start of a message.
 */

import type { ChannelMentionAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
import type { BasecampChannelConfig } from "../types.js";

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

/**
 * Resolve the agent's display name for a given account.
 * Uses the account config's displayName field.
 */
function resolveAgentDisplayName(cfg: OpenClawConfig | undefined, accountId?: string): string | undefined {
  if (!cfg) return undefined;
  const section = getBasecampSection(cfg);
  if (!section?.accounts) return undefined;

  // If accountId matches a specific account, use its displayName
  if (accountId && section.accounts[accountId]) {
    return section.accounts[accountId]!.displayName;
  }

  // Fall back to first account with a displayName
  for (const acct of Object.values(section.accounts)) {
    if (acct.displayName) return acct.displayName;
  }

  return undefined;
}

export const basecampMentionAdapter: ChannelMentionAdapter = {
  stripPatterns: ({ cfg, agentId }) => {
    const name = resolveAgentDisplayName(cfg, agentId);
    if (!name) return [];
    // Match agent's display name at the start of text, followed by
    // optional punctuation and whitespace (common mention artifact pattern)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [`^${escaped}[,:]?\\s*`];
  },

  stripMentions: ({ text, cfg, agentId }) => {
    const name = resolveAgentDisplayName(cfg, agentId);
    if (!name) return text;

    // Strip agent's display name from the start of the message
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped}[,:]?\\s*`, "i");
    return text.replace(pattern, "").trim();
  },
};
