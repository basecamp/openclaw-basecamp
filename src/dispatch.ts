/**
 * Dispatch bridge — connects inbound Basecamp events to OpenClaw agents.
 *
 * This is the critical bridge between the inbound event fabric and OpenClaw's
 * agent routing/reply system. For each normalized BasecampInboundMessage it:
 *
 * 1. Calls resolveAgentRoute with peer + parentPeer to find the target agent
 * 2. Builds a MsgContext with all Basecamp-specific fields
 * 3. Calls dispatchReplyWithBufferedBlockDispatcher to run the agent
 * 4. The deliver callback uses persona resolution and postReplyToEvent
 *    to send the agent's response back to the correct Basecamp surface
 */

import type { BasecampInboundMessage, BasecampChannelConfig, BasecampEngagementType, ResolvedBasecampAccount } from "./types.js";
import { DEFAULT_ENGAGE } from "./types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getBasecampRuntime } from "./runtime.js";
import { resolvePersonaAccountId, resolveBasecampAccount, resolveBasecampDmPolicy, resolveBasecampAllowFrom, resolveCircuitBreakerConfig } from "./config.js";
import { postReplyToEvent } from "./outbound/send.js";
import { markdownToBasecampHtml } from "./outbound/format.js";
import { chunkMarkdownText, BASECAMP_TEXT_CHUNK_LIMIT } from "./adapters/outbound.js";
import { createStructuredLog } from "./logging.js";
import { CircuitBreaker } from "./bcq.js";
import { recordCircuitBreakerState } from "./metrics.js";

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

export type DispatchOptions = {
  /** The resolved account that received this event. */
  account: ResolvedBasecampAccount;
  /** Optional logger. */
  log?: { info: (msg: string) => void; warn: (msg: string) => void; debug?: (msg: string) => void; error: (msg: string) => void };
};

/**
 * Dispatch a normalized Basecamp inbound message to the OpenClaw agent pipeline.
 *
 * Returns true if the message was dispatched, false if it was dropped
 * (e.g., no matching agent route, self-message, etc.).
 */
