/**
 * Operational metrics registry for the Basecamp channel plugin.
 *
 * Provides a shared in-memory metrics store that operational components
 * (poller, webhooks, circuit breaker) write to and the status adapter reads from.
 * All methods are synchronous — no I/O, no blocking.
 */

export interface PollerSourceMetrics {
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  currentBackoffMs: number;
  pollCount: number;
  errorCount: number;
  dispatchCount: number;
  droppedCount: number;
}

export interface WebhookMetrics {
  receivedCount: number;
  dispatchedCount: number;
  droppedCount: number;
  errorCount: number;
  lastReceivedAt: number | null;
}

export interface CircuitBreakerMetrics {
  state: "closed" | "open" | "half-open";
  failures: number;
  trippedAt: number | null;
}

export interface ReconciliationMetrics {
  lastRunAt: number | null;
  replayed: number;
  unseen: number;
  promotedTypes: string[];
}

export interface AccountMetrics {
  poller: {
    activity: PollerSourceMetrics;
    readings: PollerSourceMetrics;
    assignments: PollerSourceMetrics;
    safetyNet: PollerSourceMetrics;
  };
  webhook: WebhookMetrics & { authMethods: Record<string, number> };
  circuitBreaker: Record<string, CircuitBreakerMetrics>;
  reconciliation: ReconciliationMetrics;
  dedupSize: number;
  webhookDedupSize: number;
  dispatchFailureCount: number;
  queueFullDropCount: number;
  unknownKindCount: number;
  lastUnknownKind: string | null;
}

function emptySourceMetrics(): PollerSourceMetrics {
  return {
    lastPollAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    currentBackoffMs: 0,
    pollCount: 0,
    errorCount: 0,
    dispatchCount: 0,
    droppedCount: 0,
  };
}

function emptyWebhookMetrics(): WebhookMetrics {
  return {
    receivedCount: 0,
    dispatchedCount: 0,
    droppedCount: 0,
    errorCount: 0,
    lastReceivedAt: null,
  };
}

/** Per-account metrics store. */
const metricsRegistry = new Map<string, AccountMetrics>();

function getOrCreate(accountId: string): AccountMetrics {
  let m = metricsRegistry.get(accountId);
  if (!m) {
    m = {
      poller: {
        activity: emptySourceMetrics(),
        readings: emptySourceMetrics(),
        assignments: emptySourceMetrics(),
        safetyNet: emptySourceMetrics(),
      },
      webhook: { ...emptyWebhookMetrics(), authMethods: {} },
      circuitBreaker: {},
      reconciliation: { lastRunAt: null, replayed: 0, unseen: 0, promotedTypes: [] },
      dedupSize: 0,
      webhookDedupSize: 0,
      dispatchFailureCount: 0,
      queueFullDropCount: 0,
      unknownKindCount: 0,
      lastUnknownKind: null,
    };
    metricsRegistry.set(accountId, m);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Writers — called by operational components
// ---------------------------------------------------------------------------

export type PollerSource = "activity" | "readings" | "assignments" | "safetyNet";

export function recordPollAttempt(accountId: string, source: PollerSource): void {
  const m = getOrCreate(accountId);
  m.poller[source].lastPollAt = Date.now();
  m.poller[source].pollCount++;
}

export function recordPollSuccess(accountId: string, source: PollerSource, dispatched: number, dropped?: number): void {
  const m = getOrCreate(accountId);
  m.poller[source].lastSuccessAt = Date.now();
  m.poller[source].dispatchCount += dispatched;
  if (dropped) m.poller[source].droppedCount += dropped;
  m.poller[source].currentBackoffMs = 0;
  m.poller[source].lastError = null;
  m.poller[source].lastErrorAt = null;
}

export function recordPollError(accountId: string, source: PollerSource, error: string, backoffMs: number): void {
  const m = getOrCreate(accountId);
  m.poller[source].lastErrorAt = Date.now();
  m.poller[source].lastError = error;
  m.poller[source].currentBackoffMs = backoffMs;
  m.poller[source].errorCount++;
}

export function recordWebhookReceived(accountId: string): void {
  const m = getOrCreate(accountId);
  m.webhook.receivedCount++;
  m.webhook.lastReceivedAt = Date.now();
}

export function recordWebhookDispatched(accountId: string): void {
  const m = getOrCreate(accountId);
  m.webhook.dispatchedCount++;
}

export function recordWebhookDropped(accountId: string): void {
  const m = getOrCreate(accountId);
  m.webhook.droppedCount++;
}

export function recordWebhookError(accountId: string): void {
  const m = getOrCreate(accountId);
  m.webhook.errorCount++;
}

export function recordDedupSize(accountId: string, size: number): void {
  const m = getOrCreate(accountId);
  m.dedupSize = size;
}

export function recordWebhookDedupSize(accountId: string, size: number): void {
  const m = getOrCreate(accountId);
  m.webhookDedupSize = size;
}

export function recordCircuitBreakerState(
  accountId: string,
  key: string,
  state: CircuitBreakerMetrics,
): void {
  const m = getOrCreate(accountId);
  m.circuitBreaker[key] = state;
}

export function recordDispatchFailure(accountId: string): void {
  const m = getOrCreate(accountId);
  m.dispatchFailureCount++;
}

export function recordQueueFullDrop(accountId: string): void {
  const m = getOrCreate(accountId);
  m.queueFullDropCount++;
}

export function recordWebhookAuthMethod(accountId: string, method: "token" | "hmac"): void {
  const m = getOrCreate(accountId);
  m.webhook.authMethods[method] = (m.webhook.authMethods[method] ?? 0) + 1;
}

export function recordReconciliationRun(accountId: string, result: { replayed: number; unseen: number; promotedTypes: string[] }): void {
  const m = getOrCreate(accountId);
  m.reconciliation.lastRunAt = Date.now();
  m.reconciliation.replayed = result.replayed;
  m.reconciliation.unseen = result.unseen;
  m.reconciliation.promotedTypes = result.promotedTypes;
}

export function recordUnknownKind(accountId: string, rawKind: string): void {
  const m = getOrCreate(accountId);
  m.unknownKindCount++;
  m.lastUnknownKind = rawKind;
}

// ---------------------------------------------------------------------------
// Reader — called by the status adapter
// ---------------------------------------------------------------------------

export function getAccountMetrics(accountId: string): AccountMetrics | undefined {
  return metricsRegistry.get(accountId);
}

/** Clear metrics for an account. Used in tests. */
export function clearMetrics(accountId?: string): void {
  if (accountId) {
    metricsRegistry.delete(accountId);
  } else {
    metricsRegistry.clear();
  }
}
