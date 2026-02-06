/**
 * Composite event fabric orchestrator.
 *
 * Coordinates ActivityFeedPoller + ReadingsPoller with dedup,
 * cursor persistence, and configurable intervals.
 *
 * Polling cadence (defaults):
 * - Activity feed: every 120s
 * - Readings: every 60s
 *
 * Respects AbortSignal for graceful shutdown. Uses exponential
 * backoff on errors (max 5 minutes).
 */

import type { BasecampInboundMessage, ResolvedBasecampAccount } from "../types.js";
import { resolvePollingIntervals } from "../config.js";
import { EventDedup } from "./dedup.js";
import { CursorStore } from "./cursors.js";
import { pollActivityFeed } from "./activity.js";
import { pollReadings } from "./readings.js";
import { bcqMarkReadingsRead } from "../bcq.js";
import { isSelfMessage } from "./normalize.js";

export interface CompositePollerOptions {
  account: ResolvedBasecampAccount;
  cfg: unknown;
  abortSignal?: AbortSignal;
  onEvent: (msg: BasecampInboundMessage) => Promise<void>;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
    error: (msg: string) => void;
  };
  stateDir?: string;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Save cursors with one retry after 1s delay on failure. */
async function saveCursorsWithRetry(
  cursors: CursorStore,
  accountId: string,
  log?: CompositePollerOptions["log"],
): Promise<void> {
  try {
    await cursors.save();
  } catch (err) {
    log?.warn?.(`[${accountId}] cursor save failed, retrying in 1s: ${String(err)}`);
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await cursors.save();
    } catch (retryErr) {
      log?.error?.(`[${accountId}] cursor save retry failed, continuing: ${String(retryErr)}`);
    }
  }
}

/**
 * Start the composite poller. Long-running; resolves when abort fires.
 */