export async function dispatchBasecampEvent(
  msg: BasecampInboundMessage,
  options: DispatchOptions,
): Promise<boolean> {
  const runtime = getBasecampRuntime();
  const cfg = runtime.config.loadConfig();
  const { account, log } = options;
  const slog = createStructuredLog(log, { accountId: account.accountId, source: "dispatch" });

  // ----- Self-message filtering -----
  // Skip messages from our own service account to avoid loops.
  if (msg.sender.id === account.personId) {
    slog.debug("self_message_skipped", { personId: msg.sender.id });
    return false;
  }

  // ----- Project-scope routing override -----
  // Check if the event's bucketId matches a virtualAccounts entry;
  // if so, override the accountId to the scope alias so agent bindings match.
  const effectiveAccountId = resolveProjectScopeAccountId(cfg, msg) ?? msg.accountId;

  // ----- Route resolution -----
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "basecamp",
    accountId: effectiveAccountId,
    peer: msg.peer,
    parentPeer: msg.parentPeer,
  });

  if (!route) {
    slog.debug("no_route", { peer: msg.peer.id });
    return false;
  }

  // ----- Engagement gate -----
  // Classify the event, then check it against the configured engagement
  // policy. Defaults to ["dm", "mention", "assignment", "checkin"].
  // Per-bucket overrides take precedence over channel-level config.
  const engagement = classifyEngagement(msg);
  const engagePolicy = resolveEngagePolicy(cfg, msg.meta.bucketId);
  if (!engagePolicy.includes(engagement)) {
    slog.debug("engagement_gate_dropped", {
      engagement,
      event: msg.meta.eventKind,
      type: msg.meta.recordableType,
      peer: msg.peer.id,
      policy: engagePolicy.join(","),
    });
    return false;
  }

  // ----- DM policy enforcement -----
  // Even when engagement=dm passes the engage gate, verify the sender is
  // allowed under the configured DM policy (SDK vocabulary:
  // pairing | allowlist | open | disabled).
  if (engagement === "dm") {
    const dmPolicy = resolveBasecampDmPolicy(cfg);
    if (dmPolicy === "disabled") {
      slog.debug("dm_policy_dropped", { sender: msg.sender.id, policy: "disabled" });
      return false;
    }
    if (dmPolicy === "pairing" || dmPolicy === "allowlist") {
      const allowFrom = resolveBasecampAllowFrom(cfg);
      if (!allowFrom.includes(msg.sender.id)) {
        slog.debug("dm_policy_dropped", {
          sender: msg.sender.id,
          policy: dmPolicy,
          allowFrom: allowFrom.join(","),
        });
        return false;
      }
    }
    // dmPolicy === "open" → allow all DMs through
  }

  slog.info("dispatching", {
    agent: route.agentId,
    matchedBy: route.matchedBy,
    peer: `${msg.peer.kind}:${msg.peer.id}`,
    recordableType: msg.meta.recordableType,
  });

  // ----- Resolve persona for outbound -----
  // The agent may have a dedicated Basecamp persona (service account).
  const personaAccountId = resolvePersonaAccountId(cfg, route.agentId);
  // Resolve the outbound account's bcqProfile (persona may have its own profile)
  const outboundAccount = personaAccountId
    ? resolveBasecampAccount(cfg, personaAccountId)
    : account;
  const outboundProfile = outboundAccount.bcqProfile;
  // Use the bcq account ID for API calls — NOT the OpenClaw account ID.
  // The OpenClaw account ID ("default") is never valid for bcq --account.
  const outboundBcqAccountId =
    outboundAccount.config.bcqAccountId ??
    (/^\d+$/.test(outboundAccount.accountId) ? outboundAccount.accountId : undefined);
  if (!outboundBcqAccountId) {
    slog.error("outbound_account_id_missing", {
      outboundAccount: outboundAccount.accountId,
      hint: "Set config.bcqAccountId to a valid Basecamp account id",
    });
    return false;
  }

  // ----- Build MsgContext -----
  // OpenClaw expects ChatType "direct" | "group" — NOT "dm"
  const chatType = msg.peer.kind === "dm" ? "direct" : "group";

  const ctx = {
    Body: msg.text,
    RawBody: msg.text,
    // Namespace From/To with basecamp: prefix for allowlists, audits, debug
    From: `basecamp:${msg.sender.id}`,
    To: `basecamp:${msg.peer.id}`,
    SenderId: msg.sender.id,
    SenderName: msg.sender.name,
    ChatType: chatType,
    Provider: "basecamp",
    Surface: "basecamp",
    Timestamp: new Date(msg.createdAt).getTime(),
    // MessageSid: messageId for comment/message events, recordingId for
    // non-message events (card moves, todo completions, etc.)
    MessageSid: msg.meta.messageId ?? msg.meta.recordingId,
    AccountId: msg.accountId,
    OriginatingChannel: "basecamp" as const,
    OriginatingTo: `basecamp:${msg.peer.id}`,
    WasMentioned: msg.meta.mentionsAgent || undefined,
    // Basecamp-specific context via UntrustedContext
    UntrustedContext: buildUntrustedContext(msg),
    // Session key from route
    SessionKey: route.sessionKey,
  };

  // ----- Dispatch with buffered block dispatcher -----
  let dispatchHadError = false;

  // Outbound circuit breaker: fail fast when Basecamp API is persistently down.
  const outboundCb = getOutboundCircuitBreaker(cfg, outboundAccount.accountId);
  const outboundCbKey = "outbound";

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        if (!payload.text) return;

        // Chunk long agent output to fit within Basecamp's character limit.
        // Each chunk is converted to HTML and sent as a separate message.
        const chunks = chunkMarkdownText(payload.text, BASECAMP_TEXT_CHUNK_LIMIT);

        for (const chunk of chunks) {
          const htmlContent = markdownToBasecampHtml(chunk);

          const result = await postReplyToEvent({
            bucketId: msg.meta.bucketId,
            recordingId: msg.meta.recordingId,
            recordableType: msg.meta.recordableType,
            peerId: msg.peer.id,
            content: htmlContent,
            accountId: outboundBcqAccountId,
            profile: outboundProfile,
            retries: 2,
            circuitBreaker: { instance: outboundCb, key: outboundCbKey },
          });

          if (!result.ok) {
            throw new Error(result.error ?? "Outbound delivery failed");
          }
        }
      },
      onError: (err) => {
        dispatchHadError = true;
        const errorType = classifyDispatchError(err);
        slog.error("delivery_failed", {
          agent: route.agentId,
          event: msg.meta.eventKind,
          recording: msg.meta.recordingId,
          sender: msg.sender.id,
          type: errorType,
          error: String(err),
        });
        syncOutboundCircuitBreakerMetrics(outboundCb, outboundCbKey, account.accountId, cfg);
      },
    },
  });

  if (!dispatchHadError) {
    syncOutboundCircuitBreakerMetrics(outboundCb, outboundCbKey, account.accountId, cfg);
    slog.info("delivered", {
      agent: route.agentId,
      event: msg.meta.eventKind,
      recording: msg.meta.recordingId,
    });
  }

  return true;
}

