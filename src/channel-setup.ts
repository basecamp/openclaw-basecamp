/**
 * Import-light plugin subset for `setup-entry.ts` (SPEC §1.4, §2.10, §2.11).
 *
 * This module must stay loadable without the Basecamp API client, webhooks,
 * poller, or dedup machinery — the host loads it for read-only status,
 * channels listings, and SecretRef scans without the full runtime. WP1 wires
 * it into `defineSetupPluginEntry`; `src/channel.ts` spreads this subset into
 * the full plugin.
 *
 * Shared touchpoint between WP1 and WP2 — extend, don't reshape.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { createScopedChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import {
  collectNestedChannelFieldAssignments,
  createChannelSecretTargetRegistryEntries,
  createSimpleChannelSecretContract,
  getChannelSurface,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
import { applyAccountNameToChannelSection } from "openclaw/plugin-sdk/setup";
import { basecampSetupWizard } from "./adapters/onboarding.js";
import {
  BasecampConfigSchema,
  expandTokenFilePath,
  inspectSecretValue,
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
  media: true,
  nativeCommands: false,
  blockStreaming: false,
} satisfies ChannelPlugin["capabilities"];

// ---------------------------------------------------------------------------
// Config schema slot (SPEC §2.10)
// ---------------------------------------------------------------------------

const basecampUiHints = {
  ...createChannelConfigUiHints({ channelLabel: "Basecamp", dmPolicy: { channelKey: "basecamp" } }),
  "accounts.*.tokenFile": {
    label: "Token file path",
    help: "Path to file containing OAuth token",
    sensitive: true,
  },
  "accounts.*.token": {
    label: "Token",
    help: "Inline OAuth token or SecretRef (prefer a SecretRef or tokenFile)",
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
  webhookSecret: {
    label: "Webhook secret",
    help: "Secret token (or SecretRef) for webhook URL verification",
    sensitive: true,
  },
  allowFrom: { label: "Allowed senders", help: "Basecamp person IDs allowed to message agents" },
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
  engage: {
    label: "Engagement policy",
    help: "Event types that trigger agent response: dm, mention, assignment, checkin, conversation, activity",
  },
  buckets: {
    label: "Per-project settings",
    help: "Override engage, requireMention, and tool policies per bucket",
    advanced: true,
  },
};

export const basecampConfigSchema: NonNullable<ChannelPlugin["configSchema"]> = buildChannelConfigSchema(
  BasecampConfigSchema,
  { uiHints: basecampUiHints },
);

// ---------------------------------------------------------------------------
// Config adapter slot (SPEC §2.10)
// ---------------------------------------------------------------------------

function getBasecampSection(cfg: Parameters<typeof listBasecampAccountIds>[0]): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

function isAccountConfigured(account: ResolvedBasecampAccount): boolean {
  return account.tokenSource !== "none";
}

/** Redacted per-account view for `openclaw channels inspect` and Control UI. */
export function inspectBasecampAccount(cfg: Parameters<typeof resolveBasecampAccount>[0], accountId?: string | null) {
  const account = resolveBasecampAccount(cfg, accountId);
  const tokenStatus = inspectSecretValue(
    account.config.token,
    `channels.basecamp.accounts.${account.accountId}.token`,
  ).status;
  return {
    accountId: account.accountId,
    name: account.displayName,
    enabled: account.enabled,
    configured: isAccountConfigured(account),
    tokenSource: account.tokenSource,
    tokenStatus,
    personId: account.personId || undefined,
    basecampAccountId: account.config.basecampAccountId,
    cliProfile: account.cliProfile,
    hasOAuthTokenFile: Boolean(account.config.oauthTokenFile),
    scopedBucketId: account.scopedBucketId,
  };
}

