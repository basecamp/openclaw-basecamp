#!/usr/bin/env tsx
/**
 * DF-022: Live outbound circuit breaker lifecycle test.
 *
 * Sends messages that trigger agent replies while the outbound API is
 * degraded, observing CB state transitions: closed → open → half-open → closed.
 *
 * This test is semi-automated: it sends real messages and prints CB state
 * at each stage for human verification. Full automation requires access to
 * the OpenClaw status API.
 *
 * Usage:
 *   npx tsx scripts/dogfood/outbound-cb-lifecycle.ts \
 *     --profile <bcq-profile> \
 *     --bucket <bucket-id> \
 *     --recording <campfire-recording-id> \
 *     [--threshold 3] [--cooldown 30]
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    bucket: { type: "string" },
    recording: { type: "string" },
    threshold: { type: "string", default: "3" },
    cooldown: { type: "string", default: "30" },
  },
});

if (!values.profile || !values.bucket || !values.recording) {
  console.error(
    "Usage: npx tsx outbound-cb-lifecycle.ts --profile <profile> --bucket <bucket-id> --recording <campfire-recording-id>",
  );
  process.exit(1);
}

const PROFILE = values.profile;
const BUCKET = values.bucket;
const RECORDING = values.recording;
const THRESHOLD = parseInt(values.threshold!, 10);
const COOLDOWN_S = parseInt(values.cooldown!, 10);

function bcq(args: string[]): string {
  return execFileSync("bcq", ["--profile", PROFILE, ...args], { encoding: "utf8", timeout: 30000 }).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`[DF-022] Outbound CB lifecycle test`);
  console.log(`[DF-022] threshold=${THRESHOLD}, cooldown=${COOLDOWN_S}s`);
  console.log(`[DF-022] bucket=${BUCKET}, recording=${RECORDING}`);
  console.log();

  // Phase 1: Send messages to trigger failures (outbound API should be blocked)
  console.log(`[DF-022] Phase 1: Sending ${THRESHOLD + 2} messages to trigger CB trip`);
  console.log("[DF-022] PREREQUISITE: Outbound API should be blocked (e.g. invalid bcq profile)");
  console.log();

  let sendSuccessCount = 0;
  for (let i = 0; i < THRESHOLD + 2; i++) {
    console.log(`[DF-022]   Sending message ${i + 1}/${THRESHOLD + 2}...`);
    try {
      bcq([
        "api", "post",
        `/buckets/${BUCKET}/chats/${RECORDING}/lines.json`,
        "--data", JSON.stringify({
          content: `<p>DF-022 CB test message ${i + 1} — safe to ignore</p>`,
        }),
      ]);
      sendSuccessCount++;
    } catch {
      console.log(`[DF-022]   (send failed)`);
    }
    await sleep(500);
  }

  if (sendSuccessCount === 0) {
    console.error(`[DF-022] FAIL — all ${THRESHOLD + 2} trigger messages failed to send.`);
    console.error("[DF-022] No inbound events generated, CB lifecycle cannot be exercised.");
    process.exit(1);
  }
  console.log(`[DF-022] ${sendSuccessCount}/${THRESHOLD + 2} trigger messages sent successfully.`);

  console.log();
  console.log("[DF-022] CHECK: CB should now be OPEN");
  console.log("[DF-022]   - delivery_failed logs should show for each attempt");
  console.log("[DF-022]   - dead_letter entries should be present");
  console.log(`[DF-022]   - dispatchFailureCount >= ${THRESHOLD}`);
  console.log(`[DF-022]   - circuitBreaker.outbound.state = "open"`);
  console.log();

  // Phase 2: Wait for cooldown, then send one more to trigger half-open probe
  console.log(`[DF-022] Phase 2: Waiting ${COOLDOWN_S}s for cooldown...`);
  await sleep(COOLDOWN_S * 1000 + 1000);

  console.log("[DF-022] PREREQUISITE: Restore outbound API access now (fix bcq profile)");
  console.log("[DF-022] Press Enter when ready, or wait 10s for auto-continue...");
  await sleep(10000);

  console.log("[DF-022] Sending probe message...");
  try {
    bcq([
      "api", "post",
      `/buckets/${BUCKET}/chats/${RECORDING}/lines.json`,
      "--data", JSON.stringify({
        content: "<p>DF-022 CB probe message — half-open test</p>",
      }),
    ]);
  } catch {
    console.log("[DF-022]   (send failed)");
  }

  console.log();
  console.log("[DF-022] CHECK: If outbound API is restored:");
  console.log("[DF-022]   - Half-open probe should succeed");
  console.log(`[DF-022]   - circuitBreaker.outbound.state = "closed"`);
  console.log("[DF-022]   - failures = 0");
  console.log();
  console.log("[DF-022] If outbound API is still blocked:");
  console.log("[DF-022]   - Half-open probe fails, CB re-trips");
  console.log(`[DF-022]   - circuitBreaker.outbound.state = "open"`);
  console.log();
  console.log("[DF-022] Done. Verify state via OpenClaw status adapter output.");
}

main().catch((err) => {
  console.error("[DF-022] Fatal:", err);
  process.exit(1);
});
