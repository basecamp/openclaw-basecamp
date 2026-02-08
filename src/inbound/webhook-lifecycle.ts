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

import type { BcqOptions, BcqWebhook } from "../bcq.js";
import { bcqWebhookList, bcqWebhookCreate, bcqWebhookDelete } from "../bcq.js";
import type { WebhookSecretRegistry } from "./webhook-secrets.js";
import type { StructuredLog } from "../logging.js";

export interface WebhookLifecycleConfig {
  /** HTTPS URL where Basecamp sends webhook payloads. */
  payloadUrl: string;
  /** Bucket IDs to create webhooks for. */
  projects: string[];
  /** Recordable types to subscribe to. Empty = all types. */
  types: string[];
  /** bcq options for API calls (accountId, profile, etc). */
  bcqOpts?: BcqOptions;
}

export interface ReconcileResult {
  created: string[];
  existing: string[];
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
  const result: ReconcileResult = { created: [], existing: [], failed: [] };

  for (const projectId of config.projects) {
    try {
      // List existing webhooks for this project
      let existing: BcqWebhook[] = [];
      try {
        const listResult = await bcqWebhookList(projectId, config.bcqOpts ?? {});
        existing = Array.isArray(listResult.data) ? listResult.data : [];
      } catch {
        // List failed — treat as empty (will attempt create)
        existing = [];
      }

      // Check if a webhook with our payloadUrl already exists
      const match = existing.find(
        (wh) => wh.payload_url === config.payloadUrl && wh.active,
      );

      if (match) {
        log?.debug("webhook_exists", {
          project: projectId,
          webhookId: match.id,
        });

        // If we don't have a secret stored for this project (e.g., first
        // startup after manual webhook creation), record what we can.
        // We can't recover the secret from the API — it's only returned on create.
        if (!registry.get(projectId)) {
          registry.set(projectId, {
            webhookId: String(match.id),
            secret: "", // Unknown — created before lifecycle management
            payloadUrl: match.payload_url,
            types: match.types ?? [],
          });
        }

        result.existing.push(projectId);
        continue;
      }

      // Create a new webhook
      log?.info("webhook_creating", {
        project: projectId,
        url: config.payloadUrl,
        types: config.types.length > 0 ? config.types.join(",") : "all",
      });

      const createResult = await bcqWebhookCreate(
        projectId,
        config.payloadUrl,
        config.types.length > 0 ? config.types : undefined,
        config.bcqOpts ?? {},
      );

      const webhook = createResult.data;
      if (!webhook?.id) {
        log?.error("webhook_create_failed", {
          project: projectId,
          error: "No webhook ID in response",
        });
        result.failed.push(projectId);
        continue;
      }

      // Persist the secret — it's only returned on create
      registry.set(projectId, {
        webhookId: String(webhook.id),
        secret: webhook.secret ?? "",
        payloadUrl: webhook.payload_url ?? config.payloadUrl,
        types: webhook.types ?? config.types,
      });

      log?.info("webhook_created", {
        project: projectId,
        webhookId: webhook.id,
        hasSecret: Boolean(webhook.secret),
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
  for (const projectId of config.projects) {
    const entry = registry.get(projectId);
    if (!entry?.webhookId) continue;

    try {
      await bcqWebhookDelete(projectId, entry.webhookId, config.bcqOpts ?? {});
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
