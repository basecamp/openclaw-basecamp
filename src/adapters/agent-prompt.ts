/**
 * Basecamp agent prompt adapter — channel-specific context hints for agents.
 *
 * Provides Basecamp-specific guidance to agents about peer ID formats,
 * mention conventions, threading model, surface types, and reactions.
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk";
import type { ResolvedBasecampAccount } from "../types.js";

// ChannelAgentPromptAdapter is not exported from the SDK, so extract it from ChannelPlugin.
type AgentPromptAdapter = NonNullable<ChannelPlugin<ResolvedBasecampAccount>["agentPrompt"]>;

export const basecampAgentPromptAdapter: AgentPromptAdapter = {
  messageToolHints: () => [
    "Basecamp peer IDs use the format recording:<id>, bucket:<id>, or ping:<id>.",
    "To @mention someone in Basecamp, use their bc-attachment SGID tag.",
    "Basecamp comments are flat per recording — there are no nested threads.",
    "Basecamp surfaces include: Campfire (real-time chat), Card Table (kanban), " +
      "Todo List, Check-in (recurring questions), Ping (direct messages), " +
      "Message Board, and Documents.",
    "Basecamp supports boost reactions on recordings.",
    "Campfire messages and Ping messages are delivered as chat lines. " +
      "All other surfaces receive comments on the recording.",
  ],
};
