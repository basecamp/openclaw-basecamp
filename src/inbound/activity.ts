/**
 * Activity feed polling source.
 *
 * Uses `bcq timeline` to fetch the account-wide activity feed.
 * The command wraps GET /reports/progress.json internally and handles
 * pagination. Events arrive newest-first; we filter client-side using
 * a cursor timestamp.
 */

import type {
  BasecampActivityEvent,
  BasecampInboundMessage,
  ResolvedBasecampAccount,
} from "../types.js";
import type { CircuitBreaker } from "../circuit-breaker.js";
import { getClient, rawOrThrow } from "../basecamp-client.js";
import { withCircuitBreaker } from "../retry.js";
import { normalizeActivityEvent } from "./normalize.js";

export interface ActivityPollResult {
  events: BasecampInboundMessage[];
  /** ISO timestamp of the newest event (for cursor advancement). */
  newestAt: string | undefined;
}

export interface ActivityPollerOptions {
  account: ResolvedBasecampAccount;
  /** Cursor — only process events created after this timestamp. */
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
 * Poll the activity feed for new events via `bcq timeline`.
 */
export async function pollActivityFeed(
  opts: ActivityPollerOptions,
): Promise<ActivityPollResult> {
  const { account, since, log } = opts;

  log?.debug?.(`[${account.accountId}] polling activity feed via SDK`);

  const fetchTimeline = async () => {
    const client = getClient(account);
    return client.reports.progress() as Promise<BasecampActivityEvent[]>;
  };

  const rawEvents = opts.circuitBreaker
    ? await withCircuitBreaker(opts.circuitBreaker.instance, opts.circuitBreaker.key, fetchTimeline)
    : await fetchTimeline();
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    return { events: [], newestAt: undefined };
  }

  log?.debug?.(`[${account.accountId}] activity feed: ${rawEvents.length} events`);

  const events: BasecampInboundMessage[] = [];
  let newestAt: string | undefined;

  for (const raw of rawEvents) {
    // Client-side cursor filtering: skip events at or before cursor
    if (since && raw.created_at <= since) {
      break; // Events are newest-first; once we hit the cursor, stop
    }

    try {
      const normalized = await normalizeActivityEvent(raw, account);
      if (normalized) {
        events.push(normalized);
      }

      if (!newestAt || raw.created_at > newestAt) {
        newestAt = raw.created_at;
      }
    } catch (err) {
      log?.warn?.(
        `[${account.accountId}] failed to normalize activity event id=${raw.id}: ${String(err)}`,
      );
    }
  }

  return { events, newestAt };
}
