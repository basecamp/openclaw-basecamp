# OpenClaw 2.0 (2026.8.1) migration + adoption spec — Basecamp channel plugin

Repo: `/Users/jeremy/Worktrees/f836f2c7-0312-4f97-a96d-ad2164c9f170/adjoining-zucchini` (W). Tarballs: `OLD`=2026.7.1, `NEW`=2026.8.1, `BETA`=2026.9.1-beta.1 under the scratchpad `pkgs/` dir.
Legend: **V** verified against `.d.ts`/docs/compiled JS by a researcher or verifier (conflicts resolved in favour of the cited evidence; a few load-bearing items re-read by the synthesizer); **I** inferred; **D** = decision made by the synthesizer (routine call, stated so it can be overridden).

## 0. Ground truths that shape everything

| # | Fact | Consequence | Status |
|---|---|---|---|
| G1 | Root barrel `openclaw/plugin-sdk`, `plugin-sdk/channel-runtime`, `plugin-sdk/zod` are gone from NEW `exports`. 17 src files (18 statements) import the root; 8 import `channel-runtime`; `src/config.ts:3` imports `zod`. 21 test files reference them (20 root `vi.mock`s + 2 `channel-runtime` mocks). | Nothing compiles/loads until §1 is done. | V |
| G2 | `api.on("before_agent_start")` (`index.ts:29`) — hook removed from `PluginHookName`/`PluginHookHandlerMap` in NEW (`channel-core-DmnMLBXB.d.ts:1646-1700`; `hook-runner-global-CM7gDpaY.d.ts:577`). | Compile error + surface prompt silently never fires. | V |
| G3 | `runtime.config.loadConfig()` removed (`agent-harness-runtime-Dve5eW1E.d.ts:15239-15256` has `current`, `mutateConfigFile`, `replaceConfigFile`). Used at `src/dispatch.ts:72`, `src/inbound/webhooks.ts:231`. | Runtime crash on first event. | V |
| G4 | `ChannelGroupAdapter.resolveGroupIntroHint` removed (OLD `types.adapters-sK5EFxPJ.d.ts:181-185` → NEW `types.adapters-BPSGfW3j.d.ts:244-247`); set at `src/adapters/groups.ts:60-63`. OLD core never called it (0 JS consumers). | Excess-property type error; deleting loses nothing. | V |
| G5 | `MsgContext.UntrustedContext` (`src/dispatch.ts:212-213`) is `@deprecated`, `removeAfter: "2026-09-08"` → `ChannelPromptContext` / `ChannelStructuredContext` (`installed-plugin-index-eRMeMKev.js:850-866`, `inbound-context-CdbdjY1W.js:29-30`). | 8 days from today; must rename. | V |
| G6 | `ChannelPlugin.setup` is `@deprecated` → `setupContract` (`types.plugin-JXSukMIu.d.ts:42-46`). `ChannelSetupInput` envelope narrowed to `name,token,tokenFile,useEnv,defaultTo,allowFrom` (+ deprecated tier). | `src/adapters/setup.ts` still compiles but is legacy; all-in = `defineChannelSetupContract`. | V |
| G7 | **Trust gate**: `api.runtime.state.{openKeyedStore,openSyncKeyedStore,openBlobStore,openChannelIngressQueue,openChannelIngressDrain}` throw unless `record.origin === "bundled" \|\| trustedOfficialInstall` (`loader-DLF0KUIe.js:4835-4899`); trusted = package present in openclaw's *bundled* official external catalog (`manifest-registry-7OpYeIgh.js:458-474`; catalog `official-external-plugin-bundled-catalogs-7QIXEfNP.js`: 140 entries, all `@openclaw/*` + 3 Tencent partner packages). Install overrides do not confer trust (`install-overrides.md:52-54`). | **Durable ingress queue/monitor and keyed stores are NOT adoptable** by `@37signals/openclaw-basecamp` under any install path in 2026.8.1. `persistent-dedupe` / `ingress-effect-once` bypass the gate (they call `createPluginStateSyncKeyedStore` directly, `plugin-state-store-CUzhevT9.js:1025-1036,1163-1171`, no trust lookup) and are typed public subpaths → usable. `resolveStateDir` is ungated. | V |
| G8 | ~173 of 321 `plugin-sdk/*` exports are JS-only (no `types` condition, no `.d.ts`); `sdk-subpaths.md:9-40` labels them private-local for separately published *official* plugins. Includes `channel-config-ui-hints`, `runtime-doctor-migrations`, `doctor-repair-runtime`, `channel-join-intro-runtime`, `plugin-state-store-runtime`, `channel-mention-gating`, `channel-route`, `heartbeat-runtime`, `retry-runtime`, `fetch-runtime`, `access-groups`, `thread-bindings-runtime`, `reply-reference`, `outbound-media`, `poll-runtime`. | Under `strict: true` these are TS7016. Only typed subpaths are adopted below. | V |
| G9 | BETA (2026.9.1-beta.1) was cut from main *before* 2026.8.1 final: `schemaVersions {state:12,agent:17}` vs NEW `{15,19}`; docs are a strict subset; exports = NEW minus `browser-cdp`, `channel-join-intro-runtime`, `diagnostic-flags`, `gateway-config-runtime`; types identical except `ChannelSecurityDmPolicy.classifyEntryAuthentication`, action `"conversation-open"`, `ChannelSetupAdapter.configPromotion`, `PluginHookRegistrationOptions.eligibleDispatchKinds` absent. | Target 2026.8.1. Treat those five surfaces as unstable; don't adopt. The dated deprecation gates in NEW `compatibility.md`/`sdk-migration.md` are the real roadmap. | V |
| G10 | Typing pins: openclaw depends on `zod@4.4.3` and `typebox@1.3.16` (renamed package; `AnyAgentTool`/`ChannelAgentTool` parameter schemas are `typebox` 1.x `TSchema`, `types-BK7bELXN.d.ts:48`). Runtime zod inside openclaw is bundled; only types reference the `zod` package (36 `.d.ts`, 0 `.js`). | Plugin adds `zod@4.4.3` (exact) and switches `@sinclair/typebox@^0.34` → `typebox@1.3.16`. | V |
| G11 | Telegram in `NEW/dist/extensions/telegram` is shim files importing hashed chunks; useful for *shape* (manifest, setup-entry, sidecars, `createChatChannelPlugin` call at `channel-DyARihQ8.js:1425-1866`), useless for import paths/typing. The documented external skeleton is `sdk-channel-plugins.md:790-1244` (`acme-chat`). | Follow the docs' external shape, not `defineBundledChannelEntry`. | V |
| G12 | `registerChannel(registration: OpenClawPluginChannelRegistration \| ChannelPlugin)` where the registration plugin is `ChannelPlugin<any, unknown, unknown>`; under `strictFunctionTypes` our `ChannelPlugin<ResolvedBasecampAccount, BasecampProbe, BasecampAudit>` is not assignable (probe/audit params contravariant). `defineChannelPluginEntry<TPlugin>` is generic over the plugin type. | Cast likely disappears with `defineChannelPluginEntry`; confirm with typecheck (I). | V/I |

---

## 1. Hard breaks — file-by-file

### 1.1 Import rewrites (src)

Canonical homes (V, by export-line sweep across all 148 typed NEW entrypoints; identical in BETA):

| Symbol | New subpath |
|---|---|
| `OpenClawPluginApi`, `PluginRuntime`, `ChannelPlugin`, `defineChannelPluginEntry`, `defineSetupPluginEntry`, `createChatChannelPlugin`, `createChannelPluginBase`, `createChannelConfigUiHints`, `buildChannelOutboundSessionRoute`, `buildChannelConfigSchema`(alt), `tryReadSecretFileSync`, `stripChannelTargetPrefix` | `openclaw/plugin-sdk/channel-core` |
| `OpenClawConfig`, `DmPolicy`, `MarkdownTableMode` | `openclaw/plugin-sdk/config-contracts` |
| `ChannelMessageActionAdapter/Context/Name`, `ChannelAgentTool`, `ChannelAccountSnapshot`, `ChannelDirectoryAdapter`, `ChannelDirectoryEntry`, `ChannelGroupContext`, `ChannelResolveResult`, `ChannelStatusAdapter`, `ChannelToolSend`, `ChannelMeta`, `ChannelOutboundAdapter`, `ChannelGatewayContext`, `ChannelCapabilities` | `openclaw/plugin-sdk/channel-contract` |
| `ChannelMessagingAdapter` | `openclaw/plugin-sdk/core` (only public home) |
| `ChannelSetupAdapter`, `ChannelSetupInput`, `ChannelSetupWizard`, `ChannelSetupDmPolicy`, `defineChannelSetupContract`, `createOptionalChannelSetupAdapter` | `openclaw/plugin-sdk/channel-setup` |
| `ChannelPairingAdapter`, `createTextPairingAdapter`, `createPairingPrefixStripper` | `openclaw/plugin-sdk/channel-pairing` (`createTextPairingAdapter` at `channel-pairing.d.ts:84-91`) |
| `createPluginRuntimeStore` (+ `PluginRuntime` re-export) | `openclaw/plugin-sdk/runtime-store` |
| `OutboundDeliveryResult`, `createAttachedChannelResultAdapter` | `openclaw/plugin-sdk/channel-send-result` |
| `emptyPluginConfigSchema`, `definePluginEntry` | `openclaw/plugin-sdk/plugin-entry` (NOT `channel-core`) — but see §1.4: we stop using it |
| **Not exported by any typed subpath**: `ChannelGroupAdapter`, `ChannelHeartbeatAdapter`, `ChannelMentionAdapter`, `ChannelResolverAdapter`, `ChannelSecurityAdapter`, `ChannelSecurityDmPolicy`, `ChannelAgentPromptAdapter`, `ChannelOwnedSetupContract`, `SecurityAuditFinding` | derive: `NonNullable<ChannelPlugin<ResolvedBasecampAccount, BasecampProbe, BasecampAudit>["groups"]>` etc.; `ReturnType<typeof defineChannelSetupContract>` — consolidate in new `src/sdk-types.ts` (D) |
| `z` | `import { z } from "zod"` |
| Unchanged subpaths (still valid in NEW/BETA): `account-id`, `setup`, `tool-send`, `param-readers`, `core`, `channel-status`, `channel-setup`, `channel-config-schema` | keep |

