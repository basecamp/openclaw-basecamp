# Basecamp Channel Plugin for OpenClaw

## What This Is

An external OpenClaw channel plugin that integrates Basecamp with OpenClaw's agent framework. Campfire chats, card tables, to-do lists, check-ins, pings, message boards -- every Basecamp surface becomes a live interaction point for AI agents.

This plugin is developed independently by the 37signals team and can later be nominated for upstream OpenClaw inclusion (see `docs/upgrades/official-catalog-nomination.md`). It targets OpenClaw >= 2026.8.1 (`peerDependencies`, `openclaw.compat.pluginApi`).

## Architecture at a Glance

- **Plugin id / channel id:** both `basecamp` (the npm package is `@37signals/openclaw-basecamp`). Entry is `defineChannelPluginEntry` in `index.ts`; a second import-light entry, `setup-entry.ts`, serves read-only status, channel listings, and SecretRef scans without the runtime.
- **Peer model:** All Basecamp places map to OpenClaw's `dm | group` peer kinds using `recording:<id>` / `bucket:<id>` / `ping:<id>` conventions. Project-level routing comes from `messaging.resolveSessionConversation` (recording -> parent bucket via the recording index) plus the `bindings` adapter, so a binding on `bucket:<id>` matches every recording inside it.
- **Event fabric:** Composite ingestion from five sources -- Activity Feed, Hey! Readings, Assignments, Webhooks, and a Safety-Net reconciliation pass. A plugin-owned replay guard on `openclaw/plugin-sdk/persistent-dedupe` (claim -> dispatch -> commit, multi-key, per-account namespace, 24h TTL) gives exactly-once delivery.
- **Inbound turns:** `dispatch.ts` runs each event through the channel turn kernel (`runtime.channel.inbound.run`) with the SDK ingress resolver handling DM policy, pairing, access groups, and per-bucket allowFrom; the plugin owns the `engage` gate and self/echo filtering. Pairing codes are delivered by Ping.
- **Multi-persona:** Multiple Basecamp service accounts per deployment, mapped via `channels.basecamp.personas` (agentId -> accountId).
- **Outbound:** `createChatChannelPlugin` outbound slot with real `sendText`/`sendMedia`; targets `recording:<id>`, `bucket:<id>` (default Campfire), `bucket:<b>/recording:<r>` (cold send), `ping:<id>`; presentation blocks rendered to Basecamp HTML (tables, dividers, headings accepted; buttons/selects/charts degrade to text).
- **Auth:** OAuth browser-based login with automatic token refresh; tokens under `<stateDir>/plugins/basecamp/tokens/`. Onboarding imports credentials from the Basecamp CLI if available. Secret-bearing config fields accept SecretRefs.
- **Resilience:** Per-source circuit breakers on polling (surfaced as `lifecycle: "recovering"`), exponential backoff retry on outbound sends, bounded webhook in-flight limiter, graceful shutdown with webhook deactivation and state flush.
- **Agent tools:** 10 channel-specific tools (create/complete/reopen todos, boost, move cards, post messages, answer check-ins, read history, generic API read/write). Registered via `api.registerTool` factories in `registerFull`, declared in the manifest's `contracts.tools`, and executed under the persona account resolved from `ctx.agentId`.

## Source Layout

```
index.ts                    Runtime entry: defineChannelPluginEntry (webhook route, gateway_stop flush, tools)
setup-entry.ts              Import-light entry: defineSetupPluginEntry (package.json openclaw.setupEntry)
doctor-contract-api.ts      Re-export shim for the doctor contract sidecar
src/channel.ts              createChatChannelPlugin composition -- all adapters wired here
src/channel-setup.ts        Import-light subset: meta, capabilities, config schema/adapter, setup contract, secrets
src/config.ts               Zod config schema (SDK account parts + SecretRefs), account resolution, project scoping
src/config-schema.ts        Re-export of BasecampConfigSchema
src/types.ts                Basecamp event types, inbound message shape, peer conventions
src/sdk-types.ts            Adapter types derived from ChannelPlugin (no typed subpath of their own)
src/basecamp-client.ts      @37signals/basecamp SDK client factory
src/basecamp-cli.ts         Basecamp CLI wrapper for auth/credential import (setup only)
src/oauth-credentials.ts    OAuth token management, interactive login, refresh
src/oauth-lite.ts           Import-light OAuth helpers shared with the setup-entry graph
src/doctor-contract-api.ts  Doctor contract (config repair rules) -- import-light
src/circuit-breaker.ts      Generic circuit breaker (used by poller sources)
src/dispatch.ts             Turn kernel adapter: engage gate, ingress resolver, context build, reply delivery
src/runtime.ts              OpenClaw runtime store (createPluginRuntimeStore)
src/logging.ts              Structured logging via the runtime child logger (console fallback)
src/metrics.ts              Structured event logging + per-account metrics
src/retry.ts                Exponential backoff retry
src/util.ts                 Shared utilities (withTimeout, etc.)

src/adapters/               SDK adapter implementations
  status.ts                 Account probes/audit, lifecycle + ingressUnavailable + lastTransportActivityAt
  doctor.ts                 Doctor adapter: legacy config rules, preview warnings, repairConfig
  lifecycle.ts              onAccountConfigChanged / onAccountRemoved / startup maintenance
  directory.ts              People lookup and resolution
  messaging.ts              Target prefixes, chat-type inference, resolveSessionConversation, session routes
  agent-tools.ts            10 Basecamp-specific agent tools (api.registerTool factory, persona via ctx.agentId)
  agent-prompt.ts           Channel-specific prompt hints (peer ids, mentions, surfaces, reactions)
  actions.ts                Message-level actions (send, react, etc.)
  outbound.ts               Target grammar parsing and chunk limit
  mentions.ts               @mention resolution
  groups.ts                 Per-bucket tool policy and requireMention
  heartbeat.ts              Polling liveness
  security.ts               Scoped DM policy resolver + security audit findings
  pairing.ts                Text pairing adapter; Ping delivery of approvals
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
  webhooks.ts               Webhook HTTP handler, HMAC/token verification, in-flight limiter
  webhook-lifecycle.ts      Webhook registration/deactivation lifecycle
  webhook-secrets.ts        Per-project HMAC secret storage
  normalize.ts              Raw Basecamp events -> BasecampInboundMessage
  replay-guard.ts           Exactly-once claim/commit on persistent-dedupe (24h TTL, per-account)
  recording-index.ts        recording -> { bucketId, recordableType } index (outbound targets, bindings)
  cursors.ts                Polling cursor persistence (json-store)
  dock-cache.ts             Project dock structure cache
  state-dir.ts              Plugin state directory (<stateDir>/plugins/basecamp)

src/tools/
  catalog.ts                Canonical basecamp_* tool names + toolMetadata (import-free; feeds the manifest)

src/outbound/               Message sending
  send.ts                   Target resolution, chat lines, comments, media via Basecamp SDK
  format.ts                 HTML/Markdown formatting
  presentation.ts           Presentation capabilities + MessagePresentation -> Markdown

src/mentions/               bc-attachment SGID parsing
  parse.ts                  Extract person IDs from Basecamp HTML @mentions

scripts/generate-manifest.ts  Emits openclaw.plugin.json (channelConfigs, contracts.tools) from code
scripts/verify-pack.sh        Asserts the npm pack ships manifest + both entries

tests/                      1416 tests across 78 files
```

