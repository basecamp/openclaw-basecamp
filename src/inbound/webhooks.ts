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
import { join } from "node:path";
import type { BasecampWebhookPayload, ResolvedBasecampAccount } from "../types.js";
import { normalizeWebhookPayload, isSelfMessage } from "./normalize.js";
import { EventDedup } from "./dedup.js";
import { JsonFileDedupStore } from "./dedup-store.js";
import { dispatchBasecampEvent } from "../dispatch.js";
import { getBasecampRuntime } from "../runtime.js";
import { resolveBasecampAccount, resolveDefaultBasecampAccountId, resolveWebhookSecret, resolveAccountForBucket, listBasecampAccountIds } from "../config.js";
import { createConsoleStructuredLog } from "../logging.js";
import { recordWebhookReceived, recordWebhookDispatched, recordWebhookDropped, recordWebhookError, recordWebhookDedupSize } from "../metrics.js";

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
    if (this.current <= 0) {
      throw new Error("Semaphore release() called without matching acquire()");
    }
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

/** State directory for persistent dedup stores. Set via setWebhookStateDir(). */
let webhookStateDir: string | undefined;

/**
 * Configure the state directory for persistent webhook dedup stores.
 * Must be called before webhooks are processed to enable restart-safe dedup.
 * Idempotent: if the directory hasn't changed, this is a no-op.
 */
export function setWebhookStateDir(dir: string): void {
  const normalized = dir || undefined;
  if (normalized === webhookStateDir) return;
  // Flush existing instances before switching directories
  for (const dedup of dedupRegistry.values()) {
    dedup.flush();
  }
  dedupRegistry.clear();
  webhookStateDir = normalized;
}

function getDedup(accountId: string): EventDedup {
  let dedup = dedupRegistry.get(accountId);
  if (!dedup) {
    const store = webhookStateDir
      ? new JsonFileDedupStore(join(webhookStateDir, `webhook-dedup-${accountId}.json`))
      : undefined;
    dedup = new EventDedup(store ? { store } : undefined);
    dedupRegistry.set(accountId, dedup);
  }
  return dedup;
}

/**
 * Flush all webhook dedup stores to disk. Call on graceful shutdown.
 */
export function flushWebhookDedup(): void {
  for (const dedup of dedupRegistry.values()) {
    dedup.flush();
  }
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

  // ----- Webhook secret verification -----
  // Reject requests when no webhookSecret is configured (disabled by default)
  // or when the provided token doesn't match.
  let cfg;
  try {
    const runtime = getBasecampRuntime();
    cfg = runtime.config.loadConfig();
  } catch (err) {
    console.error("[basecamp:webhook] failed to load config:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
    return;
  }

  const webhookSecret = resolveWebhookSecret(cfg);
  if (!webhookSecret) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Webhooks not configured (set channels.basecamp.webhookSecret)" }));
    return;
  }

  // Check token from query string: /webhooks/basecamp?token=<secret>
  const urlObj = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const providedToken = urlObj.searchParams.get("token");
  if (!providedToken || providedToken !== webhookSecret) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid webhook token" }));
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
  if (!payload.kind || !payload.recording?.id || !payload.creator?.id || !payload.recording?.bucket?.id) {
    res.writeHead(422, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing required fields: kind, recording.id, recording.bucket.id, creator.id" }));
    return;
  }

  // Return 200 immediately — process async
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));

  // Resolve account from bucket ID in the webhook payload.
  // Check virtualAccounts for a scope mapping. Reject unmapped buckets
  // in multi-account mode to prevent dispatching under the wrong identity.
  let account: ResolvedBasecampAccount;
  try {
    const bucketId = String(payload.recording.bucket.id);
    const scopeAccountId = resolveAccountForBucket(cfg, bucketId);
    if (!scopeAccountId) {
      // No virtualAccount mapping for this bucket. In multi-account mode
      // this is ambiguous — reject rather than guess wrong identity.
      const accountIds = listBasecampAccountIds(cfg);
      if (accountIds.length > 1) {
        const preslog = createConsoleStructuredLog({ accountId: "unknown", source: "webhook" });
        preslog.warn("unmapped_bucket", {
          bucketId,
          accountCount: accountIds.length,
          hint: "add a virtualAccounts entry to route this bucket to an account",
        });
        return;
      }
    }
    const effectiveAccountId = scopeAccountId ?? resolveDefaultBasecampAccountId(cfg);
    account = resolveBasecampAccount(cfg, effectiveAccountId);
    if (!account.enabled) {
      const preslog = createConsoleStructuredLog({ accountId: effectiveAccountId, source: "webhook" });
      preslog.warn("account_disabled");
      return;
    }
  } catch (err) {
    const errlog = createConsoleStructuredLog({ accountId: "unknown", source: "webhook" });
    errlog.error("account_resolution_failed", { error: String(err), stack: err instanceof Error ? err.stack : undefined });
    return;
  }

  const slog = createConsoleStructuredLog({ accountId: account.accountId, source: "webhook" });
  recordWebhookReceived(account.accountId);

  // Normalize
  let msg;
  try {
    msg = normalizeWebhookPayload(payload, account);
  } catch (err) {
    slog.error("normalization_error", { error: String(err), stack: err instanceof Error ? err.stack : undefined });
    recordWebhookError(account.accountId);
    return;
  }

  // Self-message filter
  if (isSelfMessage(msg.sender.id, account)) {
    recordWebhookDropped(account.accountId);
    return;
  }

  // Dedup
  const dedup = getDedup(account.accountId);
  const secondaryKey = msg.meta.recordingId
    ? EventDedup.secondaryKey(msg.meta.recordingId, msg.meta.eventKind, msg.createdAt)
    : undefined;
  if (dedup.isDuplicate(msg.dedupKey, secondaryKey)) {
    recordWebhookDropped(account.accountId);
    recordWebhookDedupSize(account.accountId, dedup.size);
    return;
  }

  // Check backpressure before processing
  if (dispatchSemaphore.pending >= MAX_QUEUED_DISPATCHES) {
    slog.error("queue_full");
    recordWebhookDropped(account.accountId);
    recordWebhookDedupSize(account.accountId, dedup.size);
    return;
  }
  if (dispatchSemaphore.pending > 0) {
    slog.warn("backpressure", { queued: dispatchSemaphore.pending });
  }

  // Dispatch with concurrency limit
  await dispatchSemaphore.acquire();
  try {
    const delivered = await dispatchBasecampEvent(msg, { account });
    if (delivered) {
      recordWebhookDispatched(account.accountId);
    } else {
      recordWebhookDropped(account.accountId);
    }
  } catch (err) {
    slog.error("dispatch_error", { error: String(err), stack: err instanceof Error ? err.stack : undefined });
    recordWebhookError(account.accountId);
  } finally {
    recordWebhookDedupSize(account.accountId, dedup.size);
    dispatchSemaphore.release();
  }
}
