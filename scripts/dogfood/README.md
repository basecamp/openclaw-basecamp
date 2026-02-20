# Live Dogfooding Scripts

Scenario runners for the dogfooding matrix live rows (DF-004, DF-011, DF-022).
Run against a local OpenClaw instance + real Basecamp.

## Prerequisites

- OpenClaw running locally with the Basecamp channel plugin
- `bcq` CLI configured with a valid Basecamp profile
- Webhook endpoint reachable (localhost or tunnel)

## Usage

```bash
# Queue pressure burst (DF-004)
npx tsx scripts/dogfood/queue-pressure-burst.ts --endpoint http://localhost:3000/webhooks/basecamp --secret <hmac-secret>

# Webhook auth round-trip (DF-011)
npx tsx scripts/dogfood/webhook-auth-roundtrip.ts --profile <bcq-profile> --bucket <bucket-id> --project <project-id>

# Outbound CB lifecycle (DF-022)
npx tsx scripts/dogfood/outbound-cb-lifecycle.ts --profile <bcq-profile> --bucket <bucket-id> --recording <recording-id>
```

## Pass criteria

Each script exits 0 on success, 1 on failure, with structured output describing
what was tested and what passed/failed.