## For the Dev Agent

Read `PLAN.md` for the full architecture. It is the authoritative source for all design decisions (Q1-Q24), the peer model, event fabric, routing, multi-persona identity, and implementation phases. `docs/upgrades/openclaw-2.0-spec.md` records the 2.0 migration decisions section by section.

### Key Decisions to Know

- **Config schema lives in code and is projected into the manifest.** `src/config.ts` is the source; `ChannelPlugin.configSchema` wraps it and `npm run manifest:gen` writes the same schema + uiHints into `openclaw.plugin.json#channelConfigs`. `tests/manifest-contract.test.ts` fails when the checked-in manifest drifts. Never hand-edit the manifest.
- **Agent->persona mapping** is in `channels.basecamp.personas`, not in AgentConfig (which external plugins can't extend).
- **Pings:** 1:1 -> `dm`, multi-person -> `group`. Determined by Circle membership count.
- **Webhooks are accelerators only** -- correctness comes from polling. The system must work with webhooks disabled.
- **All recordable types are ingested.** The composite poller covers activity, readings, assignments, and a safety-net pass for anything missed.
- **Host durable ingress and keyed stores are trust-gated** to bundled/official-catalog plugins; state is plugin-owned JSON under `<stateDir>/plugins/basecamp/` (in `backupResources`), and dedup rides on the ungated `persistent-dedupe`.
- **Native API access** via `@37signals/basecamp` SDK. No CLI dependency at runtime.
- **Import discipline:** only `openclaw/plugin-sdk/<subpath>` imports (the root barrel, `channel-runtime`, and `plugin-sdk/zod` are gone). `src/channel-setup.ts` and anything it imports must stay off the heavy graph (`tests/setup-entry-imports.test.ts`).

### Reference: OpenClaw Plugin API

External plugins register via:
```typescript
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

export default defineChannelPluginEntry({
  id: "basecamp",
  name: "Basecamp",
  description: "...",
  plugin: basecampChannel,
  setRuntime: setBasecampRuntime,
  registerFull(api) {
    api.registerHttpRoute({ path: "/webhooks/basecamp", auth: "plugin", handler });
    api.on("gateway_stop", flush);
  },
});
```

`ChannelPlugin` and the adapter types come from `openclaw/plugin-sdk/channel-core` and `openclaw/plugin-sdk/channel-contract`; `OpenClawConfig` from `openclaw/plugin-sdk/config-contracts`. The subpath map is `node_modules/openclaw/docs/plugins/sdk-subpaths.md`; the channel walkthrough is `node_modules/openclaw/docs/plugins/sdk-channel-plugins.md`.

For patterns, study the shipped Telegram shims in `node_modules/openclaw/dist/extensions/telegram` and the bundled channels in `~/Work/openclaw/openclaw/extensions/` (telegram, slack, discord).

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

- `npm run check` -- typecheck + lint + tests (what CI runs).
- `npm test` -- 1416 tests across 78 files; `npx vitest run --coverage` enforces >85% coverage thresholds.
- `npm run typecheck` -- zero-error TypeScript.
- `npm run manifest:gen` -- regenerate `openclaw.plugin.json` after touching the config schema, uiHints, or tool names; the manifest contract test fails otherwise.
- `bash scripts/verify-pack.sh` -- confirms the pack ships `openclaw.plugin.json`, `dist/index.js`, and `dist/setup-entry.js`.
- CI also runs a pack-install smoke on Node 22 and 24: `npm pack` -> `openclaw plugins install npm-pack:<tgz> --force --accept-capabilities` -> `openclaw plugins inspect basecamp --runtime --json`.
