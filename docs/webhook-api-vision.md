# Basecamp Event Stream API -- Vision & Specification

## 1. Executive Summary

This document proposes an **account-wide event stream API** for Basecamp to replace the current per-project webhook system. The goal is to provide a reliable, structured, real-time event delivery mechanism suitable for multi-project agent platforms like the OpenClaw Basecamp plugin.

The current webhook API was designed for single-project integrations: one webhook registration per project, all event types delivered without filtering, no sequence numbers, no replay capability. An agent platform managing dozens of projects for an account must register and manage webhooks individually, implement client-side deduplication, poll separate APIs for assignment changes and reading state, and accept that events missed during downtime are gone forever.

The proposed API consolidates all of this into a single account-wide subscription with typed events, sequence numbers, rich payloads, and replay capability.

---

## 2. Current State & Limitations

### 2.1 How the plugin works today

The OpenClaw Basecamp plugin uses a **composite event fabric** that stitches together three separate data sources to approximate a unified event stream:

| Source | API | Interval | What it provides |
|--------|-----|----------|------------------|
| Activity feed | `GET /reports/progress.json` | 120s poll | Account-wide timeline: messages, comments, card moves, todo completions |
| Hey! Readings | `GET /my/readings.json` | 60s poll | Unread inbox items: mentions, DMs, new content in subscribed recordings |
| Assignments | `GET /my/assignments.json` | 300s poll | Currently assigned todos (set-diff to detect new assignments) |

A supplementary **webhook handler** receives per-project webhook payloads at `/webhooks/basecamp` for lower-latency delivery of events in projects where webhooks have been manually registered.

### 2.2 Limitations

| Current Behavior | Problem for Agent Platform |
|---|---|
| **Per-project webhook registration** | 50 projects = 50 registrations. Dynamic management overhead when projects are created/archived. No way to automatically include new projects. |
| **No account-wide subscriptions** | Must poll `GET /reports/progress.json` to monitor all projects. 120s minimum latency, no push delivery. |
| **No assignment change events** | No `todo.assigned` / `todo.unassigned` webhooks. Must poll `GET /my/assignments.json` and diff the full set to detect changes. First poll requires bootstrap (snapshot all existing IDs to avoid false positives). |
| **No reading state events** | No way to know when a user reads a message or todo. Must poll `GET /my/readings.json` to detect inbox state changes. |
| **No sequence numbers or idempotency keys** | No gap detection -- if the plugin misses a webhook delivery, there is no way to know. Client must maintain a 24-hour rolling dedup window with both primary keys (per-source event IDs) and secondary keys (cross-source recording:action:timestamp composites) to collapse duplicate events from activity feed + readings + webhooks. |
| **No filtering at registration** | Webhook delivers ALL event types for a project. Plugin receives card moves, document edits, vault changes, and schedule updates it doesn't care about, then filters client-side. |
| **Cascading changes not atomic** | Completing a parent todo with 10 children produces 11 separate webhook deliveries. No way to correlate them as a single operation. |
| **No backfill or replay** | Events missed during downtime (deploy, crash, network partition) are gone forever. Plugin's cursor-based polling partially mitigates this for the activity feed, but webhook-only events have no recovery path. |
| **Sparse payloads** | Webhook payloads include recording ID and type but not full state (assignees, column, parent todolist, due date). Plugin must make follow-up API calls to fetch context for agent dispatch. |
| **Activity feed is lossy** | `GET /reports/progress.json` returns a fixed-size page of recent events. During high-activity periods, events can scroll off before the next poll. No pagination token for reliable consumption. |

### 2.3 Client-side complexity this creates

The plugin currently maintains:

- **`EventDedup`** -- rolling 24-hour window with primary + secondary key maps, periodic pruning, persistent JSON file store for restart safety
- **`CursorStore`** -- per-account timestamp cursors for activity feed and readings, plus a custom key for the assignment ID set
- **`CompositePoller`** -- orchestrator running three independent poll loops with per-source exponential backoff (max 5 min), abort signal coordination, and cursor persistence with retry
- **Cross-source dedup** -- secondary keys (`recording:action:timestamp`) to collapse the same Basecamp event seen from both the activity feed and the readings inbox
- **Assignment bootstrap** -- first-run snapshot of all current assignment IDs to avoid flooding agents with stale assignments on initial deploy

All of this complexity exists because the API does not provide a single, reliable event stream.

---

## 3. Proposed API Design

### 3.1 Account-Wide Event Streams

Register a single subscription per integration that covers all projects the service user has access to. New projects are automatically included.

**Create subscription:**

