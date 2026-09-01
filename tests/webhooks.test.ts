import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/dispatch.js", () => ({
  dispatchBasecampEvent: vi.fn().mockResolvedValue(true),
}));
const webhookTestCfg = {
  channels: {
    basecamp: {
      accounts: { default: { personId: "1" } },
      webhookSecret: "test-secret-123",
    },
  },
};
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
let _whTestStateDir = "";
vi.mock("../src/inbound/state-dir.js", () => ({
  resolvePluginStateDir: vi.fn(() => _whTestStateDir),
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
      dedupKey: `webhook:${seq}`,
      createdAt: `2025-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    };
  }),
  isSelfMessage: vi.fn(() => false),
}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listBasecampAccountIds,
  resolveAccountForBucket,
  resolveDefaultBasecampAccountId,
  resolveWebhookSecret,
} from "../src/config.js";
import { dispatchBasecampEvent } from "../src/dispatch.js";
import { resetReplayGuard } from "../src/inbound/replay-guard.js";
import { handleBasecampWebhook, webhookInFlightLimiter } from "../src/inbound/webhooks.js";
import { clearMetrics, getAccountMetrics } from "../src/metrics.js";
import { clearBasecampRuntime, setBasecampRuntime } from "../src/runtime.js";

beforeEach(() => {
  vi.clearAllMocks();
  _whTestStateDir = mkdtempSync(join(tmpdir(), "wh-test-"));
  process.env.OPENCLAW_STATE_DIR = _whTestStateDir;
  resetReplayGuard();
  setBasecampRuntime({ config: { current: () => webhookTestCfg } } as any);
  vi.mocked(resolveWebhookSecret).mockReturnValue("test-secret-123");
});

afterEach(() => {
  clearBasecampRuntime();
  resetReplayGuard();
  delete process.env.OPENCLAW_STATE_DIR;
  rmSync(_whTestStateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// L3: In-flight concurrency limiter (SDK webhook guard)
// ---------------------------------------------------------------------------

describe("webhookInFlightLimiter", () => {
  afterEach(() => {
    webhookInFlightLimiter.clear();
  });

  it("acquires up to the per-key cap and rejects beyond it", () => {
    for (let i = 0; i < 10; i++) {
      expect(webhookInFlightLimiter.tryAcquire("acct")).toBe(true);
    }
    expect(webhookInFlightLimiter.tryAcquire("acct")).toBe(false);
  });

  it("release frees a slot for the same key", () => {
    for (let i = 0; i < 10; i++) webhookInFlightLimiter.tryAcquire("acct");
    expect(webhookInFlightLimiter.tryAcquire("acct")).toBe(false);
    webhookInFlightLimiter.release("acct");
    expect(webhookInFlightLimiter.tryAcquire("acct")).toBe(true);
  });

  it("keys are independent", () => {
    for (let i = 0; i < 10; i++) webhookInFlightLimiter.tryAcquire("a");
    expect(webhookInFlightLimiter.tryAcquire("a")).toBe(false);
    expect(webhookInFlightLimiter.tryAcquire("b")).toBe(true);
  });

  it("clear drops all retained state", () => {
    webhookInFlightLimiter.tryAcquire("acct");
    expect(webhookInFlightLimiter.size()).toBeGreaterThan(0);
    webhookInFlightLimiter.clear();
    expect(webhookInFlightLimiter.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Webhook handler hardening
// ---------------------------------------------------------------------------

function mockReq(method: string, url: string, body?: string): IncomingMessage {
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
  (req as any).socket = { destroyed: false, writableEnded: false };
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
    expect(res.body).toContain("Invalid webhook signature or token");
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
    expect(resolveBasecampAccount).toHaveBeenCalledWith(expect.anything(), "work");
  });
});

// ---------------------------------------------------------------------------
// Webhook dedup via the shared replay guard
// ---------------------------------------------------------------------------

describe("webhook dedup via replay guard", () => {
  it("dedupes a repeated delivery of the same webhook event", async () => {
    const { normalizeWebhookPayload } = await import("../src/inbound/normalize.js");
    const fixedMsg = {
      channel: "basecamp",
      accountId: "default",
      peer: { kind: "group", id: "recording:777" },
      sender: { id: "2", name: "Tester" },
      text: "hi",
      html: "<p>hi</p>",
      meta: {
        bucketId: "1",
        recordingId: "777",
        recordableType: "Chat::Line",
        eventKind: "created",
        mentions: [],
        mentionsAgent: false,
        attachments: [],
        sources: ["webhook"],
      },
      dedupKey: "webhook:fixed-777",
      createdAt: "2025-01-01T00:00:00Z",
    };
    vi.mocked(normalizeWebhookPayload).mockResolvedValue(fixedMsg as any);

    const payload = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 777, type: "Comment", bucket: { id: 100, name: "Test" } },
      creator: { id: 2, name: "Tester" },
    });

    for (const _ of [0, 1]) {
      const req = mockReq("POST", "/webhooks/basecamp?token=test-secret-123", payload);
      const res = mockRes();
      await handleBasecampWebhook(req, res);
      expect(res.status).toBe(200);
    }

    // Both deliveries acknowledged, but the agent dispatch ran exactly once.
    expect(dispatchBasecampEvent).toHaveBeenCalledTimes(1);
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
