# Live Dogfooding Scripts

Assisted runbooks for the dogfooding matrix live rows (DF-004, DF-011, DF-022).
Run against a local OpenClaw instance + real Basecamp.

These scripts drive real traffic and print structured output for operator
verification. They are **not fully automated** — pass/fail determination
requires inspecting OpenClaw logs or status adapter output.

## Prerequisites

- OpenClaw running locally with the Basecamp channel plugin
- `basecamp` CLI configured with a valid Basecamp profile
- Webhook endpoint reachable (localhost or tunnel)

## Usage

```bash
# Queue pressure burst (DF-004)
# Token auth (primary — matches real BC3 webhook flow):
npx tsx scripts/dogfood/queue-pressure-burst.ts \
  --endpoint http://localhost:3000/webhooks/basecamp \
  --token <webhook-secret> \
  [--count 150] [--status-url http://localhost:3000/status]

# HMAC auth (fallback — for testing the HMAC verification path):
npx tsx scripts/dogfood/queue-pressure-burst.ts \
  --endpoint http://localhost:3000/webhooks/basecamp \
  --hmac-secret <hmac-secret> \
  [--count 150]

# Webhook auth round-trip (DF-011)
# Token auth tested via payload URL; operator verifies dispatch in logs
npx tsx scripts/dogfood/webhook-auth-roundtrip.ts \
  --profile <basecamp-profile> \
  --bucket <bucket-id> \
  --project <project-id> \
  --payload-url http://localhost:3000/webhooks/basecamp \
  --token <webhook-secret> \
  [--status-url http://localhost:3000/status]

# Outbound CB lifecycle (DF-022)
# Manual verification: check status adapter for CB state transitions
npx tsx scripts/dogfood/outbound-cb-lifecycle.ts \
  --profile <basecamp-profile> \
  --bucket <bucket-id> \
  --recording <recording-id>
```

## Exit codes

| Script | Exit 0 | Exit 1 | Exit 2 |
|--------|--------|--------|--------|
| DF-004 | All 200s (+ metrics clean if `--status-url`) | HTTP failures or queue_full detected | Metrics endpoint unreachable |
| DF-011 | Token auth verified (with `--status-url`) or assisted runbook (without) | No token auth hits in metrics, or fatal error | — |
| DF-022 | Always (assisted runbook) | All trigger messages failed to send | — |

DF-022 requires operator verification of OpenClaw logs/status.
DF-004 and DF-011 can be gate-enforced with `--status-url`.
Without `--status-url`, DF-011 is an assisted runbook requiring manual log verification.
