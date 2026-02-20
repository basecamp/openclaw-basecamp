#!/usr/bin/env tsx
/**
 * DF-004: Live queue pressure burst test.
 *
 * Sends a burst of signed webhook payloads to the local OpenClaw endpoint
 * and verifies that all return 200 without triggering queue_full drops.
 *
 * Usage:
 *   npx tsx scripts/dogfood/queue-pressure-burst.ts \
 *     --endpoint http://localhost:3000/webhooks/basecamp \
 *     --secret <hmac-secret> \
 *     [--count 150] [--bucket 1]
 */
import crypto from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    endpoint: { type: "string" },
    secret: { type: "string" },
    count: { type: "string", default: "150" },
    bucket: { type: "string", default: "1" },
    "status-url": { type: "string" },
  },
});

if (!values.endpoint || !values.secret) {
  console.error("Usage: npx tsx queue-pressure-burst.ts --endpoint <url> --secret <hmac-secret> [--status-url <url>]");
  process.exit(1);
}

const ENDPOINT = values.endpoint;
const SECRET = values.secret;
const COUNT = parseInt(values.count!, 10);
const BUCKET_ID = parseInt(values.bucket!, 10);
const STATUS_URL = values["status-url"];

function makePayload(seq: number) {
  return JSON.stringify({
    kind: "line_created",
    recording: {
      id: 10000 + seq,
      type: "Chat::Line",
      bucket: { id: BUCKET_ID, type: "Project" },
      title: `Burst test message ${seq}`,
      content: `<p>Burst test ${seq}</p>`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      url: `https://3.basecampapi.com/1/buckets/${BUCKET_ID}/chats/1/lines/${10000 + seq}.json`,
    },
    creator: {
      id: 99999,
      name: "Burst Tester",
      email_address: "burst@test.local",
    },
  });
}

function sign(body: string): { signature: string; timestamp: string } {
  const ts = String(Math.floor(Date.now() / 1000));
  const hmac = crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
  return { signature: `sha256=${hmac}`, timestamp: ts };
}

async function sendWebhook(seq: number): Promise<{ seq: number; status: number; ok: boolean }> {
  const body = makePayload(seq);
  const { signature, timestamp } = sign(body);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Basecamp-Signature": signature,
      "X-Basecamp-Timestamp": timestamp,
    },
    body,
  });

  return { seq, status: res.status, ok: res.ok };
}

async function main() {
  console.log(`[DF-004] Sending ${COUNT} webhooks to ${ENDPOINT}`);
  const start = Date.now();

  // Fire all at once — maximum pressure
  const results = await Promise.all(
    Array.from({ length: COUNT }, (_, i) => sendWebhook(i)),
  );

  const elapsed = Date.now() - start;
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log(`[DF-004] Completed in ${elapsed}ms`);
  console.log(`[DF-004] ${ok.length}/${COUNT} returned 200`);

  if (failed.length > 0) {
    const statusCounts = new Map<number, number>();
    for (const r of failed) {
      statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
    }
    console.log(`[DF-004] Failures:`, Object.fromEntries(statusCounts));
  }

  if (failed.length > 0) {
    console.log("[DF-004] FAIL — some webhooks rejected");
    process.exit(1);
  }

  // All 200s is necessary but not sufficient — handler returns 200 before dispatch.
  // Check status endpoint for the real signal if available.
  if (STATUS_URL) {
    console.log(`[DF-004] Waiting 2s for dispatch to settle...`);
    await new Promise((r) => setTimeout(r, 2000));
    console.log(`[DF-004] Checking metrics at ${STATUS_URL}...`);
    try {
      const res = await fetch(STATUS_URL);
      const status = await res.json() as Record<string, unknown>;
      const accounts = status.accounts as Record<string, { queueFullDropCount?: number }> | undefined;
      const drops = accounts
        ? Object.values(accounts).reduce((sum, a) => sum + (a.queueFullDropCount ?? 0), 0)
        : 0;
      if (drops > 0) {
        console.log(`[DF-004] FAIL — ${drops} events dropped to queue_full`);
        process.exit(1);
      }
      console.log("[DF-004] PASS — all webhooks accepted, no queue_full drops in metrics");
      process.exit(0);
    } catch (err) {
      console.error("[DF-004] WARNING — could not check status endpoint:", err);
      console.log("[DF-004] INCONCLUSIVE — all 200s but metrics unverified. Check logs for queue_full.");
      process.exit(2);
    }
  } else {
    console.log("[DF-004] INCONCLUSIVE — all 200s (necessary but not sufficient).");
    console.log("[DF-004] Handler returns 200 before dispatch — queue_full drops are invisible to HTTP status.");
    console.log("[DF-004] Provide --status-url to check metrics, or verify no queue_full in logs.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[DF-004] Fatal:", err);
  process.exit(1);
});