export async function startCompositePoller(
  opts: CompositePollerOptions,
): Promise<void> {
  const { account, cfg, abortSignal, onEvent, log } = opts;

  const intervals = resolvePollingIntervals(cfg);
  const activityIntervalMs = intervals.activityIntervalMs;
  const readingsIntervalMs = intervals.readingsIntervalMs;

  const dedup = new EventDedup();
  const stateDir = opts.stateDir ?? "/tmp/openclaw-basecamp-state";

  // Validate state directory
  const { mkdir, access } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  try {
    await mkdir(stateDir, { recursive: true });
    await access(stateDir, constants.W_OK);
    log?.info?.(`[${account.accountId}] state directory: ${stateDir}`);
  } catch (err) {
    log?.error?.(`[${account.accountId}] state directory not writable: ${stateDir}: ${String(err)}`);
    throw err;
  }

  const cursors = new CursorStore(stateDir, account.accountId);

  try {
    await cursors.load();
    const c = cursors.get();
    log?.info?.(
      "[" + account.accountId + "] loaded cursors: activity=" + (c.activitySince ?? "none") + " readings=" + (c.readingsSince ?? "none"),
    );
  } catch (err) {
    log?.warn?.("[" + account.accountId + "] failed to load cursors, starting fresh: " + String(err));
  }

  let activityBackoff = 0;
  let readingsBackoff = 0;
  const MAX_BACKOFF_MS = 5 * 60 * 1000;

  let lastActivityPoll = 0;
  let lastReadingsPoll = 0;

  log?.info?.(
    "[" + account.accountId + "] composite poller started (activity=" + activityIntervalMs + "ms, readings=" + readingsIntervalMs + "ms)",
  );

  while (!abortSignal?.aborted) {
    const now = Date.now();
    const activityDue = now - lastActivityPoll >= activityIntervalMs + activityBackoff;
    const readingsDue = now - lastReadingsPoll >= readingsIntervalMs + readingsBackoff;

    // Poll activity feed
    if (activityDue) {
      lastActivityPoll = now;
      try {
        const result = await pollActivityFeed({
          account,
          since: cursors.get().activitySince,
          log,
        });

        let dispatched = 0;
        for (const event of result.events) {
          const secondaryKey = event.meta.recordingId
            ? EventDedup.secondaryKey(event.meta.recordingId, event.meta.eventKind, event.createdAt)
            : undefined;

          if (dedup.isDuplicate(event.dedupKey, secondaryKey)) continue;
          if (isSelfMessage(event.sender.id, account)) continue;

          try {
            await onEvent(event);
            dispatched++;
          } catch (err) {
            log?.error?.("[" + account.accountId + "] dispatch error for " + event.dedupKey + ": " + String(err));
          }
        }

        if (result.newestAt) {
          cursors.setActivitySince(result.newestAt);
          await saveCursorsWithRetry(cursors, account.accountId, log);
        }

        if (dispatched > 0) {
          log?.info?.("[" + account.accountId + "] activity: " + result.events.length + " events, " + dispatched + " dispatched");
        }

        activityBackoff = 0;
      } catch (err) {
        activityBackoff = clamp(
          activityBackoff === 0 ? activityIntervalMs : activityBackoff * 2,
          activityIntervalMs,
          MAX_BACKOFF_MS,
        );
        log?.error?.("[" + account.accountId + "] activity feed error (backoff=" + activityBackoff + "ms): " + String(err));
      }
    }

    // Poll readings
    if (readingsDue) {
      lastReadingsPoll = now;
      try {
        const result = await pollReadings({
          account,
          since: cursors.get().readingsSince,
          log,
        });

        let dispatched = 0;
        for (const event of result.events) {
          const secondaryKey = event.meta.recordingId
            ? EventDedup.secondaryKey(event.meta.recordingId, event.meta.eventKind, event.createdAt)
            : undefined;

          if (dedup.isDuplicate(event.dedupKey, secondaryKey)) continue;
          if (isSelfMessage(event.sender.id, account)) continue;

          try {
            await onEvent(event);
            dispatched++;
          } catch (err) {
            log?.error?.("[" + account.accountId + "] dispatch error for reading " + event.dedupKey + ": " + String(err));
          }
        }

        // Mark processed readings as read so they don't reappear
        if (result.processedSgids.length > 0) {
          try {
            await bcqMarkReadingsRead(result.processedSgids, {
              accountId: account.config.bcqAccountId ?? account.accountId,
              profile: account.bcqProfile,
            });
            log?.debug?.("[" + account.accountId + "] marked " + result.processedSgids.length + " readings as read");
          } catch (err) {
            log?.warn?.("[" + account.accountId + "] failed to mark readings as read: " + String(err));
          }
        }

        if (result.newestAt) {
          cursors.setReadingsSince(result.newestAt);
          await saveCursorsWithRetry(cursors, account.accountId, log);
        }

        if (dispatched > 0) {
          log?.info?.("[" + account.accountId + "] readings: " + result.events.length + " unreads, " + dispatched + " dispatched");
        }

        readingsBackoff = 0;
      } catch (err) {
        readingsBackoff = clamp(
          readingsBackoff === 0 ? readingsIntervalMs : readingsBackoff * 2,
          readingsIntervalMs,
          MAX_BACKOFF_MS,
        );
        log?.error?.("[" + account.accountId + "] readings error (backoff=" + readingsBackoff + "ms): " + String(err));
      }
    }

    // Sleep until next poll
    const nextActivityDue = lastActivityPoll + activityIntervalMs + activityBackoff - Date.now();
    const nextReadingsDue = lastReadingsPoll + readingsIntervalMs + readingsBackoff - Date.now();
    const sleepMs = Math.max(1000, Math.min(nextActivityDue, nextReadingsDue));

    await abortableSleep(sleepMs, abortSignal);
  }

  try {
    await saveCursorsWithRetry(cursors, account.accountId, log);
    log?.info?.("[" + account.accountId + "] composite poller stopped, cursors saved");
  } catch (err) {
    log?.warn?.("[" + account.accountId + "] failed to save final cursors: " + String(err));
  }
}