function resolveLinkState(account: ResolvedBasecampAccount): "linked" | "not-linked" | "unknown" {
  switch (account.tokenSource) {
    case "oauth":
      return existsSync(account.config.oauthTokenFile ?? "") ? "linked" : "not-linked";
    case "tokenFile": {
      const path = account.config.tokenFile;
      return path && existsSync(expandTokenFilePath(path, { homedir, resolve })) ? "linked" : "not-linked";
    }
    case "config":
      // Inline token, or a SecretRef the host materializes at runtime.
      return account.token ? "linked" : "unknown";
    case "none":
      return "not-linked";
  }
}

type AllowFromAccessorAccount = { effectiveAllowFrom: string[] };

const scopedConfigAdapter = createScopedChannelConfigAdapter<ResolvedBasecampAccount, AllowFromAccessorAccount>({
  sectionKey: "basecamp",
  listAccountIds: (cfg) => listBasecampAccountIds(cfg),
  resolveAccount: (cfg, accountId) => resolveBasecampAccount(cfg, accountId),
  defaultAccountId: (cfg) => resolveDefaultBasecampAccountId(cfg),
  inspectAccount: (cfg, accountId) => inspectBasecampAccount(cfg, accountId),
  clearBaseFields: [],
  resolveAllowFrom: (account) => account.effectiveAllowFrom,
  formatAllowFrom: (allowFrom) => allowFrom.map((entry) => `Person ${entry}`),
  resolveAccessorAccount: ({ cfg, accountId }) => ({
    effectiveAllowFrom: resolveBasecampAllowFrom(cfg, accountId),
  }),
});

export const basecampConfigAdapter = {
  ...scopedConfigAdapter,
  isConfigured: (account) => isAccountConfigured(account),
  isEnabled: (account) => account.enabled,
  disabledReason: () => "Manually disabled",
  unconfiguredReason: () => "No token or OAuth token file configured",
  isLinked: (account) => resolveLinkState(account),
  unlinkedReason: (account) =>
    account.tokenSource === "oauth"
      ? `OAuth token file missing (${account.config.oauthTokenFile}) — run \`openclaw channels login --channel basecamp\``
      : "No credentials linked — run `openclaw channels add basecamp` to authenticate",
  describeAccount: (account) => ({
    accountId: account.accountId,
    name: account.displayName,
    enabled: account.enabled,
    configured: isAccountConfigured(account),
    tokenSource: account.tokenSource,
    cliProfile: account.cliProfile,
  }),
  deleteAccount: ({ cfg, accountId }) => {
    const updated = scopedConfigAdapter.deleteAccount!({ cfg, accountId });
    // Clean up persona entries pointing to the deleted account
    const section = getBasecampSection(updated);
    if (section?.personas) {
      const cleaned = { ...section.personas };
      for (const [agentId, targetId] of Object.entries(cleaned)) {
        if (targetId === accountId) delete cleaned[agentId];
      }
      return {
        ...updated,
        channels: {
          ...updated.channels,
          basecamp: { ...section, personas: cleaned },
        },
      };
    }
    return updated;
  },
} satisfies ChannelPlugin<ResolvedBasecampAccount>["config"];

// ---------------------------------------------------------------------------
// Setup contract slot (SPEC §2.11)
// ---------------------------------------------------------------------------