```http
POST /{account_id}/integrations/{integration_id}/subscriptions.json
Content-Type: application/json

{
  "event_types": ["todo.*", "campfire.line.created", "card.moved"],
  "delivery_url": "https://agent.example.com/webhooks/basecamp",
  "secret": "whsec_a1b2c3d4e5f6..."
}
```

```json
{
  "id": 1001,
  "integration_id": 42,
  "event_types": ["todo.*", "campfire.line.created", "card.moved"],
  "delivery_url": "https://agent.example.com/webhooks/basecamp",
  "status": "active",
  "created_at": "2025-01-15T08:00:00Z",
  "last_delivery_at": null,
  "sequence": 0
}
```

**List subscriptions:**

```http
GET /{account_id}/integrations/{integration_id}/subscriptions.json
```

**Update subscription (change event types or URL):**

```http
PUT /{account_id}/integrations/{integration_id}/subscriptions/{id}.json
Content-Type: application/json

{
  "event_types": ["todo.*", "campfire.*", "card.*", "comment.created"]
}
```

**Delete subscription:**

```http
DELETE /{account_id}/integrations/{integration_id}/subscriptions/{id}.json
```

### 3.2 Event Type Filtering

Events use a hierarchical dot-notation namespace. Subscriptions accept exact types or wildcards.

#### Event type catalog

```
# Campfire
campfire.line.created
campfire.line.updated
campfire.line.deleted

# Todos
todo.created
todo.completed
todo.reopened
todo.assigned
todo.unassigned
todo.edited
todo.commented

# Cards (Card Table / Kanban)
card.created
card.moved
card.assigned
card.unassigned
card.completed
card.commented
card.step.completed

# Comments
comment.created
comment.updated
comment.deleted

# Messages
message.created
message.edited
message.commented

# Documents
document.created
document.edited
document.commented

# Check-ins (Questions)
question.created
question.answered

# Schedule
schedule.entry.created
schedule.entry.rescheduled
schedule.entry.commented

# Uploads
upload.created

# Reading state
recording.read

# Boosts
recording.boosted

# Lifecycle
recording.archived
recording.unarchived
recording.trashed
recording.untrashed
```

#### Wildcard matching

- `todo.*` -- matches `todo.created`, `todo.completed`, `todo.assigned`, etc.
- `card.*` -- matches all card events
- `*` -- matches everything (equivalent to no filter)

Single-asterisk wildcards apply to a single level only: `todo.*` matches `todo.completed` but not `todo.step.completed`. For recursive matching across any number of sub-levels, use the double-asterisk (`**`) wildcard: `todo.**` matches `todo.completed`, `todo.step.completed`, and so on. The `**` wildcard should appear at the end of the pattern.

### 3.3 Sequence Numbers

Every event in the account stream receives a **monotonically increasing sequence number**. This enables:

1. **Gap detection** -- client stores its high-water mark and compares against incoming sequence
2. **Replay on reconnect** -- fetch missed events by sequence range
3. **Ordering guarantee** -- events are delivered in causal order within a subscription

Sequence numbers are **per-subscription** (assigned after event type filtering), so clients only see contiguous sequences for events matching their subscription. There are no "gaps" from filtered-out event types.

```
Sequence: 41 → todo.assigned
Sequence: 42 → todo.completed
Sequence: 43 → campfire.line.created
...
```

**Replay endpoint:**

```http
GET /{account_id}/integrations/{integration_id}/events.json?since_sequence=41&limit=100
```

```json
{
  "events": [
    { "sequence": 42, "type": "todo.completed", "..." : "..." },
    { "sequence": 43, "type": "campfire.line.created", "..." : "..." }
  ],
  "has_more": false,
  "next_sequence": 44
}
```

Replay is available for at least 72 hours. After that, events are garbage-collected and the client should use the regular API to reconcile state.

**Gap detection flow:**

1. Client receives event with `sequence: 45`
2. Client's high-water mark is `42`
3. Client detects gap (missing 43, 44)
4. Client calls `GET /events.json?since_sequence=42&limit=100`
5. Replays missed events, advances high-water mark to 45

This eliminates the need for the plugin's bespoke rolling-window, cross-source deduplication layer: `EventDedup`, secondary key maps, and `JsonFileDedupStore` all become unnecessary. Clients instead rely on ordered delivery via `sequence` plus simple idempotency using `event_id`.

### 3.4 Assignment Lifecycle Events

First-class events for assignment changes, eliminating the need to poll and diff `GET /my/assignments.json`.

**`todo.assigned`:**

