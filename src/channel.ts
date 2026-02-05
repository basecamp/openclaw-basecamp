import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { buildChannelConfigSchema, DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { ResolvedBasecampAccount, BasecampInboundMessage } from "./types.js";
import type { BasecampProbe, BasecampAudit } from "./adapters/status.js";
import {
  BasecampConfigSchema,
  listBasecampAccountIds,
  resolveBasecampAccount,
  resolveBasecampAccountAsync,
  resolveDefaultBasecampAccountId,
} from "./config.js";
import { getBasecampRuntime } from "./runtime.js";
import { sendBasecampText } from "./outbound/send.js";
import { dispatchBasecampEvent } from "./dispatch.js";
import { bcqAuthStatus } from "./bcq.js";
import { basecampOnboardingAdapter } from "./adapters/onboarding.js";
import { basecampSetupAdapter } from "./adapters/setup.js";
import { basecampStatusAdapter } from "./adapters/status.js";
import { basecampPairingAdapter } from "./adapters/pairing.js";
import { basecampDirectoryAdapter } from "./adapters/directory.js";
import { basecampMessagingAdapter } from "./adapters/messaging.js";
import { basecampResolverAdapter } from "./adapters/resolver.js";
import { basecampHeartbeatAdapter } from "./adapters/heartbeat.js";
import { basecampGroupAdapter } from "./adapters/groups.js";
import { basecampAgentPromptAdapter } from "./adapters/agent-prompt.js";
import { basecampMentionAdapter } from "./adapters/mentions.js";

export const basecampChannel: ChannelPlugin<ResolvedBasecampAccount, BasecampProbe, BasecampAudit> = {
  id: "basecamp",

  meta: {
    id: "basecamp",
    label: "Basecamp",
    selectionLabel: "Basecamp (Campfire, Cards, Todos, Check-ins, Pings)",
    docsPath: "/channels/basecamp",
    docsLabel: "basecamp",
    blurb: "Campfire chats, card tables, to-do lists, check-ins, pings — every Basecamp surface as a live agent interaction point.",
    systemImage: "building.2",
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    threads: false,
    reactions: false,
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

  mentions: basecampMentionAdapter,

  reload: { configPrefixes: ["channels.basecamp"] },

  configSchema: buildChannelConfigSchema(BasecampConfigSchema),

  config: {
    listAccountIds: (cfg) => listBasecampAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveBasecampAccount(cfg, accountId),
    defaultAccountId: (cfg) => resolveDefaultBasecampAccountId(cfg),
    isConfigured: (account) => Boolean(account.token?.trim() || account.config.tokenFile || account.bcqProfile),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.displayName,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim() || account.config.tokenFile || account.bcqProfile),
      tokenSource: account.tokenSource,
      bcqProfile: account.bcqProfile,
    }),
  },

  security: {
    resolveDmPolicy: ({ cfg, accountId }) => {
      const section = cfg.channels?.basecamp as Record<string, unknown> | undefined;
      const dmPolicy = (section?.dmPolicy as string) ?? "pairing";
      const allowFrom = (section?.allowFrom as Array<string | number>) ?? [];
      const basePath =
        accountId && accountId !== DEFAULT_ACCOUNT_ID
          ? `channels.basecamp.accounts.${accountId}.`
          : "channels.basecamp.";
      return {
        policy: dmPolicy,
        allowFrom,
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: `Add the sender's Basecamp person ID to ${basePath}allowFrom`,
      };
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 10000,
    sendText: async ({ to, text, accountId }) => {
      const result = await sendBasecampText({ to, text, accountId });
      return { channel: "basecamp", messageId: result.messageId };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = await resolveBasecampAccountAsync(ctx.cfg, ctx.account.accountId);

      // If bcqProfile is configured, verify bcq auth status before proceeding
      if (account.bcqProfile) {
        try {
          const authResult = await bcqAuthStatus({ profile: account.bcqProfile });
          if (!authResult.data.authenticated) {
            ctx.log?.error(
              `[${account.accountId}] cannot start: bcq profile "${account.bcqProfile}" is not authenticated`,
            );
            return;
          }
        } catch (err) {
          ctx.log?.error(
            `[${account.accountId}] cannot start: bcq auth check failed for profile "${account.bcqProfile}": ${String(err)}`,
          );
          return;
        }
      }

      if (!account.token && !account.bcqProfile) {
        ctx.log?.error(
          `[${account.accountId}] cannot start: no token (check tokenFile or token config) and no bcqProfile`,
        );
        return;
      }

      ctx.log?.info(
        `[${account.accountId}] starting Basecamp channel (person: ${account.personId})`,
      );

      // Import poller dynamically to avoid circular deps and allow
      // the inbound worker to complete their module independently.
      let startCompositePoller: typeof import("./inbound/poller.js").startCompositePoller;
      try {
        const pollerMod = await import("./inbound/poller.js");
        startCompositePoller = pollerMod.startCompositePoller;
      } catch (err) {
        ctx.log?.error(
          `[${account.accountId}] failed to load poller module: ${String(err)}`,
        );
        return;
      }

      // Resolve state directory for cursor persistence.
      // runtime.state.resolveStateDir(env, homedir) returns the base OpenClaw
      // state dir; we append a plugin-specific subdirectory.
      let stateDir: string;
      try {
        const os = await import("node:os");
        const path = await import("node:path");
        const runtime = getBasecampRuntime();
        const baseDir = runtime.state.resolveStateDir(process.env, os.homedir);
        stateDir = path.join(baseDir, "plugins", "basecamp");
      } catch {
        stateDir = "/tmp/openclaw-basecamp-state";
      }

      // Event handler: filter self-messages, then dispatch to OpenClaw agents
      const onEvent = async (msg: BasecampInboundMessage) => {
        // Self-message filtering: skip events from our own service account
        if (msg.sender.id === account.personId) {
          return;
        }

        await dispatchBasecampEvent(msg, {
          account,
          log: ctx.log as any,
        });
      };

      // Start the composite poller (activity feed + readings)
      ctx.log?.info(`[${account.accountId}] starting composite poller`);

      // startCompositePoller returns Promise<void> — it runs until abortSignal fires
      await startCompositePoller({
        account,
        cfg: ctx.cfg,
        abortSignal: ctx.abortSignal,
        onEvent,
        stateDir,
        log: {
          info: (msg) => ctx.log?.info?.(msg),
          warn: (msg) => ctx.log?.warn?.(msg),
          debug: (msg) => ctx.log?.debug?.(msg),
          error: (msg) => ctx.log?.error?.(msg),
        },
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      return { cleared: false, loggedOut: false };
    },
  },
};
