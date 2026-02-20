# Dogfooding Matrix

Source of truth for reliability validation. Each row maps to either a CI-enforced
integration test (`tests/dogfooding/*.test.ts`) or a live scenario runner
(`scripts/dogfood/*.ts`), or both.

## Gates

1. **PR merge gate**: all integration rows green in CI.
2. **Release gate**: all live rows green at least once on current main.
3. **Prereq**: dead-letter semantics (#33) must be landed before queue-pressure
   rows are considered complete.

---

## Queue Pressure

| ID | Mode | Setup | Stimulus | Expected | Pass Criteria |
|----|------|-------|----------|----------|---------------|
| DF-001 | integration | Semaphore(1), MAX_QUEUED=2 (override via module internals). Mock `dispatchBasecampEvent` to block. | Fire 4 concurrent webhook calls. | First acquired, second+third queued, fourth hits `queue_full` path. `queueFullDropCount` incremented. `webhook.droppedCount` incremented. | `getAccountMetrics(id).queueFullDropCount >= 1`, fourth call returns 200 but event is not dispatched. |
| DF-002 | integration | Same as DF-001 but release semaphore after queue_full. | Fire events after drain. | New events dispatch normally — `dispatchedCount` increments, no `queue_full` log. | `webhook.dispatchedCount` increases, `queueFullDropCount` unchanged after recovery. |
| DF-003 | integration | Mock `dispatchBasecampEvent` to throw. | Dispatch a single webhook event. | `dispatch_error` logged. `webhook.errorCount` incremented. `dispatchFailureCount` incremented. `dead_letter` logged with full context. | `getAccountMetrics(id).dispatchFailureCount >= 1`, `webhook.errorCount >= 1`. |
| DF-004 | live | Start OpenClaw with webhook endpoint. Seed webhook secret via lifecycle API. | Burst 150 webhooks in <2s with valid HMAC. | Most dispatched, some may trigger `backpressure` warn. None dropped to `queue_full` under normal concurrency. | All return 200. No `queue_full` in logs. |

## Webhook Auth

| ID | Mode | Setup | Stimulus | Expected | Pass Criteria |
|----|------|-------|----------|----------|---------------|
| DF-005 | integration | Config with `webhookSecret`. No HMAC headers. | POST with `?token=<correct>`. | 200 OK, event dispatched. | Response status 200. |
| DF-006 | integration | Config with `webhookSecret`. No HMAC headers. | POST with `?token=wrong`. | 403 "Invalid webhook signature or token". | Response status 403. |
| DF-007 | integration | No `webhookSecret`. No HMAC secrets registered. | POST with no auth. | 403 "Webhooks not configured". | Response status 403, body includes "not configured". |
| DF-008 | integration | Two accounts (`acct-a`, `acct-b`) via virtualAccounts. Each has HMAC secrets in registry. Bucket 100 maps to `acct-a`. | POST with valid HMAC from `acct-a`'s secret, bucket.id=100. | Authenticated via scoped lookup. Dispatched to `acct-a`. | Response 200. `dispatchBasecampEvent` called with `acct-a` resolved account. |
| DF-009 | integration | Same as DF-008. | POST with valid HMAC from `acct-b`'s secret, bucket.id=100. | Rejected — scoped to `acct-a`, `acct-b`'s secret not tried. | Response 403. |
| DF-010 | integration | Bucket resolves to `acct-a` but `acct-a` registry is empty. | POST with valid HMAC from `acct-b`'s secret. | Fail-closed: `acct-b`'s secret NOT tried as fallback. | Response 403. |
| DF-011 | live | Register webhook with Basecamp API (real HMAC secret returned). Persist to registry. | Trigger a real Basecamp event (e.g. post a campfire line). | Webhook delivered with valid HMAC. Verified and dispatched. | Event appears in dispatch logs. No auth errors. |

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
| DF-018 | integration | CB threshold=2, cooldown=100ms. Mock `postReplyToEvent` to fail. | Dispatch 3 events. | First 2 fail (record failures). Third hits open breaker. `delivery_failed` + `dead_letter` logged for each. `dispatchFailureCount` = 3. CB state synced as "open". | `getAccountMetrics(id).circuitBreaker.outbound.state === "open"`. `dispatchFailureCount >= 3`. |
| DF-019 | integration | CB tripped (open). Wait > cooldownMs. Mock `postReplyToEvent` to succeed. | Dispatch 1 event. | Half-open probe allowed. Success resets CB to "closed". `dispatchFailureCount` unchanged. | `circuitBreaker.outbound.state === "closed"`, `failures === 0`. |
| DF-020 | integration | CB tripped (open). Wait > cooldownMs. Mock `postReplyToEvent` to fail. | Dispatch 1 event. | Half-open probe fails. CB re-trips to "open". `dispatchFailureCount` increments. | `circuitBreaker.outbound.state === "open"`. |
| DF-021 | integration | Persona routes outbound to `acct-b`. Mock `postReplyToEvent` to fail. | Dispatch event received on `acct-a`. | `dispatchFailureCount` recorded on `acct-b` (outbound), NOT `acct-a` (inbound). | `getAccountMetrics("acct-b").dispatchFailureCount >= 1`. `getAccountMetrics("acct-a")` has no dispatch failures. |
| DF-022 | live | Start OpenClaw. Configure CB threshold=3, cooldown=30s. Block outbound API (e.g. invalid bcq profile). | Send 5 messages that trigger agent replies. | First 3 fail, CB opens. Next 2 fail-fast. After 30s, send another — half-open probe. | CB state transitions visible in status adapter output. Recovery on valid API restore. |

---

## Row Counts

| Target | Integration | Live | Total |
|--------|-------------|------|-------|
| Queue pressure | 3 | 1 | 4 |
| Webhook auth | 6 | 1 | 7 |
| DM policy | 6 | 0 | 6 |
| Outbound CB | 4 | 1 | 5 |
| **Total** | **19** | **3** | **22** |
