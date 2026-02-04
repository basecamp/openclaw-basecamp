# OpenClaw × Basecamp × Coworker: S-Tier Integration Architecture

## Vision

Today Coworker is a human-driven loop: someone types `/security-monitor` and the agent checks the queue. OpenClaw transforms this into an event-driven system where every Basecamp surface — Campfire chats, card tables, to-do lists, automatic check-ins, pings, message boards — becomes a live nerve ending that routes activity to specialized agents. A HackerOne report arrives and the security agent triages it, posting `[PROPOSED]` to a Basecamp card. A card moves to "Needs Diagnosis" and the bugs agent spawns an analysis subagent. A check-in fires at 4pm asking "What shipped today?" and an agent drafts an answer from the day's commit history. A Campfire @mention asks "what's the status of that Safari bug?" and the bugs agent reconstructs the timeline.

The Basecamp channel isn't a notification pipe — it's the **primary interaction surface**. Humans approve, redirect, and override through the same Basecamp UI they already live in. Agents narrate in Campfire, track state on card tables, and surface decisions as card comments.

**Multi-persona by design.** Teams can have their own teammate-bots — different names, avatars, behaviors — all served by one OpenClaw deployment and routed by bindings. An admin can "hatch" a new agent persona from a Basecamp command: create the agent, link a service account, wire routing, and the new bot shows up in the team's project ready to work.

**Composite event fabric.** No single Basecamp API gives complete signal coverage. The channel ingests from multiple sources — activity feed, Hey! Readings, Action Cable, webhooks, direct recordable polls — and deduplicates into a unified event stream. Every signal path humans see, agents see too.

---

## Part 1: Development Path — External Plugin

**External plugin, owned by your team.** Develop independently, share with colleagues via local path or git URL, and nominate for OpenClaw inclusion when mature. No fork required — the plugin system treats external plugins identically to bundled ones.

```
Development repo: ~/Work/basecamp/basecamp-openclaw-plugin/
Install: openclaw plugins install /path/to/basecamp-openclaw-plugin
         — or — plugins.load.paths in openclaw.yaml
Upstream later: PR to openclaw/openclaw to bundle under extensions/basecamp/
```

**Why external-first:**
- Own the release cadence — ship alongside Basecamp changes
- Iterate freely without upstream review cycles
- Colleagues install from git or local path
- Full integration depth — external plugins get the same `ChannelPlugin` API as bundled ones
- When stable, nominate for bundling with a small upstream PR (registry + dock + move plugin)

### 1.1 Plugin Repo Structure

```
basecamp-openclaw-plugin/
├── package.json                  # NPM package with openclaw.extensions metadata
├── openclaw.plugin.json          # Plugin manifest: channels, config schema
├── tsconfig.json
├── README.md
├── scripts/
│   └── install-local.sh          # Dev install helper
├── src/
│   ├── index.ts                  # Default export: { id, register(api) }
│   ├── channel.ts                # ChannelPlugin<BasecampAccount> definition
│   ├── types.ts                  # BasecampAccountConfig, event types, peer conventions
│   ├── config.ts                 # listAccountIds, resolveAccount, virtual aliases
│   ├── inbound/
│   │   ├── poller.ts             # Composite event fabric: orchestrates all sources
│   │   ├── activity.ts           # Activity feed polling (120s)
│   │   ├── readings.ts           # Hey! Readings polling (60s)
│   │   ├── webhooks.ts           # Webhook receiver + signature validation
│   │   ├── action-cable.ts       # Real-time Campfire/thread events (Phase 2+)
│   │   ├── normalize.ts          # Basecamp event → OpenClaw inbound message
│   │   └── dedup.ts              # Composite dedup (event_id, recording+action+ts)
│   ├── outbound/
│   │   ├── send.ts               # sendText → bcq (Phase 1), native API later
│   │   └── format.ts             # Markdown → Basecamp HTML, @mention → bc-attachment
│   ├── mentions/
│   │   └── parse.ts              # bc-attachment SGID parsing + person cache
│   └── adapters/
│       ├── meta.ts               # id: "basecamp", label, blurb
│       ├── capabilities.ts       # chatTypes: [direct, group]
│       ├── security.ts           # DM policy for Pings
│       ├── gateway.ts            # startAccount/logoutAccount lifecycle
│       └── directory.ts          # List peers (projects, campfires, recordings)
└── tests/
    └── ...
```

### 1.2 Key Plugin Files

**`package.json`:**
```json
{
  "name": "@37signals/openclaw-basecamp",
  "version": "0.1.0",
  "type": "module",
  "openclaw": {
    "extensions": ["./src/index.ts"]
  },
  "dependencies": {
    "openclaw": ">=2026.2.0"
  }
}
```

**`openclaw.plugin.json`:**
```json
{
  "id": "basecamp",
  "name": "Basecamp",
  "description": "Basecamp channel for OpenClaw — Campfire, cards, todos, check-ins, pings",
  "channels": ["basecamp"]
}
```

**Note on config schema:** The channel config schema lives in `ChannelPlugin.configSchema` (runtime code), not in the plugin manifest. This matches how bundled channels work — the manifest declares the channel ID, but the `configSchema` adapter in `channel.ts` owns validation. The manifest `configSchema` is only for minimal gating.

The runtime schema (in `src/config.ts`) validates:
```typescript
// channels.basecamp config shape:
{
  accounts: Record<string, {
    tokenFile: string,
    personId: string,
    displayName?: string,
    attachableSgid?: string,
  }>,
  virtualAccounts?: Record<string, {
    accountId: string,
    bucketId: string,
  }>,
  personas?: Record<string, string>,  // agentId → accountId
}
```

**`src/index.ts`:**
```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { basecampChannel } from "./channel.js";

export default {
  id: "basecamp",
  name: "Basecamp",
  description: "Basecamp channel — Campfire, cards, todos, check-ins, pings",
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: basecampChannel });
  },
};
```

**`src/channel.ts`:** (skeleton)
```typescript
import type { ChannelPlugin } from "openclaw/plugin-sdk";
import type { BasecampAccount } from "./types.js";

export const basecampChannel: ChannelPlugin<BasecampAccount> = {
  id: "basecamp",
  meta: { id: "basecamp", label: "Basecamp", blurb: "Campfire, cards, todos, check-ins" },
  capabilities: { chatTypes: ["direct", "group"] },
  config: { /* listAccountIds, resolveAccount, defaultAccountId */ },
  gateway: { /* startAccount, logoutAccount */ },
  outbound: { /* sendText */ },
  mentions: { /* parseMentions, formatMention */ },
  security: { /* dmPolicy */ },
  messaging: { /* normalizeTarget */ },
};
```