```json
{
  "event_id": "evt_01HQXYZ123456",
  "sequence": 50,
  "type": "todo.assigned",
  "timestamp": "2025-01-15T10:00:00Z",
  "account_id": 12345,
  "recording": {
    "id": 67890,
    "type": "Todo",
    "title": "Review Q4 metrics",
    "status": "active",
    "assignees": [
      { "id": 111, "name": "Alice" },
      { "id": 222, "name": "Bob" }
    ],
    "bucket": { "id": 333, "name": "Acme Project" },
    "todolist": { "id": 444, "name": "Sprint 12" },
    "due_on": "2025-01-20",
    "app_url": "https://3.basecamp.com/12345/buckets/333/todos/67890"
  },
  "actor": { "id": 999, "name": "Carol" },
  "assignee": { "id": 222, "name": "Bob" },
  "previous_assignees": [
    { "id": 111, "name": "Alice" }
  ]
}
```

The payload includes:
- **`assignees`** -- the full current assignee list (not just the delta)
- **`assignee`** -- the specific person added/removed by this event
- **`previous_assignees`** -- the assignee list before this change

This also applies to cards:
- `card.assigned` / `card.unassigned` with the same payload shape

### 3.5 Reading State Events

Push notification when a user reads content, replacing the need to poll `GET /my/readings.json`.

**`recording.read`:**

```json
{
  "event_id": "evt_01HQXYZ789012",
  "sequence": 55,
  "type": "recording.read",
  "timestamp": "2025-01-15T10:05:00Z",
  "account_id": 12345,
  "recording": {
    "id": 67890,
    "type": "Message",
    "title": "Project kickoff notes",
    "bucket": { "id": 333, "name": "Acme Project" },
    "app_url": "https://3.basecamp.com/12345/buckets/333/messages/67890"
  },
  "reader": { "id": 222, "name": "Bob" },
  "read_at": "2025-01-15T10:05:00Z"
}
```

This enables agents to know when their messages have been seen without polling.

### 3.6 Atomic Grouped Notifications

Bulk operations produce a single webhook delivery with a `group_id` that ties related events together.

**Example: completing a parent todo with 3 child todos**

Instead of 4 separate deliveries, one grouped payload:

```json
{
  "group_id": "grp_01HQXYZ345678",
  "events": [
    {
      "event_id": "evt_01HQXYZ000001",
      "sequence": 60,
      "type": "todo.completed",
      "recording": { "id": 100, "type": "Todo", "title": "Parent task" },
      "actor": { "id": 111, "name": "Alice" }
    },
    {
      "event_id": "evt_01HQXYZ000002",
      "sequence": 61,
      "type": "todo.completed",
      "recording": { "id": 101, "type": "Todo", "title": "Subtask 1" },
      "actor": { "id": 111, "name": "Alice" }
    },
    {
      "event_id": "evt_01HQXYZ000003",
      "sequence": 62,
      "type": "todo.completed",
      "recording": { "id": 102, "type": "Todo", "title": "Subtask 2" },
      "actor": { "id": 111, "name": "Alice" }
    },
    {
      "event_id": "evt_01HQXYZ000004",
      "sequence": 63,
      "type": "todo.completed",
      "recording": { "id": 103, "type": "Todo", "title": "Subtask 3" },
      "actor": { "id": 111, "name": "Alice" }
    }
  ],
  "timestamp": "2025-01-15T10:10:00Z",
  "account_id": 12345
}
```

Each event within the group still has its own `event_id` and `sequence` number. The `group_id` is advisory -- clients can process events individually or as a batch.

Grouped operations include:
- Completing/reopening a parent todo (cascades to children)
- Moving a card column (may reassign multiple cards)
- Archiving/trashing a project (cascades to all recordings)

### 3.7 Rich Payloads

Every event payload includes the full recording state at the time of the event, eliminating follow-up API calls.

**`todo.completed` -- full payload example:**

```json
{
  "event_id": "evt_01HQXYZ456789",
  "sequence": 42,
  "type": "todo.completed",
  "timestamp": "2025-01-15T10:00:00Z",
  "account_id": 12345,
  "recording": {
    "id": 67890,
    "type": "Todo",
    "title": "Deploy new feature",
    "status": "completed",
    "content": "<div>Deploy the new dashboard feature to production.</div>",
    "completed_at": "2025-01-15T10:00:00Z",
    "completer": { "id": 111, "name": "Alice" },
    "assignees": [{ "id": 222, "name": "Bob" }],
    "bucket": { "id": 333, "name": "Acme Project" },
    "todolist": { "id": 444, "name": "Sprint 12" },
    "due_on": "2025-01-20",
    "description": "<div>Deploy to production after QA sign-off.</div>",
    "app_url": "https://3.basecamp.com/12345/buckets/333/todos/67890",
    "comments_count": 3,
    "comments_url": "https://3.basecampapi.com/12345/buckets/333/recordings/67890/comments.json"
  },
  "actor": { "id": 111, "name": "Alice" }
}
```

