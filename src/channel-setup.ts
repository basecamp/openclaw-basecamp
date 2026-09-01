/**
 * Import-light plugin subset for `setup-entry.ts` (SPEC §1.4).
 *
 * This module must stay loadable without the Basecamp API client, webhooks,
 * poller, or dedup machinery — the host loads it for read-only status,
 * channels listings, and SecretRef scans without the full runtime. WP1 wires
 * it into `defineSetupPluginEntry`; WP2 moves `config`, `setupWizard`,
 * `setupContract`, and `secrets` here as their import graphs are lightened.
 * `src/channel.ts` spreads this subset into the full plugin.
 *
 * Shared touchpoint between WP1 and WP2 — extend, don't reshape.
 */

import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import { deleteAccountFromConfigSection, setAccountEnabledInConfigSection } from "openclaw/plugin-sdk/core";
import {
  BasecampConfigSchema,
  listBasecampAccountIds,
  resolveBasecampAccount,
  resolveBasecampAllowFrom,
  resolveDefaultBasecampAccountId,
} from "./config.js";
import type { BasecampChannelConfig, ResolvedBasecampAccount } from "./types.js";

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

/**
 * Channel config UI hints: SDK-standard hints (channel label, DM policy paths)
 * merged with Basecamp-specific field hints. Basecamp entries win on key
 * collisions. Consumed by the full plugin's `configSchema` and by
 * `scripts/generate-manifest.ts` for the checked-in manifest `channelConfigs`.
 */
export const basecampConfigUiHints = {
  ...createChannelConfigUiHints({
    channelLabel: "Basecamp",
    dmPolicy: { channelKey: "basecamp" },
  }),
  "accounts.*.tokenFile": {
    label: "Token file path",
    help: "Path to file containing OAuth token",
    sensitive: true,
  },
  "accounts.*.token": {
    label: "Token",
    help: "Inline OAuth token (prefer tokenFile)",
    sensitive: true,
    advanced: true,
  },
  "accounts.*.cliProfile": {
    label: "Basecamp CLI profile",
    help: "CLI profile for identity discovery during setup (not used at runtime)",
  },
  "accounts.*.personId": { label: "Person ID", help: "Your Basecamp person ID (numeric)" },
  "accounts.*.basecampAccountId": {
    label: "Basecamp Account ID",
    help: "Numeric Basecamp account ID (auto-set during onboarding)",
  },
  "accounts.*.oauthTokenFile": {
    label: "OAuth token file",
    help: "Path to OAuth token JSON (auto-managed)",
    sensitive: true,
  },
  "accounts.*.oauthClientId": {
    label: "OAuth Client ID (override)",
    help: "Override channel-level OAuth client ID for this account",
  },
  "accounts.*.oauthClientSecret": {
    label: "OAuth Client Secret (override)",
    help: "Override channel-level OAuth secret",
    sensitive: true,
  },
  "oauth.clientId": { label: "OAuth Client ID", help: "Basecamp OAuth app client ID for browser-based login" },
  "oauth.clientSecret": { label: "OAuth Client Secret", help: "Basecamp OAuth app secret", sensitive: true },
  personas: {
    label: "Agent personas",
    help: "Maps agent IDs to Basecamp account IDs for multi-identity outbound",
    advanced: true,
  },
  virtualAccounts: {
    label: "Project scopes",
    help: "Maps synthetic account IDs to specific projects",
    advanced: true,
  },
  dmPolicy: { label: "DM policy", help: "Controls who can DM agents: pairing, allowlist, open, disabled" },
  allowFrom: { label: "Allowed senders", help: "Basecamp person IDs allowed to message agents" },
  engage: {
    label: "Engagement policy",
    help: "Event types that trigger agent response: dm, mention, assignment, checkin, conversation, activity",
  },
  buckets: {
    label: "Per-project settings",
    help: "Override engage, requireMention, and tool policies per bucket",
    advanced: true,
  },
} satisfies NonNullable<NonNullable<ChannelPlugin["configSchema"]>["uiHints"]>;

/**
 * Channel config schema (JSON Schema + uiHints + runtime validator), built
 * from the Zod source of truth in `src/config.ts`. Single home for both the
 * full plugin and the setup subset; the manifest `channelConfigs.basecamp`
 * block is generated from it (`npm run manifest:gen`).
 */
export const basecampConfigSchema: NonNullable<ChannelPlugin["configSchema"]> = buildChannelConfigSchema(
  BasecampConfigSchema,
  { uiHints: basecampConfigUiHints },
);

/**
 * Config adapter: account listing/resolution and config-section edits, all
 * backed by the import-light `src/config.ts` helpers. Shared by the full
 * plugin and the setup subset so `openclaw channels list/status` work without
 * loading the runtime. WP2 rewrites this via `createScopedChannelConfigAdapter`.
 */
export const basecampConfigAdapter: ChannelPlugin<ResolvedBasecampAccount>["config"] = {
  listAccountIds: (cfg) => listBasecampAccountIds(cfg),
  resolveAccount: (cfg, accountId) => resolveBasecampAccount(cfg, accountId),
  defaultAccountId: (cfg) => resolveDefaultBasecampAccountId(cfg),
  isConfigured: (account) =>
    Boolean(account.token?.trim() || account.config.tokenFile || account.config.oauthTokenFile),
  isEnabled: (account) => account.enabled,
  disabledReason: () => "Manually disabled",
  unconfiguredReason: () => "No token or OAuth token file configured",
  describeAccount: (account) => ({
    accountId: account.accountId,
    name: account.displayName,
    enabled: account.enabled,
    configured: Boolean(account.token?.trim() || account.config.tokenFile || account.config.oauthTokenFile),
    tokenSource: account.tokenSource,
    cliProfile: account.cliProfile,
  }),
  setAccountEnabled: ({ cfg, accountId, enabled }) =>
    setAccountEnabledInConfigSection({ cfg, sectionKey: "basecamp", accountId, enabled }),
  deleteAccount: ({ cfg, accountId }) => {
    const updated = deleteAccountFromConfigSection({
      cfg,
      sectionKey: "basecamp",
      accountId,
    });
    // Clean up persona entries pointing to the deleted account
    const section = updated.channels?.basecamp as BasecampChannelConfig | undefined;
    if (section?.personas) {
      const cleaned = { ...section.personas };
      for (const [agentId, targetId] of Object.entries(cleaned)) {
        if (targetId === accountId) delete cleaned[agentId];
      }
      (updated.channels!.basecamp as any).personas = cleaned;
    }
    return updated;
  },
  resolveAllowFrom: ({ cfg }) => resolveBasecampAllowFrom(cfg),
  formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => `Person ${entry}`),
};

/**
 * Import-light plugin subset consumed by `setup-entry.ts`.
 *
 * WP2 adds `setupWizard`, `setupContract`, and `secrets` here once their
 * import graphs are light — add slots below, keep the existing names.
 */
export const basecampSetupPlugin: Pick<
  ChannelPlugin<ResolvedBasecampAccount>,
  "id" | "meta" | "capabilities" | "configSchema" | "config"
> = {
  id: "basecamp",
  meta: basecampChannelMeta,
  capabilities: basecampChannelCapabilities,
  configSchema: basecampConfigSchema,
  config: basecampConfigAdapter,
};