### 1.3 Installation

**For development (local path):**
```yaml
# openclaw.yaml
plugins:
  load:
    paths:
      - ~/Work/basecamp/basecamp-openclaw-plugin
```

**For colleagues (git):**
```bash
openclaw plugins install git+ssh://git@github.com/basecamp/basecamp-openclaw-plugin
```

### 1.4 Upstream Nomination (Later)

When the plugin is stable, submit a PR to `openclaw/openclaw`:

1. Move plugin code to `extensions/basecamp/`
2. Add `basecamp` to `CHAT_CHANNEL_ORDER` in `src/channels/registry.ts`
3. Add Basecamp `ChannelDock` entry in `src/channels/dock.ts`
4. Add `docs/channels/basecamp.md`

The plugin code is identical whether external or bundled. The only difference is discovery path.

---

## Part 2: Basecamp Channel — Grounded in bc3 + OpenClaw Reality

### 2.1 Basecamp Domain Model

Basecamp's core model is **Bucket → Recording → Recordable**:
- **Bucket** = Project or Circle (Pings are Circle buckets)
- **Recording** owns the thread tree (parent/children), events, visibility, comments
- **Recordable** types: Chat::Transcript, Chat::Line, Kanban::Card, Message, Todo, Question, Question::Answer, Document, Upload, Vault, Comment

Campfire and Pings are both `Chat::Transcript` recordings with `Chat::Line` children. Comments are a Recordable type living as children of their parent recording.

### 2.2 Peer Model (OpenClaw-Compatible)

**Critical constraint:** OpenClaw peer kinds are limited to `dm | group | channel`. No custom kinds. All Basecamp places map through these three:

```
Basecamp Place       bc3 Model                   peer.kind   peer.id                    parentPeer
──────────────       ─────────                   ─────────   ───────                    ──────────
Campfire             Chat::Transcript + Lines     group       recording:<transcriptId>   bucket:<bucketId>
Ping (1:1)           Circle → Chat::Transcript    dm          ping:<circleBucketId>      (none)
Ping (multi-person)  Circle → Chat::Transcript    group       ping:<circleBucketId>      (none)
Card                 Kanban::Card                 group       recording:<cardId>          bucket:<bucketId>
Message board post   Message                      group       recording:<messageId>       bucket:<bucketId>
To-do                Todo                         group       recording:<todoId>          bucket:<bucketId>
Check-in question    Question                     group       recording:<questionId>      bucket:<bucketId>
Check-in answer      Question::Answer (child)     group       (same as parent question)   bucket:<bucketId>
Document/Upload      Document, Upload, Vault      group       recording:<recordingId>     bucket:<bucketId>
```

Comments and chat lines are **child recordings** — they map to `meta.messageId`/`meta.eventId`, not peer identity. The peer is always the parent recording (the thread).

**parentPeer** enables per-project routing via existing `resolveAgentRoute` inheritance. Set `parentPeer = { kind: "group", id: "bucket:<bucketId>" }` on all non-DM events. Bindings match parentPeer when peer doesn't match directly — no core schema changes needed.

### 2.3 Account Mapping (Dual Strategy)

**Primary:** Basecamp account as `accountId`. `channels.basecamp.accounts.<accountId>` holds auth + account info. Routing uses parentPeer for per-project binding.

**Optional:** Virtual bucket aliases. `channels.basecamp.virtualAccounts.<alias>` → `{ accountId, bucketId }`. If a bucketId matches a virtual alias, inbound events emit `accountId = <alias>` for clean per-project bindings without parentPeer. Teams choose their preferred style:

```jsonc
// Style A: parentPeer routing (minimal config)
{ "agentId": "bugs", "match": { "channel": "basecamp", "peer": { "kind": "group", "id": "bucket:123" } } }

// Style B: virtual account alias (explicit)
{ "agentId": "bugs", "match": { "channel": "basecamp", "accountId": "bugs-project" } }
```

### 2.4 Composite Event Fabric

No single Basecamp API provides complete signal coverage. The channel ingests from **all** signal sources and deduplicates:

```
┌──────────────────────────────────────────────────────────────────┐
│                    COMPOSITE EVENT FABRIC                         │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ Activity     │  │ Hey! Readings│  │ Action Cable         │   │
│  │ Feed         │  │ (mentions,   │  │ (ChatChannel,        │   │
│  │ (per-account │  │  assignments,│  │  ThreadsChannel)     │   │
│  │  polling)    │  │  comments,   │  │                      │   │
│  │              │  │  follows)    │  │  Real-time Campfire   │   │
│  │ Comprehensive│  │              │  │  + thread updates     │   │
│  │ event log    │  │ Mirrors what │  │                      │   │
│  │              │  │ humans see   │  │  Phase 2+            │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────────────┘   │
│         │                 │                  │                    │
│  ┌──────┴─────┐  ┌───────┴──────┐  ┌────────┴──────────┐       │
│  │ Webhooks   │  │ Direct Polls │  │ bcq event sync   │       │
│  │ (selective │  │ (per-project │  │ (h1, Help Scout,  │       │
│  │  where     │  │  for gaps;   │  │  Sentry — via     │       │
│  │  available)│  │  slower      │  │  webhook channel) │       │
│  │            │  │  cadence)    │  │                   │       │
│  └──────┬─────┘  └──────┬──────┘  └────────┬──────────┘       │
│         │               │                   │                    │
│         └───────────────┼───────────────────┘                    │
│                         ▼                                        │
│              ┌─────────────────────┐                             │
│              │   DEDUPLICATION     │                              │
│              │   event_id or       │                              │
│              │   recordingId +     │                              │
│              │   action + timestamp│                              │
│              │   (replay window)   │                              │
│              └──────────┬──────────┘                             │
│                         ▼                                        │
│              Unified inbound message stream                      │
└──────────────────────────────────────────────────────────────────┘
```

**Source priority and ingestion order (per account, per cycle):**

| Priority | Source | Default Cadence | Role | Gaps |
|----------|--------|-----------------|------|------|
| 1 | **Action Cable** | Real-time | Immediate chat + thread events | Campfire/threads only |
| 2 | **Webhooks** | Real-time | Fast recordable create/update/comment | Not all event types |
| 3 | **Hey! Readings** | 60s polling | Mentions, assignments, comments — what humans see | Only "interesting" events |
| 4 | **Activity Feed** | 120s polling | Comprehensive historical log | Some actions missing; no real-time |
| 5 | **Direct Polls** | 5-10 min | Gap-filler for specific high-value recordables | Expensive; selective |