Per-file (V):

| File | Old | New |
|---|---|---|
| `index.ts:1-2` | `OpenClawPluginApi`, `emptyPluginConfigSchema` from root | replaced wholesale by `defineChannelPluginEntry` from `channel-core` (§1.4) |
| `src/runtime.ts:1` | `PluginRuntime` from root | `import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store"` (§1.5) |
| `src/channel.ts:1` | `ChannelPlugin` from root | `channel-core` |
| `src/config.ts:1,3` | `OpenClawConfig` root; `z` from `plugin-sdk/zod` | `config-contracts`; `"zod"` |
| `src/dispatch.ts:14`, `src/inbound/poller.ts:20`, `src/adapters/{hatch:18,mentions:11,onboarding:11,pairing:9,security:8,directory:9,agent-prompt:10,setup:8,status:13}.ts` | `OpenClawConfig` root | `config-contracts` |
| `src/adapters/actions.ts:11-17` | `ChannelMessageActionAdapter/Context/Name` root | `channel-contract` (`readStringParam`/`ChannelToolSend` unchanged) |
| `src/adapters/agent-prompt.ts:10` | `ChannelPlugin`, `OpenClawConfig` root | `channel-core`, `config-contracts` |
| `src/adapters/agent-tools.ts:26` | `ChannelAgentTool` root | `channel-contract` |
| `src/adapters/directory.ts:10` | `ChannelDirectoryAdapter/Entry` from `channel-runtime` | `channel-contract` |
| `src/adapters/groups.ts:8` | `ChannelGroupAdapter/Context` from `channel-runtime` | `ChannelGroupContext` from `channel-contract`; adapter type derived; **delete `resolveGroupIntroHint` (L60-63)** |
| `src/adapters/heartbeat.ts:10`, `mentions.ts:12`, `resolver.ts:10` | adapter types from `channel-runtime` | derived types (`ChannelResolveResult` from `channel-contract`) |
| `src/adapters/messaging.ts:8` | `ChannelMessagingAdapter` from `channel-runtime` | `core` (or derived) |
| `src/adapters/pairing.ts:10` | `ChannelPairingAdapter` from `channel-runtime` | `channel-pairing` (or replace whole adapter with `createTextPairingAdapter` / `createChatChannelPlugin({pairing:{text}})`) |
| `src/adapters/status.ts:13,15` | `ChannelAccountSnapshot` root, `ChannelStatusAdapter` `channel-runtime` | both `channel-contract` |
| `src/adapters/setup.ts:8` | `ChannelSetupAdapter/Input` root | `channel-setup` — then file is deleted in WP2 |
| `src/adapters/onboarding.ts:13-14` | already `channel-setup`/`setup` | unchanged (`DmPolicy` may move to `config-contracts`) |

### 1.2 Contract/field changes that bite (V)

| Site | Change |
|---|---|
| `src/adapters/groups.ts:60-63` | delete `resolveGroupIntroHint` |
| `src/dispatch.ts:72`, `src/inbound/webhooks.ts:231` | `loadConfig()` → thread `ctx.cfg` from `gateway.startAccount` into the poller/dispatch (`DispatchOptions.cfg`); webhook handler uses `getBasecampRuntime().config.current()` (returns `DeepReadonly<OpenClawConfig>` — widen signatures or cast at the boundary) |
| `src/dispatch.ts:212-213`, `:434-445` | `UntrustedContext` → `ChannelPromptContext` (string[]) — superseded entirely by §2.2 |
| `index.ts:29-35` | delete `before_agent_start` hook (§1.4, §2.2) |
| `src/channel.ts:250-258` outbound results | `{channel, messageId}` still valid; add `target: {kind:"conversation", id}`; never return `{ok:false}` (`ChannelSendRawResult` deprecated, `channel-send-result.d.ts:7-19`); failures throw |
| `src/adapters/actions.ts:47` | `describeMessageTool` return still valid; add `capabilities: ["presentation"]` in §3 |
| `src/config.ts:16-27, 50-60` | schema must move to `zod` package v4; `buildChannelConfigSchema(schema: ZodTypeAny, {uiHints?, jsonSchemaMode?})` |
| `src/adapters/agent-tools.ts:24-25` | `@sinclair/typebox` → `typebox` 1.3.16 (`Type.Object` API is compatible for the shapes used, I) |

### 1.3 Manifest / package changes (hard-ish: needed to load cleanly and pass consent)

`openclaw.plugin.json` (loader rules `manifest-d6d9sGsO.js:1338-1622`, V):

```json5
{
  "id": "basecamp",                       // §8 Q1 — rename from "openclaw-basecamp" (recommended)
  "name": "Basecamp", "description": "...", "version": "0.1.0",
  "icon": "https://cdn.simpleicons.org/basecamp",
  "channels": ["basecamp"],
  "activation": { "onStartup": false, "onChannels": ["basecamp"] },   // D: lazy; plugin loads once channels.basecamp configured; routes 503 Retry-After:1 until ready — Basecamp webhooks retry and are accelerators only
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} },  // plugins.entries.<id>.config — we have none; channel schema goes in channelConfigs
  "contracts": { "tools": ["basecamp_create_todo", "basecamp_complete_todo", "basecamp_reopen_todo", "basecamp_read_history", "basecamp_add_boost", "basecamp_move_card", "basecamp_post_message", "basecamp_answer_checkin", "basecamp_api_read", "basecamp_api_write"] },
  "toolMetadata": { "basecamp_read_history": {"replaySafe": true}, "basecamp_api_read": {"replaySafe": true}, /* 8 mutating tools */ "basecamp_post_message": {"sideEffecting": true}, "...": {} },
  "doctorContract": { "configRepair": true },        // only if WP2 ships doctor adapter + doctor-contract-api export
  "backupResources": [{ "disposition": "include", "scope": "state", "relativePath": "plugins/basecamp" }],
  "channelConfigs": { "basecamp": {
      "label": "Basecamp", "description": "...",
      "commands": { "nativeCommandsAutoEnabled": false, "nativeSkillsAutoEnabled": false },
      "schema": { /* GENERATED from BasecampConfigSchema via buildChannelConfigSchema(...).schema */ },
      "uiHints": { /* GENERATED: createChannelConfigUiHints({channelLabel:"Basecamp", dmPolicy:{channelKey:"basecamp"}}) + Basecamp-specific hints */ }
  } }
}
```
Missing `channelConfigs` currently produces `warn: channel plugin manifest declares basecamp without channelConfigs metadata` for every non-bundled plugin (`manifest-registry-7OpYeIgh.js:390-406`, V). `contracts.tools` is *required* only for `api.registerTool` (`loader-DLF0KUIe.js:3993-4010`) — which §2.9 adopts — and is what the capability-consent review shows (`capability-summary-CbIbMfvp.js:99`).

`package.json` (V):

| Field | Value | Why |
|---|---|---|
| `engines.node` | `">=22.22.3 <23 \|\| >=24.15.0 <25 \|\| >=25.9.0"` | host string (unchanged across OLD/NEW/BETA); pre-existing drift |
| `peerDependencies.openclaw` | `">=2026.8.1"` | `dependency-resolution.md:137-143` — managed installs relink `node_modules/openclaw` for packages declaring the peer |
| `devDependencies.openclaw` | `"2026.8.1"` | typecheck/tests |
| `dependencies.zod` | `"4.4.3"` exact | G10 |
| `dependencies.typebox` | `"1.3.16"` (remove `@sinclair/typebox`) | G10 |
| `openclaw.compat.pluginApi` | `">=2026.8.1"` | enforced at npm install + discovery (`install-managed-npm-state-CQltXPJU.js:952-961`, `discovery-DUKpMd1M.js:771`) |
| `openclaw.build` | `{ "openclawVersion": "2026.8.1", "pluginSdkVersion": "2026.8.1" }` | ClawHub publish prerequisite; cheap |
| `openclaw.install.minHostVersion` | `">=2026.8.1"` | enforced at install and registry load |
| `openclaw.setupEntry` | `"./dist/setup-entry.js"` | read-only status/channels-list/SecretRef scans without loading runtime (`manifest.md:1385`) |
| `openclaw.channel` | add `detailLabel`, `systemImage: "building.2"`, `markdownCapable: true`, `commands: {nativeCommandsAutoEnabled:false, nativeSkillsAutoEnabled:false}`, `aliases: ["bc"]`, `setup.fields[]` (mirror of `defineChannelSetupContract` fields, §2.6), `doctorCapabilities: { dmAllowFromMode: "topOnly", groupModel: "route" }` | drives `openclaw channels add basecamp --help` without runtime; doctor dmPolicy/allowFrom checks |
| `files` | keep `dist/`, `openclaw.plugin.json` | manifest must be at package root |
| `scripts` | add `manifest:gen` (emit `channelConfigs` from schema) | contract test asserts checked-in manifest == generated |

Do NOT add `runtimeExtensions` (source `index.ts` is not shipped), `setupFeatures.configPromotion` (unless promotion keys declared), `setupFeatures.legacyStateMigrations` (deprecated), `configContracts.*` (paths are relative to `plugins.entries.<id>.config`, cannot reach `channels.basecamp`).

