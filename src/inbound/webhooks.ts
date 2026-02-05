/**
 * Basecamp webhook HTTP handler (supplementary inbound source).
 *
 * Receives Basecamp webhook payloads at /webhooks/basecamp, normalizes
 * them to BasecampInboundMessage, and dispatches to agents. Supplements
 * the polling-based inbound pipeline with real-time delivery.
 *
 * Webhook events use their own EventDedup instance. Cross-source dedup
 * with the poller relies on the secondary key (recording:id:kind:ts)
 * which both sources generate for the same underlying Basecamp event.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { BasecampWebhookPayload, ResolvedBasecampAccount } from "../types.js";
import { normalizeWebhookPayload, isSelfMessage } from "./normalize.js";
import { EventDedup } from "./dedup.js";
import { dispatchBasecampEvent } from "../dispatch.js";
import { getBasecampRuntime } from "../runtime.js";
import { resolveBasecampAccount } from "../config.js";

/** Per-account dedup instances for webhook events. */
const dedupRegistry = new Map<string, EventDedup>();

function getDedup(accountId: string): EventDedup {
  let dedup = dedupRegistry.get(accountId);
  if (!dedup) {
    dedup = new EventDedup();
    dedupRegistry.set(accountId, dedup);
  }
  return dedup;
}

/**
 * Read the full request body as a string.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Basecamp webhook HTTP handler.
 *
 * Returns 200 immediately to acknowledge receipt, then processes
 * the event asynchronously to avoid webhook timeout.
 */
export async function handleBasecampWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Only accept POST
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // Read and parse body
  let payload: BasecampWebhookPayload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body) as BasecampWebhookPayload;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  // Validate minimal required fields
  if (!payload.kind || !payload.recording?.id || !payload.creator?.id) {
    res.writeHead(422, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing required fields: kind, recording.id, creator.id" }));
    return;
  }

  // Return 200 immediately — process async
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));

  // Resolve account from the webhook delivery context.
  // Basecamp webhooks include a bucket.id — we use it to find the account.
  // For Phase 1, we resolve the default account.
  let account: ResolvedBasecampAccount;
  try {
    const runtime = getBasecampRuntime();
    const cfg = runtime.config.loadConfig();
    account = resolveBasecampAccount(cfg);
  } catch (err) {
    console.error("[basecamp:webhook] failed to resolve account:", err);
    return;
  }

  // Normalize
  let msg;
  try {
    msg = normalizeWebhookPayload(payload, account);
  } catch (err) {
    console.error("[basecamp:webhook] normalization error:", err);
    return;
  }

  // Self-message filter
  if (isSelfMessage(msg.sender.id, account)) {
    return;
  }

  // Dedup
  const dedup = getDedup(account.accountId);
  const secondaryKey = msg.meta.recordingId
    ? EventDedup.secondaryKey(msg.meta.recordingId, msg.meta.eventKind, msg.createdAt)
    : undefined;
  if (dedup.isDuplicate(msg.dedupKey, secondaryKey)) {
    return;
  }

  // Dispatch
  try {
    await dispatchBasecampEvent(msg, { account });
  } catch (err) {
    console.error("[basecamp:webhook] dispatch error:", err);
  }
}
