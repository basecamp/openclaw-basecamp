# @37signals/openclaw-basecamp

OpenClaw channel plugin for Basecamp. Connects Campfire chats, card tables, to-do lists, check-ins, pings, and message boards to OpenClaw agents -- every Basecamp surface as a live agent interaction point.

## Prerequisites

- [OpenClaw](https://openclaw.dev) (latest version)
- Node.js >= 22.5 (required for `node:sqlite`)
- A Basecamp account plus either:
  - An OAuth app you control (client ID + secret), registered at [launchpad.37signals.com/integrations](https://launchpad.37signals.com/integrations), or
  - An authenticated Basecamp CLI profile with stored credentials that the onboarding wizard can import

## Installation

```sh
openclaw plugins install @37signals/openclaw-basecamp
```

## Quick start

```sh
openclaw channels add
```

Select **Basecamp** from the list, then follow the onboarding wizard. It handles:

1. OAuth app setup (or importing credentials from an existing Basecamp CLI profile)
2. Browser-based authentication and token creation
3. Identity discovery and Basecamp account selection
4. Writing the channel configuration

## Configuration

All configuration lives under `channels.basecamp` in your OpenClaw config file.

| Key | Type | Description |
|-----|------|-------------|
| `enabled` | `boolean` | Enable or disable the channel |
| `accounts` | `object` | Per-account auth config (personId, token/tokenFile, OAuth credentials) |
| `personas` | `object` | Map agent IDs to Basecamp account IDs for message routing (agent tools still execute under the default account) |
| `dmPolicy` | `"pairing" \| "allowlist" \| "open" \| "disabled"` | How the agent handles Basecamp Pings (DMs). Default: `"pairing"` |
| `allowFrom` | `string[]` | Global allowlist of Basecamp person IDs permitted to interact |
| `engage` | `string[]` | Engagement types to respond to: `dm`, `mention`, `assignment`, `checkin`, `conversation`, `activity` |
| `buckets` | `object` | Per-project overrides (requireMention, tool allow/deny lists, engage types, allowFrom) |
| `webhooks` | `object` | Webhook subscription config: `payloadUrl`, `projects`, `types`, `autoRegister`, `deactivateOnStop` |
| `webhookSecret` | `string` | Secret token for webhook URL verification |
| `oauth` | `object` | Channel-level OAuth credentials (`clientId`, `clientSecret`) shared across accounts |
| `polling` | `object` | Polling intervals: `activityIntervalMs` (default 120s), `readingsIntervalMs` (60s), `assignmentsIntervalMs` (300s) |
| `retry` | `object` | Retry behavior: `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `jitter` |
| `circuitBreaker` | `object` | Circuit breaker: `threshold`, `cooldownMs` |
| `safetyNet` | `object` | Safety net polling for missed events: `projects`, `intervalMs` |
| `reconciliation` | `object` | Gap reconciliation: `enabled`, `intervalMs` |

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

## Development

```sh
git clone <repo-url>
cd basecamp-openclaw-plugin
npm install
npm test
npm run typecheck
```
