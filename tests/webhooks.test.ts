import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("../src/dispatch.js", () => ({
  dispatchBasecampEvent: vi.fn().mockResolvedValue(true),
}));
vi.mock("../src/runtime.js", () => ({
  getBasecampRuntime: vi.fn(() => ({
    config: {
      loadConfig: () => ({
        channels: {
          basecamp: {
            accounts: { default: { personId: "1" } },
            webhookSecret: "test-secret-123",
          },
        },
      }),
    },
  })),
}));
vi.mock("../src/config.js", () => ({
  resolveBasecampAccount: vi.fn(() => ({
    accountId: "default",
    enabled: true,
    personId: "1",
    token: "",
    tokenSource: "none",
    config: { personId: "1" },
  })),
  resolveDefaultBasecampAccountId: vi.fn(() => "default"),
  resolveWebhookSecret: vi.fn(() => "test-secret-123"),
  resolveAccountForBucket: vi.fn(() => undefined),
  listBasecampAccountIds: vi.fn(() => ["default"]),
}));
let webhookDedupSeq = 0;
vi.mock("../src/inbound/normalize.js", () => ({
  normalizeWebhookPayload: vi.fn(() => {
    const seq = ++webhookDedupSeq;
    return {
      channel: "basecamp",
      accountId: "default",
      peer: { kind: "group", id: `recording:${seq}` },
      sender: { id: "2", name: "Tester" },
      text: "hi",
      html: "<p>hi</p>",
      meta: { bucketId: "1", recordingId: String(seq), recordableType: "Chat::Line", eventKind: "line_created", mentions: [], mentionsAgent: false, attachments: [], sources: ["webhook"] },
      dedupKey: `webhook:${seq}`,
      createdAt: `2025-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    };
  }),
  isSelfMessage: vi.fn(() => false),
}));

import { Semaphore, handleBasecampWebhook, setWebhookStateDir, flushWebhookDedup } from "../src/inbound/webhooks.js";
import { resolveDefaultBasecampAccountId, resolveWebhookSecret, resolveAccountForBucket, listBasecampAccountIds } from "../src/config.js";
import { dispatchBasecampEvent } from "../src/dispatch.js";
import { getAccountMetrics, clearMetrics } from "../src/metrics.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveWebhookSecret).mockReturnValue("test-secret-123");
});

// ---------------------------------------------------------------------------
// L3: Semaphore concurrency limiter
// ---------------------------------------------------------------------------

describe("Semaphore", () => {
  it("acquires up to max concurrent", async () => {
    const sem = new Semaphore(3);

    await sem.acquire();
    await sem.acquire();
    await sem.acquire();

    // All 3 acquired, pending queue should be empty
    expect(sem.pending).toBe(0);
  });

  it("queues when at max", async () => {
    const sem = new Semaphore(2);

    await sem.acquire();
    await sem.acquire();

    // This should queue
    let resolved = false;
    const p = sem.acquire().then(() => { resolved = true; });

    // Give microtask a chance
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(sem.pending).toBe(1);

    // Release one to unblock
    sem.release();
    await p;
    expect(resolved).toBe(true);
    expect(sem.pending).toBe(0);
  });

  it("release unblocks queued in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    await sem.acquire();

    const p1 = sem.acquire().then(() => { order.push(1); });
    const p2 = sem.acquire().then(() => { order.push(2); });

    expect(sem.pending).toBe(2);

    // Release first queued
    sem.release();
    await p1;
    expect(order).toEqual([1]);

    // Release second queued
    sem.release();
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it("pending count is correct through lifecycle", async () => {
    const sem = new Semaphore(1);

    expect(sem.pending).toBe(0);

    await sem.acquire();
    expect(sem.pending).toBe(0);

    const p1 = sem.acquire();
    expect(sem.pending).toBe(1);

    const p2 = sem.acquire();
    expect(sem.pending).toBe(2);

    sem.release();
    await p1;
    expect(sem.pending).toBe(1);

    sem.release();
    await p2;
    expect(sem.pending).toBe(0);
  });

  it("handles rapid acquire/release cycles", async () => {
    const sem = new Semaphore(3);

    // Rapidly acquire and release 20 times
    for (let i = 0; i < 20; i++) {
      await sem.acquire();
      sem.release();
    }

    expect(sem.pending).toBe(0);

    // Can still acquire after rapid cycling
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    expect(sem.pending).toBe(0);

    sem.release();
    sem.release();
    sem.release();
  });

  it("throws when release() is called without matching acquire()", () => {
    const sem = new Semaphore(2);

    expect(() => sem.release()).toThrow("release() called without matching acquire()");
  });
});

// ---------------------------------------------------------------------------
// Webhook handler hardening
// ---------------------------------------------------------------------------

function mockReq(
  method: string,
  url: string,
  body?: string,
): IncomingMessage {
  const { Readable } = require("node:stream");
  const req = new Readable({
    read() {
      if (body) this.push(body);
      this.push(null);
    },
  }) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost:18789" };
  return req;
}

function mockRes(): ServerResponse & { status: number; body: string } {
  const res = {
    status: 0,
    body: "",
    writeHead(code: number, _headers?: Record<string, string>) {
      res.status = code;
    },
    end(data?: string) {
      res.body = data ?? "";
    },
  } as any;
  return res;
}

describe("handleBasecampWebhook — hardening", () => {
  it("rejects GET requests with 405", async () => {
    const req = mockReq("GET", "/webhooks/basecamp?token=test-secret-123");
    const res = mockRes();
    await handleBasecampWebhook(req, res);
    expect(res.status).toBe(405);
  });

  it("rejects requests when no webhookSecret configured", async () => {
    vi.mocked(resolveWebhookSecret).mockReturnValue(undefined);
    const req = mockReq("POST", "/webhooks/basecamp", "{}");
    const res = mockRes();
    await handleBasecampWebhook(req, res);
    expect(res.status).toBe(403);
    expect(res.body).toContain("webhookSecret");
  });

  it("rejects requests with wrong token", async () => {
    const req = mockReq("POST", "/webhooks/basecamp?token=wrong", "{}");
    const res = mockRes();
    await handleBasecampWebhook(req, res);
    expect(res.status).toBe(403);
    expect(res.body).toContain("Invalid webhook token");
  });

  it("rejects requests with no token", async () => {
    const req = mockReq("POST", "/webhooks/basecamp", "{}");
    const res = mockRes();
    await handleBasecampWebhook(req, res);
    expect(res.status).toBe(403);
  });

  it("accepts requests with correct token and valid payload", async () => {
    const payload = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 100, name: "Test" } },
      creator: { id: 2, name: "Tester" },
    });
    const req = mockReq("POST", "/webhooks/basecamp?token=test-secret-123", payload);
    const res = mockRes();
    await handleBasecampWebhook(req, res);
    expect(res.status).toBe(200);
  });

  it("rejects invalid JSON body with 400", async () => {
    const req = mockReq("POST", "/webhooks/basecamp?token=test-secret-123", "not json");
    const res = mockRes();
    await handleBasecampWebhook(req, res);
    expect(res.status).toBe(400);
  });

  it("rejects payload missing required fields with 422", async () => {
    const payload = JSON.stringify({ kind: "comment_created" });
    const req = mockReq("POST", "/webhooks/basecamp?token=test-secret-123", payload);
    const res = mockRes();
    await handleBasecampWebhook(req, res);
    expect(res.status).toBe(422);
  });

  it("drops unmapped bucket in multi-account mode instead of falling to default", async () => {
    // Multi-account: resolveAccountForBucket returns undefined (unmapped),
    // listBasecampAccountIds returns multiple accounts → should drop.
    vi.mocked(resolveAccountForBucket).mockReturnValue(undefined);
    vi.mocked(listBasecampAccountIds).mockReturnValue(["acct-a", "acct-b"]);

    const payload = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 999, name: "Unknown" } },
      creator: { id: 2, name: "Tester" },
    });
    const req = mockReq("POST", "/webhooks/basecamp?token=test-secret-123", payload);
    const res = mockRes();
    await handleBasecampWebhook(req, res);

    // Returns 200 (webhook acknowledged) but dispatch is NOT called
    expect(res.status).toBe(200);
    expect(dispatchBasecampEvent).not.toHaveBeenCalled();
  });

  it("allows unmapped bucket in single-account mode (unambiguous)", async () => {
    vi.mocked(resolveAccountForBucket).mockReturnValue(undefined);
    vi.mocked(listBasecampAccountIds).mockReturnValue(["default"]);

    const payload = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 100, name: "Test" } },
      creator: { id: 2, name: "Tester" },
    });
    const req = mockReq("POST", "/webhooks/basecamp?token=test-secret-123", payload);
    const res = mockRes();
    await handleBasecampWebhook(req, res);

    expect(res.status).toBe(200);
    expect(dispatchBasecampEvent).toHaveBeenCalled();
  });

  it("routes to sole non-default account when bucket is unmapped", async () => {
    // Single account named "work" (not "default") — should resolve via
    // resolveDefaultBasecampAccountId instead of falling to DEFAULT_ACCOUNT_ID.
    vi.mocked(resolveAccountForBucket).mockReturnValue(undefined);
    vi.mocked(listBasecampAccountIds).mockReturnValue(["work"]);
    vi.mocked(resolveDefaultBasecampAccountId).mockReturnValue("work");
    const { resolveBasecampAccount } = await import("../src/config.js");
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      accountId: "work",
      enabled: true,
      personId: "1",
      token: "",
      tokenSource: "none",
      config: { personId: "1" },
    });

    const payload = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 100, name: "Test" } },
      creator: { id: 2, name: "Tester" },
    });
    const req = mockReq("POST", "/webhooks/basecamp?token=test-secret-123", payload);
    const res = mockRes();
    await handleBasecampWebhook(req, res);

    expect(res.status).toBe(200);
    expect(dispatchBasecampEvent).toHaveBeenCalled();
    expect(resolveBasecampAccount).toHaveBeenCalledWith(
      expect.anything(),
      "work",
    );
  });
});

// ---------------------------------------------------------------------------
// Webhook dedup persistence
// ---------------------------------------------------------------------------

describe("webhook dedup persistence", () => {
  afterEach(() => {
    // Reset state dir for other tests (idempotent no-op if already empty)
    setWebhookStateDir("");
  });

  it("setWebhookStateDir and flushWebhookDedup are exported functions", () => {
    expect(typeof setWebhookStateDir).toBe("function");
    expect(typeof flushWebhookDedup).toBe("function");
  });

  it("setWebhookStateDir is idempotent (same dir does not flush)", () => {
    // Setting the same dir twice should not clear existing dedup instances
    setWebhookStateDir("/tmp/test-dir");
    setWebhookStateDir("/tmp/test-dir");
    // No throw, no clearing — second call is a no-op
    setWebhookStateDir("");
  });

  it("flushWebhookDedup does not throw when no state dir is set", () => {
    expect(() => flushWebhookDedup()).not.toThrow();
  });

  it("creates persistent dedup when state dir is configured", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "webhook-dedup-test-"));

    setWebhookStateDir(dir);

    // Process a webhook to trigger dedup creation
    const payload = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 100, name: "Test" } },
      creator: { id: 2, name: "Tester" },
    });
    const req = mockReq("POST", "/webhooks/basecamp?token=test-secret-123", payload);
    const res = mockRes();
    await handleBasecampWebhook(req, res);
    expect(res.status).toBe(200);

    // Flush to disk
    flushWebhookDedup();

    // Verify a dedup file was created
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(dir);
    const dedupFiles = files.filter((f: string) => f.startsWith("webhook-dedup-"));
    expect(dedupFiles.length).toBeGreaterThan(0);

    // Clean up temp directory
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Webhook metrics recording
// ---------------------------------------------------------------------------

describe("handleBasecampWebhook — metrics", () => {
  beforeEach(async () => {
    clearMetrics();
    // Ensure resolveBasecampAccount returns the expected default mock
    const { resolveBasecampAccount } = await import("../src/config.js");
    vi.mocked(resolveBasecampAccount).mockReturnValue({
      accountId: "default",
      enabled: true,
      personId: "1",
      token: "",
      tokenSource: "none",
      config: { personId: "1" },
    } as any);
  });

  afterEach(() => {
    clearMetrics();
  });

  it("records received and dispatched metrics on successful webhook", async () => {
    const payload = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 100, name: "Test" } },
      creator: { id: 2, name: "Tester" },
    });
    const req = mockReq("POST", "/webhooks/basecamp?token=test-secret-123", payload);
    const res = mockRes();
    await handleBasecampWebhook(req, res);
    expect(res.status).toBe(200);

    const metrics = getAccountMetrics("default");
    expect(metrics).toBeDefined();
    expect(metrics!.webhook.receivedCount).toBe(1);
    expect(metrics!.webhook.dispatchedCount).toBe(1);
    expect(metrics!.webhook.droppedCount).toBe(0);
    expect(metrics!.webhook.errorCount).toBe(0);
  });

  it("records dropped metric when self-message is filtered", async () => {
    const { isSelfMessage } = await import("../src/inbound/normalize.js");
    vi.mocked(isSelfMessage).mockReturnValueOnce(true);

    const payload = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 100, name: "Test" } },
      creator: { id: 2, name: "Tester" },
    });
    const req = mockReq("POST", "/webhooks/basecamp?token=test-secret-123", payload);
    const res = mockRes();
    await handleBasecampWebhook(req, res);

    const metrics = getAccountMetrics("default");
    expect(metrics).toBeDefined();
    expect(metrics!.webhook.receivedCount).toBe(1);
    expect(metrics!.webhook.droppedCount).toBe(1);
    expect(metrics!.webhook.dispatchedCount).toBe(0);
  });

  it("records dropped metric when dispatch returns false (route miss / policy drop)", async () => {
    vi.mocked(dispatchBasecampEvent).mockResolvedValueOnce(false);

    const payload = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 100, name: "Test" } },
      creator: { id: 2, name: "Tester" },
    });
    const req = mockReq("POST", "/webhooks/basecamp?token=test-secret-123", payload);
    const res = mockRes();
    await handleBasecampWebhook(req, res);

    const metrics = getAccountMetrics("default");
    expect(metrics).toBeDefined();
    expect(metrics!.webhook.receivedCount).toBe(1);
    expect(metrics!.webhook.droppedCount).toBe(1);
    expect(metrics!.webhook.dispatchedCount).toBe(0);
    expect(metrics!.webhook.errorCount).toBe(0);
  });

  it("records error metric on dispatch failure", async () => {
    vi.mocked(dispatchBasecampEvent).mockRejectedValueOnce(new Error("dispatch failed"));

    const payload = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 100, name: "Test" } },
      creator: { id: 2, name: "Tester" },
    });
    const req = mockReq("POST", "/webhooks/basecamp?token=test-secret-123", payload);
    const res = mockRes();
    await handleBasecampWebhook(req, res);

    const metrics = getAccountMetrics("default");
    expect(metrics).toBeDefined();
    expect(metrics!.webhook.receivedCount).toBe(1);
    expect(metrics!.webhook.errorCount).toBe(1);
    expect(metrics!.webhook.dispatchedCount).toBe(0);
  });
});
