/**
 * Basecamp webhook HTTP handler (supplementary inbound source).
 *
 * Receives Basecamp webhook payloads at /webhooks/basecamp, normalizes
 * them to BasecampInboundMessage, and dispatches to agents. Supplements
 * the polling-based inbound pipeline with real-time delivery.
 *
 * Request hygiene uses the SDK webhook guards (SPEC §2.17):
 * - readWebhookBodyOrReject: bounded body read (raw body needed for HMAC)
 * - createWebhookInFlightLimiter: per-account concurrency cap
 * - runDetachedWebhookWork: post-ack processing visible to gateway drain
 * - safeEqualSecret: constant-time secret comparison
 * HMAC verification itself stays plugin-owned (Basecamp's Stripe-style
 * signed-payload protocol is channel-specific).
 *
 * Webhook events share the process-wide replay guard with the poller.
 * Cross-source dedup relies on the secondary key (recordingId:action:ts)
 * which both sources generate for the same event.
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import {
  createWebhookInFlightLimiter,
  readWebhookBodyOrReject,
  runDetachedWebhookWork,
} from "openclaw/plugin-sdk/webhook-request-guards";
import {
  listBasecampAccountIds,
  resolveAccountForBucket,
  resolveBasecampAccount,
  resolveDefaultBasecampAccountId,
  resolveWebhookSecret,
} from "../config.js";
import { dispatchBasecampEvent } from "../dispatch.js";
import { createConsoleStructuredLog } from "../logging.js";
import {
  recordQueueFullDrop,
  recordWebhookAuthMethod,
  recordWebhookDispatched,
  recordWebhookDropped,
  recordWebhookError,
  recordWebhookReceived,
} from "../metrics.js";
import { getBasecampRuntime } from "../runtime.js";
import type { BasecampWebhookPayload, ResolvedBasecampAccount } from "../types.js";
import { isSelfMessage, normalizeWebhookPayload } from "./normalize.js";
import { getRecordingIndex, recordInboundMessageMappings } from "./recording-index.js";
import { getReplayGuard, replaySecondaryKey } from "./replay-guard.js";
import { resolvePluginStateDir } from "./state-dir.js";
import { JsonFileWebhookSecretStore, WebhookSecretRegistry } from "./webhook-secrets.js";

// ---------------------------------------------------------------------------
// Concurrency limiter — per-account in-flight cap (no unbounded queue)
// ---------------------------------------------------------------------------

/** Max concurrent webhook dispatches per account. */
const MAX_CONCURRENT_DISPATCHES = 10;

export const webhookInFlightLimiter = createWebhookInFlightLimiter({
  maxInFlightPerKey: MAX_CONCURRENT_DISPATCHES,
});

// ---------------------------------------------------------------------------
// HMAC-SHA256 verification (Stripe-style: X-Basecamp-Signature + Timestamp)
// ---------------------------------------------------------------------------

/** Per-account webhook secret registries, keyed by account and bound to a state dir. */
const secretRegistries = new Map<string, { registry: WebhookSecretRegistry; stateDir: string }>();

/**
 * Get or create a webhook secret registry for an account.
 * The registry is backed by a persistent JSON file in the plugin state dir.
 * If the resolved state dir has changed since the registry was created, the
 * old one is flushed and a new one is created for the new path.
 */
export function getWebhookSecretRegistry(accountId: string): WebhookSecretRegistry {
  const currentStateDir = resolvePluginStateDir();
  const entry = secretRegistries.get(accountId);

  if (entry && entry.stateDir === currentStateDir) {
    return entry.registry;
  }

  // State dir changed or first access — flush old registry if present
  if (entry) {
    entry.registry.flush();
  }

  const store = new JsonFileWebhookSecretStore(join(currentStateDir, `webhook-secrets-${accountId}.json`));
  const registry = new WebhookSecretRegistry(store);
  secretRegistries.set(accountId, { registry, stateDir: currentStateDir });
  return registry;
}

/** Maximum age (in seconds) for timestamp replay protection. Default: 5 minutes. */
const MAX_TIMESTAMP_AGE_S = 300;

/**
 * Verify a Basecamp webhook HMAC-SHA256 signature.
 *
 * Protocol (Stripe-style):
 *   signed_payload = "{timestamp}.{body}"
 *   expected = "sha256=" + HMAC-SHA256(secret, signed_payload).hex()
 *
 * Returns true if the signature is valid for any of the provided secrets.
 */
