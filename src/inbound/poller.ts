/**
 * Composite event fabric orchestrator.
 *
 * Coordinates three polling sources with dedup, cursor persistence,
 * and configurable intervals:
 *
 * - Activity feed (120s default): account-wide timeline events
 * - Readings (60s default): Hey! inbox unreads
 * - Assignments (300s default): set-diff of /my/assignments.json
 *
 * Activity and readings use timestamp cursors (events are streams).
 * Assignments uses an ID-set cursor (API returns current state, not events).
 * On first assignments poll, bootstraps by recording existing IDs without
 * emitting events to avoid flooding agents with stale assignments.
 *
 * Respects AbortSignal for graceful shutdown. Uses exponential
 * backoff on errors (max 5 minutes).
 */

import type { BasecampInboundMessage, ResolvedBasecampAccount } from "../types.js";
import { resolvePollingIntervals, resolveCircuitBreakerConfig, resolveSafetyNetConfig, resolveReconciliationConfig, resolveAccountForBucket, listBasecampAccountIds } from "../config.js";
import { EventDedup } from "./dedup.js";
import { getAccountDedup } from "./dedup-registry.js";
import { resolvePluginStateDir } from "./state-dir.js";
import { CursorStore } from "./cursors.js";
import { pollActivityFeed } from "./activity.js";
import { pollReadings } from "./readings.js";
import { pollAssignments } from "./assignments.js";
import { pollSafetyNet, deserializeSnapshot, serializeSnapshot, deserializePending, serializePending } from "./safety-net.js";
import type { SafetyNetSnapshot, DisappearedPending } from "./safety-net.js";
import { runReconciliation, deserializePromotionState, serializePromotionState } from "./reconciliation.js";
import type { PromotionState } from "./reconciliation.js";
import { CircuitBreaker } from "../circuit-breaker.js";
import { getClient, rawOrThrow } from "../basecamp-client.js";
import { withCircuitBreaker } from "../retry.js";
import { isSelfMessage } from "./normalize.js";
import { createStructuredLog } from "../logging.js";
import { recordPollAttempt, recordPollSuccess, recordPollError, recordDedupSize, recordCircuitBreakerState, recordReconciliationRun } from "../metrics.js";
import { withTimeout } from "../util.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