**Ingestion order per cycle:**
1. Drain Action Cable queue (if running)
2. Drain webhook queue
3. Poll Hey! Readings (delta since last cursor)
4. Poll Activity Feed (delta since last cursor)
5. Run targeted recordable polls (delta)

**Dedup rules:**
- Primary: `eventId` (if present)
- Secondary: `recordingId + action + createdAt`
- Tertiary: content hash + sender + timestamp window (±2 min)
- Rolling dedup window: 24h per account

**Backoff/throttling:**
- High activity → Activity Feed interval stretches to 5 min max
- Rate limit hit → pause Direct Polls first (lowest priority)
- Budget pressure → pause Direct Polls, then Activity Feed (Action Cable + webhooks continue free)

### 2.5 Signal Types (from Event Fabric)

Signals extracted from the composite fabric, keyed to the meta field:

**Chat (Campfire + Pings):**
| Signal | Source(s) | Meta |
|--------|-----------|------|
| New line | Activity + Action Cable | `eventKind: "line_created"` |
| Line edited | Activity | `eventKind: "line_edited"` |
| Line deleted | Activity | `eventKind: "line_deleted"` |
| @mention of agent | Any (bc-attachment parsing) | `mentionsAgent: true` |
| @mention of person | Any | `mentions: [sgid, ...]` |
| Attachment | Any | `attachments: [...]` |

**Cards:**
| Signal | Source(s) | Meta |
|--------|-----------|------|
| Card created | Activity + Webhook | `eventKind: "created"`, `column` |
| Card moved | Activity + Direct Poll diff | `eventKind: "moved"`, `column`, `columnPrevious` |
| Card assigned | Activity + Hey! Readings | `eventKind: "assigned"`, `assignees`, `assignedToAgent` |
| Card comment | Activity + Webhook | `eventKind: "comment"` |
| State marker in comment | Parsing | `stateMarker: "[APPROVED]"` |
| Card step completed | Activity | `eventKind: "step_completed"` |
| Due date approaching | Direct Poll | `eventKind: "sla_warning"` |

**Todos:**
| Signal | Source(s) | Meta |
|--------|-----------|------|
| Todo created | Activity + Webhook | `eventKind: "created"` |
| Todo completed | Activity + Webhook | `eventKind: "completed"` |
| Todo reopened | Activity | `eventKind: "reopened"` |
| Todo assigned | Activity + Hey! Readings | `eventKind: "assigned"`, `assignedToAgent` |
| Todo overdue | Direct Poll | `eventKind: "overdue"` |

**Check-Ins:**
| Signal | Source(s) | Meta |
|--------|-----------|------|
| Question asked (scheduled) | Activity + Direct Poll | `eventKind: "checkin_due"` |
| Answer posted | Activity | `eventKind: "checkin_answered"` |
| Question paused/resumed | Activity | `eventKind: "checkin_paused"` / `"checkin_resumed"` |

**Messages/Documents:**
| Signal | Source(s) | Meta |
|--------|-----------|------|
| Post created | Activity + Webhook | `eventKind: "created"` |
| Post edited | Activity | `eventKind: "edited"` |
| Comment on post | Activity + Webhook | `eventKind: "comment"` |

**Global:**
| Signal | Source(s) | Meta |
|--------|-----------|------|
| Subscription change | Hey! Readings | `eventKind: "subscription_changed"` |
| Visibility change | Activity | `eventKind: "visibility_changed"` |
| Archive/Unarchive | Activity | `eventKind: "archived"` / `"unarchived"` |
| Trash/Untrash | Activity | `eventKind: "trashed"` / `"untrashed"` |

### 2.6 Inbound Message Shape

```typescript
{
  channel: "basecamp",
  accountId: string,                       // Real Basecamp account or virtual alias
  peer: {
    kind: "dm" | "group",                  // OpenClaw-native kinds only
    id: string,                            // recording:<id>, bucket:<id>, or ping:<id>
  },
  parentPeer?: {
    kind: "group",
    id: string,                            // bucket:<bucketId> for project routing
  },
  sender: {
    id: string,                            // Basecamp person ID
    name: string,
    email: string,                         // For identity linking
  },
  text: string,                            // HTML → plain text extraction
  html: string,                            // Original Basecamp HTML
  meta: {
    bucketId: string,                      // Always present
    recordingId: string,                   // Thread recording ID
    recordableType: string,                // "Chat::Line", "Comment", "Kanban::Card", etc.
    messageId?: string,                    // Child recording ID (comment/line)
    eventKind: string,                     // "comment", "created", "moved", "assigned", etc.
    mentions: string[],                    // Person SGIDs
    mentionsAgent: boolean,                // Whether agent's identity was @mentioned
    attachments: Array<{ sgid, url, type }>,
    column?: string,                       // Card current column
    columnPrevious?: string,               // Card previous column
    assignees?: string[],                  // Person IDs
    assignedToAgent?: boolean,             // Whether agent's person_id is in assignees
    stateMarker?: string,                  // "[APPROVED]", "[REJECTED]", etc.
    dueOn?: string,                        // ISO date
    matchedPatterns?: string[],            // Which mention/keyword patterns matched
  }
}
```

### 2.7 Outbound Delivery

| Thread Type | Outbound Action | Basecamp Endpoint |
|-------------|----------------|-------------------|
| Campfire transcript | Post Chat::Line | `POST /buckets/{id}/chats/{id}/lines.json` |
| Ping transcript | Post Chat::Line to Circle transcript | Same as Campfire (transcript endpoint) |
| Any commentable recording | Post Comment | `POST /buckets/{id}/recordings/{id}/comments.json` |
| Card (create) | Create Kanban::Card | `POST /buckets/{id}/card_tables/lists/{id}/cards.json` |
| Card (move) | Move to column | Card moves endpoint |
| Todo (complete) | Complete | `POST /buckets/{id}/todos/{id}/completion.json` |

**Formatting:** Markdown → Basecamp HTML. `@name` → `<bc-attachment sgid="{attachable_sgid}">` via person cache lookup.

**Identity:** Service account user for all outbound in Phase 1. Posts prefixed with `[agent-name]` for clarity. Chatbot persona deferred to Phase 4.

### 2.8 @Mention Mechanics

**Inbound:** Parse `<bc-attachment sgid="...">` tags from HTML. Resolve SGIDs against cached person/bot registry. If SGID matches agent's service account → `meta.mentionsAgent = true`, bypass mention gate.

**Outbound:** Agent output with `@person-name` → channel looks up person in project people cache (`GET /projects/{id}/people.json`) → replaces with `<bc-attachment sgid="{attachable_sgid}">`. Cache refreshed hourly.

### 2.9 Assignment-Driven Workflows