**`campfire.line.created` -- full payload example:**

```json
{
  "event_id": "evt_01HQXYZ111222",
  "sequence": 70,
  "type": "campfire.line.created",
  "timestamp": "2025-01-15T10:15:00Z",
  "account_id": 12345,
  "recording": {
    "id": 99001,
    "type": "Chat::Line",
    "content": "<div>Hey <bc-attachment sgid=\"abc123\">@Coworker</bc-attachment>, can you check the deploy?</div>",
    "parent": {
      "id": 88001,
      "type": "Chat::Transcript",
      "title": "Campfire",
      "app_url": "https://3.basecamp.com/12345/buckets/333/chats/88001"
    },
    "bucket": { "id": 333, "name": "Acme Project" },
    "app_url": "https://3.basecamp.com/12345/buckets/333/chats/88001/lines/99001"
  },
  "actor": { "id": 111, "name": "Alice", "attachable_sgid": "xyz789" },
  "mentions": [
    { "sgid": "abc123", "person_id": 555, "name": "Coworker" }
  ]
}
```

**`card.moved` -- full payload example:**

```json
{
  "event_id": "evt_01HQXYZ333444",
  "sequence": 75,
  "type": "card.moved",
  "timestamp": "2025-01-15T10:20:00Z",
  "account_id": 12345,
  "recording": {
    "id": 55001,
    "type": "Kanban::Card",
    "title": "Design homepage wireframes",
    "status": "active",
    "assignees": [{ "id": 222, "name": "Bob" }],
    "column": { "id": 660, "name": "In Progress" },
    "previous_column": { "id": 659, "name": "To Do" },
    "bucket": { "id": 333, "name": "Acme Project" },
    "card_table": { "id": 550, "name": "Design Pipeline" },
    "due_on": null,
    "app_url": "https://3.basecamp.com/12345/buckets/333/card_tables/550/cards/55001"
  },
  "actor": { "id": 111, "name": "Alice" }
}
```

**`comment.created` -- full payload example:**

```json
{
  "event_id": "evt_01HQXYZ555666",
  "sequence": 80,
  "type": "comment.created",
  "timestamp": "2025-01-15T10:25:00Z",
  "account_id": 12345,
  "recording": {
    "id": 77001,
    "type": "Comment",
    "content": "<div>Looks good, approved! [APPROVED]</div>",
    "parent": {
      "id": 67890,
      "type": "Todo",
      "title": "Deploy new feature",
      "status": "active",
      "assignees": [{ "id": 222, "name": "Bob" }],
      "bucket": { "id": 333, "name": "Acme Project" }
    },
    "bucket": { "id": 333, "name": "Acme Project" },
    "app_url": "https://3.basecamp.com/12345/buckets/333/todos/67890#__recording_77001"
  },
  "actor": { "id": 111, "name": "Alice" }
}
```

**`recording.read` -- full payload example:**

```json
{
  "event_id": "evt_01HQXYZ777888",
  "sequence": 85,
  "type": "recording.read",
  "timestamp": "2025-01-15T10:30:00Z",
  "account_id": 12345,
  "recording": {
    "id": 67890,
    "type": "Message",
    "title": "Weekly status update",
    "bucket": { "id": 333, "name": "Acme Project" },
    "app_url": "https://3.basecamp.com/12345/buckets/333/messages/67890"
  },
  "reader": { "id": 222, "name": "Bob" },
  "read_at": "2025-01-15T10:30:00Z"
}
```

**`question.answered` -- full payload example:**

```json
{
  "event_id": "evt_01HQXYZ999000",
  "sequence": 90,
  "type": "question.answered",
  "timestamp": "2025-01-15T10:35:00Z",
  "account_id": 12345,
  "recording": {
    "id": 33001,
    "type": "Question::Answer",
    "content": "<div>Shipped the API refactor. Tests green.</div>",
    "parent": {
      "id": 33000,
      "type": "Question",
      "title": "What did you work on today?"
    },
    "bucket": { "id": 333, "name": "Acme Project" },
    "app_url": "https://3.basecamp.com/12345/buckets/333/questions/33000/answers/33001"
  },
  "actor": { "id": 111, "name": "Alice" }
}
```

### 3.8 Server-Sent Events (SSE) Alternative

For lowest-latency use cases (Campfire chat), an SSE endpoint provides sub-second event delivery over a long-lived HTTP connection.

**Connect:**

```http
GET /{account_id}/integrations/{integration_id}/events/stream?event_types=campfire.line.created,campfire.line.updated
Accept: text/event-stream
```