export interface CompositePollerOptions {
  account: ResolvedBasecampAccount;
  cfg: unknown;
  abortSignal?: AbortSignal;
  onEvent: (msg: BasecampInboundMessage) => Promise<boolean>;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
    error: (msg: string) => void;
  };
  stateDir?: string;
  /** Projects with active webhook subscriptions. When non-empty, the activity
   *  poll interval is extended (5x) since webhooks provide real-time delivery
   *  and polling becomes a reconciliation mechanism. */
  webhookActiveProjects?: Set<string>;
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
  slog: ReturnType<typeof createStructuredLog>,
): Promise<void> {
  try {
    await cursors.save();
  } catch (err) {
    slog.warn("cursor_save_failed", { error: String(err), retrying: true });
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await cursors.save();
    } catch (retryErr) {
      slog.error("cursor_save_retry_failed", { error: String(retryErr) });
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
  const slog = createStructuredLog(log, { accountId: account.accountId, source: "poller" });

  const intervals = resolvePollingIntervals(cfg);
  const webhookActive = opts.webhookActiveProjects && opts.webhookActiveProjects.size > 0;
  // When webhooks are active, activity polling becomes reconciliation — extend interval 5x
  const WEBHOOK_RECONCILIATION_MULTIPLIER = 5;
  const activityIntervalMs = webhookActive
    ? intervals.activityIntervalMs * WEBHOOK_RECONCILIATION_MULTIPLIER
    : intervals.activityIntervalMs;
  const readingsIntervalMs = intervals.readingsIntervalMs;
  const assignmentsIntervalMs = intervals.assignmentsIntervalMs;

  const stateDir = opts.stateDir ?? resolvePluginStateDir();

  // Validate state directory
  const { mkdir, access } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  try {
    await mkdir(stateDir, { recursive: true });
    await access(stateDir, constants.W_OK);
    slog.info("state_directory", { path: stateDir });
  } catch (err) {
    slog.error("state_directory_not_writable", { path: stateDir, error: String(err) });
    throw err;
  }

  // Shared per-account dedup — survives gateway restarts (SQLite-backed)
  const dedup = getAccountDedup(account.accountId);
  slog.info("dedup_loaded", { entries: dedup.size });

  const cursors = new CursorStore(stateDir, account.accountId);

  try {
    await cursors.load();
    const c = cursors.get();
    slog.info("cursors_loaded", { activity: c.activitySince ?? "none", readings: c.readingsSince ?? "none" });
  } catch (err) {
    slog.warn("cursors_load_failed", { error: String(err) });
  }

  // Circuit breaker: fail fast when Basecamp API is persistently down.
  // One CB instance per account; separate keys per polling source.
  const cbConfig = resolveCircuitBreakerConfig(cfg as any);
  const cb = new CircuitBreaker({ threshold: cbConfig.threshold, cooldownMs: cbConfig.cooldownMs });

  /** Sync a circuit breaker key's state to the metrics registry. */
  function syncCircuitBreakerMetrics(key: string): void {
    const state = cb.getState(key);
    if (!state) return;
    let derived: "closed" | "open" | "half-open" = "closed";
    if (state.trippedAt != null) {
      derived = Date.now() - state.trippedAt >= cbConfig.cooldownMs ? "half-open" : "open";
    }
    recordCircuitBreakerState(account.accountId, key, {
      state: derived,
      failures: state.failures,
      trippedAt: state.trippedAt,
    });
  }

  let activityBackoff = 0;
  let readingsBackoff = 0;
  let assignmentsBackoff = 0;
  const MAX_BACKOFF_MS = 5 * 60 * 1000;

  let lastActivityPoll = 0;
  let lastReadingsPoll = 0;
  let lastAssignmentsPoll = 0;

  // Assignments poller: set-diff cursor (known todo IDs, not timestamps).
  // If the cursor has no stored IDs, the first poll is a bootstrap (snapshot only).
  const storedIds = cursors.getCustom("assignmentIds");
  let assignmentKnownIds: Set<string> = new Set();
  let assignmentsBootstrapped = false;
  if (storedIds !== undefined) {
    try {
      const parsed = JSON.parse(storedIds);
      if (Array.isArray(parsed)) {
        assignmentKnownIds = new Set(parsed as string[]);
        assignmentsBootstrapped = true;
      }
    } catch {
      slog.warn("corrupt_assignment_cursor");
    }
  }

  // ----- Safety net state -----
  const snConfig = resolveSafetyNetConfig(cfg as OpenClawConfig);
  const rcConfig = resolveReconciliationConfig(cfg as OpenClawConfig);

  // Resolve safety-net projects scoped to this account
  const allSnProjects = snConfig.projects;
  let accountSnProjects: number[] = [];
  if (allSnProjects.length > 0) {
    const concreteAccountIds = listBasecampAccountIds(cfg as OpenClawConfig);
    const isSingleAccount = concreteAccountIds.length <= 1;
    for (const pid of allSnProjects) {
      const owner = resolveAccountForBucket(cfg as OpenClawConfig, pid);
      if (owner) {
        if (owner === account.accountId) accountSnProjects.push(Number(pid));
      } else if (isSingleAccount) {
        accountSnProjects.push(Number(pid));
      } else {
        slog.warn("unmapped_safetynet_project", { projectId: pid });
      }
    }
  }

  const safetyNetIntervalMs = snConfig.intervalMs;
  const DEEP_CRAWL_EVERY = 6;
  let safetyNetCycleCount = 0;
  let lastSafetyNetPoll = 0;
  let safetyNetBackoff = 0;

  // Load stored snapshot
  let safetyNetSnapshot: SafetyNetSnapshot | undefined;
  let safetyNetPending: DisappearedPending | undefined;
  const storedSnap = cursors.getCustom("safetyNetSnapshot");
  if (storedSnap) safetyNetSnapshot = deserializeSnapshot(storedSnap);
  const storedPending = cursors.getCustom("safetyNetPending");
  if (storedPending) safetyNetPending = deserializePending(storedPending);

  // Load promotion state for reconciliation
  let promotionState: PromotionState | undefined;
  const storedPromotion = cursors.getCustom("reconciliation:promotions");
  if (storedPromotion) promotionState = deserializePromotionState(storedPromotion);

  let lastReconciliationPoll = 0;

  slog.info("started", {
    activityMs: activityIntervalMs,
    readingsMs: readingsIntervalMs,
    assignmentsMs: assignmentsIntervalMs,
    ...(webhookActive ? { mode: "reconciliation", webhookProjects: opts.webhookActiveProjects!.size } : { mode: "primary" }),
  });

  while (!abortSignal?.aborted) {
    const now = Date.now();
    const activityDue = now - lastActivityPoll >= activityIntervalMs + activityBackoff;
    const readingsDue = now - lastReadingsPoll >= readingsIntervalMs + readingsBackoff;

    // Poll activity feed
    if (activityDue) {
      lastActivityPoll = now;
      recordPollAttempt(account.accountId, "activity");
      try {
        const result = await pollActivityFeed({
          account,
          since: cursors.get().activitySince,
          circuitBreaker: { instance: cb, key: "activity" },
          log,
        });

        let dispatched = 0;
        let dropped = 0;
        for (const event of result.events) {
          const secondaryKey = event.meta.recordingId
            ? EventDedup.secondaryKey(event.meta.recordingId, event.meta.eventKind, event.createdAt)
            : undefined;

          if (dedup.isDuplicate(event.dedupKey, secondaryKey)) continue;
          if (isSelfMessage(event.sender.id, account)) continue;

          try {
            const delivered = await onEvent(event);
            if (delivered) {
              dispatched++;
            } else {
              dropped++;
            }
          } catch (err) {
            slog.error("dispatch_error", { feed: "activity", key: event.dedupKey, error: String(err) });
          }
        }

        if (result.newestAt) {
          cursors.setActivitySince(result.newestAt);
          await saveCursorsWithRetry(cursors, slog);
        }

        if (dispatched > 0 || dropped > 0) {
          slog.info("poll_dispatched", { feed: "activity", total: result.events.length, dispatched, dropped });
        }

        recordPollSuccess(account.accountId, "activity", dispatched, dropped);
        recordDedupSize(account.accountId, dedup.size);
        syncCircuitBreakerMetrics("activity");
        activityBackoff = 0;
      } catch (err) {
        activityBackoff = clamp(
          activityBackoff === 0 ? activityIntervalMs : activityBackoff * 2,
          activityIntervalMs,
          MAX_BACKOFF_MS,
        );
        recordPollError(account.accountId, "activity", String(err), activityBackoff);
        syncCircuitBreakerMetrics("activity");
        slog.error("poll_error", { feed: "activity", backoff: activityBackoff, error: String(err) });
      }
    }

    // Poll readings
    if (readingsDue) {
      lastReadingsPoll = now;
      recordPollAttempt(account.accountId, "readings");
      try {
        const result = await pollReadings({
          account,
          since: cursors.get().readingsSince,
          circuitBreaker: { instance: cb, key: "readings" },
          log,
        });

        let dispatched = 0;
        let dropped = 0;
        for (const event of result.events) {
          const secondaryKey = event.meta.recordingId
            ? EventDedup.secondaryKey(event.meta.recordingId, event.meta.eventKind, event.createdAt)
            : undefined;

          if (dedup.isDuplicate(event.dedupKey, secondaryKey)) continue;
          if (isSelfMessage(event.sender.id, account)) continue;

          try {
            const delivered = await onEvent(event);
            if (delivered) {
              dispatched++;
            } else {
              dropped++;
            }
          } catch (err) {
            slog.error("dispatch_error", { feed: "readings", key: event.dedupKey, error: String(err) });
          }
        }

        // Mark processed readings as read so they don't reappear
        if (result.processedSgids.length > 0) {
          try {
            const markRead = async () => {
              const client = getClient(account);
              await rawOrThrow(await client.raw.PUT("/my/unreads.json" as any, {
                body: { readables: result.processedSgids } as any,
              }));
            };
            await withCircuitBreaker(cb, "readings:mark-read", markRead);
            slog.debug("readings_marked_read", { count: result.processedSgids.length });
          } catch (err) {
            slog.warn("readings_mark_read_failed", { error: String(err) });
          }
        }

        if (result.newestAt) {
          cursors.setReadingsSince(result.newestAt);
          await saveCursorsWithRetry(cursors, slog);
        }

        if (dispatched > 0 || dropped > 0) {
          slog.info("poll_dispatched", { feed: "readings", total: result.events.length, dispatched, dropped });
        }

        recordPollSuccess(account.accountId, "readings", dispatched, dropped);
        recordDedupSize(account.accountId, dedup.size);
        syncCircuitBreakerMetrics("readings");
        readingsBackoff = 0;
      } catch (err) {
        readingsBackoff = clamp(
          readingsBackoff === 0 ? readingsIntervalMs : readingsBackoff * 2,
          readingsIntervalMs,
          MAX_BACKOFF_MS,
        );
        recordPollError(account.accountId, "readings", String(err), readingsBackoff);
        syncCircuitBreakerMetrics("readings");
        slog.error("poll_error", { feed: "readings", backoff: readingsBackoff, error: String(err) });
      }
    }

    // Poll assignments (set-diff: detect newly assigned todos)
    const assignmentsDue = now - lastAssignmentsPoll >= assignmentsIntervalMs + assignmentsBackoff;
    if (assignmentsDue) {
      lastAssignmentsPoll = now;
      recordPollAttempt(account.accountId, "assignments");
      try {
        const result = await pollAssignments({
          account,
          knownIds: assignmentKnownIds,
          isBootstrap: !assignmentsBootstrapped,
          circuitBreaker: { instance: cb, key: "assignments" },
          log,
        });

        let dispatched = 0;
        let dropped = 0;
        for (const event of result.events) {
          if (dedup.isDuplicate(event.dedupKey)) continue;
          if (isSelfMessage(event.sender.id, account)) continue;

          try {
            const delivered = await onEvent(event);
            if (delivered) {
              dispatched++;
            } else {
              dropped++;
            }
          } catch (err) {
            slog.error("dispatch_error", { feed: "assignments", key: event.dedupKey, error: String(err) });
          }
        }

        // Persist updated known-ID set
        assignmentKnownIds = result.knownIds;
        assignmentsBootstrapped = true;
        cursors.setCustom("assignmentIds", JSON.stringify([...result.knownIds]));
        await saveCursorsWithRetry(cursors, slog);

        if (dispatched > 0 || dropped > 0) {
          slog.info("poll_dispatched", { feed: "assignments", total: result.events.length, dispatched, dropped });
        }

        recordPollSuccess(account.accountId, "assignments", dispatched, dropped);
        recordDedupSize(account.accountId, dedup.size);
        syncCircuitBreakerMetrics("assignments");
        assignmentsBackoff = 0;
      } catch (err) {
        assignmentsBackoff = clamp(
          assignmentsBackoff === 0 ? assignmentsIntervalMs : assignmentsBackoff * 2,
          assignmentsIntervalMs,
          MAX_BACKOFF_MS,
        );
        recordPollError(account.accountId, "assignments", String(err), assignmentsBackoff);
        syncCircuitBreakerMetrics("assignments");
        slog.error("poll_error", { feed: "assignments", backoff: assignmentsBackoff, error: String(err) });
      }
    }

    // ----- Safety net poll -----
    if (accountSnProjects.length > 0) {
      const snDue = now - lastSafetyNetPoll >= safetyNetIntervalMs + safetyNetBackoff;
      if (snDue) {
        lastSafetyNetPoll = now;
        safetyNetCycleCount++;
        const isDeepCrawl = safetyNetCycleCount % DEEP_CRAWL_EVERY === 0;
        recordPollAttempt(account.accountId, "safetyNet");

        try {
          const client = getClient(account);
          const result = await withCircuitBreaker(cb, "safetyNet", () =>
            pollSafetyNet({
              account,
              client,
              projectIds: accountSnProjects,
              previousSnapshot: safetyNetSnapshot,
              previousPending: safetyNetPending,
              isDeepCrawl,
              log,
            }),
          );

          let dispatched = 0;
          let dropped = 0;
          for (const event of result.events) {
            if (dedup.isDuplicate(event.dedupKey)) continue;

            try {
              const delivered = await onEvent(event);
              if (delivered) dispatched++;
              else dropped++;
            } catch (err) {
              slog.error("dispatch_error", { feed: "safetyNet", key: event.dedupKey, error: String(err) });
            }
          }

          safetyNetSnapshot = result.snapshot;
          safetyNetPending = result.pending;
          cursors.setCustom("safetyNetSnapshot", serializeSnapshot(result.snapshot));
          cursors.setCustom("safetyNetPending", serializePending(result.pending));
          await saveCursorsWithRetry(cursors, slog);

          if (dispatched > 0 || dropped > 0) {
            slog.info("poll_dispatched", {
              feed: "safetyNet",
              total: result.events.length,
              dispatched,
              dropped,
              deep: isDeepCrawl,
            });
          }

          recordPollSuccess(account.accountId, "safetyNet", dispatched, dropped);
          recordDedupSize(account.accountId, dedup.size);
          syncCircuitBreakerMetrics("safetyNet");
          safetyNetBackoff = 0;
        } catch (err) {
          safetyNetBackoff = clamp(
            safetyNetBackoff === 0 ? safetyNetIntervalMs : safetyNetBackoff * 2,
            safetyNetIntervalMs,
            MAX_BACKOFF_MS,
          );
          recordPollError(account.accountId, "safetyNet", String(err), safetyNetBackoff);
          syncCircuitBreakerMetrics("safetyNet");
          slog.error("poll_error", { feed: "safetyNet", backoff: safetyNetBackoff, error: String(err) });
        }
      }
    }

    // ----- Reconciliation pass -----
    if (rcConfig.enabled) {
      const rcDue = now - lastReconciliationPoll >= rcConfig.intervalMs;
      if (rcDue) {
        try {
          const client = getClient(account);
          const result = await runReconciliation({
            account,
            client,
            dedup,
            maxItems: 250,
            gapThreshold: rcConfig.gapThreshold,
            promotionState,
            log,
          });

          lastReconciliationPoll = now;

          promotionState = {
            promotions: result.promotions,
            previousGaps: result.gapsByType,
          };
          cursors.setCustom(
            "reconciliation:promotions",
            serializePromotionState(result.promotions, result.gapsByType),
          );
          await saveCursorsWithRetry(cursors, slog);

          recordReconciliationRun(account.accountId, {
            replayed: result.replayed,
            unseen: result.unseen,
            promotedTypes: result.promotions.map((p) => p.type),
          });
        } catch (err) {
          // Don't update lastReconciliationPoll — retry on next loop iteration
          slog.error("reconciliation_error", { error: String(err) });
        }
      }
    }
    // Promotions are observability-only: persisted to cursor state and metrics
    // for operator visibility. Frequency escalation (tier-2) deferred.

    // Sleep until next poll
    const nextActivityDue = lastActivityPoll + activityIntervalMs + activityBackoff - Date.now();
    const nextReadingsDue = lastReadingsPoll + readingsIntervalMs + readingsBackoff - Date.now();
    const nextAssignmentsDue = lastAssignmentsPoll + assignmentsIntervalMs + assignmentsBackoff - Date.now();
    const sleepCandidates = [nextActivityDue, nextReadingsDue, nextAssignmentsDue];
    if (accountSnProjects.length > 0) {
      sleepCandidates.push(lastSafetyNetPoll + safetyNetIntervalMs + safetyNetBackoff - Date.now());
    }
    if (rcConfig.enabled) {
      sleepCandidates.push(lastReconciliationPoll + rcConfig.intervalMs - Date.now());
    }
    const sleepMs = Math.max(1000, Math.min(...sleepCandidates));

    await abortableSleep(sleepMs, abortSignal);
  }

  try {
    // dedup.flush() is sync (writeFileSync) — best-effort, cannot be timeout-protected.
    dedup.flush();
    // Cursor save is async (fs/promises.writeFile) — timeout-protect it.
    const saveResult = await withTimeout(
      saveCursorsWithRetry(cursors, slog).then(() => "saved" as const),
      5000,
      `${account.accountId} poller cursor save`,
      { warn: (msg: string) => slog.warn(msg) },
    );
    if (saveResult === "saved") {
      slog.info("stopped");
    } else {
      // Prevent any belated background write from overwriting newer cursors
      // saved by a restarted poller instance.
      cursors.abandon();
      slog.warn("stopped_with_cursor_save_timeout");
    }
  } catch (err) {
    slog.warn("final_state_save_failed", { error: String(err) });
  }
}
