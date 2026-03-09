/**
 * Reconciliation pass — detect gaps in event delivery.
 *
 * Periodically fetches recent activity via client.reports.progress() and
 * checks each event against the dedup store using hasSeen(). Events that
 * were NOT seen indicate a delivery gap.
 */

import type { BasecampActivityEvent, ResolvedBasecampAccount } from "../types.js";
import { EventDedup } from "./dedup.js";
import { isNormalizableKind, recordableTypeForKind, resolveEventKind } from "./normalize.js";

// ---------------------------------------------------------------------------
// Reconciliation result
// ---------------------------------------------------------------------------

export interface ReconciliationResult {
  /** Number of events replayed from the activity feed. */
  replayed: number;
  /** Number of events not found in the dedup store (gaps). */
  unseen: number;
  /** Gap counts per recordable type. */
  gapsByType: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Core reconciliation
// ---------------------------------------------------------------------------

export interface ReconciliationOptions {
  account: ResolvedBasecampAccount;
  client: any;
  dedup: EventDedup;
  maxItems?: number;
  windowMs?: number;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export async function runReconciliation(opts: ReconciliationOptions): Promise<ReconciliationResult> {
  const { account, client, dedup, log, maxItems = 250, windowMs = 24 * 60 * 60 * 1000 } = opts;

  const cutoff = new Date(Date.now() - windowMs).toISOString();

  // Fetch recent activity
  let rawEvents: BasecampActivityEvent[];
  try {
    rawEvents = (await client.reports.progress({ maxItems })) as BasecampActivityEvent[];
    if (!Array.isArray(rawEvents)) rawEvents = [];
  } catch (err) {
    log?.error?.(`[${account.accountId}] reconciliation: fetch failed: ${String(err)}`);
    return { replayed: 0, unseen: 0, gapsByType: {} };
  }

  let replayed = 0;
  let unseen = 0;
  const gapsByType: Record<string, number> = {};

  for (const event of rawEvents) {
    // Client-side window filter
    if (event.created_at < cutoff) continue;

    // Only count events whose kind we can normalize
    if (!isNormalizableKind(event.kind)) continue;
    const recordableType = recordableTypeForKind(event.kind)!;

    replayed++;

    // Check if we've seen this event
    const primaryKey = `activity:${event.id}`;
    const recordingId = event.recording?.id;
    const secondaryKey = recordingId
      ? EventDedup.secondaryKey(String(recordingId), resolveEventKind(event.kind), event.created_at)
      : undefined;

    if (!dedup.hasSeen(primaryKey, secondaryKey)) {
      unseen++;
      gapsByType[recordableType] = (gapsByType[recordableType] ?? 0) + 1;
    }
  }

  log?.info?.(`[${account.accountId}] reconciliation: replayed=${replayed} unseen=${unseen}`);

  return { replayed, unseen, gapsByType };
}
