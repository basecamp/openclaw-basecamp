import type { ChannelPlugin } from "openclaw/plugin-sdk";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk";
import { basecampActionsAdapter } from "./adapters/actions.js";
import { basecampAgentPromptAdapter } from "./adapters/agent-prompt.js";
import { basecampAgentTools } from "./adapters/agent-tools.js";
import { basecampDirectoryAdapter } from "./adapters/directory.js";
import { basecampGroupAdapter } from "./adapters/groups.js";
import { basecampHeartbeatAdapter } from "./adapters/heartbeat.js";
import { basecampMentionAdapter } from "./adapters/mentions.js";
import { basecampMessagingAdapter } from "./adapters/messaging.js";
import { basecampOnboardingAdapter } from "./adapters/onboarding.js";
import { BASECAMP_TEXT_CHUNK_LIMIT, chunkMarkdownText, resolveOutboundTarget } from "./adapters/outbound.js";
import { basecampPairingAdapter } from "./adapters/pairing.js";
import { basecampResolverAdapter } from "./adapters/resolver.js";
import { basecampSecurityAdapter } from "./adapters/security.js";
import { basecampSetupAdapter } from "./adapters/setup.js";
import type { BasecampAudit, BasecampProbe } from "./adapters/status.js";
import { basecampStatusAdapter } from "./adapters/status.js";
import { clearClient } from "./basecamp-client.js";
import {
  BasecampConfigSchema,
  listBasecampAccountIds,
  resolveAccountForBucket,
  resolveBasecampAccount,
  resolveBasecampAccountAsync,
  resolveBasecampAllowFrom,
  resolveDefaultBasecampAccountId,
  resolveWebhooksConfig,
  scopeWebhookProjects,
} from "./config.js";
import { dispatchBasecampEvent } from "./dispatch.js";
import { closeAccountDedup } from "./inbound/dedup-registry.js";
import { resolvePluginStateDir } from "./inbound/state-dir.js";
import { deactivateWebhooks, reconcileWebhooks } from "./inbound/webhook-lifecycle.js";
import { flushWebhookSecrets, getWebhookSecretRegistry } from "./inbound/webhooks.js";
import { sendBasecampMedia, sendBasecampText } from "./outbound/send.js";
import { getBasecampRuntime } from "./runtime.js";
import type { BasecampChannelConfig, BasecampInboundMessage, ResolvedBasecampAccount } from "./types.js";
import { withTimeout } from "./util.js";

/** JSON snapshot of config sections relevant to persona/virtualAccount validation.
 *  Re-validated whenever this changes (handles runtime config reload). */
let lastValidatedConfigJson: string | undefined;

/** Reset module-level validation state. Exported only for test isolation. */
export function _resetValidationState(): void {
  lastValidatedConfigJson = undefined;
}