### 1.4 Entry (`index.ts`) → `defineChannelPluginEntry` (V; impl `core-BtT7fqGk.js`)

```ts
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
export default defineChannelPluginEntry({
  id: "basecamp", name: "Basecamp", description: "…",        // name+description REQUIRED (agent-harness-runtime-Dve5eW1E.d.ts:18790-18800)
  plugin: basecampChannel,                                    // generic TPlugin — drop `as any`, confirm by typecheck
  // configSchema: omit → defaults to emptyChannelConfigSchema (type is ChannelEntryConfigSchema<TPlugin>, NOT OpenClawPluginConfigSchema; emptyPluginConfigSchema does not typecheck here)
  setRuntime: setBasecampRuntime,                             // runs before registerFull in "full"; NOT run in "tool-discovery"
  registerFull(api) {                                         // runs in "full" and "tool-discovery" (no runtime in the latter → nothing here may touch runtime synchronously)
    api.registerHttpRoute({ path: "/webhooks/basecamp", auth: "plugin", handler: handleBasecampWebhook });
    api.on("gateway_stop", () => flushBasecampState());       // §2.11
    registerBasecampTools(api);                               // §2.9 — api.registerTool factories
  },
});
```
Mode semantics (V from impl): `cli-metadata` → only `registerCliMetadata`; `tool-discovery` → `registerFull`+`registerCapabilities` without channel/runtime; else `registerChannel` → `setRuntime` → (`discovery`: cli-metadata+capabilities) → `full`: `registerCliMetadata` → `registerFull` → `registerCapabilities`. `api.runtime` throws in `cli-metadata`/`setup-only` (`sdk-runtime.md:12`) — today's unconditional `setBasecampRuntime(api.runtime)` is a latent crash.

New `setup-entry.ts` (root, add to `tsconfig.include`): `export default defineSetupPluginEntry(basecampSetupPlugin)` where `basecampSetupPlugin` is an import-light subset (`id, meta, capabilities, configSchema, config, setupWizard, setupContract, secrets, reload`) — `src/channel.ts` currently statically imports the Basecamp SDK client, webhooks, dedup; split into `src/channel-setup.ts` (light) + `src/channel.ts` (full, spreads the light one).

Hook removal: delete `api.on("before_agent_start")` and `src/hooks/agent-prompt-context.ts` parser. Replacement is not `before_prompt_build` (would require operator opt-in `plugins.entries.<id>.hooks.allowConversationAccess: true` for non-bundled plugins, `hooks.md:117-133`) — it is §2.2: surface guidance flows in via `ChannelPromptContext`/`GroupSystemPrompt`/`channelContext` at context-build time and static rules via `agentPrompt.inboundFormattingHints`. (D)

### 1.5 Runtime store (`src/runtime.ts`)

```ts
const store = createPluginRuntimeStore<PluginRuntime>({ pluginId: "basecamp", errorMessage: "Basecamp runtime not initialized" });
export const { setRuntime: setBasecampRuntime, getRuntime: getBasecampRuntime, tryGetRuntime: tryGetBasecampRuntime, clearRuntime: clearBasecampRuntime } = store;
```
Option-object form creates a global named slot shared across duplicate SDK module instances (`runtime-store.d.ts:16-21`) — matters for managed per-plugin npm projects. `src/inbound/state-dir.ts:15-30` uses `tryGetRuntime()`; **delete the `/tmp/basecamp-state` fallback** (writes secrets to a world-visible tmp path with `0o700`; after §1.4 the webhook route exists only in `full`, where `setRuntime` has already run, V). Handler must still fail closed if runtime is absent.

### 1.6 Test-side hard breaks (V)

| Change | Files |
|---|---|
| Delete `vi.mock("openclaw/plugin-sdk", …)` — inert today (src imports subpaths; only `index.ts` imported the root and no test imports it) | 20 files: `tests/{config,hatch,heartbeat,resolver,directory,project-scoping,security,webhook-project-scoping,mentions-adapter,oauth-credentials,pairing,actions,channel-gateway,outbound,config-adapter,startup-validation,auth,status-enhanced,setup,onboarding}.test.ts` |
| Delete `vi.mock("openclaw/plugin-sdk/channel-runtime", () => ({}))` | `tests/pairing.test.ts:13`, `tests/onboarding.test.ts:60` |
| Delete `onboarding.test.ts:66` `core` mock (src imports `applyAccountNameToChannelSection` from `setup`); delete `:26` `account-id` mock (it changes `normalizeAccountId` semantics — behavioural divergence) | `tests/onboarding.test.ts` |
| Delete `sdkMock()` (L80) and rewrite `stubRuntime()` (L93) to `{ config: { current }, … }` — both currently unused | `tests/helpers.ts` |
| `loadConfig` → `current` / pass `cfg` (≈17 refs across 10 files, concentrated in `dispatch.test.ts` fixture L41-49 + 7 `mockReturnValue` sites) | `tests/{dispatch,dispatch-enhanced,dispatch-outbound,webhooks,webhook-hmac}.test.ts`, `tests/dogfooding/{dm-policy,outbound-cb,queue-pressure,webhook-auth}.test.ts` |
| 16 `vi.mock("../src/runtime.js")` → `setBasecampRuntime(mock)` in `beforeEach`, `clearBasecampRuntime()` in `afterEach` (pattern: `sdk-testing.md:262-287`) | dispatch, dispatch-enhanced, dispatch-outbound, channel-gateway, webhook-hmac, webhooks, outbound, outbound-retry, config-adapter, dedup-registry, startup-validation, auth, dogfooding×4 |
| `vitest.config.ts:5-8` alias `openclaw/plugin-sdk` → delete (root gone; 0 doc references to `OPENCLAW_PLUGIN_SDK_PATH`) | `vitest.config.ts` |

---

## 2. Idiomatic-2.0 adoption

Effort: S ≤ ½ day, M 1–2 days, L 3+ days. "Weaker" flags where the SDK equivalent loses something we have.