**SSE stream:**

```
id: 70
event: campfire.line.created
data: {"event_id":"evt_01HQXYZ111222","sequence":70,"type":"campfire.line.created","timestamp":"2025-01-15T10:15:00Z","recording":{"id":99001,"type":"Chat::Line","content":"<div>Hey team!</div>"},"actor":{"id":111,"name":"Alice"}}

id: 71
event: campfire.line.created
data: {"event_id":"evt_01HQXYZ111223","sequence":71,"type":"campfire.line.created","timestamp":"2025-01-15T10:15:05Z","recording":{"id":99002,"type":"Chat::Line","content":"<div>Ready for standup?</div>"},"actor":{"id":222,"name":"Bob"}}

```

**Reconnection:**

SSE's built-in `Last-Event-ID` header handles reconnection automatically. The server uses the sequence number as the event ID, so reconnecting resumes from exactly where the client left off.

```http
GET /{account_id}/integrations/{integration_id}/events/stream?event_types=campfire.*
Accept: text/event-stream
Last-Event-ID: 70
```

The server replays all events since sequence 70 before switching to live delivery.

**Heartbeat:**

The server sends a comment line every 30 seconds to keep the connection alive:

```
: heartbeat 2025-01-15T10:16:00Z

```

### 3.9 Delivery Guarantees

**At-least-once delivery.** Every event is delivered at least once. Clients must handle duplicate deliveries (trivially, using the `event_id` field -- no windowed dedup needed).

**Retry policy:**

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 30 seconds |
| 3 | 2 minutes |
| 4 | 10 minutes |
| 5 | 1 hour |

After 5 failed attempts, the event is moved to a **dead letter queue**. The subscription is marked as `degraded` and an admin notification is sent.

If delivery fails persistently for 72 hours, the subscription is automatically **paused**. The integration owner is notified and must explicitly resume it.

**Ordering semantics:** Events are delivered in sequence order on a best-effort basis. A persistently failing event does **not** block delivery of subsequent events (no head-of-line blocking). When an event is moved to the dead letter queue, its sequence number becomes a permanent gap in the delivered stream. Clients should use the replay endpoint to detect and reconcile gaps rather than assuming contiguous delivery under degraded conditions.

**Delivery status API:**

```http
GET /{account_id}/integrations/{integration_id}/subscriptions/{id}/deliveries.json?status=failed&limit=50
```

```json
{
  "deliveries": [
    {
      "event_id": "evt_01HQXYZ456789",
      "sequence": 42,
      "type": "todo.completed",
      "status": "failed",
      "attempts": 5,
      "last_attempt_at": "2025-01-15T11:00:00Z",
      "last_error": "HTTP 503 Service Unavailable",
      "next_retry_at": null
    }
  ],
  "paused": false
}
```

**Webhook signature:**

Every delivery includes an HMAC-SHA256 signature in the `X-Basecamp-Signature` header. The signature is computed over `{timestamp}.{raw_body}` using the subscription's `secret`, where `timestamp` is the Unix epoch seconds from the `X-Basecamp-Timestamp` header. This replaces the current query-string token approach and prevents replay attacks.

```
X-Basecamp-Signature: sha256=a1b2c3d4e5f6...
X-Basecamp-Timestamp: 1705312800
X-Basecamp-Event: todo.completed
X-Basecamp-Delivery: evt_01HQXYZ456789
```

Receivers should reject requests where `X-Basecamp-Timestamp` is more than 5 minutes from the current time to prevent replay of captured signatures.

### 3.10 Idempotency Keys

Every event payload includes a globally unique `event_id` in ULID format (`evt_{ulid}`). ULIDs are:

- **Sortable** -- lexicographic ordering matches chronological ordering
- **Unique** -- 128-bit value (48-bit timestamp + 80-bit randomness) with extremely low collision probability
- **Compact** -- 26-character Crockford Base32 encoding

Clients can deduplicate by storing only the `event_id` of each processed event. No need for windowed dedup, secondary keys, or cross-source correlation.

```
evt_01HQXYZ123456  →  timestamp: 2025-01-15T10:00:00.000Z, random: XYZ123456
evt_01HQXYZ123457  →  timestamp: 2025-01-15T10:00:00.001Z, random: XYZ123457
```

---

## 4. Registration Flow

### Step 1: Create an integration

The account admin creates an integration (bot user) in Basecamp's admin panel. This produces an `integration_id` and API credentials.

### Step 2: Create a subscription

The integration registers its event subscription:

