#!/usr/bin/env tsx
/**
 * DF-011: Live webhook auth round-trip test.
 *
 * Registers a webhook with Basecamp via the basecamp CLI (with token auth
 * baked into the payload URL), triggers a real event, and verifies the
 * webhook is delivered and authenticated via the token path.
 *
 * BC3 does not return HMAC secrets, so token auth (?token=<secret>) is
 * the primary mechanism. If BC3 ever returns a secret, the script logs
 * that the HMAC fallback path can also be verified.
 *
 * Usage:
 *   npx tsx scripts/dogfood/webhook-auth-roundtrip.ts \
 *     --profile <basecamp-profile> \
 *     --bucket <bucket-id> \
 *     --project <project-id> \
 *     --payload-url http://localhost:3000/webhooks/basecamp \
 *     --token <webhook-secret> \
 *     [--status-url http://localhost:3000/status]
 *
 * Note: This creates and then deletes a webhook. Requires API access
 * to the target Basecamp project.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    bucket: { type: "string" },
    project: { type: "string" },
    "payload-url": { type: "string" },
    token: { type: "string" },
    "status-url": { type: "string" },
  },
});

if (!values.profile || !values.bucket || !values.project || !values["payload-url"] || !values.token) {
  console.error(
    "Usage: npx tsx webhook-auth-roundtrip.ts --profile <profile> --bucket <bucket-id> " +
    "--project <project-id> --payload-url <url> --token <webhook-secret> [--status-url <url>]",
  );
  process.exit(1);
}

const PROFILE = values.profile;
const BUCKET = values.bucket;
const PROJECT = values.project;
const PAYLOAD_URL = values["payload-url"];
const TOKEN = values.token;
const STATUS_URL = values["status-url"];

function basecamp(args: string[]): string {
  return execFileSync("basecamp", ["--profile", PROFILE, ...args], { encoding: "utf8", timeout: 30000 }).trim();
}

async function main() {
  console.log("[DF-011] Creating webhook subscription...");

  // Bake token into the payload URL so BC3 sends it back on every delivery
  const sep = PAYLOAD_URL.includes("?") ? "&" : "?";
  const tokenizedUrl = `${PAYLOAD_URL}${sep}token=${encodeURIComponent(TOKEN)}`;

  // Create webhook
  const createResult = basecamp([
    "api", "post",
    `/buckets/${BUCKET}/webhooks.json`,
    "--data", JSON.stringify({
      payload_url: tokenizedUrl,
      types: ["Comment"],
    }),
  ]);

  let webhook: { id: number; secret?: string };
  try {
    webhook = JSON.parse(createResult);
  } catch {
    console.error("[DF-011] Failed to parse webhook creation response:", createResult);
    process.exit(1);
  }

  console.log(`[DF-011] Webhook created: id=${webhook.id}`);
  if (webhook.secret) {
    console.log("[DF-011] Unexpected: HMAC secret returned (redacted). Will test HMAC path too.");
  } else {
    console.log("[DF-011] No HMAC secret (expected for BC3). Token auth will be tested.");
  }

  // Give the webhook a moment to propagate
  await new Promise((r) => setTimeout(r, 2000));

  // Trigger an event by posting a comment
  console.log("[DF-011] Posting test comment to trigger webhook...");
  try {
    basecamp([
      "api", "post",
      `/buckets/${BUCKET}/recordings/${PROJECT}/comments.json`,
      "--data", JSON.stringify({ content: "<p>DF-011 dogfood test — safe to ignore</p>" }),
    ]);
    console.log("[DF-011] Comment posted. Webhook should fire shortly.");
  } catch (err) {
    console.error("[DF-011] Failed to post comment:", err);
  }

  // Wait for delivery (webhook is async)
  console.log("[DF-011] Waiting 5s for webhook delivery...");
  await new Promise((r) => setTimeout(r, 5000));

  // Check status endpoint for auth method metrics if available.
  // When --status-url is provided, this is gate-enforcing: exit 1 if
  // no token auth hits were recorded.
  let gateResult: "pass" | "fail" | "skip" = "skip";
  if (STATUS_URL) {
    try {
      const res = await fetch(STATUS_URL);
      const status = await res.json() as Record<string, unknown>;
      const accounts = status.accounts as Record<string, { webhook?: { authMethods?: Record<string, number> } }> | undefined;
      let totalTokenHits = 0;
      if (accounts) {
        for (const [id, acct] of Object.entries(accounts)) {
          const tokenHits = acct.webhook?.authMethods?.["token"] ?? 0;
          const hmacHits = acct.webhook?.authMethods?.["hmac"] ?? 0;
          totalTokenHits += tokenHits;
          console.log(`[DF-011] Account ${id}: token=${tokenHits}, hmac=${hmacHits}`);
        }
      }
      if (totalTokenHits > 0) {
        console.log(`[DF-011] PASS — token auth recorded (${totalTokenHits} hit(s))`);
        gateResult = "pass";
      } else {
        console.error("[DF-011] FAIL — no token auth hits in metrics after webhook delivery");
        gateResult = "fail";
      }
    } catch (err) {
      console.error("[DF-011] FAIL — status endpoint unreachable:", err);
      gateResult = "fail";
    }
  }

  // Clean up — delete the webhook
  console.log("[DF-011] Cleaning up webhook...");
  try {
    basecamp(["api", "delete", `/buckets/${BUCKET}/webhooks/${webhook.id}.json`]);
    console.log("[DF-011] Webhook deleted");
  } catch {
    console.warn("[DF-011] Failed to delete webhook (may need manual cleanup)");
  }

  if (gateResult === "fail") {
    process.exit(1);
  }

  if (gateResult === "skip") {
    console.log("[DF-011] MANUAL CHECK: Verify in OpenClaw logs that:");
    console.log("  - Webhook was received and authenticated via token auth");
    console.log("  - authMethod='token' recorded in metrics");
    console.log("  - Event was dispatched (not rejected with 403)");
    console.log("  - No auth errors in logs");
    if (webhook.secret) {
      console.log("  - (Bonus) HMAC secret was returned — verify HMAC fallback also works");
    }
  }
  console.log("[DF-011] Done");
}

main().catch((err) => {
  console.error("[DF-011] Fatal:", err);
  process.exit(1);
});