// ---------------------------------------------------------------------------
// Helpers
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
function classifyEngagement(msg: BasecampInboundMessage): BasecampEngagementType {
  if (msg.peer.kind === "dm") return "dm";
  if (msg.meta.mentionsAgent) return "mention";
  if (msg.meta.assignedToAgent) return "assignment";

  // Check-in reminders: Question in Hey! inbox = you're a respondent
  if (
    msg.meta.recordableType === "Question" &&
    msg.meta.sources.includes("readings")
  ) {
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
function resolveEngagePolicy(
  cfg: OpenClawConfig,
  bucketId: string,
): BasecampEngagementType[] {
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
 * Prefers structured error properties (code, status) over message heuristics.
 */
function classifyDispatchError(err: unknown): string {
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

  // Auth errors: prefer structured HTTP status, then message heuristics.
  if (statusValue === 401 || statusValue === 403) return "auth";
  if (lowerMessage.includes("unauthorized") || lowerMessage.includes("forbidden")) return "auth";

  // Network errors: prefer error codes when available, fall back to message.
  if (code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "ECONNRESET") return "network";
  if (
    lowerMessage.includes("etimedout") ||
    lowerMessage.includes("econnrefused") ||
    lowerMessage.includes("econnreset") ||
    lowerMessage.includes("timeout")
  ) return "network";

  // Routing errors: be specific to avoid matching HTTP 404s.
  if (/\bno route\b/.test(lowerMessage)) return "routing";

  return "unknown";
}

/**
 * Check if an inbound message's bucketId matches a virtualAccounts entry.
 * Returns the virtual account key (scope alias) if matched, undefined otherwise.
 */
function resolveProjectScopeAccountId(
  cfg: OpenClawConfig,
  msg: BasecampInboundMessage,
): string | undefined {
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

/**
 * Build UntrustedContext entries from Basecamp-specific metadata.
 * These are passed to the agent as untrusted context (not system instructions).
 */
function buildUntrustedContext(msg: BasecampInboundMessage): string[] {
  const lines: string[] = [];

  lines.push(`[basecamp] recordableType=${msg.meta.recordableType}`);
  lines.push(`[basecamp] eventKind=${msg.meta.eventKind}`);
  lines.push(`[basecamp] bucketId=${msg.meta.bucketId} recordingId=${msg.meta.recordingId}`);

  if (msg.meta.column) {
    lines.push(`[basecamp] column=${msg.meta.column}`);
  }
  if (msg.meta.columnPrevious) {
    lines.push(`[basecamp] columnPrevious=${msg.meta.columnPrevious}`);
  }
  if (msg.meta.assignedToAgent) {
    lines.push(`[basecamp] assignedToAgent=true`);
  }
  if (msg.meta.stateMarker) {
    lines.push(`[basecamp] stateMarker=${msg.meta.stateMarker}`);
  }
  if (msg.meta.dueOn) {
    lines.push(`[basecamp] dueOn=${msg.meta.dueOn}`);
  }
  if (msg.meta.mentions.length > 0) {
    lines.push(`[basecamp] mentions=${msg.meta.mentions.join(",")}`);
  }
  if (msg.meta.assignees && msg.meta.assignees.length > 0) {
    lines.push(`[basecamp] assignees=${msg.meta.assignees.join(",")}`);
  }

  // Include original HTML for the agent if it's different from plain text
  if (msg.html && msg.html !== msg.text) {
    lines.push(`[basecamp] originalHtml=${msg.html}`);
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