```bash
curl -X POST \
  "https://3.basecampapi.com/12345/integrations/42/subscriptions.json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_types": ["todo.*", "campfire.line.created", "card.*", "comment.created", "recording.read"],
    "delivery_url": "https://agent.example.com/webhooks/basecamp",
    "secret": "whsec_a1b2c3d4e5f6..."
  }'
```

### Step 3: Receive events

Events start flowing immediately. The first delivery includes a `subscription.activated` meta-event:

```json
{
  "event_id": "evt_01HQXYZ000000",
  "sequence": 0,
  "type": "subscription.activated",
  "timestamp": "2025-01-15T08:00:00Z",
  "account_id": 12345,
  "subscription_id": 1001
}
```

### Step 4: Process and acknowledge

The client returns `200 OK` within 10 seconds to acknowledge receipt. Processing happens asynchronously.

### Step 5: Handle gaps

On restart, the client checks its stored high-water mark and replays any missed events:

```bash
curl "https://3.basecampapi.com/12345/integrations/42/events.json?since_sequence=42&limit=100" \
  -H "Authorization: Bearer $TOKEN"
```

### Step 6: Manage lifecycle

```bash
# Pause subscription (stop deliveries, events accumulate for replay)
curl -X PUT \
  "https://3.basecampapi.com/12345/integrations/42/subscriptions/1001.json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"status": "paused"}'

# Resume subscription (replay accumulated events)
curl -X PUT \
  "https://3.basecampapi.com/12345/integrations/42/subscriptions/1001.json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"status": "active"}'

# Delete subscription
curl -X DELETE \
  "https://3.basecampapi.com/12345/integrations/42/subscriptions/1001.json" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 5. Migration Path

The new event stream API coexists with the existing per-project webhook system during transition.

### Phase 1: Ship event stream API alongside existing webhooks

- Existing per-project webhooks continue to work unchanged
- New account-wide subscriptions are opt-in
- Both systems can deliver events for the same project simultaneously
- Clients migrating can run both in parallel to verify parity

### Phase 2: Feature parity period

- New event types (`todo.assigned`, `recording.read`, etc.) are available only through the event stream API
- Existing webhook event types are delivered through both systems
- Documentation guides new integrations to use the event stream API

### Phase 3: Deprecation

- Per-project webhooks are marked as deprecated in docs
- Existing registrations continue to work
- New per-project webhook registrations are discouraged (optional: blocked)

### Phase 4: Sunset

- After a generous notice period (12+ months), per-project webhooks are removed
- All integrations use the event stream API

### Compatibility notes

- The event stream API uses different event type names (`todo.completed` vs `todo_completed` webhook kind). A mapping table is published for migration.
- Rich payloads in the event stream are a superset of existing webhook payloads. No information is lost.

---

## 6. Webhook Payload Examples

### 6.1 `campfire.line.created`

Fired when someone posts a new line in a Campfire chat.

```json
{
  "event_id": "evt_01HQXYZ111222",
  "sequence": 70,
  "type": "campfire.line.created",
  "timestamp": "2025-01-15T10:15:00Z",
  "account_id": 12345,
  "recording": {
    "id": 99001,
    "type": "Chat::Line",
    "content": "<div>Hey <bc-attachment sgid=\"BAh7CEkiCG...\">@Coworker</bc-attachment>, the deploy is ready for review.</div>",
    "parent": {
      "id": 88001,
      "type": "Chat::Transcript",
      "title": "Campfire",
      "app_url": "https://3.basecamp.com/12345/buckets/333/chats/88001"
    },
    "bucket": { "id": 333, "name": "Acme Project" },
    "app_url": "https://3.basecamp.com/12345/buckets/333/chats/88001/lines/99001"
  },
  "actor": {
    "id": 111,
    "name": "Alice",
    "email_address": "alice@example.com",
    "attachable_sgid": "BAh7CEkiCG..."
  },
  "mentions": [
    { "sgid": "BAh7CEkiCG...", "person_id": 555, "name": "Coworker" }
  ]
}
```

### 6.2 `todo.created`

Fired when a new todo is created.

```json
{
  "event_id": "evt_01HQXYZ222333",
  "sequence": 71,
  "type": "todo.created",
  "timestamp": "2025-01-15T10:16:00Z",
  "account_id": 12345,
  "recording": {
    "id": 67891,
    "type": "Todo",
    "title": "Write integration tests for payment flow",
    "status": "active",
    "content": "<div>Cover edge cases: expired cards, insufficient funds, 3DS challenge.</div>",
    "assignees": [
      { "id": 222, "name": "Bob" }
    ],
    "bucket": { "id": 333, "name": "Acme Project" },
    "todolist": { "id": 444, "name": "Sprint 12" },
    "due_on": "2025-01-22",
    "app_url": "https://3.basecamp.com/12345/buckets/333/todos/67891"
  },
  "actor": { "id": 111, "name": "Alice" }
}
```

### 6.3 `todo.completed`

Fired when a todo is completed.

```json
{
  "event_id": "evt_01HQXYZ456789",
  "sequence": 42,
  "type": "todo.completed",
  "timestamp": "2025-01-15T10:00:00Z",
  "account_id": 12345,
  "recording": {
    "id": 67890,
    "type": "Todo",
    "title": "Deploy new feature",
    "status": "completed",
    "content": "<div>Deploy the new dashboard feature to production.</div>",
    "completed_at": "2025-01-15T10:00:00Z",
    "completer": { "id": 111, "name": "Alice" },
    "assignees": [{ "id": 222, "name": "Bob" }],
    "bucket": { "id": 333, "name": "Acme Project" },
    "todolist": { "id": 444, "name": "Sprint 12" },
    "due_on": "2025-01-20",
    "app_url": "https://3.basecamp.com/12345/buckets/333/todos/67890"
  },
  "actor": { "id": 111, "name": "Alice" }
}
```

### 6.4 `todo.assigned`

Fired when a person is assigned to a todo.

```json
{
  "event_id": "evt_01HQXYZ333444",
  "sequence": 50,
  "type": "todo.assigned",
  "timestamp": "2025-01-15T10:05:00Z",
  "account_id": 12345,
  "recording": {
    "id": 67890,
    "type": "Todo",
    "title": "Review Q4 metrics",
    "status": "active",
    "assignees": [
      { "id": 111, "name": "Alice" },
      { "id": 222, "name": "Bob" }
    ],
    "bucket": { "id": 333, "name": "Acme Project" },
    "todolist": { "id": 444, "name": "Sprint 12" },
    "due_on": "2025-01-20",
    "app_url": "https://3.basecamp.com/12345/buckets/333/todos/67890"
  },
  "actor": { "id": 999, "name": "Carol" },
  "assignee": { "id": 222, "name": "Bob" },
  "previous_assignees": [
    { "id": 111, "name": "Alice" }
  ]
}
```

### 6.5 `card.moved`

Fired when a card is moved between columns on a Card Table.

```json
{
  "event_id": "evt_01HQXYZ555666",
  "sequence": 75,
  "type": "card.moved",
  "timestamp": "2025-01-15T10:20:00Z",
  "account_id": 12345,
  "recording": {
    "id": 55001,
    "type": "Kanban::Card",
    "title": "Design homepage wireframes",
    "status": "active",
    "assignees": [{ "id": 222, "name": "Bob" }],
    "column": { "id": 660, "name": "In Progress" },
    "previous_column": { "id": 659, "name": "To Do" },
    "bucket": { "id": 333, "name": "Acme Project" },
    "card_table": { "id": 550, "name": "Design Pipeline" },
    "due_on": null,
    "app_url": "https://3.basecamp.com/12345/buckets/333/card_tables/550/cards/55001"
  },
  "actor": { "id": 111, "name": "Alice" }
}
```

### 6.6 `comment.created`

Fired when a comment is added to any recording (todo, message, card, etc.).

```json
{
  "event_id": "evt_01HQXYZ777888",
  "sequence": 80,
  "type": "comment.created",
  "timestamp": "2025-01-15T10:25:00Z",
  "account_id": 12345,
  "recording": {
    "id": 77001,
    "type": "Comment",
    "content": "<div>Looks good! Approved and ready for deploy.</div>",
    "parent": {
      "id": 67890,
      "type": "Todo",
      "title": "Deploy new feature",
      "status": "active",
      "assignees": [{ "id": 222, "name": "Bob" }]
    },
    "bucket": { "id": 333, "name": "Acme Project" },
    "app_url": "https://3.basecamp.com/12345/buckets/333/todos/67890#__recording_77001"
  },
  "actor": { "id": 111, "name": "Alice" }
}
```

### 6.7 `recording.read`

Fired when a user reads a recording.

```json
{
  "event_id": "evt_01HQXYZ999000",
  "sequence": 85,
  "type": "recording.read",
  "timestamp": "2025-01-15T10:30:00Z",
  "account_id": 12345,
  "recording": {
    "id": 67890,
    "type": "Message",
    "title": "Weekly status update",
    "bucket": { "id": 333, "name": "Acme Project" },
    "app_url": "https://3.basecamp.com/12345/buckets/333/messages/67890"
  },
  "reader": { "id": 222, "name": "Bob" },
  "read_at": "2025-01-15T10:30:00Z"
}
```

---

## 7. Impact on OpenClaw Plugin

The event stream API would dramatically simplify the OpenClaw Basecamp plugin. Here is what changes.

### 7.1 Components eliminated

| Current component | Purpose | Why it's no longer needed |
|---|---|---|
| `src/inbound/poller.ts` | Composite poller orchestrating 3 poll loops | Replaced by single webhook subscription |
| `src/inbound/activity.ts` | Activity feed polling via `basecamp timeline` | Events pushed via subscription |
| `src/inbound/readings.ts` | Hey! Readings polling via `basecamp readings` | `recording.read` events pushed |
| `src/inbound/assignments.ts` | Assignment set-diff polling via `basecamp assignments` | `todo.assigned`/`todo.unassigned` events pushed |
| `src/inbound/dedup.ts` | Rolling-window dedup with primary + secondary keys | Replaced by `event_id` dedup (trivial set lookup) |
| `src/inbound/dedup-store.ts` | JSON file persistence for dedup state | Replaced by sequence number high-water mark (single integer) |
| `src/inbound/cursors.ts` | Per-source timestamp cursor persistence | Replaced by single sequence number |

### 7.2 Components simplified

| Current component | Change |
|---|---|
| `src/inbound/webhooks.ts` | Simplified: single handler, HMAC signature verification replaces query-string token, sequence tracking replaces dedup |
| `src/inbound/normalize.ts` | Simplified: rich payloads include structured type, assignees, parent -- less parsing and inference needed |
| `src/config.ts` | Simplified: remove `polling.*` interval config, remove `webhookSecret` (replaced by subscription-level secret) |
| `index.ts` | No change to registration, but the service layer no longer starts poll loops |

### 7.3 New capabilities enabled

| Capability | How |
|---|---|
| **Real-time Campfire** | SSE stream with `types=campfire.*` for sub-second chat delivery |
| **Assignment awareness** | Direct `todo.assigned` events instead of 5-minute poll delay |
| **Read receipts** | `recording.read` events enable "message seen" tracking |
| **Gap recovery** | Sequence-based replay on startup -- no events lost during downtime |
| **Atomic batch processing** | `group_id` lets the agent handle bulk operations as single units |
| **Reduced API calls** | Rich payloads eliminate follow-up calls for recording context |

### 7.4 Simplified architecture

**Before (current):**

```
                    +-----------------+
                    | Activity Feed   |  poll every 120s
                    | GET /reports/   |
                    | progress.json   |
                    +--------+--------+
                             |
                    +--------+--------+
                    | Readings        |  poll every 60s
                    | GET /my/        |
                    | readings.json   |
                    +--------+--------+
                             |           +------------------+
                    +--------+--------+  | Per-project      |
                    | Assignments     |  | Webhooks (N)     |
                    | GET /my/        |  | POST /webhooks/  |
                    | assignments.json|  | basecamp         |
                    +--------+--------+  +--------+---------+
                             |                    |
                    +--------+--------------------+---------+
                    |          Cross-source dedup           |
                    |  primary keys + secondary keys + TTL  |
                    |  + JSON file persistence              |
                    +--------+------------------------------+
                             |
                    +--------+--------+
                    |   normalize.ts  |
                    |  (infer types,  |
                    |   parse URLs,   |
                    |   resolve peers)|
                    +--------+--------+
                             |
                    +--------+--------+
                    |   dispatch.ts   |
                    +-----------------+
