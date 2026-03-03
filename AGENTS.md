# Basecamp Channel Plugin for OpenClaw

## What This Is

An external OpenClaw channel plugin that integrates Basecamp with OpenClaw's agent framework. Campfire chats, card tables, to-do lists, check-ins, pings, message boards — every Basecamp surface becomes a live interaction point for AI agents.

This plugin is developed independently by the 37signals team and can later be nominated for upstream OpenClaw inclusion.

## Architecture at a Glance

- **Channel type:** `basecamp` — registers via `api.registerChannel()` like any OpenClaw channel
- **Peer model:** All Basecamp places map to OpenClaw's `dm | group` peer kinds using `recording:<id>` / `bucket:<id>` / `ping:<id>` conventions. `parentPeer` enables per-project routing without schema changes.
- **Event fabric:** Composite ingestion from Activity Feed, Hey! Readings, webhooks, direct polls, and (later) Action Cable. Deduplication via per-account sqlite with 24h TTL.
- **Multi-persona:** Multiple Basecamp service accounts per deployment, mapped via `channels.basecamp.personas` (agentId → accountId).
- **Outbound:** Chat lines, comments, card creation via the basecamp CLI (Phase 1), native API later.

## For the Dev Agent

Read `PLAN.md` for the full architecture. It is the authoritative source for all design decisions (Q1-Q20), the peer model, event fabric, routing, multi-persona identity, and implementation phases.

### Key Decisions to Know

- **Config schema lives in code** (`ChannelPlugin.configSchema`), not in `openclaw.plugin.json`. The manifest is minimal.
- **Agent→persona mapping** is in `channels.basecamp.personas`, not in AgentConfig (which external plugins can't extend).
- **Pings:** 1:1 → `dm`, multi-person → `group`. Determined by Circle membership count.
- **Webhooks are accelerators only** — correctness comes from polling. The system must work with webhooks disabled.
- **Phase 1 uses the basecamp CLI** for all Basecamp API access. Native API replaces polling in Phase 2, full native in Phase 3.
- **All recordable types are ingested from Phase 1.** Outbound actions are phased by risk.

### Where to Start (Phase 1)

1. **Scaffold the repo:** `package.json`, `openclaw.plugin.json`, `tsconfig.json`, `src/index.ts`
2. **Channel skeleton:** `src/channel.ts` — implement `ChannelPlugin<BasecampAccount>` with meta, capabilities, config adapter
3. **Config adapter:** `src/config.ts` — parse accounts, virtualAccounts, personas from `channels.basecamp` config
4. **Types:** `src/types.ts` — Basecamp event types, inbound message shape, peer conventions
5. **Event fabric:** `src/inbound/` — activity feed polling, Hey! Readings polling, normalization, dedup
6. **Outbound:** `src/outbound/` — post chat lines and comments via the basecamp CLI
7. **Mentions:** `src/mentions/parse.ts` — bc-attachment SGID parsing

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
  └── Recording (owns thread tree, events, visibility)
        └── Recordable (Chat::Transcript, Chat::Line, Kanban::Card, Message, Todo, Question, etc.)
              └── Child Recordings (comments, lines)
```

- Campfire = `Chat::Transcript` with `Chat::Line` children
- Pings = Circle bucket → `Chat::Transcript`
- Cards = `Kanban::Card` in card tables with columns
- @mentions = `<bc-attachment sgid="...">` in HTML content
- Person identity = `personId` + `attachableSgid`

### Reference: Coworker Context

This plugin powers the Coworker agent system (37signals internal ops). Coworker config lives separately in `~/Work/basecamp/coworker/openclaw-plugin/`. The channel plugin itself is general-purpose — any OpenClaw user could bind agents to Basecamp projects.

Coworker skills (54 SKILL.md files across security, bugs, support, exceptions, performance, audit) inject as system prompts. The channel doesn't know about skills — it just routes events to agents via bindings.

### Testing

Phase 1 smoke tests (from PLAN.md Part 11):
1. Plugin installs and appears in `openclaw plugins list`
2. Config validates without schema errors
3. Activity feed poll returns events
4. Outbound post appears in Campfire
5. parentPeer routing works
6. Multi-persona @mention routing works
7. Dedup collapses duplicate events
