# Dogfooding Matrix

Source of truth for reliability validation. Each row maps to either a CI-enforced
integration test (`tests/dogfooding/*.test.ts`) or a live scenario runner
(`scripts/dogfood/*.ts`), or both.

## Gates

1. **PR merge gate**: all integration rows green in CI.
2. **Release gate**: all live (assisted) rows exercised at least once on current
   main. Operator verification documented in run log.
3. **Prereq**: dead-letter semantics (#33) must be landed before queue-pressure
   rows are considered complete.

---

## Queue Pressure

| ID | Mode | Setup | Stimulus | Expected | Pass Criteria |
|----|------|-------|----------|----------|---------------|
| DF-001 | integration | Real module-level `dispatchSemaphore` (10 active, 100 queued). Mock `dispatchBasecampEvent` with 200ms delay so all handlers reach the semaphore before any slot frees. | Fire 111 concurrent webhook calls. | First 10 acquired, next 100 queued, 111th+ hits `queue_full` path. All handlers complete within 15s timeout. | `getAccountMetrics(id).queueFullDropCount >= 1`, `webhook.droppedCount >= 1`. |
| DF-002 | integration | Fresh state (no carryover from DF-001). Mock `dispatchBasecampEvent` resolves instantly. | Fire 1 webhook event. | Dispatched normally — `dispatchedCount` increments, no `queue_full`. | `webhook.dispatchedCount >= 1`, `queueFullDropCount === 0`. |
| DF-003 | integration | Mock `dispatchBasecampEvent` to throw. | Dispatch a single webhook event. | `dispatch_error` logged. `webhook.errorCount` incremented. Handler returns 200 (response sent before dispatch). | `webhook.errorCount >= 1`. Note: `dispatchFailureCount` is recorded inside dispatch's `onError`, not when the handler catches a dispatch throw. |
| DF-004 | live (assisted) | Start OpenClaw with `webhookSecret` configured (provides token auth). Optionally seed HMAC secrets via lifecycle API for fallback testing. | Burst 150 webhooks in <2s with valid token auth (`?token=`). Optionally repeat with `--hmac-secret` to exercise HMAC fallback. | Most dispatched, some may trigger `backpressure` warn. None dropped to `queue_full` under normal concurrency. | All return 200 (necessary but not sufficient — handler returns 200 before dispatch). Operator must verify no `queue_full` in logs. If `--status-url` provided, script checks metrics endpoint for `queueFullDropCount === 0`. |

## Webhook Auth

| ID | Mode | Setup | Stimulus | Expected | Pass Criteria |
|----|------|-------|----------|----------|---------------|
| DF-005 | integration | Config with `webhookSecret`. No HMAC headers. | POST with `?token=<correct>`. | 200 OK, event dispatched. | Response status 200. |
| DF-006 | integration | Config with `webhookSecret`. No HMAC headers. | POST with `?token=wrong`. | 403 "Invalid webhook signature or token". | Response status 403. |
| DF-007 | integration | No `webhookSecret`. No HMAC secrets registered. | POST with no auth. | 403 "Webhooks not configured". | Response status 403, body includes "not configured". |
| DF-008 | integration | Two accounts (`acct-a`, `acct-b`) via virtualAccounts. Each has HMAC secrets in registry. Bucket 100 maps to `acct-a`. | POST with valid HMAC from `acct-a`'s secret, bucket.id=100. | Authenticated via scoped lookup. Dispatched to `acct-a`. | Response 200. `dispatchBasecampEvent` called with `acct-a` resolved account. |
| DF-009 | integration | Same as DF-008. | POST with valid HMAC from `acct-b`'s secret, bucket.id=100. | Rejected — scoped to `acct-a`, `acct-b`'s secret not tried. | Response 403. |
| DF-010 | integration | Bucket resolves to `acct-a` but `acct-a` registry is empty. | POST with valid HMAC from `acct-b`'s secret. | Fail-closed: `acct-b`'s secret NOT tried as fallback. | Response 403. |
| DF-011 | live (assisted) | Register webhook with Basecamp API, payload URL includes `?token=<webhookSecret>`. BC3 does not return HMAC secrets. | Trigger a real Basecamp event (e.g. post a comment). BC3 delivers to the `?token=` URL. | Webhook delivered and authenticated via token path. `authMethods.token` incremented in metrics. | With `--status-url`: script asserts `authMethods.token >= 1`, exits 1 on failure. Without: operator verifies in OpenClaw logs: webhook received, `authMethod='token'`, event dispatched, no auth errors. |

> **HMAC fallback lane**: If a future BC version returns HMAC secrets, or if secrets are manually seeded via the lifecycle API, the runtime's HMAC verification path (DF-008 through DF-010 in integration) will also fire. The live test can probe this by seeding an HMAC secret and sending a request without `?token=` but with valid `X-Basecamp-Signature` headers. This is an optional secondary exercise; the common case is token auth.

## DM Policy

| ID | Mode | Setup | Stimulus | Expected | Pass Criteria |
|----|------|-------|----------|----------|---------------|
| DF-012 | integration | `dmPolicy: "disabled"`. Route exists. | Dispatch DM event (peer.kind="dm"). | `dm_policy_dropped` logged. Returns `false`. | `dispatchBasecampEvent` returns `false`. |
| DF-013 | integration | `dmPolicy: "pairing"`, `allowFrom: ["777"]`. | Dispatch DM from sender "777". | Passes gate. Dispatched. | Returns `true`. |
| DF-014 | integration | `dmPolicy: "pairing"`, `allowFrom: ["777"]`. | Dispatch DM from sender "888". | `dm_policy_dropped` logged. Returns `false`. | Returns `false`. |
| DF-015 | integration | Default config (no dmPolicy set). | Dispatch DM from any sender. | Default "pairing" applies. Sender not in empty `allowFrom` → dropped. | Returns `false`. |
| DF-016 | integration | `engage: ["mention"]` (no "dm"). | Dispatch DM event. | `engagement_gate_dropped` logged before DM policy check. | Returns `false`. |
| DF-017 | integration | `engage: ["dm", "mention", "conversation"]`. Bucket override `engage: ["mention"]` for bucket "456". | Dispatch conversation event for bucket "456". | Bucket override takes precedence. `engagement_gate_dropped`. | Returns `false`. |

## Outbound Circuit Breaker

| ID | Mode | Setup | Stimulus | Expected | Pass Criteria |
|----|------|-------|----------|----------|---------------|
| DF-018 | integration | Direct `CircuitBreaker` instance, threshold=2, cooldown=50ms. No dispatch pipeline — exercises CB state machine + `recordCircuitBreakerState` + `recordDispatchFailure` directly. | `recordFailure()` ×2, sync metrics, then 3 `recordDispatchFailure()` calls. | CB trips at threshold. Metrics show state "open", `dispatchFailureCount === 3`. | `cb.isOpen(key) === true`. `circuitBreaker[key].state === "open"`. `dispatchFailureCount === 3`. Note: CB state transitions happen in `execBcq` (below `postReplyToEvent`), so DF-018/019/020 exercise the CB + metrics directly. DF-021 validates the full dispatch integration path. |
| DF-019 | integration | CB tripped (open), same direct instance. Wait > cooldownMs. | `isOpen()` returns false (half-open probe), then `recordSuccess()`. Sync metrics. | Probe allowed. Success resets CB to "closed". Metrics synced. | `circuitBreaker[key].state === "closed"`, `failures === 0`. |
| DF-020 | integration | CB tripped (open), same direct instance. Wait > cooldownMs. | `isOpen()` returns false (probe), then `recordFailure()`. Sync metrics. | Probe fails. CB re-trips to "open". Metrics synced. | `circuitBreaker[key].state === "open"`. |
| DF-021 | integration | Full dispatch pipeline. Persona routes outbound to `acct-b`. Mock `postReplyToEvent` to return `{ ok: false }`. | Dispatch event received on `acct-a`. | `dispatchFailureCount` recorded on `acct-b` (outbound persona), NOT `acct-a` (inbound receiver). | `getAccountMetrics("acct-b").dispatchFailureCount >= 1`. `getAccountMetrics("acct-a").dispatchFailureCount === 0`. |
| DF-022 | live (assisted) | Start OpenClaw. Configure CB threshold=3, cooldown=30s. Block outbound API (e.g. invalid bcq profile). | Send 5 messages that trigger agent replies. Wait cooldown, restore API, send probe. | First 3 fail, CB opens. Next 2 fail-fast. After cooldown, half-open probe succeeds, CB closes. | Operator verifies CB state transitions in status adapter output. Script exits 1 only if trigger messages cannot be sent (no inbound events generated). |

---

## Row Counts

| Target | Integration | Live | Total |
|--------|-------------|------|-------|
| Queue pressure | 3 | 1 | 4 |
| Webhook auth | 6 | 1 | 7 |
| DM policy | 6 | 0 | 6 |
| Outbound CB | 4 | 1 | 5 |
| **Total** | **19** | **3** | **22** |