```

**After (with event stream API):**

```
                    +------------------+
                    | Event Stream     |
                    | POST /webhooks/  |    single subscription
                    | basecamp         |    all event types
                    +--------+---------+
                             |
                    +--------+---------+
                    | Sequence tracker |    single integer
                    | (high-water mark)|    replay on gap
                    +--------+---------+
                             |
                    +--------+---------+
                    |  normalize.ts    |    simplified:
                    |  (structured     |    rich payloads
                    |   payloads)      |    reduce inference
                    +--------+---------+
                             |
                    +--------+---------+
                    |   dispatch.ts    |
                    +------------------+

                    +------------------+
                    | SSE stream       |    optional:
                    | campfire.*       |    real-time chat
                    +------------------+
```

### 7.5 Migration strategy for the plugin

1. **Phase 1**: Add event stream subscription handler alongside existing composite poller. Run both in parallel, compare event delivery for parity validation.
2. **Phase 2**: Once parity is confirmed, disable composite poller. Use event stream as sole inbound source with sequence-based replay for gap recovery.
3. **Phase 3**: Remove polling code (`activity.ts`, `readings.ts`, `assignments.ts`, `poller.ts`, `dedup.ts`, `dedup-store.ts`, `cursors.ts`).
4. **Phase 4**: Add SSE stream for Campfire real-time delivery.