The agent's Basecamp identity (service account) has a `person_id`. Assignments to this person ID trigger agent processing:

- **Card assigned to agent** → route to domain agent based on card table mapping
- **Todo assigned to agent** → agent reads todo content, determines action, executes or proposes
- **Card assigned to human** → context update: narrate new assignee in Campfire, update work item

### 2.10 Card Column Moves as State Machine

Column names map to the universal Coworker state machine (configurable per card table):

```yaml
column_state_map:
  work_ledger:
    "Inbox": INBOX
    "Working": WORKING
    "Proposed": PROPOSED
    "Approved": APPROVED      # Human moves here = approval signal
    "Executed": EXECUTED
    "Closed": CLOSED
  bugs:
    "New": INBOX
    "Triaging": WORKING
    "Diagnosed": PROPOSED
    "Fixing": EXECUTED
    "Verified": CLOSED
```

Human-initiated column moves trigger state transitions. Moving from "Proposed" to "Approved" is equivalent to `[APPROVED]` — agent deduplicates both signals.

---

## Part 3: Routing & Bindings

### 3.1 Binding Hierarchy (Using Existing OpenClaw Semantics)

```
Priority 1: Peer match (specific recording/thread)
  { channel: "basecamp", peer: { kind: "group", id: "recording:456" } }

Priority 2: parentPeer match (specific bucket/project)
  { channel: "basecamp", peer: { kind: "group", id: "bucket:123" } }
  → matches via parentPeer inheritance in resolveAgentRoute

Priority 3: Account match (all activity on a Basecamp account)
  { channel: "basecamp", accountId: "bc-main" }

Priority 4: Channel default
  { channel: "basecamp" }
```

### 3.2 Practical Binding Configuration

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "security-agent",
        "model": "anthropic/claude-opus-4-5",
        "bindings": [
          // Security Ops project (all recordings)
          { "channel": "basecamp", "peer": { "kind": "group", "id": "bucket:SEC_PROJECT_ID" } },
          // Specific security triage Campfire
          { "channel": "basecamp", "peer": { "kind": "group", "id": "recording:SEC_CAMPFIRE_ID" } }
        ],
        "groupChat": {
          "requireMention": true,
          "mentionPatterns": ["(?i)@coworker", "(?i)\\b(security|vuln|cve|hackerone)\\b"]
        }
      },
      {
        "id": "bugs-agent",
        "model": "anthropic/claude-sonnet-4-5",
        "bindings": [
          // Bugs project
          { "channel": "basecamp", "peer": { "kind": "group", "id": "bucket:BUGS_PROJECT_ID" } }
        ]
      },
      {
        "id": "standup-agent",
        "model": "anthropic/claude-haiku-3-5",
        "bindings": [
          // Bound to specific check-in question recordings
          { "channel": "basecamp", "peer": { "kind": "group", "id": "recording:CHECKIN_QUESTION_ID" } }
        ]
      },
      {
        "id": "router-agent",
        "model": "anthropic/claude-haiku-3-5",
        "bindings": [
          // Catch-all for unmatched Basecamp activity
          { "channel": "basecamp" }
        ]
      }
    ]
  }
}
```

### 3.3 Mention Gating by Place Type

The agent decides based on `meta.recordableType` whether to respond. The channel always delivers the message; the agent's AGENTS.md instructions govern when to act:

```markdown
## When to respond (in agent AGENTS.md)

ALWAYS respond when:
- meta.mentionsAgent is true (you were @mentioned)
- meta.assignedToAgent is true (work assigned to you)
- meta.stateMarker is present ("[APPROVED]", "[REJECTED]", etc.)
- meta.eventKind is "created" and recording is in your monitored card table
- meta.eventKind is "checkin_due"
- peer.kind is "dm" (Ping — always respond to DMs)

ONLY respond when mentioned:
- Campfire lines without @mention (high-volume, avoid noise)
- Message board posts without @mention
- Document comments without @mention

NEVER respond to:
- Your own messages (sender.id matches your person_id)
- Events you already processed (check work ledger for UWID)
```

### 3.4 Cross-Domain Routing

The router-agent classifies unmatched events and forwards them:

```
Campfire: "@coworker there's a security issue in login that's spiking Sentry"

Router-agent receives (catch-all binding):
  1. Classifies: primary=security, secondary=exceptions
  2. Creates card in Security Work Ledger: "[security] Login vuln"
  3. Creates card in Exceptions Work Ledger: "[exceptions] Login error spike"
  4. Cross-links the two cards in comments
  5. Replies in Campfire: "Routed to security-agent and exceptions-agent"
```

---

## Part 4: Multi-Persona Identity Model

### 4.1 Decision: Multiple Personas in One Deployment

A single OpenClaw deployment supports multiple Basecamp service accounts (personas). Each persona has its own name, avatar, and behavior, routed by bindings. Teams get their own teammate-bots without running separate infrastructure.

```jsonc
{
  "channels": {
    "basecamp": {
      "accounts": {
        "bc-security": {
          "tokenFile": "~/.config/bcq/security-bot.token",
          "personId": "12345",                    // Basecamp person ID
          "displayName": "Security Bot",
          "attachableSgid": "sgid://bc/Person/12345"
        },
        "bc-bugs": {
          "tokenFile": "~/.config/bcq/bugs-bot.token",
          "personId": "67890",
          "displayName": "Bugs Bot",
          "attachableSgid": "sgid://bc/Person/67890"
        },
        "bc-standup": {
          "tokenFile": "~/.config/bcq/standup-bot.token",
          "personId": "11111",
          "displayName": "Standup Bot",
          "attachableSgid": "sgid://bc/Person/11111"
        }
      },
      "personas": {
        // Agent → account mapping lives HERE, not in AgentConfig
        // (OpenClaw AgentConfig can't be extended by external plugins)
        "security-agent": "bc-security",
        "bugs-agent": "bc-bugs",
        "standup-agent": "bc-standup"
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "security-agent",
        "bindings": [
          { "channel": "basecamp", "accountId": "bc-security" },
          { "channel": "basecamp", "peer": { "kind": "group", "id": "bucket:SEC_PROJECT" } }
        ]
      },
      {
        "id": "bugs-agent",
        "bindings": [
          { "channel": "basecamp", "peer": { "kind": "group", "id": "bucket:BUGS_PROJECT" } }
        ]
      },
      {
        "id": "standup-agent",
        "bindings": [
          { "channel": "basecamp", "peer": { "kind": "group", "id": "recording:CHECKIN_Q_ID" } }
        ]
      }
    ]
  }
}
```

**Why `channels.basecamp.personas`?** OpenClaw's `AgentConfig` can't be extended by external plugins — there's no `basecampAccount` field. Instead, the agent→persona mapping lives inside `channels.basecamp.personas`, which the channel plugin's config schema owns and validates. On outbound, the channel looks up the sending agent's ID in `personas` to select the right service account.

**Outbound routing:** When an agent replies, the channel resolves `personas[agentId]` → account ID → service account credentials. Different agents post as different Basecamp users (different name/avatar). If an agent has no persona mapping, falls back to the default account.

**Inbound @mention routing:** Each persona's `attachableSgid` is registered. When a Campfire message @mentions "Security Bot", the channel resolves the SGID to `bc-security`, sets `meta.mentionsAgent = true`, and routes to `security-agent`.

### 4.2 "Hatch Agent" Flow (Explicit Admin-Triggered)

An admin agent can create new personas on demand. This is always explicit — never implicit or self-creating.

```
Admin command (CLI or Basecamp):
  "hatch agent standup-bot for project Engineering"

