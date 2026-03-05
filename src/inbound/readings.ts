/**
 * Hey! Readings polling source.
 *
 * Polls GET /my/readings.json via the Basecamp API to ingest unread notifications.
 * Processes the `unreads` array — items with new activity the service
 * account hasn't "read" yet.
 */

import { getClient, rawOrThrow } from "../basecamp-client.js";
import type { CircuitBreaker } from "../circuit-breaker.js";
import { withCircuitBreaker } from "../retry.js";
import type { BasecampInboundMessage, BasecampReadingsEntry, ResolvedBasecampAccount } from "../types.js";
import { normalizeReadingsEvent } from "./normalize.js";

export interface ReadingsPollResult {
  events: BasecampInboundMessage[];
  /** ISO timestamp of the newest reading (for cursor advancement). */
  newestAt: string | undefined;
  /** Readable SGIDs of all processed entries — passed to the SDK mark-read call in the poller. */
  processedSgids: string[];
}

export interface ReadingsPollerOptions {
  account: ResolvedBasecampAccount;
  /** Initial cursor — only process readings newer than this. */
  since?: string;
  /** Circuit breaker for fail-fast on repeated API failures. */
  circuitBreaker?: { instance: CircuitBreaker; key: string };
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
    error: (msg: string) => void;
  };
}

/**
 * Poll Hey! Readings for unread items.
 */
export async function pollReadings(opts: ReadingsPollerOptions): Promise<ReadingsPollResult> {
  const { account, since, log } = opts;

  log?.debug?.(`[${account.accountId}] polling readings via SDK`);

  const fetchReadings = async () => {
    const client = getClient(account);
    return rawOrThrow<{
      unreads: BasecampReadingsEntry[];
      reads?: BasecampReadingsEntry[];
      memories?: BasecampReadingsEntry[];
    }>(await client.raw.GET("/my/readings.json" as any, {}));
  };

  const data = opts.circuitBreaker
    ? await withCircuitBreaker(opts.circuitBreaker.instance, opts.circuitBreaker.key, fetchReadings)
    : await fetchReadings();

  const unreads = data?.unreads;
  if (!Array.isArray(unreads) || unreads.length === 0) {
    return { events: [], newestAt: undefined, processedSgids: [] };
  }

  log?.debug?.(`[${account.accountId}] readings returned ${unreads.length} unreads`);

  // Filter by cursor timestamp if provided
  const filtered = since
    ? unreads.filter((r) => {
        const ts = r.unread_at ?? r.created_at;
        return ts > since;
      })
    : unreads;

  const events: BasecampInboundMessage[] = [];
  const processedSgids: string[] = [];
  let newestAt: string | undefined;

  for (const raw of filtered) {
    try {
      const normalized = normalizeReadingsEvent(raw, account);

      // Always mark the item as processed regardless of normalization outcome.
      // Unknown types return null (dropped with metric), but the unread must still
      // be recorded to prevent infinite re-polling of the same item every cycle.
      if (raw.readable_sgid) {
        processedSgids.push(raw.readable_sgid);
      }
      const ts = raw.unread_at ?? raw.created_at;
      if (!newestAt || ts > newestAt) {
        newestAt = ts;
      }

      if (!normalized) continue;
      events.push(normalized);
    } catch (err) {
      log?.warn?.(`[${account.accountId}] failed to normalize reading id=${raw.id}: ${String(err)}`);
    }
  }

  return { events, newestAt, processedSgids };
}
