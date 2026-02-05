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

import type { BasecampInboundMessage, ResolvedBasecampAccount } from "./types.js";
import { getBasecampRuntime } from "./runtime.js";
import { resolvePersonaAccountId, resolveBasecampAccount } from "./config.js";
import { postReplyToEvent } from "./outbound/send.js";
import { markdownToBasecampHtml } from "./outbound/format.js";

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

  // ----- Self-message filtering -----
  // Skip messages from our own service account to avoid loops.
  if (msg.sender.id === account.personId) {
    log?.debug?.(`[${account.accountId}] skipping self-message from personId=${msg.sender.id}`);
    return false;
  }

  // ----- Route resolution -----
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "basecamp",
    accountId: msg.accountId,
    peer: msg.peer,
    parentPeer: msg.parentPeer,
  });

  if (!route) {
    log?.debug?.(`[${account.accountId}] no agent route for peer=${msg.peer.id}`);
    return false;
  }

  log?.info?.(
    `[${account.accountId}] dispatching to agent=${route.agentId} via ${route.matchedBy} ` +
    `peer=${msg.peer.kind}:${msg.peer.id} recordableType=${msg.meta.recordableType}`,
  );

  // ----- Resolve persona for outbound -----
  // The agent may have a dedicated Basecamp persona (service account).
  const personaAccountId = resolvePersonaAccountId(cfg, route.agentId);
  const outboundAccountId = personaAccountId ?? account.accountId;
  // Resolve the outbound account's bcqProfile (persona may have its own profile)
  const outboundAccount = personaAccountId
    ? resolveBasecampAccount(cfg, personaAccountId)
    : account;
  const outboundProfile = outboundAccount.bcqProfile;

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
  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        if (!payload.text) return;

        // Convert agent markdown output to Basecamp HTML
        const htmlContent = markdownToBasecampHtml(payload.text);

        await postReplyToEvent({
          bucketId: msg.meta.bucketId,
          recordingId: msg.meta.recordingId,
          recordableType: msg.meta.recordableType,
          peerId: msg.peer.id,
          content: htmlContent,
          accountId: outboundAccountId,
          profile: outboundProfile,
        });
      },
      onError: (err) => {
        log?.error?.(`[${account.accountId}] reply error for agent=${route.agentId}: ${String(err)}`);
      },
    },
  });

  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