Admin agent workflow:
  1. CREATE Basecamp service account
     → New user "Standup Bot" with avatar
     → Add to target project as member
     → Store auth token

  2. CREATE OpenClaw agent entry
     → agents.list += {
         id: "standup-bot",
         model: "claude-haiku-3-5",
         basecampAccount: "bc-standup-bot",
         workspace: "~/.openclaw/agents/standup-bot/"
       }
     → Write AGENTS.md with persona instructions

  3. CREATE channel account entry
     → channels.basecamp.accounts.bc-standup-bot = {
         tokenFile, personId, displayName, attachableSgid
       }

  4. CREATE routing bindings
     → bindings += {
         agentId: "standup-bot",
         match: { channel: "basecamp", peer: { kind: "group", id: "bucket:ENG_PROJECT" } }
       }

  5. ANNOUNCE in target project Campfire
     → "Standup Bot has joined this project.
        @mention me for daily standup questions and check-in summaries."

  6. RELOAD Gateway config (hot-reload or restart)
```

**Guard rails:**
- Only the admin agent can hatch (requires elevated permissions)
- Hatch flow validates: project exists, service account credentials work, no conflicting bindings
- Audit log entry in admin chronicle
- Hatched agents start in dry-run mode by default

---

## Part 5: Settled Decisions

### Q1: Chatbot API vs. Webhooks → **Service account + webhooks + polling (Phase 1). Chatbot deferred.**

Service account user for all outbound. Webhooks for card/comment/todo events. Polling fallback for surfaces without webhook support (column moves, assignment changes, check-in answers). Chatbot integration deferred to Phase 4 when agent persona is introduced.

### Q2: Session Persistence → **Hybrid by place type**

| Place Type | Session Strategy | Rationale |
|------------|-----------------|-----------|
| Card | Persistent (keyed by `recording:<cardId>`) | Long-lived work items with multi-comment threads |
| Ping (DM) | Persistent (keyed by `ping:<circleBucketId>`) | Ongoing person-to-agent conversations |
| Campfire | Ephemeral, reconstruct from last N lines | High-volume; maintaining state is expensive |
| Todo | Ephemeral | Single-action items |
| Check-in | Ephemeral | Each cycle independent |
| Message board | Ephemeral | One-shot discussions |

Persistent sessions idle-timeout after 4h. On timeout, archive. On next event, reconstruct from Work Ledger card comments.

### Q3: Skill Loading Parity → **Test harness comparing Claude Code vs OpenClaw**

SKILL.md files inject identically as system prompt content in both environments. Behavioral contract:
1. Skills injected as system prompt, not user message
2. REFERENCE.md loaded only on explicit request
3. Frontmatter parsed for metadata, not injected into model

Test harness: 10 canonical scenarios per domain. Run through both Claude Code and OpenClaw. Compare triage decisions, state markers, and chronicle output.

### Q4: bcq vs. Native API → **bcq in Phase 1, native for polling in Phase 2, full native in Phase 3**

Phase 1: All reads/writes via bcq. Phase 2: Native API for polling (avoids process spawn overhead at 60s intervals), bcq for writes. Phase 3: Full native API in channel adapter; bcq remains as agent tool for ad-hoc queries.

### Q5: Approval Timeout → **Tiered escalation, never auto-approve writes**

```yaml
approval_timeouts:
  security:
    first_reminder: 2h      # Campfire nudge
    escalation: 8h           # @mention domain lead
    auto_action: none        # Never auto-approve

  bugs:
    first_reminder: 4h
    escalation: 24h
    auto_action: none

  support:
    first_reminder: 1h       # Customer-facing, tighter SLA
    escalation: 4h
    auto_action: none

  exceptions:
    first_reminder: 4h
    escalation: 24h
    auto_action: auto_acknowledge_48h  # Auto-ack (not resolve) after 48h

  performance:
    first_reminder: 2h
    escalation: 8h
    auto_action: none
```

### Q6: Cost Guardrails → **Daily ceiling + per-domain limits + model fallback cascade**

```yaml
cost_guardrails:
  global:
    daily_budget_usd: 50.00
    alert_at_pct: [50, 75, 90]      # Campfire alerts at thresholds

  per_domain:
    security:  { max_events_per_hour: 20,  max_subagents: 3 }
    bugs:      { max_events_per_hour: 30,  max_subagents: 2 }
    support:   { max_events_per_hour: 50,  max_subagents: 1 }
    exceptions:{ max_events_per_hour: 100, max_subagents: 0 }
    performance:{ max_events_per_hour: 10, max_subagents: 1 }

  overflow: queue     # Queue events, don't drop
  budget_exceeded: pause_and_alert
