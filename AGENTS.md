# Basecamp Channel Plugin for OpenClaw

## What This Is

An external OpenClaw channel plugin that integrates Basecamp with OpenClaw's agent framework. Campfire chats, card tables, to-do lists, check-ins, pings, message boards -- every Basecamp surface becomes a live interaction point for AI agents.

This plugin is developed independently by the 37signals team and can later be nominated for upstream OpenClaw inclusion.

## Architecture at a Glance

- **Channel type:** `basecamp` -- registers via `api.registerChannel()` like any OpenClaw channel
- **Peer model:** All Basecamp places map to OpenClaw's `dm | group` peer kinds using `recording:<id>` / `bucket:<id>` / `ping:<id>` conventions. `parentPeer` enables per-project routing without schema changes.
- **Event fabric:** Composite ingestion from five sources -- Activity Feed, Hey! Readings, Assignments, Webhooks, and a Safety-Net reconciliation pass. SQLite-backed dedup with 24h TTL and cross-source secondary keys ensures exactly-once delivery.
- **Multi-persona:** Multiple Basecamp service accounts per deployment, mapped via `channels.basecamp.personas` (agentId -> accountId).
- **Outbound:** Chat lines, comments, card creation, and media via `@37signals/basecamp` SDK.
- **Auth:** OAuth browser-based login with automatic token refresh. Onboarding imports credentials from the Basecamp CLI if available.
- **Resilience:** Per-source circuit breakers on polling, exponential backoff retry on outbound sends, graceful shutdown with webhook deactivation and state flush.
- **Agent tools:** 10 channel-specific tools (create/complete/reopen todos, boost, move cards, post messages, answer check-ins, read history, generic API read/write).

## Source Layout

```
index.ts                    Plugin entry point: registers channel, webhook route, agent prompt hook
src/channel.ts              ChannelPlugin wiring -- all adapters composed here
src/config.ts               Zod config schema, account resolution, project scoping
src/types.ts                Basecamp event types, inbound message shape, peer conventions
src/basecamp-client.ts      @37signals/basecamp SDK client factory
src/oauth-credentials.ts    OAuth token management, interactive login, refresh
src/circuit-breaker.ts      Generic circuit breaker (used by poller sources)
src/dispatch.ts             Engagement gating, DM policy, agent routing
src/runtime.ts              OpenClaw runtime handle
src/metrics.ts              Structured event logging
src/retry.ts                Exponential backoff retry
src/util.ts                 Shared utilities (withTimeout, etc.)

src/adapters/               SDK adapter implementations
  status.ts                 Account health probes and audit
  directory.ts              People lookup and resolution
  messaging.ts              Inbound message normalization
  agent-tools.ts            10 Basecamp-specific agent tools
  agent-prompt.ts           Prompt context injection
  actions.ts                Message-level actions (send, react, etc.)
  outbound.ts               Target resolution and text chunking
  mentions.ts               @mention resolution
  groups.ts                 Group/channel metadata
  heartbeat.ts              Polling liveness
  security.ts               Sender verification
  pairing.ts                Account pairing flow
  setup.ts                  First-run setup
  onboarding.ts             Interactive onboarding with CLI credential import
  hatch.ts                  Account creation
  resolver.ts               Peer/message ID resolution

src/inbound/                Event fabric
  poller.ts                 Composite poller orchestrator (activity + readings + assignments + safety-net)
  activity.ts               Activity feed polling
  readings.ts               Hey! Readings polling
  assignments.ts            Assignment event polling
  safety-net.ts             Reconciliation safety net (catches missed events)
  reconciliation.ts         Webhook reconciliation pass
  webhooks.ts               Webhook HTTP handler + HMAC verification
  webhook-lifecycle.ts      Webhook registration/deactivation lifecycle
  webhook-secrets.ts        Per-project HMAC secret storage
  normalize.ts              Raw Basecamp events -> BasecampInboundMessage
  dedup.ts                  In-memory dedup engine with 24h TTL
  dedup-store.ts            Dedup persistence interface
  dedup-store-sqlite.ts     SQLite-backed dedup persistence (WAL mode)
  dedup-registry.ts         Per-account singleton dedup instances
  cursors.ts                Polling cursor persistence
  dock-cache.ts             Project dock structure cache
  state-dir.ts              Plugin state directory resolution

src/outbound/               Message sending
  send.ts                   Send chat lines, comments, media via Basecamp SDK
  format.ts                 HTML/Markdown formatting

src/hooks/                  Agent prompt context
  agent-prompt-context.ts   Surface-aware prompt injection (Campfire vs Cards vs Todos etc.)

src/mentions/               bc-attachment SGID parsing
  parse.ts                  Extract person IDs from Basecamp HTML @mentions

tests/                      1127+ tests across 65 files
```

## For the Dev Agent

Read `PLAN.md` for the full architecture. It is the authoritative source for all design decisions (Q1-Q20), the peer model, event fabric, routing, multi-persona identity, and implementation phases.

### Key Decisions to Know

- **Config schema lives in code** (`ChannelPlugin.configSchema`), not in `openclaw.plugin.json`. The manifest is minimal.
- **Agent->persona mapping** is in `channels.basecamp.personas`, not in AgentConfig (which external plugins can't extend).
- **Pings:** 1:1 -> `dm`, multi-person -> `group`. Determined by Circle membership count.
- **Webhooks are accelerators only** -- correctness comes from polling. The system must work with webhooks disabled.
- **All recordable types are ingested.** The composite poller covers activity, readings, assignments, and a safety-net pass for anything missed.
- **Native API access** via `@37signals/basecamp` SDK (pinned to a specific commit SHA). No CLI dependency at runtime.

### Reference: OpenClaw Plugin API

External plugins register via:
```typescript
export default {
  id: "basecamp",
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: basecampChannel });
  },
};
```

The `ChannelPlugin` interface includes adapters for: meta, config, capabilities, security, gateway, outbound, mentions, messaging, threading, directory, actions, streaming, heartbeat, and more. See `openclaw/plugin-sdk` for types.

Study existing channel plugins (telegram, slack, discord) in `~/Work/openclaw/openclaw/extensions/` for patterns.

### Reference: Basecamp Domain Model

```
Bucket (Project/Circle)
  +-- Recording (owns thread tree, events, visibility)
        +-- Recordable (Chat::Transcript, Chat::Line, Kanban::Card, Message, Todo, Question, etc.)
              +-- Child Recordings (comments, lines)
```

- Campfire = `Chat::Transcript` with `Chat::Line` children
- Pings = Circle bucket -> `Chat::Transcript`
- Cards = `Kanban::Card` in card tables with columns
- @mentions = `<bc-attachment sgid="...">` in HTML content
- Person identity = `personId` + `attachableSgid`

### Reference: Coworker Context

This plugin powers the Coworker agent system (37signals internal ops). Coworker config lives separately in `~/Work/basecamp/coworker/openclaw-plugin/`. The channel plugin itself is general-purpose -- any OpenClaw user could bind agents to Basecamp projects.

Coworker skills (54 SKILL.md files across security, bugs, support, exceptions, performance, audit) inject as system prompts. The channel doesn't know about skills -- it just routes events to agents via bindings.

### Testing

Run `npm test` -- 1127+ tests across 65 files with >85% coverage thresholds. Run `npm run typecheck` for zero-error TypeScript checking.
