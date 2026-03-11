/**
 * Reconciliation pass — detect gaps in event delivery.
 *
 * Periodically fetches recent activity via client.reports.progress() and
 * checks each event against the dedup store using hasSeen(). Events that
 * were NOT seen indicate a delivery gap.
 *
 * Gap counts per recordable type drive promotion of safety-net direct polling:
 *   - ≥ gapThreshold gaps in 2 consecutive cycles → promote type to safety net
 *   - 3 clean cycles → demote
 *   - Max 3 promoted types at a time
 *   - 24h TTL on promotions
 */

import type { BasecampClient } from "../basecamp-client.js";
import type { BasecampActivityEvent, BasecampRecordableType, ResolvedBasecampAccount } from "../types.js";
import { EventDedup } from "./dedup.js";
import { isNormalizableKind, recordableTypeForKind, resolveEventKind } from "./normalize.js";

// Which recordable types can be promoted to safety-net direct polling
const PROMOTABLE_TYPES: Partial<Record<BasecampRecordableType, string>> = {
  "Kanban::Card": "cards",
  Todo: "todos",
  "Question::Answer": "checkins",
};

// ---------------------------------------------------------------------------
// Promotion state
// ---------------------------------------------------------------------------

export interface PromotionEntry {
  type: BasecampRecordableType;
  promotedAt: number;
  consecutiveGapCycles: number;
  consecutiveCleanCycles: number;
}

export interface PromotionState {
  promotions: PromotionEntry[];
  /** Per-type gap history from previous cycle (for 2-consecutive-cycle check). */
  previousGaps: Record<string, number>;
}

const MAX_PROMOTIONS = 3;
const PROMOTION_TTL_MS = 24 * 60 * 60 * 1000;
const CYCLES_TO_PROMOTE = 2;
const CYCLES_TO_DEMOTE = 3;

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
  /** Currently promoted types after applying promotion logic. */
  promotions: PromotionEntry[];
  /** True when results were capped by maxItems — gap counts are sampled, not exhaustive. */
  sampled: boolean;
}

// ---------------------------------------------------------------------------
// Core reconciliation
// ---------------------------------------------------------------------------

export interface ReconciliationOptions {
  account: ResolvedBasecampAccount;
  client: BasecampClient;
  dedup: EventDedup;
  maxItems?: number;
  windowMs?: number;
  gapThreshold?: number;
  promotionState?: PromotionState;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export async function runReconciliation(opts: ReconciliationOptions): Promise<ReconciliationResult> {
  // maxItems caps SDK pagination (v0.4.0+). 250 covers a typical 24h window
  // while preventing runaway pagination on high-activity accounts.
  const { account, client, dedup, log, maxItems = 250, windowMs = 24 * 60 * 60 * 1000, gapThreshold = 3 } = opts;

  const cutoff = new Date(Date.now() - windowMs).toISOString();

  // Fetch recent activity
  let rawEvents: BasecampActivityEvent[];
  try {
    rawEvents = (await client.reports.progress({ maxItems })) as BasecampActivityEvent[];
    if (!Array.isArray(rawEvents)) rawEvents = [];
  } catch (err) {
    log?.error?.(`[${account.accountId}] reconciliation: fetch failed: ${String(err)}`);
    return {
      replayed: 0,
      unseen: 0,
      gapsByType: {},
      promotions: opts.promotionState?.promotions ?? [],
      sampled: false,
    };
  }

  // Detect truncation: if we got exactly maxItems results, the feed was
  // likely capped by pagination. Gap counts are sampled, not exhaustive.
  const sampled = rawEvents.length >= maxItems;
  if (sampled) {
    log?.warn?.(
      `[${account.accountId}] reconciliation: results capped at ${maxItems} events — gap detection is sampled`,
    );
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

  // Apply promotion logic
  const promotions = applyPromotionLogic({
    gapsByType,
    gapThreshold,
    previousState: opts.promotionState,
  });

  log?.info?.(
    `[${account.accountId}] reconciliation: replayed=${replayed} unseen=${unseen} promoted=${promotions.length}` +
      (sampled ? " sampled=true" : ""),
  );

  return { replayed, unseen, gapsByType, promotions, sampled };
}

// ---------------------------------------------------------------------------
// Promotion logic
// ---------------------------------------------------------------------------

function applyPromotionLogic(opts: {
  gapsByType: Record<string, number>;
  gapThreshold: number;
  previousState?: PromotionState;
}): PromotionEntry[] {
  const { gapsByType, gapThreshold, previousState } = opts;
  const now = Date.now();
  const previousGaps = previousState?.previousGaps ?? {};
  const existing = (previousState?.promotions ?? []).filter((p) => now - p.promotedAt < PROMOTION_TTL_MS);

  const result: PromotionEntry[] = [];

  // Process existing promotions: demote or keep
  for (const entry of existing) {
    const typeKey = entry.type;
    const currentGaps = gapsByType[typeKey] ?? 0;

    if (currentGaps < gapThreshold) {
      const cleanCycles = entry.consecutiveCleanCycles + 1;
      if (cleanCycles >= CYCLES_TO_DEMOTE) {
        // Demoted
        continue;
      }
      result.push({
        ...entry,
        consecutiveCleanCycles: cleanCycles,
        consecutiveGapCycles: 0,
      });
    } else {
      result.push({
        ...entry,
        consecutiveGapCycles: entry.consecutiveGapCycles + 1,
        consecutiveCleanCycles: 0,
      });
    }
  }

  // Check for new promotions
  const promotedTypes = new Set(result.map((p) => p.type));
  for (const [typeStr, count] of Object.entries(gapsByType)) {
    const recordableType = typeStr as BasecampRecordableType;
    if (promotedTypes.has(recordableType)) continue;
    if (!(recordableType in PROMOTABLE_TYPES)) continue;
    if (result.length >= MAX_PROMOTIONS) break;

    if (count >= gapThreshold) {
      const prevCount = previousGaps[typeStr] ?? 0;
      if (prevCount >= gapThreshold) {
        // 2 consecutive cycles with gaps → promote
        result.push({
          type: recordableType,
          promotedAt: now,
          consecutiveGapCycles: CYCLES_TO_PROMOTE,
          consecutiveCleanCycles: 0,
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializePromotionState(promotions: PromotionEntry[], gapsByType: Record<string, number>): string {
  const state: PromotionState = { promotions, previousGaps: gapsByType };
  return JSON.stringify(state);
}

export function deserializePromotionState(raw: string): PromotionState | undefined {
  try {
    return JSON.parse(raw) as PromotionState;
  } catch {
    return undefined;
  }
}
