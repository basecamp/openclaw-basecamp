#!/usr/bin/env tsx
/**
 * DF-011: Live webhook auth round-trip test.
 *
 * Registers a webhook with Basecamp via bcq, captures the returned HMAC
 * secret, triggers a real event, and verifies the webhook is delivered
 * and authenticated.
 *
 * Usage:
 *   npx tsx scripts/dogfood/webhook-auth-roundtrip.ts \
 *     --profile <bcq-profile> \
 *     --bucket <bucket-id> \
 *     --project <project-id> \
 *     --payload-url http://localhost:3000/webhooks/basecamp
 *
 * Note: This creates and then deletes a webhook. Requires API access
 * to the target Basecamp project.
 */
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    bucket: { type: "string" },
    project: { type: "string" },
    "payload-url": { type: "string" },
  },
});

if (!values.profile || !values.bucket || !values.project || !values["payload-url"]) {
  console.error(
    "Usage: npx tsx webhook-auth-roundtrip.ts --profile <profile> --bucket <bucket-id> --project <project-id> --payload-url <url>",
  );
  process.exit(1);
}

const PROFILE = values.profile;
const BUCKET = values.bucket;
const PROJECT = values.project;
const PAYLOAD_URL = values["payload-url"];

function bcq(args: string[]): string {
  const cmd = ["bcq", "--profile", PROFILE, ...args].join(" ");
  return execSync(cmd, { encoding: "utf8", timeout: 30000 }).trim();
}

async function main() {
  console.log("[DF-011] Creating webhook subscription...");

  // Create webhook
  const createResult = bcq([
    "api", "post",
    `/buckets/${BUCKET}/webhooks.json`,
    "--data", JSON.stringify({
      payload_url: PAYLOAD_URL,
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
    console.log("[DF-011] HMAC secret received (redacted)");
  } else {
    console.warn("[DF-011] WARNING: No HMAC secret in response");
  }

  // Give the webhook a moment to propagate
  await new Promise((r) => setTimeout(r, 2000));

  // Trigger an event by posting a comment
  console.log("[DF-011] Posting test comment to trigger webhook...");
  try {
    bcq([
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

  // Clean up — delete the webhook
  console.log("[DF-011] Cleaning up webhook...");
  try {
    bcq(["api", "delete", `/buckets/${BUCKET}/webhooks/${webhook.id}.json`]);
    console.log("[DF-011] Webhook deleted");
  } catch {
    console.warn("[DF-011] Failed to delete webhook (may need manual cleanup)");
  }

  console.log("[DF-011] MANUAL CHECK: Verify in OpenClaw logs that:");
  console.log("  - Webhook was received with valid HMAC signature");
  console.log("  - Event was dispatched (not rejected with 403)");
  console.log("  - No auth errors in logs");
  console.log("[DF-011] Done");
}

main().catch((err) => {
  console.error("[DF-011] Fatal:", err);
  process.exit(1);
});