export const basecampSetupContract: NonNullable<ChannelPlugin["setupContract"]> = defineChannelSetupContract({
  fields: {
    token: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token <token>", description: "Basecamp OAuth/bearer token" },
    },
    tokenFile: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--token-file <path>", description: "Path to a file containing the Basecamp token" },
    },
    personId: {
      kind: "string",
      cli: { flags: "--person-id <id>", description: "Basecamp person ID for the service account" },
    },
    basecampAccountId: {
      kind: "string",
      cli: { flags: "--basecamp-account-id <id>", description: "Numeric Basecamp account ID for API calls" },
    },
    oauthClientId: {
      kind: "string",
      cli: { flags: "--oauth-client-id <id>", description: "Basecamp OAuth app client ID" },
    },
    oauthClientSecret: {
      kind: "string",
      sensitive: true,
      cli: { flags: "--oauth-client-secret <secret>", description: "Basecamp OAuth app client secret" },
    },
    cliProfile: {
      kind: "string",
      cli: { flags: "--cli-profile <name>", description: "Basecamp CLI profile for setup identity discovery" },
    },
  },
  adapter: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId ?? ""),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({ cfg, channelKey: "basecamp", accountId, name }),
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "basecamp",
        accountId,
        name: input.name,
      });

      const section = getBasecampSection(namedConfig) ?? {};
      const accounts = (section.accounts ?? {}) as Record<string, Record<string, unknown>>;
      const existingAccount = accounts[accountId] ?? {};

      const tokenConfig = input.tokenFile ? { tokenFile: input.tokenFile } : input.token ? { token: input.token } : {};

      return {
        ...namedConfig,
        channels: {
          ...namedConfig.channels,
          basecamp: {
            ...section,
            enabled: true,
            accounts: {
              ...accounts,
              [accountId]: {
                ...existingAccount,
                enabled: true,
                ...tokenConfig,
                ...(input.personId ? { personId: input.personId } : {}),
                ...(input.basecampAccountId ? { basecampAccountId: input.basecampAccountId } : {}),
                ...(input.oauthClientId ? { oauthClientId: input.oauthClientId } : {}),
                ...(input.oauthClientSecret ? { oauthClientSecret: input.oauthClientSecret } : {}),
                ...(input.cliProfile ? { cliProfile: input.cliProfile } : {}),
              },
            },
          },
        },
      };
    },
  },
});

// ---------------------------------------------------------------------------
// Secrets contract slot (SPEC §2.10)
// ---------------------------------------------------------------------------

const simpleSecretContract = createSimpleChannelSecretContract({
  channelKey: "basecamp",
  label: "Basecamp",
  accountFields: ["token", "oauthClientSecret"],
  channelFields: ["webhookSecret"],
  mode: "account-inheritance",
});

const nestedOAuthSecretEntries = createChannelSecretTargetRegistryEntries({
  channelKey: "basecamp",
  channel: [{ path: "oauth.clientSecret" }],
});

export const basecampSecrets = {
  secretTargetRegistryEntries: [...simpleSecretContract.secretTargetRegistryEntries, ...nestedOAuthSecretEntries],
  collectRuntimeConfigAssignments: (params) => {
    simpleSecretContract.collectRuntimeConfigAssignments(params);
    // Channel-level oauth.clientSecret is nested — collect it separately.
    const resolved = getChannelSurface(params.config, "basecamp");
    if (!resolved) return;
    collectNestedChannelFieldAssignments({
      channelKey: "basecamp",
      nestedKey: "oauth",
      field: "clientSecret",
      channel: resolved.channel,
      surface: resolved.surface,
      defaults: params.defaults,
      context: params.context,
      topLevelActive: resolved.surface.channelEnabled,
      topInactiveReason: "Basecamp channel is disabled.",
      accountActive: (entry) => entry.enabled,
      accountInactiveReason: "Basecamp account is disabled.",
    });
  },
} satisfies NonNullable<ChannelPlugin["secrets"]>;

/**
 * Import-light plugin subset consumed by `setup-entry.ts` (SPEC §1.4).
 * Everything here must stay off the heavy import graph — the contract test
 * in tests/setup-entry-imports.test.ts enforces it.
 */
export const basecampSetupPlugin: Pick<
  ChannelPlugin<ResolvedBasecampAccount>,
  "id" | "meta" | "capabilities" | "configSchema" | "config" | "setupWizard" | "setupContract" | "secrets"
> = {
  id: "basecamp",
  meta: basecampChannelMeta,
  capabilities: basecampChannelCapabilities,
  configSchema: basecampConfigSchema,
  config: basecampConfigAdapter,
  setupWizard: basecampSetupWizard,
  setupContract: basecampSetupContract,
  secrets: basecampSecrets,
};