| # | Item | SDK subpath + symbols (V) | Replaces / changes | Behaviour delta | Effort | Rec |
|---|---|---|---|---|---|---|
| 2.1 | **Plugin composition** via `createChatChannelPlugin({ base: createChannelPluginBase({...}) spread with remaining adapters, security:{dm:{…}}, pairing:{text:{…}}, threading, outbound:{base, attachedResults} })` | `channel-core`: `createChatChannelPlugin`, `createChannelPluginBase` (opts `agent-harness-runtime…:18810-18877`) | `src/channel.ts` object literal; `src/adapters/security.ts` `resolveDmPolicy` → `security.dm {channelKey:"basecamp", resolvePolicy, resolveAllowFrom, approveHint}`; `src/adapters/pairing.ts` → `pairing.text {idLabel:"basecampPersonId", message, normalizeAllowEntry, notify}` | Adds per-account dmPolicy paths (`channels.basecamp.accounts.<id>.dmPolicy`) for Doctor/audit; sets `conversationBindings.supportsCurrentConversationBinding: true` by default (override to `false` unless card/todo binding is wanted, D: false). `base` must carry everything not in the 4 named slots (`mentions, directory, resolver, actions, heartbeat, agentTools, messaging, status, gateway, lifecycle, secrets, allowlist, bindings, conversationBindings, message, auth, elevated`). | M | **adopt** |
| 2.2 | **Inbound turn kernel**: `runtime.channel.inbound.run` (`runChannelTurn`) with `ChannelTurnAdapter { ingest, classify?, preflight?, resolveTurn, onFinalize? }` + `buildContext` (`buildChannelInboundEventContext`, prefer host-injected `ctx.channelRuntime?.inbound.buildContext` when present — `ChannelGatewayContext.channelRuntime` is documented "for external channel plugins") + `createChannelReplyPipeline` | `channel-inbound`: `runChannelInboundEvent`, `buildChannelInboundEventContext`, `toInboundMediaFacts`, `classifyChannelInboundEvent`, `resolveInboundMentionDecision`, `readAgentRunTerminalOutcome`; `channel-outbound`: `createChannelReplyPipeline`; runtime `channel.inbound.{buildContext,run,dispatch}` (`agent-harness-runtime…:18356-18363`) | `src/dispatch.ts:186-344` hand-built ctx + `dispatchReplyWithBufferedBlockDispatcher` (still non-deprecated, but `finalizeInboundContext`/`recordInboundSession`/`updateLastRoute` neighbours are `@deprecated`, so the reply-only path is the legacy lane); `src/hooks/agent-prompt-context.ts` (delete); `buildUntrustedContext` (→ `ChannelPromptContext`) | Gains: `BodyForAgent`, typed `channelContext {sender, chat}` (augment `PluginHookChannelSenderContext` with `personId`, `bucketId`, `recordingId`), `media` facts for Basecamp attachments (currently dropped at `normalize.ts:406,505`), `supplemental.quote` for comment-on-recording, `sessionTranscript.chatWindow`, `message_sending/message_sent` hooks, `room_event` classification (§2.4), `botLoopProtection` facts (§2.13), session recording in core. Surface prompt: per-event text → `GroupSystemPrompt`/`ChannelPromptContext`; invariant Basecamp rules → `agentPrompt.inboundFormattingHints`. `capabilities.media` must become `true`. | L | **adopt** (the centre of the migration) |
| 2.3 | **Ingress authorization**: `createChannelIngressResolver({channelId, accountId, identity, cfg}).message/.event/.command(...)` with `defineStableChannelIngressIdentity({ key:"basecamp-person-id", … })`; pass the exact result as `channelIngress` into `buildContext` (never rebuild; `"unsupported"` is only for named legacy paths — `sdk-channel-ingress.md:118-150`) | `channel-ingress-runtime`: `createChannelIngressResolver`, `defineStableChannelIngressIdentity`, `channelIngressRoutes`, `meetsIdentifierAuthentication`; `channel-pairing`: `createChannelPairingChallengeIssuer`; runtime `channel.pairing.{upsertPairingRequest, readAllowFromStore}` | `src/dispatch.ts:107-162` DM gate + per-bucket `allowFrom` gate; dead pairing semantics (pairing-store approvals are never consulted today, so `dmPolicy:"pairing"` ≡ allowlist) | Real pairing challenges (Ping with code), pairing store honoured, access groups (`accessGroup:<name>`), `groupPolicy`/`groupAllowFrom`, command authorization, `channelIngress` evidence. Per-bucket allowFrom → route descriptor `{id:"bucket", senderAllowFrom, senderPolicy:"replace"}`. `engage` classification stays plugin-owned (no SDK analogue) in `classify`/`preflight`. Marked experimental in docs. | L (with 2.2) | **adopt** |
| 2.4 | **Ambient room events**: `classify` → `"room_event"` for `engage: ["conversation","activity"]` events instead of full user turns; `messages.groupChat.unmentionedInbound:"room_event"`, `visibleReplies:"message_tool"` | `channel-inbound`: `classifyChannelInboundEvent`, `resolveUnmentionedGroupInboundPolicy` | `engage` semantics in `dispatch.ts` (every card move currently dispatches a full turn) | Unmentioned Campfire/comment traffic recorded as quiet context; agent speaks only via `message(action=send)` — requires 2.5 working. Big token win for always-on projects. Docs list Discord/Slack/Telegram as supported; Basecamp adds support via the kernel (I). | M (after 2.2, 2.5) | **adopt** |
| 2.5 | **Real outbound**: `sendText`/`sendMedia`/`sendPayload` via `createAttachedChannelResultAdapter({channel:"basecamp", sendText, sendMedia})` (or `createChatChannelPlugin({outbound:{base, attachedResults}})`); results `{messageId, target:{kind:"conversation", id}}`; failures **throw** (`PlatformMessageNotDispatchedError` from `error-runtime` for provably-not-sent); `outbound.deliveryCapabilities.durableFinal {text, media}` | `channel-send-result`, `error-runtime`, `channel-contract` `ChannelOutboundAdapter` | `src/outbound/send.ts:308-317` always-throwing `sendBasecampText/Media`, `src/adapters/outbound.ts` `resolveOutboundTarget` always `ok:false`, bespoke `deliver` in `dispatch.ts` | Unlocks shared `message` tool, cron/heartbeat/`sessions_spawn` announce, `openclaw message send`, approvals/credential-link delivery to Basecamp, `recordOutboundMessageIdentity` echo suppression (§2.12). **Target grammar (D)**: inbound peer ids stay `recording:<id>`/`bucket:<id>`/`ping:<id>` (PLAN peer model unchanged); plugin maintains a recording→`{bucketId, recordableType}` index in plugin-owned state, populated by every inbound event (poller + webhook) and by `dock-cache`; `resolveTarget` also accepts explicit `bucket:<b>/recording:<r>` for cold sends; miss → thrown error naming the fix. `bucket:<id>` targets post a Campfire line to the project's default chat (dock-cache). | L | **adopt** |
| 2.6 | **`message` adapter**: `createChannelMessageAdapterFromOutbound({ id:"basecamp", outbound, durableFinal:{capabilities:{text, media}}, receive:{defaultAckPolicy:"after_agent_dispatch"} })` | `channel-outbound` | none today | Durable final delivery + receipts; "most plugins define one `message` adapter". Declare only what `sendMedia` really does. | S (after 2.5) | **adopt** |
| 2.7 | **Presentation**: `outbound.presentationCapabilities`, `renderPresentation({payload, presentation, ctx})`; `describeMessageTool → { actions, capabilities:["presentation"] }` | `channel-contract` `ChannelPresentationCapabilities` (`channel-contract-D5K0dYZr.d.ts:1927+`); `interactive-runtime`: `MessagePresentation`, `renderMessagePresentationFallbackText`, `adaptMessagePresentationForChannel` | `src/adapters/actions.ts:47`, `src/outbound/format.ts` | See §3.1 for the Basecamp contract. | M | **adopt** |
| 2.8 | **Chunking**: drop custom `chunker`; `outbound.chunkerMode:"markdown"`, `textChunkLimit`; honour `ctx.formatting` (`maxLinesPerMessage`); `defaultMarkdownTableMode` | `reply-chunking`: `chunkMarkdownTextWithMode`, `resolveTextChunkLimit`; `text-chunking`: `convertMarkdownTables`; `MarkdownTableMode = "off"\|"bullets"\|"code"\|"block"` | `src/adapters/outbound.ts` `chunkMarkdownText` (~150 LOC), manual chunk loop `dispatch.ts:236` | Core chunker respects fences/tables; verify fence parity against `tests/outbound*.test.ts`. Basecamp HTML supports tables? — set `defaultMarkdownTableMode` accordingly (I: `"block"` if `<table>` is accepted by the rich-text API, else `"bullets"`). | S | **adopt** |
| 2.9 | **Agent tools → `api.registerTool` factories** in `registerFull` + manifest `contracts.tools`/`toolMetadata`; `typebox` 1.x schemas; `jsonResult`/`textResult` from `tool-results`; `ctx.getRuntimeConfig()` inside `execute`; persona from `ctx.agentId` → `channels.basecamp.personas[agentId]` | `plugin-entry`/`tool-plugin`: `OpenClawPluginToolContext {config, runtimeConfig, getRuntimeConfig, agentId, sessionKey, …}` (`agent-harness-runtime…:1886-1900`); `tool-results` | `src/adapters/agent-tools.ts` (`ChannelPlugin.agentTools` slot; `ChannelAgentToolFactory` only receives `{cfg?}` so cannot fix personas); `actions.ts:28-33` inlined `jsonResult` | Fixes the known "tools execute under the default account; persona-mapped accounts not supported" warning (`channel.ts:308-313`). Tool names must not collide with core. Factories must not touch runtime at registration (tool-discovery mode). Optionally `requireApproval.scope {kind:"message-send"\|"external-post"}` on `basecamp_post_message`/`basecamp_api_write`. | M | **adopt** |
| 2.10 | **Config schema stack**: `zod` v4; `buildChannelAccountSchemaParts` (`accountShape`/`rootPolicyShape`: `dmPolicy`, `groupPolicy`, `allowFrom`, `groupAllowFrom`, `mentionPatterns`, `configWrites`, `historyLimit`, `streaming`, `markdown.tables`, `reactionLevel`, `ackReaction`…), `.strict()` accounts, SecretRef fields via `registerSensitiveConfigSchema(buildSecretInputSchema().optional())` for `token`, `oauthClientSecret`, `webhookSecret`, `oauth.clientSecret`; `buildChannelConfigSchema(schema, { uiHints: {...createChannelConfigUiHints({channelLabel:"Basecamp", dmPolicy:{channelKey:"basecamp"}}), ...basecampHints} })`; config adapter via `createScopedChannelConfigAdapter` + `inspectAccount`, `isLinked`/`unlinkedReason` (OAuth token file present) | `channel-config-schema`, `secret-input` (`buildSecretInputSchema`, `registerSensitiveConfigSchema`), `secret-input-runtime` (`resolveSecretInputString`, `hasConfiguredSecretInput`), `channel-core` (`createChannelConfigUiHints`), `channel-config-helpers` (`createScopedChannelConfigAdapter`, `createScopedDmSecurityResolver`, `clearAccountFieldsFromConfigSection`), `account-helpers`/`account-core` (`mergeAccountConfig`, `resolveAccountWithDefaultFallback`) | `src/config.ts` (16-110), `src/channel.ts` `config:` (198-236) and `configSchema`/`uiHints` (135-197), `readTokenFile`; `gateway.logoutAccount` field clearing | Per-account dmPolicy/allowFrom; SecretRef `{source:"env"\|"file"\|"exec"\|"store"}` for tokens (makes `tokenFile` redundant — keep as sugar); `configured_unavailable` status semantics in read-only paths; Control UI validates before runtime load; `tokenStatus` via `inspectAccount`. Note `createSimpleChannelSecretContract` returns `{secretTargetRegistryEntries, collectRuntimeConfigAssignments}` → assign to `ChannelPlugin.secrets`. BETA docs drop the `buildChannelAccountSchemaParts` paragraph but the export remains — adopt. `DmPolicy` normalization `pairing→allowlist` (`onboarding.ts:456-466`) goes away once 2.3 gives real pairing. | L | **adopt** |
| 2.11 | **Setup contract**: `setupContract: defineChannelSetupContract({ fields: { token:{kind:"string",sensitive}, tokenFile, personId, basecampAccountId, oauthClientId, oauthClientSecret:{sensitive}, cliProfile }, adapter: { applyAccountConfig({cfg, input}) } })` (typed `adapter`, not telegram's `legacyAdapter`); mirror fields in `package.json#openclaw.channel.setup.fields` (key = camelCase of long flag); wizard via `createStandardChannelSetupStatus`, `createChannelDmPolicy`, `createAllowFromSection`, `setSetupChannelEnabled`; OAuth browser login remains a plugin-owned `credentials[]`/`prepare` step (no browser-flow hook in `ChannelSetupWizardCredential`) but wizard `WizardPrompter` gained `openUrl?`/`deviceCode?` — use them | `channel-setup` (`defineChannelSetupContract`, `ChannelSetupWizard`), `channel-dm-policy` (`createChannelDmPolicy`), `setup` (`createAllowFromSection`, `applySetupAccountConfigPatch`, `formatCliCommand`), `setup-runtime` (`createEnvPatchedAccountSetupAdapter` if wanted) | `src/adapters/setup.ts` (delete), large parts of `src/adapters/onboarding.ts` (483 lines) | `openclaw channels add basecamp --token-file … --person-id …` works without runtime; consistent wizard status scoring. `configPromotion` (NEW-only, gone in BETA) — don't use; declare `singleAccountKeysToMove: []` if legacy adapter is kept temporarily. | M | **adopt** |
| 2.12 | **Outbound echo suppression**: `recordOutboundMessageIdentity({channel, accountId, conversationId, messageId})` after each post; `isRecentOutboundMessageIdentity` | `channel-outbound` (typed; NOT `outbound-echo-runtime` which is JS-only) | `personId` self-filter (`channel.ts:417`, `dispatch.ts:78`, `normalize.isSelfMessage`) as primary guard | Also protects multi-persona setups. Keep personId as belt-and-braces. Docs: don't maintain a parallel TTL cache. | S | **adopt** |
| 2.13 | **Bot-loop protection** facts on the turn (`{scopeId: accountId, conversationId, senderId, receiverId: personId, eventId, config, defaultsConfig, defaultEnabled}`) when sender ∈ known persona personIds | turn kernel (`AssembledChannelTurn.botLoopProtection`), `channels.defaults.botLoopProtection` (`sdk-runtime.md:91-128`) | none | Prevents persona ping-pong in shared Campfires. | S (with 2.2) | **adopt** |
| 2.14 | **Dedup → `createChannelReplayGuard`** (`{ dedupe:{ pluginId:"basecamp", namespacePrefix:"basecamp.event-dedupe", ttlMs: 24h, memoryMaxSize, stateMaxEntries }, buildReplayKey: (evt) => [primaryKey, secondaryKey], namespace: (evt) => accountId })` → `processGuarded(evt, fn)` (claim → commit / release on error), `hasRecent` for safety-net/reconciliation checks | `persistent-dedupe` (typed; `ReplayKeys = string \| readonly (string\|null\|undefined)[]`, `ChannelReplayGuard {claim, shouldProcess, processGuarded, hasRecent, forget, warmup, clearMemory}`, `persistent-dedupe.d.ts:110-160`); ungated (G7) | `src/inbound/{dedup,dedup-store,dedup-store-sqlite,dedup-registry}.ts` (~620 LOC) + `node:sqlite` dependency + JSON migration | **Parity check vs ours**: multi-key claim covers primary + cross-source secondary key (`recordingId:action:createdAt`) ✔; claim/commit fixes current TOCTOU (we record before dispatch succeeds) ✔ stronger; TTL 24h ✔; per-account isolation via `namespace` ✔; `hasSeen` → `hasRecent` ✔; `webhookDedupSize` metric ✗ (no size API — drop or count claims); storage moves from per-account `dedup-<acct>.sqlite` (WAL, plugin dir) to shared `openclaw.sqlite` plugin-state table (backed up by `openclaw backup`) — `backupResources` no longer needs to cover it. **Weaker**: no explicit `clear()`/inspection for tests beyond `clearMemory`/`forget`; relies on an ungated-by-omission path (verified in JS, not documented as a guarantee). Gate: one runtime smoke test under an `npm-pack:` install. Fallback if it fails: keep our SQLite behind the same `ReplayGuard`-shaped interface. | M | **adopt** (with smoke-test gate) |
| 2.15 | **Cursors / webhook secrets / recording→bucket index** | `json-store` (`readJsonFileWithFallback`, `writeJsonFileAtomically`), `state-paths`/`runtime.state.resolveStateDir` (ungated) | `src/inbound/cursors.ts` hand-rolled atomic JSON, `webhook-secrets.ts`, `state-dir.ts` fallback | Keyed stores are gated (G7) → keep plugin-owned files under `<stateDir>/plugins/basecamp/`, but use the SDK atomic JSON helpers. Declared in `backupResources`. | S | **adopt** (as the primary path, not a fallback) |
| 2.16 | **Durable ingress queue/monitor** (`openChannelIngressQueue` + `createChannelIngressMonitor`, ack-gated webhooks) | `channel-outbound`, `channel-ingress-runtime` | webhook `Semaphore` (`webhooks.ts:46-85`), ack-before-durable | **Not adoptable** (G7). Mitigate with 2.17. Escalation path: §8 Q3. | — | **no (blocked)** |
| 2.17 | **Webhook guards**: `readJsonWebhookBodyOrReject({req,res,maxBytes,profile:"pre-auth"})`, `createWebhookInFlightLimiter`, `runDetachedWebhookWork` (post-ack work visible to Gateway shutdown), `createFixedWindowRateLimiter`, `safeEqualSecret`, `resolveRequestClientIp` | `webhook-request-guards` (body/in-flight/detached), `webhook-ingress` (rate limiter, client IP), `security-runtime` (`safeEqualSecret`) | `webhooks.ts` `readBody` (L181), `timingSafeEqual` loop (L158), `Semaphore`, fire-and-forget dispatch | HMAC verification stays plugin-owned. Keeps at-most-once semantics (queue blocked) but bounded and drain-aware. | S | **adopt** |
| 2.18 | **Status**: `createComputedAccountStatusAdapter({ defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID), probeAccount, auditAccount, formatCapabilitiesProbe, collectStatusIssues, buildChannelSummary, resolveAccountSnapshot })`; `createAccountStatusSink` + `channelReadyPatch`/`channelBlockedPatch`/`createTransportActivityStatusPatch`; publish `lifecycle: "starting"→"ready"`, `"recovering"` when a poller breaker opens, `"blocked"` on auth failure; `ingressUnavailable: true` when webhook route/secret broken (I on semantics); `lastTransportActivityAt` from poller ticks; **throw** from `startAccount` on fatal config (today returns → not-running with no reason, `channel.ts:349-357`) | `status-helpers` (`createComputedAccountStatusAdapter`, `readAccountStatusSnapshot`, `resolveEnabledConfiguredAccountId`), `channel-status` (`createDefaultChannelRuntimeState`, `buildBaseChannelStatusSummary`, `buildTokenChannelStatusSummary`, `projectCredentialSnapshotFields`), `gateway-runtime` (`channelReadyPatch`, `channelBlockedPatch`, `createTransportActivityStatusPatch`) — avoid `channel-lifecycle` (2026-09-01 gate) | `src/adapters/status.ts` (414 lines; `status.ts:105-111` inlines `createDefaultChannelRuntimeState`, `:252-259` inlines `buildBaseChannelStatusSummary`); `setStatus({running})` calls | `channels status --probe` fidelity; generic stale-transport issues. Keep per-source circuit breakers (`circuit-breaker.ts`) — **no SDK equivalent**; surface breaker state via `lifecycle:"recovering"` + issues. | M | **adopt** |
| 2.19 | **Lifecycle**: `lifecycle.onAccountConfigChanged` (evict client/token manager when token changes), `onAccountRemoved` (delete cursors, webhook secrets, index, dedupe namespace via `forget`/namespace drop, OAuth files), `runStartupMaintenance` (prune stale cursors); `gateway.stopAccount`; `api.on("gateway_stop")` for global flush (webhook secrets, deactivate webhooks once per process) | `ChannelPlugin.lifecycle` (`types.adapters-BPSGfW3j.d.ts:591-617`), hooks `gateway_stop` (5 s budget) | `startAccount` `finally` block (`channel.ts:493-540`), `config.deleteAccount`/`gateway.logoutAccount` cleanup spread | Cleanup on account removal currently missing. `reload.accountScopedRestart`: **no** — `personas`/`virtualAccounts` are channel-root shared fields; sibling isolation not provable. | S | **adopt** |
| 2.20 | **Messaging grammar**: `targetPrefixes: ["basecamp","bc"]` (drop hand-strip at `messaging.ts:18-24`), `inferTargetChatType` (`ping:`→direct, `recording:/bucket:`→group), `resolveSessionConversation({kind, rawId})` → `{ id:"recording:<r>", baseConversationId:"bucket:<b>", parentConversationCandidates:["bucket:<b>"] }` (needs the recording→bucket index from 2.5), `resolveOutboundSessionRoute` via `buildChannelOutboundSessionRoute`, `targetResolver.resolveTarget` (project/person names → ids reusing `resolver.ts` matchers) | `core` (`ChannelMessagingAdapter`, `types.core-Cfy7zcbX.d.ts:603-611`), `channel-core` (`buildChannelOutboundSessionRoute`) | `src/adapters/messaging.ts`, `parentPeer` plumbing in `dispatch.ts:86-96` | Per-project routing/inheritance via canonical hook; `bindings[].match.peer` on buckets; heartbeat delivery to pings no longer "waiting for route". | M | **adopt** |
| 2.21 | **Bindings**: `bindings: { compileConfiguredBinding, matchInboundConversation, resolveCommandConversation, selfParentConversationByDefault }` so a binding on `bucket:<id>` matches any `recording:<id>` inside it; `conversationBindings.supportsCurrentConversationBinding: false` explicitly | `ChannelPlugin.bindings` (`types.adapters-BPSGfW3j.d.ts:800-813`) | PLAN "parentPeer enables per-project routing" implemented ad hoc via `resolveAgentRoute({parentPeer})` (still valid) | Formalizes project-level bindings with `matchPriority`. | M | **adopt** (after 2.20) |
| 2.22 | **Groups/allowlist**: `groups.resolveToolPolicy` via `resolveScopeToolsPolicy(buildChannelGroupsScopeTree(cfg,"basecamp",accountId))` honouring `toolsBySender`/`senderPolicyMode`; `resolveRequireMention` via `resolveChannelGroupRequireMention`; `allowlist: buildDmGroupAccountAllowlistAdapter({...})` for `openclaw pairing`/allowlist CLI edits of channel + per-bucket allowFrom | `channel-policy`, `allowlist-config-edit`, `runtime-group-policy` | `src/adapters/groups.ts` bespoke `buckets[*].tools`; no allowlist adapter | Buckets become `groups`-shaped config (`channels.basecamp.groups["bucket:<id>"]`?) — **D**: keep the `buckets` key name but back it with the scope tree helpers via a small adapter; revisit naming in PLAN. | M | **adopt** |
| 2.23 | **Security/doctor**: `collectWarnings` → `SecurityAuditFinding[]` via `createConditionalWarningCollector.findings({checkId, severity})`, `collectAuditFindings`; `doctor: { dmAllowFromMode:"topOnly", groupModel:"route", legacyConfigRules, collectPreviewWarnings, repairConfig }` + manifest `doctorContract.configRepair` + `doctor-contract-api.ts` sidecar (import-light) | `channel-policy` (`createConditionalWarningCollector`, `composeWarningCollectors`), `ChannelDoctorAdapter` (`types.adapters-BPSGfW3j.d.ts:558-590`) | `src/adapters/security.ts:40` string warnings; cliProfile-only nudge in `status.ts:308-317` becomes a doctor rule | `openclaw doctor --fix` repairs (dangling persona refs, `dmPolicy:"open"` without `"*"`, `cliProfile`-only accounts). **Skip `stateMigrations`** (untyped `runtime-doctor-migrations`; user waived migrations). | M | **adopt** doctor + findings; **no** stateMigrations |
| 2.24 | **Agent prompt adapter**: `inboundFormattingHints({cfg, accountId}) → {text_markup:"html", rules[]}` (encode `outbound/format.ts` capabilities: bold/italic/strike/links/ul/ol/blockquote/pre/h1, bc-attachment mentions), `reactionGuidance {level:"minimal"}`, `messageToolCapabilities` | `ChannelPlugin.agentPrompt` (`types.core-Cfy7zcbX.d.ts:702-713`) | `src/adapters/agent-prompt.ts` `messageToolHints` strings + static hints from the deleted hook | Static guidance without per-turn `prependContext` tokens. | S | **adopt** |
| 2.25 | **Retry**: `retryAsync`/`computeBackoff`/`sleepWithAbort` from `runtime-env` (typed) | `runtime-env` (not `retry-runtime`, JS-only; not `infra-runtime`, gated 2026-09-01) | `src/retry.ts` `withRetry` | Minor; keep TypeError-only classifier as a predicate. Circuit breaker stays. | S | adopt (low priority) |
| 2.26 | **Logging**: `api.logger` / `runtime.logging.getChildLogger({plugin:"basecamp"})`, `createSubsystemLogger` | `logging-core`, `runtime-env` | 20 `console.*` across 13 files; `src/logging.ts` | Redaction + verbosity integration. | S | adopt |
| 2.27 | **Directory**: `createChannelDirectoryAdapter`, `applyDirectoryQueryAndLimit`; `ctx.invalidateDirectoryCache` after people refresh | `directory-runtime` | `src/adapters/directory.ts` boilerplate | Minor. | S | adopt (low priority) |
| 2.28 | **Inbound debounce**: `defaults.queue.debounceMs` / `createInboundDebouncer` for rapid Campfire lines | `channel-inbound-debounce` | plugin dispatch queue | Only if the kernel path drops our own queue. | S | defer |
| 2.29 | **Structured questions via boosts**: `question-gateway-runtime` (`createQuestionReactionTargetStore`, `questionGatewayRuntime.reactionEmojis`), `ChannelIngressEventInput.kind:"reaction"` | `question-gateway-runtime`, `channel-ingress-runtime` | none | Needs inbound `boosted` events with actor + target recording — unverified from activity feed. Text answers already work (§3.2). | M | **defer** (phase 2) |
| 2.30 | **Approvals native**: `approvalCapability` via `createApproverRestrictedNativeApprovalCapability` + `registerChannelRuntimeContext` | `approval-runtime`, `approval-handler-adapter-runtime`, `channel-runtime-context` | none | Basecamp has no buttons; core same-chat `/approve <id> allow-once` text path works without it (§3.3). | L | **no** (revisit with 2.29) |
| 2.31 | **Join intro** `reportChannelRoomJoin` | `channel-join-intro-runtime` | none | JS-only, removed in BETA, docs say only 5 channels accept `joinIntro`. | — | **no** |
| 2.32 | **Session discussion provider**, `registerCommand` Basecamp slash commands, `before_tool_call` guardrails on `basecamp_*` (`matcher`), `heartbeat_prompt_contribution` (assignment summary) | `session-discussion`, `api.registerCommand`, hooks | none | Novel features, not migration. | S–M each | defer |
| 2.33 | Streaming / typing / polls / `edit`/`unsend` capabilities | — | — | Basecamp has no typing API, no polls; comments not editable via streaming. `capabilities.edit/unsend` only if `handleAction("edit"/"delete")` implemented. | — | no |

Keep plugin-owned (no SDK analogue, V): composite poller sources (activity/readings/assignments/safety-net/reconciliation), per-source circuit breakers, `engage` classification, webhook lifecycle registration against Basecamp, OAuth login/refresh (`oauth-credentials.ts`; optionally root token dir under `resolveStateDir()`), `@37signals/basecamp` client, HTML↔Markdown formatting, bc-attachment mention parsing, virtualAccounts/personas.

---

## 3. New 2.0 user-facing behaviours to surface through Basecamp

| Behaviour | What core does | Basecamp presentation contract (what we implement) |
|---|---|---|
| 3.1 **Rich presentation** (`MessagePresentation {title?, tone?, blocks: text\|context\|divider\|buttons\|select\|chart\|table}`) | Adapts blocks to `presentationCapabilities`, degrades unsupported blocks to deterministic text (`message-presentation.md:537-594`: `command` actions → `` label: `command` ``; `callback`/`approval`/`question` actions → label only, IDs never exposed; URL buttons → URL; selects → label list; tables → caption + `- Col: v; …`; charts → title/type/axes/values) | `outbound.presentationCapabilities = { supported:true, buttons:false, selects:false, context:true, divider:true, charts:false, tables:true /* if Basecamp rich text accepts <table>; else false */, limits:{ text:{ maxLength: 10000, encoding:"characters" } } }`; `renderPresentation` → Basecamp HTML (title→`<h1>`, text→Markdown→HTML, context→`<blockquote>`/`<em>`, divider→`<hr>` or `—`), fall back to `renderMessagePresentationFallbackText` for buttons/selects; `describeMessageTool → { actions:["send","react"], capabilities:["presentation"] }`. Never add `channelData.basecamp.*` native fields. |
| 3.2 **Structured questions** (`ask_user`) | Delivers options; on channels without buttons: "Reply with a number, an option label, or your own answer"; Skip always available (`tools/ask-user.md:31`); parses the text reply in the same session | Works once 3.1 fallback renders numbered options and the reply lands in the same session (comment on the same recording / next Campfire line). Phase 2: boosts `1️⃣–4️⃣` as answers (§2.29). |
| 3.3 **Approvals** (exec/plugin approvals, recurring-work approvals) | Typed operation-scope summary; same-chat `/approve <id> allow-once` text path is core-owned; native cards need `approvalCapability` | Text path only: presentation fallback renders the pending-approval payload as a comment/line; document `/approve` usage in README. `approvals.plugin.targets` may route to a Basecamp target once §2.5 works. |
| 3.4 **Private credential requests** (`secrets` tool) | Never accepts the value in chat; delivers a Control UI link (needs `gateway.publicOrigin`), else visible blocker + cancel | Nothing to implement beyond §2.5 delivery; README note on `gateway.publicOrigin`. |
| 3.5 **Progress cards** (`progress_card`) | Control-UI/native; channels opt in via "Progress visibility acceptance" adapter | **Defer**; possible later as edit-in-place of one Campfire line (Campfire lines are editable; comments are not). |
| 3.6 **DM policy / pairing** | Ingress resolver honours pairing store, access groups; `channel_pairing_requested` hook; Control UI approval queue | §2.3: Ping the requester with the pairing code (`createChannelPairingChallengeIssuer` + Ping via `/circles/people/<id>/lines.json`), `PAIRING_APPROVED_MESSAGE` on approval; per-account `dmPolicy` (`pairing` default from `rootPolicyShape`); `openclaw pairing approve` works. `allowlist` adapter (§2.22) enables `openclaw allowlist add basecamp …`. |
| 3.7 **Ambient room events** | Unmentioned group traffic recorded as context (`room_event`), agent speaks via `message` tool | §2.4 for `engage: conversation/activity`. |
| 3.8 **Owner-directed heartbeat** | Ambient alerts go to resolvable owner DM | `inferTargetChatType` (§2.20) + a Ping target for the configured owner person id; `heartbeat.checkReady` retained. |
| 3.9 **Bot-to-bot loop protection** | `channels.defaults.botLoopProtection` | §2.13. |
| 3.10 **Health/lifecycle** in `openclaw channels status` | `lifecycle`, `ingressUnavailable`, `lastTransportActivityAt`, `formatCapabilitiesProbe` lines | §2.18: person name, account count, poller lag, breaker states. |
| 3.11 **Install/consent UX** | Provenance warning for arbitrary npm sources (`--force`), capability consent (`--accept-capabilities`), widening surface re-prompts | §1.3 manifest declares the full surface; README documents the flags. |
| 3.12 **Join intro** | 5 channels only | **no** (§2.31). |

---

## 4. Tests & tooling

### 4.1 package.json / lockfile
See §1.3 table. Also: `npm ci` size roughly doubles (NEW tarball 224 MB vs 106 MB); openclaw's `preinstall`/`postinstall` scripts already run today (unchanged since OLD).

### 4.2 tsconfig.json
No forced change (`module`/`moduleResolution: Node16` resolves the exports map; NEW entrypoint `.d.ts` use only `zod`, `typebox`, node builtins; `skipLibCheck: true`). Add `setup-entry.ts` to `include`. TS 7.0.2 × `Node16` — CI already passes; watch for deprecation output.

### 4.3 vitest.config.ts
Delete the `OPENCLAW_PLUGIN_SDK_PATH` alias block. Thresholds/include unchanged. Run the un-mocked real SDK subpaths (they are tiny: `account-id.js` 242 B … `core.js` 5 KB) — the official worked example (`sdk-channel-plugins.md:1182-1222`) tests a channel plugin with plain vitest and no SDK mocks. No SDK test utilities are published for external plugins (`sdk-testing.md:22-24`; `files` excludes every `*test*` subpath).

### 4.4 Mock rewrite patterns
- SDK mocks: **delete** (§1.6). If one must remain, mock the exact subpath src imports, never the root.
- Runtime: replace 16 `vi.mock("../src/runtime.js")` with `setBasecampRuntime({...})`/`clearBasecampRuntime()`; runtime stub shape `{ config: { current: () => cfg, mutateConfigFile, replaceConfigFile }, channel: { routing: { resolveAgentRoute }, inbound: { buildContext, run, dispatch }, reply: {...}, pairing: {...} }, state: { resolveStateDir }, logging: { getChildLogger, shouldLogVerbose } }`.
- Agent tools: stub `OpenClawPluginToolContext` (`getRuntimeConfig`, `agentId`) once §2.9 lands (`tests/agent-tools.test.ts`).
- Setup: `tests/setup.test.ts` and setup parts of `tests/onboarding.test.ts` become behavioural rewrites against `setupContract.parseInput`/`adapter.applyAccountConfig` (not mock deletions).
- Dispatch trio: after §2.2, tests exercise `ChannelTurnAdapter.ingest/classify/preflight/resolveTurn` directly with a hand-built `cfg` and a stubbed `runtime.channel.inbound.run` — plus one integration test running the real `runChannelInboundEvent` from `channel-inbound` with a fake dispatcher.
- Dedup: `tests/{dedup,dedup-store,dedup-store-sqlite,dedup-registry,cross-source-dedup}.test.ts` → replay-guard tests using `persistent-dedupe` with `env: { OPENCLAW_STATE_DIR: tmp }`; one smoke test proving the guard works without trusted-install (§2.14 gate).
- Contract tests to add: manifest `channelConfigs.basecamp.schema` equals generated; manifest `version` equals `package.json.version`; `openclaw.channel.setup.fields` equals `setupContract.metadata.fields`; `contracts.tools` equals registered tool names; `setup-entry.ts` import graph excludes `@37signals/basecamp`/webhooks/poller (assert via `import.meta` resolution or a static `rg` in a test).

### 4.5 Wrong CLI strings in src (fix while touching; V)
| Site | Wrong | Right |
|---|---|---|
| `src/adapters/onboarding.ts:450` | `openclaw channels hatch basecamp` | no such subcommand — `openclaw channels add basecamp` |
| `src/adapters/pairing.ts:39` (comment) | `openclaw pairing status` | `openclaw pairing list` |
| `src/adapters/status.ts:327` | `openclaw start` | `openclaw gateway` |
| `src/adapters/setup.ts:2` (comment) | `openclaw setup basecamp` | `openclaw channels add --channel basecamp` (file is deleted anyway) |
| `tests/status-enhanced.test.ts:353` | asserts fix text contains `"legacy"` but `status.ts:316` lacks it | check before editing |

### 4.6 biome.json
No change; expect `noUnusedImports` for `vi` after mock deletions.

### 4.7 CI / dependabot
- `ci.yml`: node matrix `[22, 24]` (host supports both; `.mise.toml` pins 24.18.0); add pack-install smoke: `npm pack --pack-destination /tmp && OPENCLAW_STATE_DIR=$(mktemp -d) npx openclaw plugins install npm-pack:/tmp/*.tgz --force --accept-capabilities && npx openclaw plugins inspect basecamp --runtime --json` (`building-plugins.md:189-197`).
- `scripts/verify-pack.sh`: also assert `openclaw.setupEntry` target is in the pack.
- `security.yml`: trivy fs scans the larger dev tree (66 openclaw deps incl. `koffi`, `@trycua/cua-driver`) — expect noise.
- **`dependabot.yml` / `dependabot-auto-merge.yml`**: openclaw uses calendar versions, so `2026.7.1→2026.8.1` is `semver-minor` and auto-merged; history shows 10 auto-merged openclaw bumps needed a manual fix-up (#146). Add `ignore: [{dependency-name: openclaw, update-types: ["version-update:semver-minor","version-update:semver-major"]}]` or a separate non-auto-merged group.

---

## 5. Docs to update

| File | Changes |
|---|---|
| `README.md` | Node range → host string; "OpenClaw ≥ 2026.8.1"; install flow (`openclaw plugins install npm:@37signals/openclaw-basecamp`, provenance `--force`, capability consent `--accept-capabilities`, `plugins.allow: ["basecamp"]`), `openclaw channels add basecamp --help` flags; dev loop `openclaw plugins install --link ./checkout --force` (re-consents each time) or `plugins.load.paths`; `/approve` text approvals; `gateway.publicOrigin` for credential links; note keyed-store/durable-ingress unavailability for non-official installs |
| `PLAN.md` | Q11 (schema in code vs manifest) → both: code is source, manifest `channelConfigs` is generated; entry shape (`defineChannelPluginEntry`, setup entry); routing via `messaging.resolveSessionConversation`/`bindings` instead of ad-hoc `parentPeer`; outbound target grammar + recording→bucket index (§2.5 D); dedup → replay guard; ingress resolver replaces DM gate; `engage` → `room_event` mapping; peer dep `>=2026.8.1` (L83); state paths (L655, L830) |
| `RELEASING.md` | pack-install proof step; manifest `version` sync test; widening `contracts.tools`/`channels` forces re-consent on update; bump `openclaw.compat`/`openclaw.build` with each host bump; Node floor text (L86-92) |
| `AGENTS.md` | L92 "config schema lives in code, not manifest" → generated `channelConfigs`; L99-107 entry snippet → `defineChannelPluginEntry`; L111 "see `openclaw/plugin-sdk`" → `channel-core`/`channel-contract`/`config-contracts` + `docs/plugins/sdk-subpaths.md`; L113 reference impl → `node_modules/openclaw/dist/extensions/telegram` (shims) + `docs/plugins/sdk-channel-plugins.md` walkthrough; source layout (delete `hooks/`, `dedup*`, `adapters/setup.ts`; add `setup-entry.ts`, `src/channel-setup.ts`, `src/sdk-types.ts`, `src/inbound/recording-index.ts`); test counts (currently 67 files / 1182 `it`) |
| `examples/openclaw.yaml` | `plugins: { allow: ["basecamp"] }`; plugin id; fix comment `"closed"` → `"disabled"`; per-account `dmPolicy`; SecretRef examples for `token`/`webhookSecret`; `channels.defaults.botLoopProtection`; `messages.groupChat.unmentionedInbound: room_event` |
| `docs/dogfooding-matrix.md`, `docs/webhook-api-vision.md`, `scripts/dogfood/*` | prose only; update status-adapter field names (`lifecycle`) if referenced |
| `.github/*` | per §4.7 |

---

## 6. Things to avoid

| Surface | Why |
|---|---|
| `openclaw/plugin-sdk` root, `plugin-sdk/compat`, `plugin-sdk/zod`, `plugin-sdk/channel-runtime`, `plugin-sdk/webhook-path`, `config-schema`, `channel-config-schema-legacy`, `messaging-targets`, `channel-streaming`, `channel-message-runtime` | removed in NEW exports |
| `channel-lifecycle`, `channel-message`, `channel-reply-pipeline`, `config-runtime`, `infra-runtime` | removal-eligible 2026-09-01 (CHANGELOG C:20); use `channel-outbound`, `channel-inbound`, `config-contracts`, `runtime-config-snapshot`, `config-mutation`, focused `*-runtime` |
| `plugin-runtime`, `agent-runtime`, `security-runtime` broad barrels, `conversation-runtime` | "deprecated broad barrels" (`sdk-subpaths.md:56-66`); `PluginRuntime` from `runtime-store`/`channel-core`. (`safeEqualSecret` lives in `security-runtime` — accept that one import or vendor the 3-line compare.) |
| `inbound-reply-dispatch`, `dispatchReplyWithBufferedBlockDispatcher` lane, `finalizeInboundContext`, `recordInboundSession`, `updateLastRoute`, `formatInboundEnvelope` | legacy/deprecated lane; use the turn kernel |
| `UntrustedContext*`, `buildUntrustedChannelMetadata` | removal after 2026-09-08 |
| `MsgContext.Media*`, `buildMediaPayload`, `agent-media-payload` | 2026-10-01; use `media` facts |
| `InteractiveReply`/`interactive` payloads, raw `actions` exports, `channel-actions` schema helpers | use `MessagePresentation` |
| `ChannelSendRawResult`, `{chatId,channelId,roomId,conversationId}` result fields, returning `{ok:false}` | `OutboundDeliveryResult` + `target`; throw |
| `ChannelPlugin.setup` + `ChannelSetupInput` channel-specific fields, `configPromotion: "preserve-root"` (gone in BETA), `setupFeatures.legacyStateMigrations`, `lifecycle.detectLegacyStateMigrations` | `setupContract`; `doctorContract.stateMigrations` (which we skip) |
| `ChannelAccountSnapshot.healthState` | `lifecycle` |
| `ChannelSecurityDmPolicy.classifyEntryAuthentication`, action `"conversation-open"`, `eligibleDispatchKinds` | absent in BETA |
| `channel-join-intro-runtime`, `browser-cdp`, `diagnostic-flags`, `gateway-config-runtime` | absent in BETA; JS-only |
| All JS-only subpaths (G8) | TS7016; private-local |
| `api.runtime.state.{openKeyedStore,openSyncKeyedStore,openBlobStore,openChannelIngressQueue,openChannelIngressDrain}`, `createChannelIngressMonitor`, `createStandardRawEventIngressMonitor` | trust-gated (G7) — throws at channel start |
| `before_agent_start`, `deactivate`, `subagent_spawning` hooks; `before_prompt_build`/`agent_turn_prepare` for a core feature | removed / require operator opt-in |
| `runtime.config.loadConfig/writeConfigFile`, `AuthStorage.create`, `FileAuthStorageBackend`, `resolveSessionAgentId(s)` non-strict, flat `api.registerSessionExtension` etc. | removed / dated compat aliases |
| `emptyPluginConfigSchema` in `defineChannelPluginEntry.configSchema` | wrong type (`ChannelEntryConfigSchema`), won't compile |
| `defineBundledChannelEntry`, `defineBundledChannelSetupEntry`, `legacyAdapter` form | bundled-only shapes |
| `reload.accountScopedRestart` | capability claim needing sibling isolation we don't have |
| `@sinclair/typebox` | host is `typebox` 1.x |

---

## 7. Implementation ordering — work packages (parallel by worktree)

```
WP0 ──┬── WP1 ──── WP6
      ├── WP2 ──┐
      ├── WP3 ──┼── WP4b (room events, message adapter)
      ├── WP4 ──┘
      ├── WP5
      └── WP7 (docs/CI; tail merges after all)
```

| WP | Scope | Depends on | Effort |
|---|---|---|---|
| **WP0 Foundation (serial, first)** | §1.1 import rewrites + `src/sdk-types.ts`; §1.2 (`resolveGroupIntroHint`, `loadConfig`→`cfg`/`current()`, `UntrustedContext`→`ChannelPromptContext` minimal rename); §1.4 `defineChannelPluginEntry` (hook deleted; surface prompt temporarily moved into `ChannelPromptContext` lines until WP3); §1.5 runtime store + drop `/tmp` fallback; §1.3 package.json deps (`openclaw 2026.8.1`, `zod 4.4.3`, `typebox 1.3.16`, engines, peer, compat); §1.6 test mock deletions + `loadConfig`/runtime-store test rewrites; vitest alias removal. Exit: `npm run check` green on 2026.8.1. | — | M |
| **WP1 Manifest + entry + setup entry** | `openclaw.plugin.json` (§1.3) incl. `channelConfigs` generator script + contract tests; `setup-entry.ts` + `src/channel-setup.ts` split; `package.json#openclaw.{channel,setupEntry,build,install}`; `verify-pack.sh`; pack-install smoke in CI. Plugin id rename (§8 Q1). | WP0; schema shape from WP2 (generator re-run at merge) | M |
| **WP2 Config, setup contract, secrets, doctor** | §2.10 schema stack + config adapter + SecretRefs; §2.11 `setupContract` + wizard helpers + `setup.fields` mirror; §2.23 findings/doctor + `doctor-contract-api.ts`; §2.24 agentPrompt hints; delete `adapters/setup.ts`; behavioural test rewrites (`setup`, `onboarding`, `config*`, `security`). | WP0 | L |
| **WP3 Inbound kernel** | §2.2 turn kernel + `buildContext` (+ host-injected builder when present); §2.3 ingress resolver + pairing challenge; §2.13 bot-loop facts; §2.12 echo registry consumer side; §2.14 replay guard (with smoke-test gate, fallback interface); §2.15 json-store cursors; §2.17 webhook guards; §2.20 `resolveSessionConversation`/`targetPrefixes`/`inferTargetChatType`; §2.22 groups scope tree; delete `hooks/`, `dedup*`; dispatch/webhook/dedup test rewrites. | WP0 | L |
| **WP4 Outbound** | §2.5 target grammar + recording→bucket index + real `sendText/sendMedia`; §2.7 presentation + `describeMessageTool.capabilities`; §2.8 chunker swap; §2.12 `recordOutboundMessageIdentity` producer side; throw-on-failure; outbound tests. | WP0 (index store shared with WP3 — agree file `src/inbound/recording-index.ts` API up front) | L |
| **WP4b Message adapter + room events + bindings** | §2.6 `createChannelMessageAdapterFromOutbound`; §2.4 `room_event` classify for `engage: conversation/activity`; §2.21 `bindings`; `conversationBindings` explicit. | WP3 + WP4 | M |
| **WP5 Status, lifecycle, gateway** | §2.18 computed status + lifecycle patches + throw on fatal start; §2.19 lifecycle hooks + `stopAccount` + `gateway_stop`; §2.25–2.27 retry/logging/directory; CLI string fixes (§4.5); status tests. | WP0 | M |
| **WP6 Agent tools** | §2.9 `api.registerTool` factories in `registerFull`, typebox 1.x, `tool-results`, persona via `ctx.agentId`, `contracts.tools`/`toolMetadata` alignment test; `agent-tools` tests. | WP1 (registerFull, manifest) | M |
| **WP7 Docs + CI + dependabot** | §4.7, §5. Start in parallel; final pass after everything merges. | WP0 (start), all (finish) | S–M |

Merge order: WP0 → {WP1, WP2, WP3, WP4, WP5} in parallel → WP4b, WP6 → WP7 final. Shared touchpoints to pre-agree: `src/sdk-types.ts` (WP0), `src/inbound/recording-index.ts` API (WP3/WP4), `src/channel.ts` composition skeleton with `createChatChannelPlugin` (WP0 lays the skeleton; WP2–5 fill slots), `basecampSetupPlugin` subset contents (WP1/WP2).

---

## 8. Open questions requiring the user's decision

1. **Plugin id rename `openclaw-basecamp` → `basecamp`** (= channel id, matches every bundled/partner channel; unifies `plugins.entries.*`, `plugins.allow`, `tools.allow` shorthand, `openclaw plugins enable`). Package is unpublished so no `legacyPluginIds` needed; risk is a future bundled `basecamp` id collision (`preferOver` mitigates). Recommend **yes**. Coworker's `openclaw-plugin/` config must follow.
2. **Ambient room events for `engage: conversation/activity`** (§2.4) changes Coworker behaviour: unmentioned Campfire lines and card moves stop waking a full agent turn and become quiet context; the agent must call `message` to speak. Recommend **yes** but it is a product change. Alternative: keep current "every activity event is a user turn" semantics as an opt-in `engageMode`.
3. **Trust-gate escalation**: durable ingress and keyed stores stay off-limits until `@37signals/openclaw-basecamp` is in openclaw's bundled official external plugin catalog (or the plugin is upstreamed as bundled). Do you want to pursue catalog inclusion now (drives §2.16 later), or accept plugin-owned JSON/SQLite state indefinitely?
4. **Presentation rendering fidelity**: which HTML elements does the Basecamp rich-text API accept (`<table>`, `<hr>`, `<h1>`, `<details>`)? Determines `presentationCapabilities.tables/divider` and `defaultMarkdownTableMode`. Needs a live API check (not verifiable from docs here) — can be settled inside WP4 if you're fine with a probe against a test project.
5. **OAuth token location**: keep `~/.local/share/openclaw/basecamp/tokens/` (outside `backupResources` reach) or move under `<stateDir>/plugins/basecamp/tokens/` so backups include them? Recommend move (breaks nothing published).

Routine calls already made (D): target grammar via recording→bucket index + explicit `bucket:<b>/recording:<r>` (§2.5); no `before_prompt_build` hook, surface guidance via context builder + `agentPrompt` (§1.4); `conversationBindings.supportsCurrentConversationBinding: false`; `activation.onStartup: false`; skip doctor `stateMigrations`, `accountScopedRestart`, native approvals, join intro; `zod` exact pin; `typebox` 1.3.16; keep `buckets` config key backed by scope-tree helpers.

## Uncertainties carried forward (verify during implementation)

- `defineChannelPluginEntry<TPlugin>` eliminates the `as any` at `index.ts:23` (G12) — typecheck.
- `persistent-dedupe` works under an untrusted `npm-pack:` install (JS shows no gate; docs silent) — smoke test in WP3.
- `ctx.channelRuntime` is populated for external plugins at `startAccount` in 2026.8.1 (type says optional and "for external channel plugins") — runtime check; standalone `buildChannelInboundEventContext` is the fallback (non-authoritative participant evidence).
- Vitest 4 behaviour for hoisted `vi.mock` on an unresolvable specifier — moot if mocks are deleted first.
- Whether `channel-plugin-common` is a sanctioned external barrel (`sdk-subpaths.md:129` "bundled plugin helper subpaths … deprecated for new code") — we use the narrow subpaths, so moot.
- Cross-instance zod: plugin's `zod@4.4.3` schema instance consumed by openclaw's bundled zod in `buildChannelConfigSchema` (`toJSONSchema`/`safeParse` on a foreign instance) — pin exact; if it bites, `buildJsonChannelConfigSchema` (TypeBox/JSON) is the escape hatch.
- Inbound `boosted` events carry actor + target recording (for §2.29).
- `tools.allow: ["<plugin-id>"]` shorthand covers `api.registerTool` tools (documented) — moot for channel-slot tools after §2.9.
