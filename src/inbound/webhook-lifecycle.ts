/**
 * Webhook subscription lifecycle management.
 *
 * Automatically registers webhooks for configured projects on gateway
 * startup, reconciles existing subscriptions, and optionally deactivates
 * on shutdown.
 *
 * Secrets from webhook creation are persisted via WebhookSecretRegistry
 * so HMAC verification survives restarts.
 */

import type { ResolvedBasecampAccount } from "../types.js";
import { getClient, numId, rawOrThrow } from "../basecamp-client.js";
import type { WebhookSecretRegistry } from "./webhook-secrets.js";
import type { StructuredLog } from "../logging.js";

export interface WebhookLifecycleConfig {
  /** HTTPS URL where Basecamp sends webhook payloads. */
  payloadUrl: string;
  /** Bucket IDs to create webhooks for. */
  projects: string[];
  /** Recordable types to subscribe to. Empty = all types. */
  types: string[];
  /** Resolved account for API calls. */
  account: ResolvedBasecampAccount;
}

/** Shape from the SDK's Webhook type (may lack secret). */
interface WebhookRecord {
  id: number;
  active: boolean;
  payload_url: string;
  types?: string[];
  kinds?: string[];
  secret?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Check whether a webhook's subscribed types match the desired types.
 * Empty array means "all types" — two empty arrays match.
 */
function typesMatch(webhookTypes: string[] | undefined, configTypes: string[]): boolean {
  const wt = (webhookTypes ?? []).slice().sort();
  const ct = configTypes.slice().sort();
  if (wt.length !== ct.length) return false;
  return wt.every((t, i) => t === ct[i]);
}

export interface ReconcileResult {
  created: string[];
  existing: string[];
  recovered: string[];
  failed: string[];
}

/**
 * Reconcile webhook subscriptions for configured projects.
 *
 * For each project:
 * 1. List existing webhooks
 * 2. If a webhook with matching payloadUrl exists → skip (already registered)
 * 3. If no match → create a new webhook and persist the secret
 *
 * Returns which projects were created, already existed, or failed.
 */
export async function reconcileWebhooks(
  config: WebhookLifecycleConfig,
  registry: WebhookSecretRegistry,
  log?: StructuredLog,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { created: [], existing: [], recovered: [], failed: [] };
  const client = getClient(config.account);

  for (const projectId of config.projects) {
    try {
      // List existing webhooks for this project
      let existing: WebhookRecord[] = [];
      try {
        const listResult = await client.webhooks.list(numId("project", projectId));
        existing = Array.isArray(listResult) ? listResult as any : [];
      } catch {
        // List failed — treat as empty (will attempt create)
        existing = [];
      }

      // Check if a webhook with our payloadUrl already exists
      const urlMatch = existing.find(
        (wh) => wh.payload_url === config.payloadUrl && wh.active,
      );

      if (urlMatch && typesMatch(urlMatch.types, config.types)) {
        log?.debug("webhook_exists", {
          project: projectId,
          webhookId: urlMatch.id,
        });

        // If we don't have a secret stored for this project (e.g., first
        // startup after manual webhook creation), record what we can.
        if (!registry.get(projectId)) {
          registry.set(projectId, {
            webhookId: String(urlMatch.id),
            secret: "",
            payloadUrl: urlMatch.payload_url,
            types: urlMatch.types ?? [],
          });
        }

        result.existing.push(projectId);
        continue;
      }

      // URL matches but types differ — delete stale webhook before creating new one
      if (urlMatch) {
        log?.info("webhook_types_changed", {
          project: projectId,
          webhookId: urlMatch.id,
          oldTypes: (urlMatch.types ?? []).join(",") || "all",
          newTypes: config.types.length > 0 ? config.types.join(",") : "all",
        });
        try {
          await client.webhooks.delete(urlMatch.id);
          registry.remove(projectId);
        } catch (delErr) {
          log?.warn("webhook_stale_delete_failed", {
            project: projectId,
            webhookId: urlMatch.id,
            error: String(delErr),
          });
        }
      }

      // Create a new webhook via raw POST to capture the secret field
      // (SDK's Webhook type omits secret from the OpenAPI spec)
      log?.info("webhook_creating", {
        project: projectId,
        url: config.payloadUrl,
        types: config.types.length > 0 ? config.types.join(",") : "all",
      });

      const createBody: Record<string, unknown> = { payload_url: config.payloadUrl };
      if (config.types.length > 0) {
        createBody.types = config.types;
      }

      const webhook = await rawOrThrow<WebhookRecord>(
        await client.raw.POST(
          `/buckets/${projectId}/webhooks.json` as any,
          { body: createBody as any },
        ),
      );

      if (!webhook?.id) {
        log?.error("webhook_create_failed", {
          project: projectId,
          error: "No webhook ID in response",
        });
        result.failed.push(projectId);
        continue;
      }

      // Persist the secret — it's only returned on create.
      // BC3 never returns a secret, so empty string is expected.
      // Token auth via ?token= handles verification instead.
      registry.set(projectId, {
        webhookId: String(webhook.id),
        secret: webhook.secret ?? "",
        payloadUrl: webhook.payload_url ?? config.payloadUrl,
        types: webhook.types ?? config.types,
      });

      if (!webhook.secret) {
        log?.info("webhook_create_no_secret", {
          project: projectId,
          webhookId: webhook.id,
          note: "BC3 does not return secrets — token auth will be used",
        });
      }

      log?.info("webhook_created", {
        project: projectId,
        webhookId: webhook.id,
      });
      result.created.push(projectId);
    } catch (err) {
      log?.error("webhook_reconcile_failed", {
        project: projectId,
        error: String(err),
      });
      result.failed.push(projectId);
    }
  }

  return result;
}

/**
 * Deactivate webhooks for configured projects.
 *
 * Deletes webhooks that match our payloadUrl. Used on graceful shutdown
 * when `webhooks.deactivateOnStop` is true.
 */
export async function deactivateWebhooks(
  config: WebhookLifecycleConfig,
  registry: WebhookSecretRegistry,
  log?: StructuredLog,
): Promise<void> {
  const client = getClient(config.account);

  for (const projectId of config.projects) {
    const entry = registry.get(projectId);
    if (!entry?.webhookId) continue;

    // Only delete webhooks that match our current payloadUrl to avoid
    // accidentally removing webhooks from a different deployment.
    if (entry.payloadUrl && entry.payloadUrl !== config.payloadUrl) {
      log?.debug("webhook_deactivate_skipped", {
        project: projectId,
        reason: "payloadUrl mismatch",
        registered: entry.payloadUrl,
        configured: config.payloadUrl,
      });
      continue;
    }

    try {
      await client.webhooks.delete(Number(entry.webhookId));
      registry.remove(projectId);
      log?.info("webhook_deactivated", {
        project: projectId,
        webhookId: entry.webhookId,
      });
    } catch (err) {
      log?.error("webhook_deactivate_failed", {
        project: projectId,
        webhookId: entry.webhookId,
        error: String(err),
      });
    }
  }
}
