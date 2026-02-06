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

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}

/** Max concurrent webhook dispatches. */
const MAX_CONCURRENT_DISPATCHES = 10;
/** Max queued dispatches before dropping. */
const MAX_QUEUED_DISPATCHES = 100;

export const dispatchSemaphore = new Semaphore(MAX_CONCURRENT_DISPATCHES);

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

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

/** Maximum allowed webhook request body size (1 MiB). */
const MAX_WEBHOOK_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Read the full request body as a string.
 * Rejects if the body exceeds MAX_WEBHOOK_BODY_BYTES.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let finished = false;

    req.on("data", (chunk: Buffer) => {
      if (finished) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_WEBHOOK_BODY_BYTES) {
        finished = true;
        req.destroy(new Error("Request body too large"));
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });

    req.on("error", (err) => {
      if (finished) return;
      finished = true;
      reject(err);
    });
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

  // Check backpressure before processing
  if (dispatchSemaphore.pending >= MAX_QUEUED_DISPATCHES) {
    console.error("[basecamp:webhook] dispatch queue full, dropping event");
    return;
  }
  if (dispatchSemaphore.pending > 0) {
    console.warn(`[basecamp:webhook] backpressure: ${dispatchSemaphore.pending} queued dispatches`);
  }

  // Dispatch with concurrency limit
  await dispatchSemaphore.acquire();
  try {
    await dispatchBasecampEvent(msg, { account });
  } catch (err) {
    console.error("[basecamp:webhook] dispatch error:", err);
  } finally {
    dispatchSemaphore.release();
  }
}
