/**
 * Hey! Readings polling source.
 *
 * Polls GET /my/readings.json via bcq to ingest unread notifications.
 * Processes the `unreads` array — items with new activity the service
 * account hasn't "read" yet.
 */

import type {
  BasecampInboundMessage,
  BasecampReadingsEntry,
  ResolvedBasecampAccount,
} from "../types.js";
import { bcqReadings as bcqReadingsCmd } from "../bcq.js";
import { normalizeReadingsEvent } from "./normalize.js";

export interface ReadingsPollResult {
  events: BasecampInboundMessage[];
  /** ISO timestamp of the newest reading (for cursor advancement). */
  newestAt: string | undefined;
}

export interface ReadingsPollerOptions {
  account: ResolvedBasecampAccount;
  /** Initial cursor — only process readings newer than this. */
  since?: string;
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
export async function pollReadings(
  opts: ReadingsPollerOptions,
): Promise<ReadingsPollResult> {
  const { account, since, log } = opts;

  log?.debug?.(`[${account.accountId}] polling readings`);

  const result = await bcqReadingsCmd<{
    unreads: BasecampReadingsEntry[];
    reads?: BasecampReadingsEntry[];
    memories?: BasecampReadingsEntry[];
  }>({
    accountId: account.accountId,
    host: account.host,
    profile: account.bcqProfile,
  });

  const unreads = result.data?.unreads;
  if (!Array.isArray(unreads) || unreads.length === 0) {
    return { events: [], newestAt: undefined };
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
  let newestAt: string | undefined;

  for (const raw of filtered) {
    try {
      const normalized = normalizeReadingsEvent(raw, account);
      if (!normalized) continue;

      events.push(normalized);

      const ts = raw.unread_at ?? raw.created_at;
      if (!newestAt || ts > newestAt) {
        newestAt = ts;
      }
    } catch (err) {
      log?.warn?.(
        `[${account.accountId}] failed to normalize reading id=${raw.id}: ${String(err)}`,
      );
    }
  }

  return { events, newestAt };
}