export const basecampChannel: ChannelPlugin<ResolvedBasecampAccount, BasecampProbe, BasecampAudit> = {
  id: "basecamp",

  meta: {
    id: "basecamp",
    label: "Basecamp",
    selectionLabel: "Basecamp (Campfire, Cards, Todos, Check-ins, Pings)",
    docsPath: "/channels/basecamp",
    docsLabel: "basecamp",
    blurb:
      "Campfire chats, card tables, to-do lists, check-ins, pings — every Basecamp surface as a live agent interaction point.",
    systemImage: "building.2",
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    threads: false,
    reactions: true,
    media: false,
    nativeCommands: false,
    blockStreaming: false,
  },

  onboarding: basecampOnboardingAdapter,

  pairing: basecampPairingAdapter,

  setup: basecampSetupAdapter,

  status: basecampStatusAdapter,

  directory: basecampDirectoryAdapter,

  messaging: basecampMessagingAdapter,

  resolver: basecampResolverAdapter,

  heartbeat: basecampHeartbeatAdapter,

  groups: basecampGroupAdapter,

  agentPrompt: basecampAgentPromptAdapter,

  elevated: {
    allowFromFallback: () => undefined,
  },

  commands: {
    enforceOwnerForCommands: true,
    skipWhenConfigEmpty: true,
  },

  auth: {
    login: async ({ cfg, accountId }) => {
      const account = resolveBasecampAccount(cfg, accountId);
      switch (account.tokenSource) {
        case "oauth": {
          const { interactiveLogin } = await import("./oauth-credentials.js");
          await interactiveLogin(account);
          break;
        }
        case "config":
          throw new Error("Account uses an inline token — no login needed. Update the token in config directly.");
        case "tokenFile":
          throw new Error(
            `Account uses a token file (${account.config.tokenFile}). Update the file contents directly.`,
          );
        case "none":
          throw new Error(
            "No authentication configured for this account. " +
              "Run `openclaw channels add` and select Basecamp to set up credentials.",
          );
      }
    },
  },

  mentions: basecampMentionAdapter,

  actions: basecampActionsAdapter,

  agentTools: basecampAgentTools,

  reload: { configPrefixes: ["channels.basecamp"] },

  configSchema: {
    ...buildChannelConfigSchema(BasecampConfigSchema),
    uiHints: {
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
    },
  },

  config: {
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
  },

  security: basecampSecurityAdapter,

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: BASECAMP_TEXT_CHUNK_LIMIT,
    chunkerMode: "markdown",
    chunker: (text, limit) => chunkMarkdownText(text, limit),
    resolveTarget: ({ to }) => {
      const result = resolveOutboundTarget(to ?? "");
      if (result.ok) return { ok: true, to: result.to };
      return { ok: false, error: new Error(result.error) };
    },
    sendText: async ({ to, text, accountId }) => {
      const result = await sendBasecampText({ to, text, accountId });
      return { channel: "basecamp", messageId: result.messageId };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const result = await sendBasecampMedia({ to, text, mediaUrl, accountId });
      return { channel: "basecamp", messageId: result.messageId };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = await resolveBasecampAccountAsync(ctx.cfg, ctx.account.accountId);

      // ----- Startup validation -----
      // Verify critical config is valid. Log warnings but don't block startup.
      if (!account.personId) {
        ctx.log?.warn(`[${account.accountId}] validation: personId is not set — self-message filtering will not work`);
      }

      // Validate persona and virtualAccounts mappings when config changes.
      // Uses a JSON snapshot comparison so re-validation fires on runtime reload
      // (not just first startup).
      const startupSection = ctx.cfg.channels?.basecamp as BasecampChannelConfig | undefined;
      const configJson = startupSection
        ? JSON.stringify({
            accounts: Object.keys(startupSection.accounts ?? {}).sort(),
            personas: startupSection.personas,
            virtualAccounts: startupSection.virtualAccounts,
          })
        : undefined;
      if (configJson !== lastValidatedConfigJson) {
        lastValidatedConfigJson = configJson;
        if (startupSection?.personas) {
          // Warn about persona limitation with agent tools
          if (Object.keys(startupSection.personas).length > 0) {
            ctx.log?.warn(
              "Agent tools execute under the default account; " +
                "persona-mapped accounts are not yet supported for tool calls",
            );
          }
          for (const [agentId, targetAccountId] of Object.entries(startupSection.personas)) {
            const targetAccounts = startupSection.accounts ?? {};
            if (!targetAccounts[targetAccountId]) {
              ctx.log?.warn(`validation: persona "${agentId}" references non-existent account "${targetAccountId}"`);
            }
          }
        }
        if (startupSection?.virtualAccounts) {
          for (const [key, va] of Object.entries(startupSection.virtualAccounts)) {
            const targetAccounts = startupSection.accounts ?? {};
            if (!targetAccounts[va.accountId]) {
              ctx.log?.warn(`validation: virtualAccount "${key}" references non-existent account "${va.accountId}"`);
            }
          }
        }
      }

      // Startup token validation for OAuth accounts
      if (account.tokenSource === "oauth") {
        try {
          const { createTokenManager } = await import("./oauth-credentials.js");
          const tm = createTokenManager(account);
          await tm.getToken(); // validates + refreshes if needed
        } catch (err) {
          ctx.log?.error(`[${account.accountId}] cannot start: OAuth token invalid: ${String(err)}`);
          return;
        }
      }

      if (account.tokenSource === "none") {
        ctx.log?.error(`[${account.accountId}] cannot start: no authentication configured`);
        return;
      }

      if (!account.token && account.tokenSource !== "oauth") {
        ctx.log?.error(
          `[${account.accountId}] cannot start: no token (check tokenFile or token config) and no oauthTokenFile`,
        );
        return;
      }

      // Resolve the numeric Basecamp account ID for API calls.
      // Prefers explicit basecampAccountId, then falls back to accountId if numeric.
      const basecampAccountId =
        account.config.basecampAccountId ?? (/^\d+$/.test(account.accountId) ? account.accountId : undefined);

      if (!basecampAccountId) {
        ctx.log?.warn(
          `[${account.accountId}] validation: Basecamp account ID could not be resolved — ` +
            `outbound dispatch and API tools will fail. ` +
            `Set channels.basecamp.accounts.${account.accountId}.basecampAccountId`,
        );
      }

      ctx.log?.info(`[${account.accountId}] starting Basecamp channel (person: ${account.personId})`);

      // Import poller dynamically to avoid circular deps and allow
      // the inbound worker to complete their module independently.
      let startCompositePoller: typeof import("./inbound/poller.js").startCompositePoller;
      try {
        const pollerMod = await import("./inbound/poller.js");
        startCompositePoller = pollerMod.startCompositePoller;
      } catch (err) {
        ctx.log?.error(`[${account.accountId}] failed to load poller module: ${String(err)}`);
        return;
      }

      // Resolve state directory for cursor + dedup persistence.
      // Single source of truth: resolvePluginStateDir() is used by both the
      // poller (cursors via stateDir) and dedup-registry (SQLite via same fn).
      const stateDir = resolvePluginStateDir();

      // Auto-register webhooks for configured projects
      const whConfig = resolveWebhooksConfig(ctx.cfg);
      // Scope projects to this account. In multi-account mode, only reconcile
      // projects that map to the current account via virtualAccounts. Unmapped
      // projects are only eligible when there is exactly one concrete account
      // (single-account mode) — otherwise skip + warn to prevent cross-account
      // delete/recreate churn.
      const accountProjects = scopeWebhookProjects({
        cfg: ctx.cfg,
        projects: whConfig.projects,
        accountId: account.accountId,
        log: ctx.log,
      });
      let webhookActiveProjects: Set<string> | undefined;
      if (whConfig.autoRegister && whConfig.payloadUrl && accountProjects.length > 0) {
        const registry = getWebhookSecretRegistry(account.accountId);
        try {
          const result = await reconcileWebhooks(
            {
              payloadUrl: whConfig.payloadUrl,
              projects: accountProjects,
              types: whConfig.types,
              account,
            },
            registry,
            ctx.log
              ? {
                  info: (e, d) => ctx.log?.info?.(`[${account.accountId}] ${e} ${d ? JSON.stringify(d) : ""}`),
                  warn: (e, d) => ctx.log?.warn?.(`[${account.accountId}] ${e} ${d ? JSON.stringify(d) : ""}`),
                  error: (e, d) => ctx.log?.error?.(`[${account.accountId}] ${e} ${d ? JSON.stringify(d) : ""}`),
                  debug: (e, d) => ctx.log?.debug?.(`[${account.accountId}] ${e} ${d ? JSON.stringify(d) : ""}`),
                }
              : undefined,
          );
          ctx.log?.info(
            `[${account.accountId}] webhook reconciliation: ` +
              `${result.created.length} created, ${result.existing.length} existing, ` +
              `${result.recovered.length} recovered, ${result.failed.length} failed`,
          );
          // Projects with active webhooks (created, already existing, or recovered)
          const active = [...result.created, ...result.existing, ...result.recovered];
          if (active.length > 0) {
            webhookActiveProjects = new Set(active);
          }
        } catch (err) {
          ctx.log?.error(`[${account.accountId}] webhook reconciliation failed: ${String(err)}`);
        }
      }

      // Event handler: filter self-messages, then dispatch to OpenClaw agents.
      // Returns true if dispatched to an agent, false if dropped (no route,
      // engagement gate, DM policy, etc.).
      const onEvent = async (msg: BasecampInboundMessage): Promise<boolean> => {
        // Self-message filtering: skip events from our own service account
        if (msg.sender.id === account.personId) {
          return false;
        }

        return dispatchBasecampEvent(msg, {
          account,
          log: ctx.log as any,
        });
      };

      // Mark channel as running
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
      });

      // Start the composite poller (activity feed + readings)
      ctx.log?.info(`[${account.accountId}] starting composite poller`);

      // startCompositePoller returns Promise<void> — it runs until abortSignal fires
      try {
        await startCompositePoller({
          account,
          cfg: ctx.cfg,
          abortSignal: ctx.abortSignal,
          onEvent,
          stateDir,
          webhookActiveProjects,
          log: {
            info: (msg) => ctx.log?.info?.(msg),
            warn: (msg) => ctx.log?.warn?.(msg),
            debug: (msg) => ctx.log?.debug?.(msg),
            error: (msg) => ctx.log?.error?.(msg),
          },
        });
      } finally {
        // Deactivate webhooks on shutdown if configured (with timeout)
        const whShutdownConfig = resolveWebhooksConfig(ctx.cfg);
        if (whShutdownConfig.deactivateOnStop && whShutdownConfig.payloadUrl && whShutdownConfig.projects.length > 0) {
          const registry = getWebhookSecretRegistry(account.accountId);
          await withTimeout(
            deactivateWebhooks(
              {
                payloadUrl: whShutdownConfig.payloadUrl,
                projects: whShutdownConfig.projects,
                types: whShutdownConfig.types,
                account,
              },
              registry,
              ctx.log
                ? {
                    info: (e, d) => ctx.log?.info?.(`[${account.accountId}] ${e} ${d ? JSON.stringify(d) : ""}`),
                    warn: (e, d) => ctx.log?.warn?.(`[${account.accountId}] ${e} ${d ? JSON.stringify(d) : ""}`),
                    error: (e, d) => ctx.log?.error?.(`[${account.accountId}] ${e} ${d ? JSON.stringify(d) : ""}`),
                    debug: (e, d) => ctx.log?.debug?.(`[${account.accountId}] ${e} ${d ? JSON.stringify(d) : ""}`),
                  }
                : undefined,
            ).catch((err) => {
              ctx.log?.error(`[${account.accountId}] webhook deactivation failed: ${String(err)}`);
            }),
            5000,
            `${account.accountId} webhook deactivation`,
            ctx.log as any,
          );
        }

        // Close account dedup (flush + close SQLite) + flush secret stores (with timeout)
        await withTimeout(
          Promise.resolve().then(() => {
            closeAccountDedup(account.accountId);
            flushWebhookSecrets();
          }),
          5000,
          `${account.accountId} state flush`,
          ctx.log as any,
        );

        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      }
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const account = resolveBasecampAccount(cfg, accountId);

      // Delete OAuth token file if it exists
      let cleared = false;
      const tokenFilePath = account.config.oauthTokenFile;
      if (tokenFilePath) {
        try {
          const { unlink } = await import("node:fs/promises");
          await unlink(tokenFilePath);
          cleared = true;
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw err;
          // File already gone — still counts as cleared
          cleared = true;
        }
      }

      // Evict cached TokenManager and SDK client for this account only
      const { clearTokenManager } = await import("./oauth-credentials.js");
      clearTokenManager(accountId);
      clearClient(accountId);

      // Close account dedup DB
      closeAccountDedup(accountId);

      return { cleared, loggedOut: cleared };
    },
  },
};