```

Model fallback cascade: Opus→Sonnet at 75% budget, Sonnet→Haiku at 90%, pause non-critical at 100%.

### Q7: Claude Code Coexistence → **Complementary, Work Ledger deduplicates**

| Mode | Surface | Use Case |
|------|---------|----------|
| Event-driven | OpenClaw via Basecamp | Continuous intake, automated triage |
| Interactive | Human in Claude Code terminal | Deep investigation, ad-hoc analysis |
| Batch | OpenClaw swarm | 10+ queue items |
| Development | Claude Code + `/coworker-evolve` | Skill iteration |

Deduplication: Before processing, check Work Ledger for existing card with same external ID. If state > INBOX, skip. Git merge conflicts are last-resort dedup.

### Q8: Gateway HA → **Accepted SPOF with mitigations**

Systemd auto-restart. Webhook retry on failure. Polling catches missed events. Session state persists to disk. Claude Code remains operational independently. Acceptable for team-internal tool.

### Q9: Agent → Persona Mapping → **`channels.basecamp.personas`**

OpenClaw's `AgentConfig` can't be extended by external plugins. The agent→Basecamp account mapping lives inside `channels.basecamp.personas` (a `Record<agentId, accountId>`), which the channel plugin's config schema owns and validates. This keeps the mapping schema-valid without requiring core changes.

### Q10: Ping Peer Kind → **DM for 1:1, group for multi-person**

Basecamp Pings are Circle buckets with a Chat::Transcript. A 1:1 Ping maps to `peer.kind = "dm"` (standard DM semantics — always respond, no mention gating). A multi-person Ping maps to `peer.kind = "group"` (follows group mention gating rules). The channel inspects Circle membership count to choose.

### Q11: Config Schema Location → **`ChannelPlugin.configSchema` (code), not manifest**

The channel config schema lives in the plugin's runtime code (`ChannelPlugin.configSchema` adapter), not in `openclaw.plugin.json`. This matches how bundled channels work. The manifest declares the channel ID; the runtime code owns validation. Manifest `configSchema` is minimal gating only.

### Q12: Event Fabric Completeness → **Activity + Readings primary, reconciliation backstop, agent-friendly feed long-term**

Primary real-time fabric: Activity Feed + Hey! Readings. Add a low-cadence reconciliation pass (every 6h, covering last 24h window) to validate no events were silently dropped. If reconciliation detects gaps for a recordable type, auto-promote it to the direct poll list. Long-term: push for a Basecamp agent-friendly event feed that replaces both polling sources. During Phase 1, run `bcq` against a live account to document exact coverage per recordable type.

### Q13: Boosts/Reactions → **Informational signal in Phase 1; approval semantic in Phase 3**

Boosts are visible in the Activity Feed. In Phase 1, surface as `eventKind: "boosted"` (informational). In Phase 3, allow config to map specific boost types (e.g., thumbs-up on a `[PROPOSED]` comment) as approval signals equivalent to `[APPROVED]`.

### Q14: Webhooks Scope → **Accelerators only, never sole source for correctness**

Webhooks are supplementary. The system must function correctly with webhooks disabled. Webhook-delivered events deduplicate against polling sources. Supported webhook types: recording created, recording updated, comment posted. We do not rely on webhooks for column moves, assignment changes, or check-in answers.

### Q15: Action Cable Auth → **Phase 2 gated by "stable auth" milestone**

Action Cable requires WebSocket connection with session cookies or token auth. For a non-browser Gateway host, this likely requires a bearer token or API key approach. Phase 2 implementation is gated by confirming a reliable auth model that doesn't depend on browser sessions. If auth proves brittle, AC remains optional and polling continues as primary.

### Q16: Direct Polling Fallback Criteria → **Hybrid: low-cadence safety net + escalation on detected lag**

Two-tier approach:

**Tier 1 — Safety net (always on):** Low-cadence polls (every 10 min) for cards, todos, and check-ins in monitored projects. Runs regardless of feed health. Cheap enough to not matter.

**Tier 2 — Escalation (on lag detection):** If Activity/Readings show no events for a monitored project for 10+ minutes during business hours, escalate to rapid direct polls (every 2 min) until feed resumes. Triggers:
- Card table monitored but no card events in 10 min
- Check-in question due (per schedule) but no `checkin_due` event
- Todo assigned to agent with no update in 15 min after expected completion
- SLA warning threshold approaching (from `dueOn` in config)

### Q17: Persona Provisioning → **Manual for Phase 1, scriptable hatch in Phase 3**

Phase 1: Admin manually creates Basecamp service accounts, adds to projects, stores tokens. Phase 3: The hatch flow wraps this in a scripted sequence (create user → add to project → store token → update config → announce). Full API-driven provisioning depends on Basecamp admin API access.

### Q18: Dedup TTL & Storage Layout → **Per-account sqlite, 24h TTL, plugin state dir**

```
~/.openclaw/plugins/basecamp/state/
  ├── dedup-<accountId>.sqlite    # Event dedup window
  └── cursors-<accountId>.json    # Polling cursors (activity feed position, readings cursor)
```

TTL: 24h rolling window. Entries older than 24h are pruned on each poll cycle. Sqlite chosen for persistence across restarts and queryability for debugging.

### Q19: Mention Resolution → **Require `personId` in config; auto-resolve `attachableSgid` at startup**

`personId` is required in each account config (it's the stable Basecamp identifier). `attachableSgid` is auto-resolved at startup via `GET /people/{personId}.json` and cached (refreshed hourly). Config-declared `attachableSgid` takes precedence as an explicit override. This reduces config friction (personId is easy to find) while keeping SGID routing reliable.

### Q20: Operational Monitoring → **Alert triggers for silent fabric failures**

```yaml
monitoring:
  alerts:
    - name: activity_feed_stalled
      condition: "no events from activity feed for 10 minutes during business hours"
      action: campfire_alert + log_warning

    - name: readings_stalled
      condition: "no events from readings for 5 minutes during business hours"
      action: campfire_alert + log_warning

    - name: dedup_spike
      condition: "dedup rate > 80% for 30 minutes"
      action: log_warning  # May indicate source overlap, not failure

    - name: outbound_failure
      condition: "3+ consecutive outbound post failures"
      action: campfire_alert + pause_outbound + log_error

    - name: polling_latency
      condition: "poll cycle takes > 30 seconds"
      action: log_warning + stretch_cadence

    - name: budget_threshold
      condition: "daily cost at 75% / 90% / 100%"
      action: campfire_alert + model_cascade + pause_non_critical
