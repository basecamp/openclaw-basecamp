/**
 * Import-light plugin subset for `setup-entry.ts` (SPEC §1.4).
 *
 * This module must stay loadable without the Basecamp API client, webhooks,
 * poller, or dedup machinery — the host loads it for read-only status,
 * channels listings, and SecretRef scans without the full runtime. WP1 wires
 * it into `defineSetupPluginEntry`; WP2 moves `configSchema`, `config`,
 * `setupWizard`, `setupContract`, and `secrets` here as their import graphs
 * are lightened. `src/channel.ts` spreads this subset into the full plugin.
 *
 * Shared touchpoint between WP1 and WP2 — extend, don't reshape.
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";

export const basecampChannelMeta = {
  id: "basecamp",
  label: "Basecamp",
  selectionLabel: "Basecamp (Campfire, Cards, Todos, Check-ins, Pings)",
  docsPath: "/channels/basecamp",
  docsLabel: "basecamp",
  blurb:
    "Campfire chats, card tables, to-do lists, check-ins, pings — every Basecamp surface as a live agent interaction point.",
  systemImage: "building.2",
} satisfies ChannelPlugin["meta"];

export const basecampChannelCapabilities = {
  chatTypes: ["direct", "group"],
  threads: false,
  reactions: true,
  media: false,
  nativeCommands: false,
  blockStreaming: false,
} satisfies ChannelPlugin["capabilities"];