export function verifyWebhookSignature(params: {
  signature: string;
  timestamp: string;
  rawBody: string;
  secrets: string[];
}): boolean {
  const { signature, timestamp, rawBody, secrets } = params;
  if (!signature || !timestamp || secrets.length === 0) return false;

  // Replay protection: reject if timestamp is too old
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (age > MAX_TIMESTAMP_AGE_S) return false;

  const signedPayload = `${timestamp}.${rawBody}`;

  return secrets.some((secret) => {
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
    return safeEqualSecret(signature, expected);
  });
}

/**
 * Drop an account's in-memory secret registry without flushing. Used when the
 * account is removed: a later flushWebhookSecrets() must not resurrect the
 * deleted secrets file from the cached snapshot.
 */
export function closeWebhookSecretRegistry(accountId: string): void {
  secretRegistries.delete(accountId);
}

/**
 * Flush all webhook secret registries to disk. Call on graceful shutdown.
 */
export function flushWebhookSecrets(): void {
  for (const { registry } of secretRegistries.values()) {
    registry.flush();
  }
}

/** Maximum allowed webhook request body size (1 MiB). */
const MAX_WEBHOOK_BODY_BYTES = 1 * 1024 * 1024;
/** Body read timeout. */
const WEBHOOK_BODY_TIMEOUT_MS = 10_000;

/**
 * Basecamp webhook HTTP handler.
 *
 * Returns 200 immediately to acknowledge receipt, then processes the event
 * on a detached gateway work root (visible to shutdown drain).
 */
export async function handleBasecampWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Only accept POST
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // ----- Load config -----
  // config.current() returns a DeepReadonly snapshot; widen at this boundary.
  let cfg: OpenClawConfig;
  try {
    const runtime = getBasecampRuntime();
    cfg = runtime.config.current() as OpenClawConfig;
  } catch (err) {
    console.error("[basecamp:webhook] failed to load config:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
    return;
  }

  // ----- Read body first (raw string needed for both HMAC and JSON parsing) -----
  // Pre-auth read with bounded size/time; the guard writes the rejection
  // response itself on failure.
  const bodyRead = await readWebhookBodyOrReject({
    req,
    res,
    maxBytes: MAX_WEBHOOK_BODY_BYTES,
    timeoutMs: WEBHOOK_BODY_TIMEOUT_MS,
    profile: "pre-auth",
    invalidBodyMessage: "Invalid request body",
  });
  if (!bodyRead.ok) return;
  const rawBody = bodyRead.value;

  // ----- Authentication -----
  // Try query-string token first (?token=<secret>), then fall back to HMAC
  // signature verification (X-Basecamp-Signature header). Token is primary
  // because BC3 never returns HMAC secrets on webhook creation.
  const webhookSecret = resolveWebhookSecret(cfg);

  let authenticated = false;
  let authMethod: "token" | "hmac" | undefined;

  // Token path (primary): check query-string ?token=<webhookSecret>
  if (webhookSecret) {
    const urlObj = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const providedToken = urlObj.searchParams.get("token");
    if (providedToken && safeEqualSecret(providedToken, webhookSecret)) {
      authenticated = true;
      authMethod = "token";
    }
  }

  // HMAC path (secondary): X-Basecamp-Signature + X-Basecamp-Timestamp
  if (!authenticated) {
    const hmacSignature = req.headers["x-basecamp-signature"] as string | undefined;
    const hmacTimestamp = req.headers["x-basecamp-timestamp"] as string | undefined;

    if (hmacSignature && hmacTimestamp) {
      // HMAC path: scope verification to the specific bucket/account when possible.
      let candidateSecrets: string[] = [];
      let bucketResolved = false;
      try {
        const parsed = JSON.parse(rawBody) as { recording?: { bucket?: { id?: number } } };
        const bucketId = parsed?.recording?.bucket?.id;
        if (bucketId != null) {
          const bucketAccountId = resolveAccountForBucket(cfg, String(bucketId));
          if (bucketAccountId) {
            bucketResolved = true;
            const registry = getWebhookSecretRegistry(bucketAccountId);
            candidateSecrets = registry.getAllSecrets().filter((s) => s.length > 0);
          }
        }
      } catch {
        // JSON parse failed — fall through to all secrets
      }

      if (!bucketResolved && candidateSecrets.length === 0) {
        for (const accountId of listBasecampAccountIds(cfg)) {
          const registry = getWebhookSecretRegistry(accountId);
          candidateSecrets.push(...registry.getAllSecrets().filter((s) => s.length > 0));
        }
      }

      if (candidateSecrets.length > 0) {
        authenticated = verifyWebhookSignature({
          signature: hmacSignature,
          timestamp: hmacTimestamp,
          rawBody,
          secrets: candidateSecrets,
        });
        if (authenticated) authMethod = "hmac";
      }
    }
  }

  if (!authenticated) {
    // No valid authentication — check if webhooks are configured at all.
    // Eagerly load registries for all configured accounts to avoid false
    // negatives when secrets exist on disk but weren't loaded yet.
    const hasAnySecrets = listBasecampAccountIds(cfg).some((id) => getWebhookSecretRegistry(id).size > 0);
    if (!webhookSecret && !hasAnySecrets) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Webhooks not configured (set channels.basecamp.webhookSecret or configure webhooks.payloadUrl)",
        }),
      );
    } else {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid webhook signature or token" }));
    }
    return;
  }

  // ----- Parse body -----
  let payload: BasecampWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as BasecampWebhookPayload;
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

  // Return 200 immediately — process on a detached gateway work root so the
  // continuation stays admitted (and drain-aware) after this request settles.
  // Started synchronously while the request is still admitted.
  const detached = runDetachedWebhookWork(() => processWebhookPayload(payload, cfg, authMethod));

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));

  await detached;
}

