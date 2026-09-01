# @37signals/openclaw-basecamp

OpenClaw channel plugin for Basecamp. Connects Campfire chats, card tables, to-do lists, check-ins, pings, and message boards to OpenClaw agents -- every Basecamp surface as a live agent interaction point.

Plugin id: **`basecamp`** (the npm package name is `@37signals/openclaw-basecamp`; the plugin id is what `plugins.allow`, `plugins.entries.*`, `openclaw plugins inspect`, and `tools.allow` use).

## Prerequisites

- [OpenClaw](https://openclaw.dev) >= 2026.8.1 (`openclaw.compat.pluginApi` and `peerDependencies.openclaw` both enforce this at install and load)
- Node.js `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0` (the OpenClaw host range; `engines.node`)
- A Basecamp account plus either:
  - An OAuth app you control (client ID + secret), registered at [launchpad.37signals.com/integrations](https://launchpad.37signals.com/integrations), or
  - An authenticated Basecamp CLI profile with stored credentials that the onboarding wizard can import

## Installation

```sh
openclaw plugins install npm:@37signals/openclaw-basecamp --force --accept-capabilities
```

- `npm:` selects the npm registry deterministically. The package is not in OpenClaw's bundled/official catalog, so a non-interactive install must pass `--force` to confirm the source (interactive installs prompt instead). `--force` does not bypass `security.installPolicy`.
- `--accept-capabilities` records consent for the capability surface the manifest declares: the `basecamp` channel and the ten `basecamp_*` tools. Interactive installs show the review screen instead. A later update that widens that surface asks for consent again (`openclaw plugins update basecamp --accept-capabilities`).
- OpenClaw logs `Plugin manifest id "basecamp" differs from npm package name "@37signals/openclaw-basecamp"; using manifest id as the config key.` This is informational and expected.
- If your config uses a `plugins.allow` list, add the plugin id, not the package name:

  ```yaml
  plugins:
    allow: ["basecamp"]
  ```

The plugin activates lazily (`activation.onChannels: ["basecamp"]`): it loads once `channels.basecamp` is configured. While the Gateway is still starting its plugins, the webhook path answers `503 Retry-After: 1`; Basecamp retries, and webhooks are accelerators only.

Verify the install without starting the Gateway:

```sh
openclaw plugins inspect basecamp --runtime --json
```

## Quick start

```sh
openclaw channels add basecamp
```

The onboarding wizard handles OAuth app setup (or import from a Basecamp CLI profile), browser-based login, identity discovery, Basecamp account selection, and writing the channel config. The same fields are available as flags for non-interactive setup -- `openclaw channels add basecamp --help` lists only Basecamp's options:

| Flag | Config key | Notes |
|------|------------|-------|
| `--token <token>` | `accounts.<id>.token` | Inline OAuth/bearer token (prefer `--token-file` or a SecretRef) |
| `--token-file <path>` | `accounts.<id>.tokenFile` | File containing the token |
| `--person-id <id>` | `accounts.<id>.personId` | Numeric Basecamp person ID of the service account |
| `--basecamp-account-id <id>` | `accounts.<id>.basecampAccountId` | Numeric Basecamp account ID for API calls |
| `--oauth-client-id <id>` | `accounts.<id>.oauthClientId` | Basecamp OAuth app client ID |
| `--oauth-client-secret <secret>` | `accounts.<id>.oauthClientSecret` | Basecamp OAuth app client secret |
| `--cli-profile <name>` | `accounts.<id>.cliProfile` | Basecamp CLI profile used only for setup identity discovery |

Re-authenticate an OAuth account later with `openclaw channels login --channel basecamp [--account <id>]`. `openclaw channels status --probe` reports each account's lifecycle (`starting` / `ready` / `recovering` while a poller circuit breaker is open / `blocked` on auth failure / `stopped`), whether webhook ingress is unavailable, and the last poller activity.

## Configuration

All configuration lives under `channels.basecamp`. The schema is defined in code (`src/config.ts`) and projected into the manifest's `channelConfigs` by `npm run manifest:gen`, so the Control UI and `openclaw doctor` validate it without loading the runtime.

| Key | Type | Description |
|-----|------|-------------|
| `enabled` | `boolean` | Enable or disable the channel |
| `accounts` | `object` | Per-account auth and identity (`personId`, `token`/`tokenFile`, `basecampAccountId`, OAuth overrides) plus the standard per-account policy leaves (`dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `mentionPatterns`, `historyLimit`, `markdown.tables`, ...). Account-level values override the channel-level ones below. |
| `personas` | `object` | Map agent IDs to Basecamp account IDs; the agent replies and runs tools as that account |
| `virtualAccounts` | `object` | Synthetic account IDs scoped to one project: `{ accountId, bucketId }` |
| `dmPolicy` | `"pairing" \| "allowlist" \| "open" \| "disabled"` | How Pings (DMs) from unknown people are handled. Default: `"pairing"` — the requester gets a pairing code by Ping and `openclaw pairing approve` admits them; `"allowlist"` admits only `allowFrom`. |
| `allowFrom` | `string[]` | Basecamp person IDs permitted to DM agents (`"*"` with `dmPolicy: "open"`) |
| `groupPolicy` | `"open" \| "allowlist" \| "disabled"` | Sender policy for project surfaces (Campfires, comments). Default: `"open"` |
| `engage` | `string[]` | Engagement types that reach an agent: `dm`, `mention`, `assignment`, `checkin`, `conversation`, `activity` |
| `buckets` | `object` | Per-project overrides keyed by bucket ID (or `"*"`): `requireMention`, `tools.allow`/`tools.deny`, `engage`, `allowFrom`, `enabled` |
| `webhooks` | `object` | Webhook subscription config: `payloadUrl`, `projects`, `types`, `autoRegister`, `deactivateOnStop` |
| `webhookSecret` | `string \| SecretRef` | Token for webhook URL verification (`?token=`). Required for the webhook route to accept requests |
| `oauth` | `object` | Channel-level OAuth app credentials (`clientId`, `clientSecret`) shared across accounts |
| `polling` | `object` | Polling intervals: `activityIntervalMs` (default 120s), `readingsIntervalMs` (60s), `assignmentsIntervalMs` (300s) |
| `retry` | `object` | Retry behavior: `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `jitter` |
| `circuitBreaker` | `object` | Circuit breaker: `threshold`, `cooldownMs` |
| `safetyNet` | `object` | Safety net polling for missed events: `projects`, `intervalMs` |
| `reconciliation` | `object` | Gap reconciliation: `enabled`, `intervalMs`, `gapThreshold` |

### Secrets

`token`, `oauthClientSecret`, `webhookSecret`, and `oauth.clientSecret` accept either a literal string or a SecretRef (`source: "env" | "file" | "exec" | "store"`) resolved by the OpenClaw secrets runtime, so plaintext never has to live in the config file:

```yaml
channels:
  basecamp:
    webhookSecret: { source: "env", provider: "default", id: "BASECAMP_WEBHOOK_SECRET" }
    accounts:
      main:
        personId: "12345678"
        basecampAccountId: "9999999"
        token: { source: "env", provider: "default", id: "BASECAMP_TOKEN" }
```

`tokenFile` remains as shorthand for a `file` SecretRef. `openclaw secrets audit --check` reports which Basecamp fields are still plaintext.

### Ambient project chatter

Events that reach an agent because of `engage: ["conversation", "activity"]` -- unmentioned Campfire lines, comments, card moves -- are classified as room events rather than user turns by default: the agent sees them as quiet context and speaks only by calling the `message` tool. Set `messages.groupChat.unmentionedInbound: user_request` (globally, or per agent under `groupChat`) to make every engaged event a full turn again; `visibleReplies: message_tool` keeps ambient replies on the tool path:

```yaml
messages:
  groupChat:
    unmentionedInbound: room_event   # Basecamp default; user_request opts out
    visibleReplies: message_tool
```

Mentions, DMs, assignments, and check-in prompts stay full user turns. `requireMention: true` on a bucket drops unmentioned traffic before it becomes a room event.

### Bot-to-bot loops

When several personas share a Campfire, the channel attaches bot-loop facts to any turn whose sender is another configured persona. Set the shared baseline once:

```yaml
channels:
  defaults:
    botLoopProtection:
      maxEventsPerWindow: 20
      windowSeconds: 60
      cooldownSeconds: 60
```

## Addressing Basecamp from outside a conversation

Outbound targets use the same peer grammar as inbound sessions, optionally prefixed with `basecamp:` or `bc:`:

| Target | Posts |
|--------|-------|
| `recording:<id>` | A Campfire line or comment on a recording the channel has already seen (resolved through the recording→bucket index) |
| `bucket:<id>` | A Campfire line in the project's default chat |
| `bucket:<b>/recording:<r>` | A comment on a recording the channel has never seen (cold send with an explicit bucket) |
| `ping:<id>` | A line in a Circle (Ping) chat; the id is the circle's bucket id |

A bare number is treated as `recording:<id>`. A `recording:` target that is not in the index fails with an error naming the explicit `bucket:<b>/recording:<r>` form.

```sh
openclaw message send --channel basecamp --target recording:11111 --message "Deploy finished."
```

The same resolution serves cron and heartbeat announcements, `sessions_spawn`, the shared `message` tool, and the delivery paths below. Media is posted as a link on chat targets and as an attachment on commentable recordings; only text is declared durable-final.

### Approvals, questions, credentials

- **Approvals** (exec, plugin, recurring work) arrive as a comment or Campfire line describing the pending operation. Basecamp has no buttons, so approve in the same chat with the core text command: `/approve <id> allow-once`, `/approve <id> allow-always`, or `/approve <id> deny`. Slash commands on this channel are owner-only (`enforceOwnerForCommands`), so list approvers' Basecamp person IDs in `commands.ownerAllowFrom`.
- **Structured questions** (`ask_user`) render as a numbered option list; reply with a number, an option label, or free text in the same recording.
- **Private credential requests** (the `secrets` tool) never accept a value in chat. OpenClaw delivers a Control UI link, which needs `gateway.publicOrigin` set to the externally reachable Gateway origin; without it the agent reports a visible blocker instead of a dead link.
- **Rich presentations** (`--presentation`, tool payloads) render titles, context, dividers, and tables as Basecamp HTML; buttons, selects, and charts degrade to deterministic text.

## Agent tools

Agents connected through this channel have access to the following tools:

| Tool | Description |
|------|-------------|
| `basecamp_create_todo` | Create a new to-do item in a Basecamp to-do list |
| `basecamp_complete_todo` | Mark a to-do as complete |
| `basecamp_reopen_todo` | Reopen a completed to-do (mark as incomplete) |
| `basecamp_read_history` | Fetch recent messages or comments from a recording (chat transcript or comments) |
| `basecamp_add_boost` | Add a boost (reaction) to any recording -- emoji or short celebratory text |
| `basecamp_move_card` | Move a card to a different column in a card table |
| `basecamp_post_message` | Post a new message to a message board |
| `basecamp_answer_checkin` | Answer a check-in question |
| `basecamp_api_read` | GET any Basecamp 3 API resource (projects, people, todos, documents, schedules, etc.) |
| `basecamp_api_write` | POST/PUT/DELETE any Basecamp 3 API resource |

Tools are registered through `api.registerTool` and listed in the manifest's `contracts.tools`, so they appear on the capability-consent screen and can be allowlisted per agent with `tools.allow: ["basecamp"]` (every tool from the plugin) or by name. A tool call runs under the account mapped for the calling agent in `channels.basecamp.personas`, falling back to the default account. Without any configured account the tools still register and return `{ ok: false, error }` naming the missing config instead of silently disappearing.

## Known host limitations (openclaw 2026.8.1)

- `openclaw message send --channel basecamp …` is rejected at CLI argument validation with `Unknown channel "basecamp"`. The CLI checks the requested channel against the process-root plugin registry, which a CLI process never activates for non-bundled plugins (the plugin is loaded into a request-scoped registry instead). Sends through the gateway — the agent's `message` tool, cron/heartbeat announcements, and the channel's `outbound` adapter — are unaffected.
- Durable ingress queues and keyed/blob stores are trust-gated to bundled and official-catalog plugins; see `docs/upgrades/official-catalog-nomination.md`.
- Basecamp's account-wide progress feed omits the authenticated user's own activity, so a single-person sandbox cannot drive the poller with its own posts; use webhooks (or a second person) when testing inbound delivery.

## State and backups

OpenClaw's keyed stores and durable ingress queues are reserved for bundled and official-catalog plugins, so this plugin keeps its own state as JSON under `<stateDir>/plugins/basecamp/`:

- `cursors-<account>.json` -- polling cursors
- `recording-index-<account>.json` -- recording→bucket index for outbound targets and project-level bindings
- `webhook-secrets-<account>.json` -- per-project webhook HMAC secrets
- `tokens/<account>.json` -- OAuth tokens (with a companion `.client.json`)

The directory is declared in the manifest's `backupResources`, so `openclaw backup` includes it. Replay-guard (exactly-once) state lives in OpenClaw's shared plugin-state SQLite store with a 24h TTL and needs no separate backup. Webhook delivery is at-most-once, bounded by a per-account in-flight limit; correctness comes from polling.

## Development

```sh
git clone <repo-url>
cd openclaw-basecamp
npm install
npm run build          # required — OpenClaw loads dist/index.js and dist/setup-entry.js
npm run check          # typecheck + lint + tests
npm run manifest:gen   # regenerate openclaw.plugin.json after schema or tool changes
bash scripts/verify-pack.sh
```

Run the checkout inside a local Gateway either as a managed link install (creates an install record; re-consents on every `--force` reinstall):

```sh
openclaw plugins install --link /path/to/openclaw-basecamp --force --accept-capabilities
```

or as a bare load path (no install record, no consent tracking):

```yaml
plugins:
  load:
    paths: ["/path/to/openclaw-basecamp"]
```

Either way, rebuild (`npm run build`) after each change; the Gateway loads `dist/`. CI additionally proves the packed artifact installs cleanly: `npm pack`, then `openclaw plugins install npm-pack:<tgz> --force --accept-capabilities` and `openclaw plugins inspect basecamp --runtime --json` in a scratch `OPENCLAW_STATE_DIR`.
