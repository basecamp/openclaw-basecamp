/**
 * Basecamp mentions adapter — strip @mention artifacts from inbound text.
 *
 * Basecamp @mentions use `<bc-attachment sgid="...">Name</bc-attachment>`
 * HTML tags. The inbound pipeline strips HTML to plain text before the agent
 * sees it, but the mentioned person's name remains inline. This adapter
 * strips the agent's own display name when it appears as a mention artifact
 * at the start of a message.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ChannelMentionAdapter } from "openclaw/plugin-sdk/channel-runtime";
import type { BasecampChannelConfig } from "../types.js";

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

/**
 * Resolve the Basecamp account ID for an agent, using persona mapping.
 * agentId may be an OpenClaw agent ID that maps to a Basecamp account via
 * the personas config. Falls back to treating agentId as a direct account key.
 */
function resolveAccountIdForAgent(cfg: OpenClawConfig, agentId?: string): string | undefined {
  if (!agentId) return undefined;
  const section = getBasecampSection(cfg);
  // Check persona mapping: agentId → accountId
  const personaAccountId = section?.personas?.[agentId];
  if (personaAccountId) return personaAccountId;
  // Fall back to treating agentId as a direct account key
  if (section?.accounts?.[agentId]) return agentId;
  return undefined;
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

  // Without a resolved accountId, don't fall back to an arbitrary account's
  // displayName — in multi-persona setups that could strip legitimate text.
  return undefined;
}

export const basecampMentionAdapter: ChannelMentionAdapter = {
  stripPatterns: ({ cfg, agentId }) => {
    const accountId = cfg ? resolveAccountIdForAgent(cfg, agentId) : agentId;
    const name = resolveAgentDisplayName(cfg, accountId);
    if (!name) return [];
    // Match agent's display name at the start of text, followed by
    // optional punctuation and whitespace (common mention artifact pattern)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [`^${escaped}[,:]?\\s*`];
  },

  stripMentions: ({ text, cfg, agentId }) => {
    const accountId = cfg ? resolveAccountIdForAgent(cfg, agentId) : agentId;
    const name = resolveAgentDisplayName(cfg, accountId);
    if (!name) return text;

    // Strip agent's display name from the start of the message
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped}[,:]?\\s*`, "i");
    return text.replace(pattern, "").trim();
  },
};