```

---

### Basecamp Place Coverage Matrix

**Principle: Ingest all recordables from Phase 1; limit outbound actions by phase.**

All recordable types flow through the event fabric from day one — no blind spots. Outbound actions (posting, moving, completing) are phased to avoid risk.

| Recordable Type | Ingest | Activity Feed | Hey! Readings | Direct Poll | Webhook | Action Cable | Outbound |
|----------------|--------|---------------|---------------|-------------|---------|-------------|----------|
| Chat::Line (Campfire) | Phase 1 | ✓ | ✓ (@mention) | - | - | Phase 2 | Phase 1 (post) |
| Chat::Line (Ping) | Phase 1 | ✓ | ✓ | - | - | Phase 2 | Phase 1 (post) |
| Kanban::Card | Phase 1 | ✓ (create/comment) | ✓ (assign) | ✓ (moves) | ✓ (create) | - | Phase 1 (create/comment), Phase 3 (move) |
| Comment | Phase 1 | ✓ | ✓ | - | ✓ | - | Phase 1 (post) |
| Todo | Phase 1 | ✓ | ✓ (assign) | ✓ (complete) | ✓ | - | Phase 3 (complete) |
| Question | Phase 1 | ✓ | - | ✓ (schedule) | - | - | Phase 3 (answer) |
| Question::Answer | Phase 1 | ✓ | - | ✓ | - | - | Phase 3 (post) |
| Message | Phase 1 | ✓ | ✓ (comment) | - | ✓ | - | Phase 3 (comment) |
| Document | Phase 1 | ✓ | ✓ (comment) | - | - | - | Phase 3 (comment) |
| Upload | Phase 1 | ✓ | - | - | - | - | - |

**Phase 1 outbound:** Chat lines (Campfire + Ping), comments on any recording, card creation.
**Phase 3 outbound:** Card moves, todo completion, check-in answers, message/document comments.

---

## Part 6: Multi-Node Distribution

### 6.1 Topology

```
┌───────────────────────────────────────────────────────────────┐
│                 GATEWAY HOST (VPS / Mac mini)                  │
│                                                                │
│  Gateway (ws://127.0.0.1:18789)                               │
│  ├── Basecamp Channel (webhooks + poller)                     │
│  ├── Webhook Channel (HackerOne, Sentry, Help Scout, etc.)   │
│  ├── Session Manager + Agent Router                           │
│                                                                │
│  Agents on host:                                               │
│  ├── router-agent    (Haiku, unsandboxed, instant classify)   │
│  ├── security-agent  (Opus, sandboxed, h1 CLI + creds)       │
│  └── support-agent   (Sonnet, sandboxed, Help Scout MCP)     │
└────────────────────┬──────────────────────────────────────────┘
                     │ WebSocket (Tailscale)
          ┌──────────┼──────────┐
          ▼                     ▼
   ┌──────────────┐     ┌───────────────┐
   │  BUILD NODE  │     │ ANALYSIS NODE │
   │  (Linux VPS) │     │  (Mac mini)   │
   │              │     │               │
   │  bugs-agent  │     │ exceptions-   │
   │  (Sonnet,    │     │   agent       │
   │   sandboxed) │     │ performance-  │
   │              │     │   agent       │
   │  Has:        │     │ (Haiku/Sonnet,│
   │  - App repo  │     │  read-only)   │
   │  - Test suite│     │               │
   │  - Docker    │     │ Has:          │
   └──────────────┘     │ - Sentry MCP  │
                        │ - Grafana MCP │
                        └───────────────┘
```

### 6.2 Node Registration & Agent Binding

```bash
# Build node registers
openclaw node run --host gateway.tailnet --port 18789 --display-name "Build Node"
# Gateway approves
openclaw nodes approve <requestId>
```

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "bugs-agent",
        "node": "build-node",
        "workspace": "/home/deploy/app",
        "sandbox": {
          "mode": "all",
          "scope": "agent",
          "workspaceAccess": "rw",
          "docker": { "image": "ruby:3.3", "network": "restricted" }
        }
      },
      {
        "id": "exceptions-agent",
        "node": "analysis-node",
        "sandbox": {
          "mode": "all",
          "scope": "session",
          "workspaceAccess": "ro",
          "docker": { "network": "none" }
        }
      }
    ]
  }
}
```

### 6.3 Cross-Node Subagent Spawning

Subagents run on parent's node by default. For cross-node work, spawn using an `agentId` bound to the target node:

```
security-agent (Gateway) spawns:
  └── agentId: "code-verifier" → bound to Build Node
      (needs app codebase to verify vulnerability claim)

bugs-agent (Build Node) spawns:
  └── agentId: "sentry-correlator" → bound to Analysis Node
      (needs Sentry MCP for error correlation)
```

---

## Part 7: Automatic Check-In Integration

### 7.1 Agent-Drafted Check-In Answers

```yaml
checkins:
  auto_answer:
    - match: "What did you ship?"
      agent: standup-agent
      sources: [git_log_today, work_ledger_closed, campfire_highlights]
      mode: draft   # Human reviews before posting

    - match: "What are you working on?"
      agent: standup-agent
      sources: [work_ledger_working, active_agent_sessions]

    - match: "Anything blocking you?"
      agent: standup-agent
      sources: [work_ledger_restrained, approval_pending_4h, sla_at_risk]
```

### 7.2 Team Answer Synthesis

After humans answer a check-in, standup-agent synthesizes a combined summary posted to Campfire:

```
"What shipped today?" fires at 4pm → 5 humans answer
standup-agent collects answers + agent activity:
  "Today: [human highlights]. Security queue: 3 reports triaged (2 valid).
   Bugs: 2 resolved, 1 escalated. Support: 12 conversations handled."
```

---

## Part 8: Where the Work Lives

### Decision: External plugin repo + coworker plugin in coworker repo

The Basecamp channel plugin is developed as an **external plugin** owned by your team. It's general-purpose infrastructure (like Slack, Discord, Telegram) that can later be nominated for OpenClaw inclusion. The Coworker-specific agent definitions, skill bindings, and operational config live in the coworker repo's `openclaw-plugin/`.

```
WHERE EACH PIECE LIVES:

basecamp-openclaw-plugin/ (external plugin repo)
├── src/                          Channel adapter implementation
│   ├── channel.ts                ChannelPlugin<BasecampAccount>
│   ├── inbound/                  Polling, webhooks, Action Cable
│   ├── outbound/                 sendText, formatting
│   └── ...
├── openclaw.plugin.json          Plugin manifest + config schema
└── package.json                  NPM package with openclaw.extensions

coworker (this repo)
├── openclaw-plugin/              ← Coworker-specific orchestration
│   ├── openclaw.json             Agent definitions, bindings, tool wrappers
│   ├── agents/                   Per-agent AGENTS.md / SOUL.md
│   ├── tools/                    h1, bcq, sentry-mcp tool configs
│   └── tests/                    Behavioral parity tests
├── skills/                       ← Unchanged: SKILL.md files
└── bin/                          ← Unchanged: h1 CLI, etc.
```

**Why this split:**
- The Basecamp channel is reusable by anyone, not Coworker-specific. Other OpenClaw users could bind their own agents to Basecamp projects.
- External plugin gives your team full ownership during development.
- Coworker config stays in the coworker repo where it's versioned alongside skills.
- `openclaw-plugin/openclaw.json` is a standard OpenClaw config file that references the Basecamp channel plugin.

**Contribution flow:**
1. Develop `basecamp-openclaw-plugin/` independently
2. Work in `coworker/openclaw-plugin/` for agent definitions and bindings
3. When mature, nominate Basecamp channel for upstream inclusion via PR to `openclaw/openclaw`

### Coworker Plugin Structure (in this repo)

```
openclaw-plugin/
├── openclaw.json                 # Main config: agents, bindings, tools, personas
├── metadata.yaml                 # Plugin metadata (exists, update)
├── agents/
│   ├── security-agent/
│   │   ├── AGENTS.md            # Security agent instructions
│   │   └── SOUL.md              # Persona: formal, precise, security-minded
│   ├── bugs-agent/
│   │   ├── AGENTS.md
│   │   └── SOUL.md
│   ├── support-agent/
│   │   ├── AGENTS.md
│   │   └── SOUL.md
│   ├── standup-agent/
│   │   ├── AGENTS.md
│   │   └── SOUL.md
│   └── router-agent/
│       └── AGENTS.md
├── tools/
│   ├── h1.yaml                  # HackerOne CLI tool wrapper
│   ├── bcq.yaml                 # Basecamp CLI tool wrapper
│   ├── sentry-mcp.yaml         # Sentry MCP server config
│   ├── helpscout-mcp.yaml      # Help Scout MCP server config
│   └── grafana-mcp.yaml        # Grafana MCP server config
├── tests/
│   └── parity/                  # Behavioral parity test scenarios
├── demo/                        # (exists) Demo data
└── work/                        # (exists) Development workspace
```

---

## Part 9: Implementation Phases

### Phase 1: Core Channel + Event Fabric Baseline

- Basecamp channel plugin in `basecamp-openclaw-plugin/`
- **Event fabric:** Activity feed polling + Hey! Readings polling + webhook receiver
- Deduplication layer (event_id or recordingId + action + timestamp)
- Plugin manifest + config schema
- Peer model with `recording:<id>` / `bucket:<id>` / `ping:<id>` conventions
- parentPeer for project-level routing
- @mention detection (bc-attachment SGID parsing)
- Markdown → Basecamp HTML formatting
- **Multi-persona:** Support for multiple `channels.basecamp.accounts`, one per persona
- Service account outbound identity (per-account routing for replies)
- Coworker sample `openclaw.json` with agents + bindings

**Validation:** Post to Campfire from Gateway as "Security Bot" persona. Receive card comment via activity feed polling. Route by parentPeer to correct agent. @mention "Bugs Bot" in Campfire → routes to bugs-agent with correct persona.

### Phase 2: Security Domain Agent (First End-to-End)

- `security-agent` definition with Opus model + sandboxing
- `h1` tool wrapper with read-auto/write-approval policies
- Skill loading: SKILL.md mounted in agent workspace
- HackerOne webhook → Gateway → security-agent routing
- Subagent spawning via `sessions_spawn` for analysis
- Chronicle fan-out: git commit + Basecamp card + Campfire narration
- Approval flow: `[PROPOSED]` on card → human moves to "Approved" column or comments `[APPROVED]` → agent executes
- Behavioral parity test harness

**Validation:** HackerOne BugReceived webhook → security-agent triages → posts `[PROPOSED]` to card → human approves → agent executes (dry-run).

### Phase 3: All Domains + All Places + Action Cable + Hatch

- Remaining agents: bugs, support, exceptions, performance, router, standup
- Remaining tool wrappers: bcq, sentry-mcp, helpscout-mcp, grafana-mcp
- **Action Cable** for real-time Campfire + thread updates (ChatChannel, ThreadsChannel)
- Activity feed + Hey! Readings polling continues as baseline
- Direct recordable polls for gap-filling (slower cadence)
- Polling becomes fallback when Action Cable is available
- Todo, check-in, message board, document peer support
- Assignment-driven workflows
- Column-move state machine
- Cross-domain routing via router-agent
- Check-in auto-answering and synthesis
- Approval timeouts + cost guardrails
- **"Hatch Agent" admin flow** for creating new personas on demand

### Phase 4: Multi-Node + Agent Persona + Production

- Node setup (build node, analysis node)
- Agent-to-node binding
- Cross-node subagent spawning
- Docker sandbox per agent
- Basecamp Agent persona (replacing service account)
- Chatbot integration for Campfire
- Production monitoring + SLA tracking
- Graduated dry-run removal
- Operational runbook
- **Upstream nomination** — PR to bundle plugin in `openclaw/openclaw`

---

## Part 10: Key Files

| File | Location | Status | Role |
|------|----------|--------|------|
| `src/index.ts` | basecamp-openclaw-plugin | New | Plugin entry point + registration |
| `src/channel.ts` | basecamp-openclaw-plugin | New | ChannelPlugin implementation |
| `openclaw.plugin.json` | basecamp-openclaw-plugin | New | Plugin manifest + config schema |
| `package.json` | basecamp-openclaw-plugin | New | NPM package with openclaw.extensions |
| `src/inbound/poller.ts` | basecamp-openclaw-plugin | New | Composite event fabric orchestrator |
| `src/inbound/normalize.ts` | basecamp-openclaw-plugin | New | Basecamp event → inbound message |
| `src/inbound/dedup.ts` | basecamp-openclaw-plugin | New | Event deduplication |
| `src/outbound/send.ts` | basecamp-openclaw-plugin | New | sendText via bcq / native API |
| `src/outbound/format.ts` | basecamp-openclaw-plugin | New | Markdown → Basecamp HTML |
| `src/mentions/parse.ts` | basecamp-openclaw-plugin | New | bc-attachment SGID parsing |
| `openclaw-plugin/openclaw.json` | coworker | New | Agent definitions, bindings, tools |
| `openclaw-plugin/metadata.yaml` | coworker | Exists | Update for channel declaration |
| `skills/security-orchestrate/SKILL.md` | coworker | Exists | sessions_spawn orchestration pattern |
| `skills/coworker-chronicle/SKILL.md` | coworker | Exists | Chronicle interface (git + Basecamp) |
| `skills/coworker-restraint/SKILL.md` | coworker | Exists | Safety guardrails |

---

## Part 11: Verification Plan

### Phase 1 Smoke Tests

1. **Install plugin:** `openclaw plugins install ~/Work/basecamp/basecamp-openclaw-plugin` → plugin appears in `openclaw plugins list`
2. **Config validation:** Add `channels.basecamp` to openclaw.yaml → no schema errors
3. **Activity feed poll:** Start gateway → channel polls activity feed → events appear in gateway logs
4. **Outbound post:** Agent sends text → Campfire line appears from service account
5. **Routing:** Card comment in project X → routes to bugs-agent (parentPeer match)
6. **Multi-persona:** @mention "Security Bot" in Campfire → routes to security-agent, not bugs-agent
7. **Dedup:** Same event from activity feed + webhook → processed once

### Parity Tests

10 canonical scenarios per domain, run through both Claude Code (`/security-triage`) and OpenClaw (security-agent session). Compare triage decisions, state markers, chronicle output.