/** Post-ack webhook processing: account resolution → normalize → guard → dispatch. */
async function processWebhookPayload(
  payload: BasecampWebhookPayload,
  cfg: OpenClawConfig,
  authMethod: "token" | "hmac" | undefined,
): Promise<void> {
  // Resolve account from bucket ID in the webhook payload.
  // Check virtualAccounts for a scope mapping. Reject unmapped buckets
  // in multi-account mode to prevent dispatching under the wrong identity.
  let account: ResolvedBasecampAccount;
  try {
    const bucketId = String(payload.recording!.bucket!.id);
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
    errlog.error("account_resolution_failed", {
      error: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return;
  }

  const slog = createConsoleStructuredLog({ accountId: account.accountId, source: "webhook" });
  recordWebhookReceived(account.accountId);
  if (authMethod) recordWebhookAuthMethod(account.accountId, authMethod);

  // Normalize
  let msg: Awaited<ReturnType<typeof normalizeWebhookPayload>>;
  try {
    msg = await normalizeWebhookPayload(payload, account);
  } catch (err) {
    slog.error("normalization_error", { error: String(err), stack: err instanceof Error ? err.stack : undefined });
    recordWebhookError(account.accountId);
    return;
  }

  if (!msg) {
    slog.warn("unknown_kind_dropped", { kind: payload.kind });
    recordWebhookDropped(account.accountId);
    return;
  }

  // Populate the recording→bucket index so outbound cold sends can resolve
  // recordings seen only via webhooks (SPEC §2.15).
  try {
    const index = await getRecordingIndex(account.accountId);
    recordInboundMessageMappings(
      index,
      msg,
      (payload.recording as { parent?: { id: string | number; type?: string } }).parent,
    );
  } catch {
    // Index population is best-effort; outbound resolution reports misses.
  }

  // Self-message filter (belt-and-braces — dispatch also checks)
  if (isSelfMessage(msg.sender.id, account)) {
    recordWebhookDropped(account.accountId);
    return;
  }

  // In-flight cap per account: reject rather than queue unboundedly.
  if (!webhookInFlightLimiter.tryAcquire(account.accountId)) {
    slog.error("queue_full");
    recordWebhookDropped(account.accountId);
    recordQueueFullDrop(account.accountId);
    return;
  }

  try {
    // Replay guard (shared with poller — cross-source secondary key)
    const secondaryKey = msg.meta.recordingId
      ? replaySecondaryKey(msg.meta.recordingId, msg.meta.eventKind, msg.createdAt)
      : undefined;
    const inbound = msg;
    const result = await getReplayGuard().processGuarded(
      { accountId: account.accountId, primaryKey: msg.dedupKey, secondaryKey },
      async () => dispatchBasecampEvent(inbound, { account, cfg }),
    );

    if (result.kind !== "processed") {
      recordWebhookDropped(account.accountId);
    } else if (result.value) {
      recordWebhookDispatched(account.accountId);
    } else {
      recordWebhookDropped(account.accountId);
    }
  } catch (err) {
    slog.error("dispatch_error", { error: String(err), stack: err instanceof Error ? err.stack : undefined });
    recordWebhookError(account.accountId);
  } finally {
    webhookInFlightLimiter.release(account.accountId);
  }
}
