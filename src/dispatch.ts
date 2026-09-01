/**
 * Dispatch bridge — connects inbound Basecamp events to OpenClaw agents.
 *
 * SPEC §2.2/§2.3: each normalized BasecampInboundMessage runs through the
 * channel turn kernel (`runtime.channel.inbound.run`) with a
 * ChannelTurnAdapter:
 *
 * - ingest: project the message into NormalizedTurnInput
 * - classify: always "message" for now (room_event classification is a
 *   follow-up product decision — see SPEC §2.4)
 * - preflight: plugin-owned gates (self/echo filter, engagement policy) and
 *   the shared ingress resolver (DM policy, pairing store, per-bucket
 *   allowFrom route descriptor); pairing challenges are delivered as
 *   Basecamp Pings
 * - resolveTurn: builds the inbound event context (BodyForAgent, typed
 *   channelContext, media facts, supplemental quote/surface guidance) and
 *   returns a routed turn plan whose delivery posts back to Basecamp
 *
 * Bot-loop protection facts (§2.13) are attached when the sender is another
 * configured Basecamp persona.
 */

import type { ChannelInboundEventRunnerParams, InboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import {
  buildChannelInboundEventContext,
  runChannelInboundEvent,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import type {
  ChannelIngressRouteDescriptor,
  ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { isRecentOutboundMessageIdentity } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { BASECAMP_TEXT_CHUNK_LIMIT, chunkMarkdownText } from "./adapters/outbound.js";
import { isBasecampError } from "./basecamp-client.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import {
  resolveBasecampAccount,
  resolveBasecampAllowFrom,
  resolveBasecampBucketAllowFrom,
  resolveBasecampDmPolicy,
  resolveCircuitBreakerConfig,
  resolvePersonaAccountId,
} from "./config.js";
import { createStructuredLog } from "./logging.js";
import { recordCircuitBreakerState, recordDispatchFailure } from "./metrics.js";
import { markdownToBasecampHtml } from "./outbound/format.js";
import { postReplyToEvent } from "./outbound/send.js";
import { getBasecampRuntime } from "./runtime.js";
import type {
  BasecampChannelConfig,
  BasecampEngagementType,
  BasecampInboundMessage,
  ResolvedBasecampAccount,
} from "./types.js";
import { DEFAULT_ENGAGE } from "./types.js";

/**
 * Instance-bound reply dispatcher type, derived from the typed reply-runtime
 * surface (`DispatchReplyFromConfig` itself has no typed subpath export).
 */
type DispatchReplyFromConfig = NonNullable<
  Parameters<typeof import("openclaw/plugin-sdk/reply-runtime").dispatchInboundMessage>[0]["dispatchReplyFromConfig"]
>;

/** Per-account outbound circuit breakers. Separate from poller CBs. */
const outboundCircuitBreakers = new Map<string, CircuitBreaker>();

function getOutboundCircuitBreaker(cfg: OpenClawConfig, accountId: string): CircuitBreaker {
  let cb = outboundCircuitBreakers.get(accountId);
  if (!cb) {
    const cbConfig = resolveCircuitBreakerConfig(cfg);
    cb = new CircuitBreaker({ threshold: cbConfig.threshold, cooldownMs: cbConfig.cooldownMs });
    outboundCircuitBreakers.set(accountId, cb);
  }
  return cb;
}

/**
 * Stable Basecamp sender identity for the shared ingress resolver.
 * Person IDs are immutable numeric strings from authenticated API payloads:
 * the boundary vouches for the sender without binding the exact identifier.
 */
const basecampIngressIdentity = defineStableChannelIngressIdentity({
  key: "basecamp-person-id",
  normalize: (value) => {
    const stripped = value.replace(/^(basecamp|bc):/i, "").trim();
    return stripped.length > 0 ? stripped : undefined;
  },
  authentication: "asserted",
  entryIdPrefix: "basecamp-person",
});

export type DispatchOptions = {
  /** The resolved account that received this event. */
  account: ResolvedBasecampAccount;
  /** The active OpenClaw config, threaded from gateway.startAccount / webhook handler. */
  cfg: OpenClawConfig;
  /** Optional logger. */
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
    error: (msg: string) => void;
  };
  /**
   * Host-injected channel runtime surface from the gateway context
   * (`ctx.channelRuntime`). Preferred over the plugin runtime when it carries
   * an inbound surface; verified structurally at runtime.
   */
  channelRuntime?: unknown;
  /**
   * Instance-bound reply dispatcher override for the assembled turn.
   * Left unset in production (core supplies its own); integration tests
   * inject a fake dispatcher here to run the real kernel end to end.
   */
  dispatchReplyFromConfig?: DispatchReplyFromConfig;
};

type InboundSurface = {
  buildContext: typeof buildChannelInboundEventContext;
  run: typeof runChannelInboundEvent;
};

/**
 * Resolve the inbound kernel surface: prefer the host-injected gateway
 * `ctx.channelRuntime.inbound` when it is populated (documented "for external
 * channel plugins" but optional — verify shape at runtime), then the injected
 * plugin runtime, then the standalone builders from channel-inbound.
 */
function resolveInboundSurface(channelRuntime: unknown): InboundSurface {
  const injected = (channelRuntime as { inbound?: Partial<InboundSurface> } | undefined)?.inbound;
  if (typeof injected?.buildContext === "function" && typeof injected?.run === "function") {
    return { buildContext: injected.buildContext, run: injected.run };
  }
  const runtime = tryRuntimeInbound();
  if (runtime) return runtime;
  return { buildContext: buildChannelInboundEventContext, run: runChannelInboundEvent };
}

function tryRuntimeInbound(): InboundSurface | undefined {
  try {
    const inbound = getBasecampRuntime().channel.inbound as Partial<InboundSurface> | undefined;
    if (typeof inbound?.buildContext === "function" && typeof inbound?.run === "function") {
      return { buildContext: inbound.buildContext, run: inbound.run };
    }
  } catch {
    // runtime not initialized — fall through to the standalone builders
  }
  return undefined;
}

/**
 * Dispatch a normalized Basecamp inbound message to the OpenClaw agent pipeline.
 *
 * Returns true if the message was dispatched, false if it was dropped
 * (e.g., no matching agent route, self-message, ingress denial, etc.).
 */
export async function dispatchBasecampEvent(msg: BasecampInboundMessage, options: DispatchOptions): Promise<boolean> {
  const surface = resolveInboundSurface(options.channelRuntime);
  const adapter = createBasecampTurnAdapter(msg, options);
  const result = await surface.run({
    channel: "basecamp",
    accountId: msg.accountId,
    raw: msg,
    adapter,
  });
  return result.dispatched === true;
}

// ---------------------------------------------------------------------------
// Turn adapter
// ---------------------------------------------------------------------------

/** Per-turn state resolved in preflight and consumed by resolveTurn. */
type TurnState = {
  effectiveAccountId: string;
  route: {
    agentId: string;
    sessionKey: string;
    accountId: string;
    matchedBy?: string;
  };
  ingress: ResolvedChannelMessageIngress;
  outboundAccount: ResolvedBasecampAccount;
  outboundBasecampAccountId: string;
};

export type BasecampTurnAdapter = ChannelInboundEventRunnerParams<BasecampInboundMessage>["adapter"];

/**
 * Build the ChannelTurnAdapter for one inbound Basecamp message.
 * Exported so tests can exercise ingest/classify/preflight/resolveTurn
 * directly against a hand-built cfg.
 */
export function createBasecampTurnAdapter(msg: BasecampInboundMessage, options: DispatchOptions): BasecampTurnAdapter {
  const { account, cfg, log } = options;
  const slog = createStructuredLog(log, { accountId: account.accountId, source: "dispatch" });
  const correlationId = msg.correlationId;
  const chatKind = msg.peer.kind === "dm" ? ("direct" as const) : ("group" as const);
  const messageId = msg.meta.messageId ?? msg.meta.recordingId;

  let state: TurnState | undefined;

  return {
    ingest: (raw: BasecampInboundMessage) => ({
      id: raw.dedupKey,
      timestamp: new Date(raw.createdAt).getTime(),
      rawText: raw.text,
      textForAgent: raw.text,
      raw,
    }),

    // Every admitted Basecamp event is a full user turn for now. Ambient
    // room_event classification for engage: conversation/activity is a
    // separate product decision (SPEC §2.4) layered on the message adapter.
    classify: () => ({ kind: "message" as const, canStartAgentTurn: true }),

    preflight: async () => {
      // ----- Self-message filtering -----
      if (msg.sender.id === account.personId) {
        slog.debug("self_message_skipped", { correlationId, personId: msg.sender.id });
        return { kind: "drop" as const, reason: "self_message" };
      }

      // ----- Outbound echo suppression (§2.12 consumer side) -----
      // The personId check above is the primary guard; the shared outbound
      // identity registry catches multi-persona echoes the moment the send
      // path records them.
      if (
        isRecentOutboundMessageIdentity({
          channel: "basecamp",
          accountId: msg.accountId,
          conversationId: msg.peer.id,
          messageId,
        })
      ) {
        slog.debug("outbound_echo_skipped", { correlationId, messageId });
        return { kind: "drop" as const, reason: "outbound_echo" };
      }

      // ----- Project-scope routing override -----
      const effectiveAccountId = resolveProjectScopeAccountId(cfg, msg) ?? msg.accountId;

      // ----- Route resolution -----
      const runtime = getBasecampRuntime();
      const toRoutePeer = (p?: { kind: "dm" | "group"; id: string }) =>
        p ? { kind: (p.kind === "dm" ? "direct" : p.kind) as "direct" | "group", id: p.id } : undefined;

      const route = runtime.channel.routing.resolveAgentRoute({
        cfg,
        channel: "basecamp",
        accountId: effectiveAccountId,
        peer: toRoutePeer(msg.peer),
        parentPeer: toRoutePeer(msg.parentPeer),
      });

      if (!route) {
        slog.debug("no_route", { correlationId, peer: msg.peer.id });
        return { kind: "drop" as const, reason: "no_route" };
      }

      // ----- Engagement gate (plugin-owned; no SDK analogue) -----
      const engagement = classifyEngagement(msg);
      const engagePolicy = resolveEngagePolicy(cfg, msg.meta.bucketId);
      if (!engagePolicy.includes(engagement)) {
        slog.debug("engagement_gate_dropped", {
          correlationId,
          engagement,
          event: msg.meta.eventKind,
          type: msg.meta.recordableType,
          peer: msg.peer.id,
          policy: engagePolicy.join(","),
        });
        return { kind: "drop" as const, reason: `engagement:${engagement}` };
      }

      // ----- Bucket sender gate for direct Pings (plugin-owned) -----
      // For group conversations the bucket allowlist rides as an ingress
      // route descriptor; the kernel's DM sender gate does not consult route
      // allowlists, so keep the direct-conversation check plugin-owned.
      const directBucketAllowFrom = chatKind === "direct" && resolveBasecampBucketAllowFrom(cfg, msg.meta.bucketId);
      if (directBucketAllowFrom && !directBucketAllowFrom.includes(msg.sender.id)) {
        slog.debug("bucket_sender_gate_dropped", {
          correlationId,
          sender: msg.sender.id,
          bucket: msg.meta.bucketId,
        });
        return { kind: "drop" as const, reason: "bucket_sender_not_allowlisted" };
      }

      // ----- Ingress authorization (§2.3) -----
      // The shared resolver owns DM policy, pairing-store fallback, and the
      // per-bucket allowFrom route descriptor (group conversations). Resolved
      // after final route selection so contextBinding freezes agent + session.
      const ingress = await resolveBasecampIngress({
        cfg,
        msg,
        chatKind,
        effectiveAccountId,
        messageId,
        route: { agentId: route.agentId, sessionKey: route.sessionKey },
      });

      const admission = ingress.ingress.admission;
      if (admission === "pairing-required") {
        await issueBasecampPairingChallenge({ cfg, msg, effectiveAccountId, slog, correlationId });
        return { kind: "handled" as const, reason: "pairing_challenge" };
      }
      if (admission !== "dispatch") {
        slog.info("ingress_dropped", {
          correlationId,
          sender: msg.sender.id,
          admission,
          reason: ingress.ingress.reasonCode,
        });
        return { kind: "drop" as const, reason: `ingress:${ingress.ingress.reasonCode}` };
      }

      // ----- Resolve persona for outbound -----
      const personaAccountId = resolvePersonaAccountId(cfg, route.agentId);
      const outboundAccount = personaAccountId ? resolveBasecampAccount(cfg, personaAccountId) : account;
      const outboundBasecampAccountId =
        outboundAccount.config.basecampAccountId ??
        (/^\d+$/.test(outboundAccount.accountId) ? outboundAccount.accountId : undefined);
      if (!outboundBasecampAccountId) {
        slog.error("outbound_account_id_missing", {
          outboundAccount: outboundAccount.accountId,
          hint: "Set config.basecampAccountId to a valid Basecamp account id",
        });
        return { kind: "drop" as const, reason: "outbound_account_id_missing" };
      }

      state = {
        effectiveAccountId,
        route: {
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          accountId: route.accountId ?? effectiveAccountId,
          matchedBy: route.matchedBy,
        },
        ingress,
        outboundAccount,
        outboundBasecampAccountId,
      };

      slog.info("dispatching", {
        correlationId,
        agent: route.agentId,
        matchedBy: route.matchedBy,
        peer: `${msg.peer.kind}:${msg.peer.id}`,
        recordableType: msg.meta.recordableType,
      });

      return {
        message: { rawBody: msg.text, bodyForAgent: msg.text },
        media: buildBasecampMediaFacts(msg),
      };
    },

    resolveTurn: async () => {
      if (!state) throw new Error("basecamp turn adapter: resolveTurn called without successful preflight");
      const { route, ingress, outboundAccount, outboundBasecampAccountId } = state;
      const surface = resolveInboundSurface(options.channelRuntime);

      const surfacePrompt = getSurfacePrompt(msg.meta.recordableType);
      const promptContext = buildChannelPromptContext(msg, { includeSurfacePrompt: chatKind === "direct" });

      const ctxPayload = await surface.buildContext({
        channel: "basecamp",
        accountId: msg.accountId,
        provider: "basecamp",
        surface: "basecamp",
        messageId,
        timestamp: new Date(msg.createdAt).getTime(),
        from: `basecamp:${msg.sender.id}`,
        sender: { id: msg.sender.id, name: msg.sender.name },
        conversation: {
          kind: chatKind,
          id: msg.peer.id,
          parentId: msg.parentPeer?.id,
          routePeer: { kind: chatKind, id: msg.peer.id },
        },
        route: {
          agentId: route.agentId,
          accountId: route.accountId,
          routeSessionKey: route.sessionKey,
        },
        reply: {
          to: `basecamp:${msg.peer.id}`,
          originatingTo: `basecamp:${msg.peer.id}`,
        },
        message: {
          rawBody: msg.text,
          bodyForAgent: msg.text,
          inboundEventKind: "user_request",
        },
        access: {
          mentions: {
            canDetectMention: true,
            wasMentioned: msg.meta.mentionsAgent,
          },
        },
        media: buildBasecampMediaFacts(msg),
        supplemental: buildBasecampSupplemental(msg, chatKind === "direct" ? undefined : surfacePrompt),
        channelContext: {
          sender: {
            id: msg.sender.id,
            name: msg.sender.name,
            personId: msg.sender.id,
          },
          chat: {
            id: msg.peer.id,
            bucketId: msg.meta.bucketId,
            recordingId: msg.meta.recordingId,
            recordableType: msg.meta.recordableType,
          },
        },
        extra: promptContext.length > 0 ? { ChannelPromptContext: promptContext } : undefined,
        // Exact host-resolved ingress result — never rebuilt (§2.3).
        channelIngress: ingress,
      });

      // Outbound circuit breaker: fail fast when Basecamp API is persistently down.
      // Keyed by effective Basecamp account ID so virtual accounts sharing the same
      // real Basecamp account share a single breaker instance.
      const outboundCb = getOutboundCircuitBreaker(cfg, outboundBasecampAccountId);
      const outboundCbKey = "outbound";

      return {
        cfg,
        channel: "basecamp",
        accountId: route.accountId,
        route: {
          agentId: route.agentId,
          sessionKey: route.sessionKey,
        },
        ctxPayload,
        ...(options.dispatchReplyFromConfig ? { dispatchReplyFromConfig: options.dispatchReplyFromConfig } : {}),
        botLoopProtection: buildBotLoopProtectionFacts({ cfg, msg, account, chatKind }),
        delivery: {
          deliver: async (payload: { text?: string }) => {
            if (!payload.text) return {};

            // Chunk long agent output to fit within Basecamp's character limit.
            // Each chunk is converted to HTML and sent as a separate message.
            const chunks = chunkMarkdownText(payload.text, BASECAMP_TEXT_CHUNK_LIMIT);
            const messageIds: string[] = [];

            for (const chunk of chunks) {
              const htmlContent = markdownToBasecampHtml(chunk);

              const result = await postReplyToEvent({
                bucketId: msg.meta.bucketId,
                recordingId: msg.meta.recordingId,
                recordableType: msg.meta.recordableType,
                peerId: msg.peer.id,
                content: htmlContent,
                account: outboundAccount,
                retries: 2,
                circuitBreaker: { instance: outboundCb, key: outboundCbKey },
                correlationId,
              });

              if (!result.ok) {
                // Preserve original error for classifyDispatchError
                if (result.error instanceof Error) throw result.error;
                throw new Error(result.message ?? "Outbound delivery failed");
              }
              if (result.messageId) messageIds.push(result.messageId);
            }

            syncOutboundCircuitBreakerMetrics(outboundCb, outboundCbKey, outboundBasecampAccountId, cfg);
            slog.info("delivered", {
              correlationId,
              agent: route.agentId,
              event: msg.meta.eventKind,
              recording: msg.meta.recordingId,
            });
            return messageIds.length > 0 ? { messageIds } : {};
          },
          onError: (err: unknown) => {
            const errorType = classifyDispatchError(err);
            slog.error("delivery_failed", {
              correlationId,
              agent: route.agentId,
              event: msg.meta.eventKind,
              recording: msg.meta.recordingId,
              sender: msg.sender.id,
              type: errorType,
              error: String(err),
            });
            recordDispatchFailure(outboundAccount.accountId);
            // Dead-letter entry: structured log with enough context to replay or investigate
            slog.error("dead_letter", {
              correlationId,
              agent: route.agentId,
              event: msg.meta.eventKind,
              recordableType: msg.meta.recordableType,
              recording: msg.meta.recordingId,
              bucket: msg.meta.bucketId,
              sender: msg.sender.id,
              peer: msg.peer.id,
              type: errorType,
              error: String(err),
              timestamp: Date.now(),
            });
            syncOutboundCircuitBreakerMetrics(outboundCb, outboundCbKey, outboundBasecampAccountId, cfg);
          },
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Ingress
// ---------------------------------------------------------------------------

async function resolveBasecampIngress(params: {
  cfg: OpenClawConfig;
  msg: BasecampInboundMessage;
  chatKind: "direct" | "group";
  effectiveAccountId: string;
  messageId: string;
  route: { agentId: string; sessionKey: string };
}): Promise<ResolvedChannelMessageIngress> {
  const { cfg, msg, chatKind, effectiveAccountId, messageId, route } = params;
  const section = cfg.channels?.basecamp as BasecampChannelConfig | undefined;

  const resolver = createChannelIngressResolver({
    channelId: "basecamp",
    accountId: effectiveAccountId,
    identity: basecampIngressIdentity,
    readStoreAllowFrom: async () => {
      // Honor pairing-store approvals via the plugin runtime.
      try {
        return await getBasecampRuntime().channel.pairing.readAllowFromStore({
          channel: "basecamp",
          accountId: effectiveAccountId,
        });
      } catch {
        return undefined;
      }
    },
  });

  // Per-bucket allowFrom becomes a route descriptor with sender replacement:
  // when a bucket configures its own allowlist, it replaces the effective
  // channel-level sender allowlist for events in that bucket.
  const bucketAllowFrom = resolveBasecampBucketAllowFrom(cfg, msg.meta.bucketId);
  const bucketRoute: ChannelIngressRouteDescriptor | undefined = bucketAllowFrom
    ? {
        id: "bucket",
        kind: "routeSender",
        configured: true,
        matched: true,
        allowed: true,
        senderPolicy: "replace",
        senderAllowFrom: bucketAllowFrom,
        blockReason: "bucket_sender_not_allowlisted",
      }
    : undefined;

  const dmPolicy = resolveBasecampDmPolicy(cfg);
  const allowFrom = resolveBasecampAllowFrom(cfg);
  // The kernel treats "open" as requiring an explicit "*" allowlist entry
  // (the doctor repairs configs to spell it out). Preserve the channel's
  // documented open semantics until the config schema writes "*" itself.
  const effectiveAllowFrom = dmPolicy === "open" && !allowFrom.includes("*") ? [...allowFrom, "*"] : allowFrom;

  // A bucket-level allowlist turns group sender policy into an allowlist
  // whose entries come from the route descriptor (senderPolicy: "replace").
  const configuredGroupPolicy = (section as { groupPolicy?: "allowlist" | "open" | "disabled" } | undefined)
    ?.groupPolicy;
  const groupPolicy = bucketAllowFrom ? "allowlist" : (configuredGroupPolicy ?? "open");

  return resolver.message({
    subject: { stableId: msg.sender.id },
    conversation: {
      kind: chatKind,
      id: msg.peer.id,
      parentId: msg.parentPeer?.id,
    },
    contextBinding: {
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      messageId,
      inboundEventKind: "user_request",
    },
    event: { kind: "message", authMode: "inbound", mayPair: chatKind === "direct" },
    dmPolicy,
    groupPolicy,
    allowFrom: effectiveAllowFrom,
    route: bucketRoute,
  });
}

async function issueBasecampPairingChallenge(params: {
  cfg: OpenClawConfig;
  msg: BasecampInboundMessage;
  effectiveAccountId: string;
  slog: ReturnType<typeof createStructuredLog>;
  correlationId: string;
}): Promise<void> {
  const { cfg, msg, effectiveAccountId, slog, correlationId } = params;
  const runtime = getBasecampRuntime();

  const issueChallenge = createChannelPairingChallengeIssuer({
    channel: "basecamp",
    accountId: effectiveAccountId,
    upsertPairingRequest: (request) =>
      runtime.channel.pairing.upsertPairingRequest({
        channel: "basecamp",
        accountId: effectiveAccountId,
        id: request.id,
        meta: request.meta,
      }),
  });

  const result = await issueChallenge({
    senderId: msg.sender.id,
    senderIdLine: `Your Basecamp person ID: ${msg.sender.id}`,
    meta: { name: msg.sender.name },
    sendPairingReply: async (text) => {
      // Challenge delivery via Basecamp Ping (circles endpoint — not in the
      // OpenAPI spec, so raw client).
      const { getClient, rawOrThrow } = await import("./basecamp-client.js");
      const account = resolveBasecampAccount(cfg, effectiveAccountId);
      const client = getClient(account);
      await rawOrThrow(
        // biome-ignore lint/suspicious/noExplicitAny: circles endpoint is not in the OpenAPI spec
        await client.raw.POST(`/circles/people/${msg.sender.id}/lines.json` as any, {
          body: { content: `<p>${text}</p>` } as any,
        }),
      );
    },
    onReplyError: (err) => {
      slog.warn("pairing_challenge_delivery_failed", { correlationId, sender: msg.sender.id, error: String(err) });
    },
  });

  slog.info("pairing_challenge", {
    correlationId,
    sender: msg.sender.id,
    created: result.created,
  });
}

// ---------------------------------------------------------------------------
// Bot-loop protection (§2.13)
// ---------------------------------------------------------------------------

/**
 * Attach bot-loop facts when the sender is another configured Basecamp
 * persona (a service account this deployment also operates). Prevents
 * persona ping-pong in shared Campfires.
 */
function buildBotLoopProtectionFacts(params: {
  cfg: OpenClawConfig;
  msg: BasecampInboundMessage;
  account: ResolvedBasecampAccount;
  chatKind: "direct" | "group";
}):
  | {
      scopeId: string;
      conversationId: string;
      senderId: string;
      receiverId: string;
      eventId?: string;
      config?: Record<string, unknown>;
      defaultsConfig?: Record<string, unknown>;
      defaultEnabled: boolean;
    }
  | undefined {
  const { cfg, msg, account } = params;
  if (!account.personId) return undefined;

  const section = cfg.channels?.basecamp as BasecampChannelConfig | undefined;
  const knownPersonaPersonIds = new Set<string>();
  for (const acct of Object.values(section?.accounts ?? {})) {
    if (acct?.personId) knownPersonaPersonIds.add(String(acct.personId));
  }
  knownPersonaPersonIds.delete(account.personId);

  if (!knownPersonaPersonIds.has(msg.sender.id)) return undefined;

  const channelDefaults = (cfg.channels as { defaults?: { botLoopProtection?: Record<string, unknown> } } | undefined)
    ?.defaults;
  const sectionConfig = (section as { botLoopProtection?: Record<string, unknown> } | undefined)?.botLoopProtection;

  return {
    scopeId: account.accountId,
    conversationId: msg.peer.id,
    senderId: msg.sender.id,
    receiverId: account.personId,
    eventId: msg.dedupKey,
    config: sectionConfig,
    defaultsConfig: channelDefaults?.botLoopProtection,
    defaultEnabled: true,
  };
}

// ---------------------------------------------------------------------------
// Media facts
// ---------------------------------------------------------------------------

/**
 * Project Basecamp attachments into inbound media facts. Basecamp
 * attachments are URL-addressed (download requires auth) — the kernel's
 * media understanding treats them as remote facts.
 */
function buildBasecampMediaFacts(msg: BasecampInboundMessage): InboundMediaFacts[] | undefined {
  const attachments = msg.meta.attachments.filter((a) => a.url);
  if (attachments.length === 0) return undefined;
  return toInboundMediaFacts(
    attachments.map((a) => ({
      url: a.url,
      contentType: a.contentType,
      messageId: msg.meta.messageId ?? msg.meta.recordingId,
    })),
  );
}

// ---------------------------------------------------------------------------
// Engagement classification (plugin-owned; no SDK analogue)
// ---------------------------------------------------------------------------

/**
 * Classify an inbound event into an engagement type.
 *
 * Ordered from most direct to most ambient:
 *   dm           — 1:1 Ping
 *   mention      — @mentioned
 *   assignment   — assigned/unassigned to agent
 *   checkin      — check-in question directed at agent (Hey! inbox)
 *   conversation — chat lines, comments in bound surfaces
 *   activity     — everything else (card moves, todo completions, edits…)
 */
export function classifyEngagement(msg: BasecampInboundMessage): BasecampEngagementType {
  if (msg.peer.kind === "dm") return "dm";
  if (msg.meta.mentionsAgent) return "mention";
  if (msg.meta.assignedToAgent) return "assignment";

  // Check-in reminders: Question in Hey! inbox = you're a respondent
  if (msg.meta.recordableType === "Question" && msg.meta.sources.includes("readings")) {
    return "checkin";
  }

  // Conversational surfaces: chat and comments
  if (
    msg.meta.recordableType === "Chat::Line" ||
    msg.meta.recordableType === "Chat::Transcript" ||
    msg.meta.recordableType === "Comment"
  ) {
    return "conversation";
  }

  return "activity";
}

/**
 * Resolve the engagement policy for a given bucket.
 * Per-bucket `engage` overrides channel-level; falls back to DEFAULT_ENGAGE.
 */
export function resolveEngagePolicy(cfg: OpenClawConfig, bucketId: string): BasecampEngagementType[] {
  const section = cfg.channels?.basecamp as BasecampChannelConfig | undefined;

  // Per-bucket override (exact match → wildcard fallback)
  const bucketConfig = section?.buckets?.[bucketId] ?? section?.buckets?.["*"];
  if (bucketConfig?.engage) return bucketConfig.engage;

  // Channel-level
  if (section?.engage) return section.engage;

  return DEFAULT_ENGAGE;
}

/**
 * Classify a dispatch error into a broad category for structured logging.
 * Prefers BasecampError.code when available, falls back to message heuristics.
 */
function classifyDispatchError(err: unknown): string {
  // SDK errors carry a structured code
  if (isBasecampError(err)) {
    switch (err.code) {
      case "auth_required":
      case "forbidden":
        return "auth";
      case "rate_limit":
        return "rate_limit";
      case "network":
        return "network";
      case "not_found":
        return "not_found";
      default:
        return err.code;
    }
  }

  // Fallback for non-BasecampError exceptions (network TypeErrors, etc.)
  const anyErr = err as { message?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
  const message = typeof anyErr?.message === "string" ? anyErr.message : String(err);
  const lowerMessage = message.toLowerCase();
  const code = typeof anyErr?.code === "string" || typeof anyErr?.code === "number" ? String(anyErr.code) : undefined;
  const statusValue =
    typeof anyErr?.status === "number"
      ? anyErr.status
      : typeof anyErr?.statusCode === "number"
        ? anyErr.statusCode
        : undefined;

  if (statusValue === 401 || statusValue === 403) return "auth";
  if (lowerMessage.includes("unauthorized") || lowerMessage.includes("forbidden")) return "auth";

  if (code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "ECONNRESET") return "network";
  if (
    lowerMessage.includes("etimedout") ||
    lowerMessage.includes("econnrefused") ||
    lowerMessage.includes("econnreset") ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("fetch")
  )
    return "network";

  if (/\bno route\b/.test(lowerMessage)) return "routing";

  return "unknown";
}

/**
 * Check if an inbound message's bucketId matches a virtualAccounts entry.
 * Returns the virtual account key (scope alias) if matched, undefined otherwise.
 */
function resolveProjectScopeAccountId(cfg: OpenClawConfig, msg: BasecampInboundMessage): string | undefined {
  const section = cfg.channels?.basecamp as BasecampChannelConfig | undefined;
  const virtualAccounts = section?.virtualAccounts;
  if (!virtualAccounts) return undefined;

  const bucketId = msg.meta.bucketId;
  for (const [key, va] of Object.entries(virtualAccounts)) {
    if (va.bucketId === bucketId) {
      return key;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Surface guidance + prompt context
// ---------------------------------------------------------------------------

/**
 * Surface-specific prompt guidance, keyed by recordable type.
 *
 * Flows into the turn context as GroupSystemPrompt (group surfaces) or a
 * ChannelPromptContext line (direct Pings) via the context builder.
 */
const SURFACE_PROMPTS: Record<string, string> = {
  "Chat::Transcript": [
    "You are responding in a Basecamp Campfire chat room.",
    "Keep responses concise and conversational — this is a real-time group chat.",
    "Use short paragraphs. Avoid walls of text.",
    "Match the casual tone of chat. No formal greetings or sign-offs.",
  ].join(" "),

  "Chat::Line": [
    "You are responding to a Campfire chat message.",
    "Keep responses concise and conversational.",
    "Use short paragraphs. Match the casual chat tone.",
  ].join(" "),

  Todo: [
    "You are commenting on a Basecamp to-do.",
    "Be detailed and actionable. Reference specific tasks and steps.",
    "Structure your response clearly — use lists for action items.",
    "Focus on helping the assignee complete the to-do.",
  ].join(" "),

  "Kanban::Card": [
    "You are commenting on a Basecamp Card Table card.",
    "Focus on the card's context, including its current column position.",
    "Be concise but thorough. Structure feedback clearly.",
  ].join(" "),

  Question: [
    "You are answering a Basecamp check-in question.",
    "Be direct and structured. Match the question format.",
    "Keep your answer focused on what was asked.",
  ].join(" "),

  Message: [
    "You are commenting on a Basecamp Message Board post.",
    "Be thorough and well-structured. Use headings and lists where appropriate.",
    "This is a longer-form discussion context.",
  ].join(" "),

  Circle: [
    "You are in a direct Basecamp Ping conversation.",
    "Be helpful and personal. This is a private conversation.",
    "You can be more detailed since it's a focused 1:1 or small group chat.",
  ].join(" "),

  Comment: [
    "You are responding to a comment on a Basecamp recording.",
    "Be concise and relevant to the discussion thread.",
    "Reference the parent context when appropriate.",
  ].join(" "),
};

/** Surface prompt for a recordable type, if one is defined. Exported for tests. */
export function getSurfacePrompt(recordableType: string): string | undefined {
  return SURFACE_PROMPTS[recordableType];
}

/**
 * Structured Basecamp event metadata for the agent — rendered by prompt
 * assembly as fenced JSON, never as system instructions.
 */
function buildBasecampSupplemental(msg: BasecampInboundMessage, groupSystemPrompt?: string) {
  const payload: Record<string, unknown> = {
    recordableType: msg.meta.recordableType,
    eventKind: msg.meta.eventKind,
    bucketId: msg.meta.bucketId,
    recordingId: msg.meta.recordingId,
  };
  if (msg.meta.column) payload.column = msg.meta.column;
  if (msg.meta.columnPrevious) payload.columnPrevious = msg.meta.columnPrevious;
  if (msg.meta.assignedToAgent) payload.assignedToAgent = true;
  if (msg.meta.stateMarker) payload.stateMarker = msg.meta.stateMarker;
  if (msg.meta.dueOn) payload.dueOn = msg.meta.dueOn;
  if (msg.meta.mentions.length > 0) payload.mentions = msg.meta.mentions;
  if (msg.meta.assignees && msg.meta.assignees.length > 0) payload.assignees = msg.meta.assignees;
  if (msg.html && msg.html !== msg.text) payload.originalHtml = msg.html;

  // Comment-on-recording: surface the parent recording as quote context.
  const parentRecordingMatch = msg.peer.id.match(/^recording:(\d+)$/);
  const quote =
    msg.meta.recordableType === "Comment" && parentRecordingMatch && parentRecordingMatch[1] !== msg.meta.recordingId
      ? { id: parentRecordingMatch[1] }
      : undefined;

  return {
    ...(quote ? { quote } : {}),
    ...(groupSystemPrompt ? { groupSystemPrompt } : {}),
    channelStructuredContext: [
      {
        label: "Basecamp event",
        source: "basecamp",
        type: "basecamp_event",
        payload,
      },
    ],
  };
}

/**
 * ChannelPromptContext lines (channel metadata, not system instructions).
 * Carries surface guidance for direct Pings, where GroupSystemPrompt does
 * not apply.
 */
function buildChannelPromptContext(msg: BasecampInboundMessage, opts: { includeSurfacePrompt: boolean }): string[] {
  const lines: string[] = [];
  if (opts.includeSurfacePrompt) {
    const surfacePrompt = getSurfacePrompt(msg.meta.recordableType);
    if (surfacePrompt) lines.push(`[basecamp] surface guidance: ${surfacePrompt}`);
  }
  return lines;
}

/**
 * Sync outbound circuit breaker state to the metrics registry.
 */
function syncOutboundCircuitBreakerMetrics(
  cb: CircuitBreaker,
  key: string,
  accountId: string,
  cfg: OpenClawConfig,
): void {
  const state = cb.getState(key);
  if (!state) return;
  const cbConfig = resolveCircuitBreakerConfig(cfg);
  let derived: "closed" | "open" | "half-open" = "closed";
  if (state.trippedAt != null) {
    derived = Date.now() - state.trippedAt >= cbConfig.cooldownMs ? "half-open" : "open";
  }
  recordCircuitBreakerState(accountId, key, {
    state: derived,
    failures: state.failures,
    trippedAt: state.trippedAt,
  });
}
