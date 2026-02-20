# Live Dogfooding Scripts

Assisted runbooks for the dogfooding matrix live rows (DF-004, DF-011, DF-022).
Run against a local OpenClaw instance + real Basecamp.

These scripts drive real traffic and print structured output for operator
verification. They are **not fully automated** — pass/fail determination
requires inspecting OpenClaw logs or status adapter output.

## Prerequisites

- OpenClaw running locally with the Basecamp channel plugin
- `bcq` CLI configured with a valid Basecamp profile
- Webhook endpoint reachable (localhost or tunnel)

## Usage

```bash
# Queue pressure burst (DF-004)
# --status-url enables automated metric check; without it, verify logs manually
npx tsx scripts/dogfood/queue-pressure-burst.ts \
  --endpoint http://localhost:3000/webhooks/basecamp \
  --secret <hmac-secret> \
  [--status-url http://localhost:3000/status]

# Webhook auth round-trip (DF-011)
# Manual verification: check OpenClaw logs for HMAC auth + dispatch
npx tsx scripts/dogfood/webhook-auth-roundtrip.ts \
  --profile <bcq-profile> \
  --bucket <bucket-id> \
  --project <project-id> \
  --payload-url http://localhost:3000/webhooks/basecamp

# Outbound CB lifecycle (DF-022)
# Manual verification: check status adapter for CB state transitions
npx tsx scripts/dogfood/outbound-cb-lifecycle.ts \
  --profile <bcq-profile> \
  --bucket <bucket-id> \
  --recording <recording-id>
```

## Exit codes

| Script | Exit 0 | Exit 1 | Exit 2 |
|--------|--------|--------|--------|
| DF-004 | All 200s (+ metrics clean if `--status-url`) | HTTP failures or queue_full detected | Metrics endpoint unreachable |
| DF-011 | Always (assisted runbook) | Fatal error | — |
| DF-022 | Always (assisted runbook) | All trigger messages failed to send | — |

DF-011 and DF-022 require operator verification of OpenClaw logs/status.
DF-004 can be fully automated with `--status-url`.
