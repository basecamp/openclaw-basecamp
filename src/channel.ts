import { type ChannelPlugin, createChannelPluginBase, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { basecampActionsAdapter } from "./adapters/actions.js";
import { basecampAgentPromptAdapter } from "./adapters/agent-prompt.js";
import { basecampAgentTools } from "./adapters/agent-tools.js";
import { basecampDirectoryAdapter } from "./adapters/directory.js";
import { basecampDoctorAdapter } from "./adapters/doctor.js";
import { basecampGroupAdapter } from "./adapters/groups.js";
import { basecampHeartbeatAdapter } from "./adapters/heartbeat.js";
import { basecampMentionAdapter } from "./adapters/mentions.js";
import { basecampMessagingAdapter } from "./adapters/messaging.js";
import { basecampSetupWizard } from "./adapters/onboarding.js";
import { BASECAMP_TEXT_CHUNK_LIMIT, chunkMarkdownText, resolveOutboundTarget } from "./adapters/outbound.js";
import { basecampPairingAdapter } from "./adapters/pairing.js";
import { basecampResolverAdapter } from "./adapters/resolver.js";
import { basecampSecurityAdapter } from "./adapters/security.js";
import type { BasecampAudit, BasecampProbe } from "./adapters/status.js";
import { basecampStatusAdapter } from "./adapters/status.js";
import { clearClient } from "./basecamp-client.js";
import {
  basecampChannelCapabilities,
  basecampChannelMeta,
  basecampConfigAdapter,
  basecampConfigSchema,
  basecampSecrets,
  basecampSetupContract,
} from "./channel-setup.js";
import {
  resolveBasecampAccount,
  resolveBasecampAccountAsync,
  resolveWebhooksConfig,
  scopeWebhookProjects,
} from "./config.js";
import { dispatchBasecampEvent } from "./dispatch.js";
import { closeAccountDedup } from "./inbound/dedup-registry.js";
import { resolvePluginStateDir } from "./inbound/state-dir.js";
import { deactivateWebhooks, reconcileWebhooks } from "./inbound/webhook-lifecycle.js";
import { flushWebhookSecrets, getWebhookSecretRegistry } from "./inbound/webhooks.js";
import { sendBasecampMedia, sendBasecampText } from "./outbound/send.js";
import type { BasecampChannelConfig, BasecampInboundMessage, ResolvedBasecampAccount } from "./types.js";
import { withTimeout } from "./util.js";

/** JSON snapshot of config sections relevant to persona/virtualAccount validation.
 *  Re-validated whenever this changes (handles runtime config reload). */
let lastValidatedConfigJson: string | undefined;

/** Reset module-level validation state. Exported only for test isolation. */
export function _resetValidationState(): void {
  lastValidatedConfigJson = undefined;
}

/**
 * Base plugin surface (SPEC §2.1): everything outside the four
 * createChatChannelPlugin slots (security, pairing, threading, outbound).
 * WP0 lays this skeleton; WP2–WP5 fill the remaining slots idiomatically.
 */
const basecampChannelBase = {
  ...createChannelPluginBase<ResolvedBasecampAccount>({
    id: "basecamp",

    meta: basecampChannelMeta,

    setupWizard: basecampSetupWizard,

    commands: {
      enforceOwnerForCommands: true,
      skipWhenConfigEmpty: true,
    },

    agentPrompt: basecampAgentPromptAdapter,

    reload: { configPrefixes: ["channels.basecamp"] },

    configSchema: basecampConfigSchema,

    security: basecampSecurityAdapter,

    setupContract: basecampSetupContract,

    doctor: basecampDoctorAdapter,

    groups: basecampGroupAdapter,
  }),

  capabilities: basecampChannelCapabilities,

  config: basecampConfigAdapter,

  secrets: basecampSecrets,

  // Bucket/recording bindings are project-level, not conversation-level (SPEC §2.21).
  conversationBindings: { supportsCurrentConversationBinding: false },

  status: basecampStatusAdapter,

  directory: basecampDirectoryAdapter,

  messaging: basecampMessagingAdapter,

  resolver: basecampResolverAdapter,

  heartbeat: basecampHeartbeatAdapter,

  mentions: basecampMentionAdapter,

  actions: basecampActionsAdapter,

  agentTools: basecampAgentTools,

  elevated: {
    allowFromFallback: () => undefined,
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
          cfg: ctx.cfg,
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

      // Delete OAuth token file and companion .client.json if they exist
      let cleared = false;
      const tokenFilePath = account.config.oauthTokenFile;
      if (tokenFilePath) {
        try {
          const { unlink } = await import("node:fs/promises");
          const { resolveClientFilePath } = await import("./oauth-credentials.js");
          await unlink(tokenFilePath);
          cleared = true;
          // Remove companion client credentials file (best-effort)
          await unlink(resolveClientFilePath(tokenFilePath)).catch(() => {});
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
} satisfies Partial<ChannelPlugin<ResolvedBasecampAccount, BasecampProbe, BasecampAudit>>;

export const basecampChannel: ChannelPlugin<ResolvedBasecampAccount, BasecampProbe, BasecampAudit> =
  createChatChannelPlugin<ResolvedBasecampAccount, BasecampProbe, BasecampAudit>({
    base: basecampChannelBase,

    pairing: basecampPairingAdapter,

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
        return { channel: "basecamp", messageId: result.messageId, target: { kind: "conversation", id: to } };
      },
      sendMedia: async ({ to, text, mediaUrl, accountId }) => {
        const result = await sendBasecampMedia({ to, text, mediaUrl, accountId });
        return { channel: "basecamp", messageId: result.messageId, target: { kind: "conversation", id: to } };
      },
    },
  });
