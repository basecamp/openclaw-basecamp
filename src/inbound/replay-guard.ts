/**
 * Replay guard — exactly-once inbound event processing (SPEC §2.14).
 *
 * Backed by `openclaw/plugin-sdk/persistent-dedupe`'s claimable dedupe, which
 * persists committed keys in the shared OpenClaw SQLite plugin-state store
 * (ungated for external plugins — proven by tests/replay-guard-smoke.test.ts).
 *
 * Semantics:
 * - Multi-key claim: every event claims its source-prefixed primary key
 *   (e.g. `activity:123`) plus an optional cross-source secondary key
 *   (`recordingId:action:createdAt`). A claim succeeds only when ALL keys are
 *   new — a duplicate on either key collapses the event. (The SDK's
 *   `createChannelReplayGuard` treats "any key new" as claimed, which would
 *   defeat cross-source collapse, so this wrapper drives `createClaimableDedupe`
 *   per key itself.)
 * - Claim → process → commit: keys are committed only after processing
 *   succeeds; failures release the claim so a later source can retry. This
 *   replaces the old record-before-dispatch TOCTOU.
 * - Per-account namespaces, 24h TTL.
 *
 * The interface is intentionally thin and plugin-owned so a durable-ingress
 * backend (queue/drain) can slot in behind it later without touching callers.
 */

import type { ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";

/** Default TTL: 24 hours in milliseconds. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Process-local fast-path cache entries before consulting SQLite. */
const DEFAULT_MEMORY_MAX_SIZE = 5000;
/** Persisted entries retained per account namespace. */
const DEFAULT_STATE_MAX_ENTRIES = 50_000;

export type ReplaySource = "activity" | "reading" | "webhook" | "direct";

/** Identity of one inbound event for replay-guard purposes. */
export type ReplayEvent = {
  /** Account namespace — dedup state is isolated per account. */
  accountId: string;
  /** Source-prefixed primary key, e.g. "activity:123". */
  primaryKey: string;
  /** Cross-source secondary key: `recordingId:action:createdAt`. */
  secondaryKey?: string;
};

export type ReplayProcessResult<T> = { kind: "processed"; value: T } | { kind: "duplicate" } | { kind: "inflight" };

/** Plugin-owned replay guard interface (backend-swappable). */
export type ReplayGuard = {
  /**
   * Claim the event, run `process`, and commit on success. A failure releases
   * the claim so the event can be retried by a later poll/source. Duplicate
   * (by primary OR secondary key) and concurrent-inflight events are skipped.
   * Errors from `process` propagate after the claim is released.
   */
  processGuarded<T>(evt: ReplayEvent, process: () => Promise<T>): Promise<ReplayProcessResult<T>>;
  /** Record an event as seen without processing (bootstrap paths). */
  record(evt: ReplayEvent): Promise<void>;
  /** True when the event was recently committed (any key). Never claims. */
  hasRecent(evt: ReplayEvent): Promise<boolean>;
  /** Remove committed keys (account cleanup, tests). */
  forget(evt: ReplayEvent): Promise<boolean>;
  /** Clear process-local caches; persisted state remains. */
  clearMemory(): void;
};

/** Build a source-prefixed primary key: `activity:123`. */
export function replayPrimaryKey(source: ReplaySource, eventId: string | number): string {
  return `${source}:${eventId}`;
}

/**
 * Build the cross-source secondary key that collapses the same logical event
 * seen from multiple sources: `recordingId:action:createdAt`.
 */
export function replaySecondaryKey(recordingId: string | number, action: string, createdAt: string): string {
  return `${recordingId}:${action}:${createdAt}`;
}

export type ReplayGuardOptions = {
  ttlMs?: number;
  memoryMaxSize?: number;
  stateMaxEntries?: number;
  /** State-database resolution env (tests pass `{ OPENCLAW_STATE_DIR: tmp }`). */
  env?: NodeJS.ProcessEnv;
  onDiskError?: (error: unknown) => void;
};

/** Create an isolated replay guard (tests, or per-backend wiring). */
export function createBasecampReplayGuard(options: ReplayGuardOptions = {}): ReplayGuard {
  const dedupe = createClaimableDedupe({
    pluginId: "basecamp",
    namespacePrefix: "basecamp.event-dedupe",
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    memoryMaxSize: options.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE,
    stateMaxEntries: options.stateMaxEntries ?? DEFAULT_STATE_MAX_ENTRIES,
    ...(options.env ? { env: options.env } : {}),
    ...(options.onDiskError ? { onDiskError: options.onDiskError } : {}),
  });

  const keysOf = (evt: ReplayEvent): string[] =>
    evt.secondaryKey && evt.secondaryKey !== evt.primaryKey ? [evt.primaryKey, evt.secondaryKey] : [evt.primaryKey];

  /**
   * All-or-nothing claim: succeeds only when every key is new. A duplicate or
   * inflight result on any key releases already-claimed keys.
   */
  const claimAll = async (
    evt: ReplayEvent,
  ): Promise<{ kind: "claimed"; claimed: string[] } | { kind: "duplicate" } | { kind: "inflight" }> => {
    const namespace = evt.accountId;
    const claimed: string[] = [];
    const release = () => {
      for (const key of claimed) dedupe.release(key, { namespace });
    };
    for (const key of keysOf(evt)) {
      let result: Awaited<ReturnType<ClaimableDedupe["claim"]>>;
      try {
        result = await dedupe.claim(key, { namespace });
      } catch (err) {
        release();
        throw err;
      }
      if (result.kind === "claimed") {
        claimed.push(key);
      } else {
        release();
        return result.kind === "inflight" ? { kind: "inflight" } : { kind: "duplicate" };
      }
    }
    return { kind: "claimed", claimed };
  };

  return {
    processGuarded: async (evt, process) => {
      const claim = await claimAll(evt);
      if (claim.kind !== "claimed") return claim;
      const namespace = evt.accountId;
      let value: Awaited<ReturnType<typeof process>>;
      try {
        value = await process();
      } catch (err) {
        for (const key of claim.claimed) dedupe.release(key, { namespace, error: err });
        throw err;
      }
      await Promise.all(claim.claimed.map((key) => dedupe.commit(key, { namespace })));
      return { kind: "processed", value };
    },

    record: async (evt) => {
      const claim = await claimAll(evt);
      if (claim.kind !== "claimed") return;
      await Promise.all(claim.claimed.map((key) => dedupe.commit(key, { namespace: evt.accountId })));
    },

    hasRecent: async (evt) => {
      const namespace = evt.accountId;
      const results = await Promise.all(keysOf(evt).map((key) => dedupe.hasRecent(key, { namespace })));
      return results.some(Boolean);
    },

    forget: async (evt) => {
      const namespace = evt.accountId;
      const results = await Promise.all(keysOf(evt).map((key) => dedupe.forget(key, { namespace })));
      return results.some(Boolean);
    },

    clearMemory: () => dedupe.clearMemory(),
  };
}

// ---------------------------------------------------------------------------
// Shared process-wide guard (poller + webhook share one instance so
// cross-source dedup sees a single claim space per account).
// ---------------------------------------------------------------------------

let sharedGuard: ReplayGuard | undefined;

/** Shared per-process guard used by all inbound paths. */
export function getReplayGuard(): ReplayGuard {
  sharedGuard ??= createBasecampReplayGuard();
  return sharedGuard;
}

/** Reset the shared guard (test isolation; also drops process-local caches). */
export function resetReplayGuard(guard?: ReplayGuard): void {
  sharedGuard?.clearMemory();
  sharedGuard = guard;
}
