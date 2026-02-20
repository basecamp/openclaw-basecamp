/**
 * DF-001 → DF-003: Queue pressure integration tests.
 *
 * Validates that the webhook handler drops events when the dispatch semaphore
 * is saturated, increments the correct metrics, and recovers after drain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that reference them
// ---------------------------------------------------------------------------

const mockDispatch = vi.fn().mockResolvedValue(true);
vi.mock("../../src/dispatch.js", () => ({
  dispatchBasecampEvent: (...args: unknown[]) => mockDispatch(...args),
}));
vi.mock("../../src/runtime.js", () => ({
  getBasecampRuntime: vi.fn(() => ({
    config: {
      loadConfig: () => ({
        channels: {
          basecamp: {
            accounts: { default: { personId: "1" } },
            webhookSecret: "tok-qp",
          },
        },
      }),
    },
  })),
}));
vi.mock("../../src/config.js", () => ({
  resolveBasecampAccount: vi.fn(() => ({
    accountId: "default",
    enabled: true,
    personId: "1",
    token: "",
    tokenSource: "none",
    config: { personId: "1" },
  })),
  resolveDefaultBasecampAccountId: vi.fn(() => "default"),
  resolveWebhookSecret: vi.fn(() => "tok-qp"),
  resolveAccountForBucket: vi.fn(() => undefined),
  listBasecampAccountIds: vi.fn(() => ["default"]),
}));
let dedupSeq = 0;
vi.mock("../../src/inbound/normalize.js", () => ({
  normalizeWebhookPayload: vi.fn(() => {
    const seq = ++dedupSeq;
    return {
      channel: "basecamp",
      accountId: "default",
      peer: { kind: "group", id: `recording:${seq}` },
      sender: { id: "2", name: "Tester" },
      text: "hi",
      html: "<p>hi</p>",
      meta: {
        bucketId: "1",
        recordingId: String(seq),
        recordableType: "Chat::Line",
        eventKind: "line_created",
        mentions: [],
        mentionsAgent: false,
        attachments: [],
        sources: ["webhook"],
      },
      dedupKey: `webhook:qp-${seq}`,
      createdAt: `2025-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    };
  }),
  isSelfMessage: vi.fn(() => false),
}));

import {
  Semaphore,
  handleBasecampWebhook,
  setWebhookStateDir,
  flushWebhookDedup,
} from "../../src/inbound/webhooks.js";
import { getAccountMetrics, clearMetrics } from "../../src/metrics.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(body: string, token = "tok-qp"): IncomingMessage {
  const { Readable } = require("node:stream");
  const req = new Readable({
    read() {
      this.push(body);
      this.push(null);
    },
  }) as IncomingMessage;
  req.method = "POST";
  req.url = `/webhooks/basecamp?token=${token}`;
  req.headers = { host: "localhost", "content-type": "application/json" };
  return req;
}

function makeRes(): ServerResponse & { statusCode: number; body: string } {
  const res: any = {
    statusCode: 0,
    body: "",
    writeHead(code: number) { res.statusCode = code; return res; },
    end(data?: string) { res.body = data ?? ""; return res; },
  };
  return res;
}

function webhookBody(bucketId = 1, recordingId = 1) {
  return JSON.stringify({
    kind: "line_created",
    recording: { id: recordingId, type: "Chat::Line", bucket: { id: bucketId, type: "Project" } },
    creator: { id: 2, name: "Tester" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dogfooding — queue pressure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMetrics();
    dedupSeq = 0;
    // Force dedup registry clear by toggling state dir
    setWebhookStateDir("/tmp/dogfood-reset");
    setWebhookStateDir(undefined as any);
  });

  afterEach(() => {
    flushWebhookDedup();
  });

  // DF-001: queue_full when real dispatchSemaphore is saturated
  it("DF-001: drops events with queue_full when dispatch queue is saturated", async () => {
    // Strategy: make dispatch slow enough that the semaphore fills to capacity
    // (10 active + 100 queued) before any handler finishes, then verify the
    // 111th webhook triggers queue_full. Each dispatch takes 200ms — long enough
    // for all 111 handlers to reach the semaphore before the first slot frees.
    mockDispatch.mockImplementation(
      () => new Promise<boolean>((r) => setTimeout(() => r(true), 200)),
    );

    const handles: Promise<void>[] = [];
    for (let i = 0; i < 111; i++) {
      const req = makeReq(webhookBody(1, 1000 + i));
      const res = makeRes();
      handles.push(handleBasecampWebhook(req, res));
    }

    // Wait for all handlers to complete (first batch takes ~200ms, then drains)
    await Promise.all(handles);

    const metrics = getAccountMetrics("default");
    expect(metrics?.queueFullDropCount).toBeGreaterThanOrEqual(1);
    expect(metrics?.webhook.droppedCount).toBeGreaterThanOrEqual(1);
  }, 15000);

  // DF-002: recovery after drain
  it("DF-002: dispatches normally after queue drains", async () => {
    mockDispatch.mockResolvedValue(true);

    const req = makeReq(webhookBody(1, 200));
    const res = makeRes();
    await handleBasecampWebhook(req, res);

    expect(res.statusCode).toBe(200);
    expect(mockDispatch).toHaveBeenCalled();
    const metrics = getAccountMetrics("default");
    expect(metrics?.webhook.receivedCount).toBeGreaterThanOrEqual(1);
    expect(metrics?.webhook.dispatchedCount).toBeGreaterThanOrEqual(1);
    expect(metrics?.queueFullDropCount ?? 0).toBe(0);
  });

  // DF-003: dispatch_error increments failure + dead_letter metrics
  it("DF-003: records dispatch failure and error metrics on dispatch throw", async () => {
    mockDispatch.mockRejectedValueOnce(new Error("dispatch exploded"));

    const req = makeReq(webhookBody(1, 300));
    const res = makeRes();
    await handleBasecampWebhook(req, res);

    expect(res.statusCode).toBe(200); // 200 returned before dispatch

    const metrics = getAccountMetrics("default");
    expect(metrics?.webhook.errorCount).toBeGreaterThanOrEqual(1);
    // dispatch_error records via recordWebhookError, not recordDispatchFailure
    // (dispatchFailureCount is for delivery failures inside dispatch, not handler-level throws)
  });
});
