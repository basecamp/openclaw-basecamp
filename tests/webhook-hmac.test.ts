import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
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
            // No webhookSecret — HMAC-only mode
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
  resolveWebhookSecret: vi.fn(() => undefined),
  resolveAccountForBucket: vi.fn(() => undefined),
  listBasecampAccountIds: vi.fn(() => ["default"]),
}));
let hmacDedupSeq = 100;
vi.mock("../src/inbound/normalize.js", () => ({
  normalizeWebhookPayload: vi.fn(() => {
    const seq = ++hmacDedupSeq;
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
        recordableType: "Comment",
        eventKind: "created",
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

import {
  verifyWebhookSignature,
  handleBasecampWebhook,
  getWebhookSecretRegistry,
  setWebhookStateDir,
} from "../src/inbound/webhooks.js";
import { WebhookSecretRegistry, JsonFileWebhookSecretStore } from "../src/inbound/webhook-secrets.js";
import { resolveAccountForBucket } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signPayload(secret: string, timestamp: string, body: string): string {
  return (
    "sha256=" +
    crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
  );
}

function mockReq(
  method: string,
  url: string,
  body?: string,
  headers?: Record<string, string>,
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
  req.headers = { host: "localhost:18789", ...headers };
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

// ---------------------------------------------------------------------------
// verifyWebhookSignature unit tests
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature", () => {
  const secret = "test-webhook-secret-abc123";
  const body = '{"kind":"comment_created","recording":{"id":1}}';
  const timestamp = String(Math.floor(Date.now() / 1000));

  it("accepts valid HMAC-SHA256 signature", () => {
    const signature = signPayload(secret, timestamp, body);
    expect(
      verifyWebhookSignature({
        signature,
        timestamp,
        rawBody: body,
        secrets: [secret],
      }),
    ).toBe(true);
  });

  it("rejects invalid signature", () => {
    expect(
      verifyWebhookSignature({
        signature: "sha256=deadbeef",
        timestamp,
        rawBody: body,
        secrets: [secret],
      }),
    ).toBe(false);
  });

  it("rejects when no secrets provided", () => {
    const signature = signPayload(secret, timestamp, body);
    expect(
      verifyWebhookSignature({
        signature,
        timestamp,
        rawBody: body,
        secrets: [],
      }),
    ).toBe(false);
  });

  it("rejects expired timestamp (replay protection)", () => {
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const signature = signPayload(secret, oldTimestamp, body);
    expect(
      verifyWebhookSignature({
        signature,
        timestamp: oldTimestamp,
        rawBody: body,
        secrets: [secret],
      }),
    ).toBe(false);
  });

  it("rejects non-numeric timestamp", () => {
    const signature = signPayload(secret, "not-a-number", body);
    expect(
      verifyWebhookSignature({
        signature,
        timestamp: "not-a-number",
        rawBody: body,
        secrets: [secret],
      }),
    ).toBe(false);
  });

  it("tries multiple secrets and accepts if any matches", () => {
    const signature = signPayload(secret, timestamp, body);
    expect(
      verifyWebhookSignature({
        signature,
        timestamp,
        rawBody: body,
        secrets: ["wrong-secret-1", "wrong-secret-2", secret],
      }),
    ).toBe(true);
  });

  it("rejects when body has been tampered with", () => {
    const signature = signPayload(secret, timestamp, body);
    expect(
      verifyWebhookSignature({
        signature,
        timestamp,
        rawBody: body + "tampered",
        secrets: [secret],
      }),
    ).toBe(false);
  });

  it("rejects empty signature", () => {
    expect(
      verifyWebhookSignature({
        signature: "",
        timestamp,
        rawBody: body,
        secrets: [secret],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WebhookSecretRegistry unit tests
// ---------------------------------------------------------------------------

describe("WebhookSecretRegistry", () => {
  it("stores and retrieves entries by project ID", () => {
    const reg = new WebhookSecretRegistry();
    reg.set("123", {
      webhookId: "w1",
      secret: "secret-abc",
      payloadUrl: "https://example.com/webhooks",
      types: ["Todo", "Comment"],
    });

    const entry = reg.get("123");
    expect(entry).toBeDefined();
    expect(entry!.secret).toBe("secret-abc");
    expect(entry!.webhookId).toBe("w1");
  });

  it("getAllSecrets returns unique secrets", () => {
    const reg = new WebhookSecretRegistry();
    reg.set("100", {
      webhookId: "w1",
      secret: "secret-a",
      payloadUrl: "https://example.com/wh",
      types: [],
    });
    reg.set("200", {
      webhookId: "w2",
      secret: "secret-b",
      payloadUrl: "https://example.com/wh",
      types: [],
    });
    // Duplicate secret
    reg.set("300", {
      webhookId: "w3",
      secret: "secret-a",
      payloadUrl: "https://example.com/wh",
      types: [],
    });

    const secrets = reg.getAllSecrets();
    expect(secrets).toHaveLength(2);
    expect(secrets).toContain("secret-a");
    expect(secrets).toContain("secret-b");
  });

  it("remove deletes an entry", () => {
    const reg = new WebhookSecretRegistry();
    reg.set("100", {
      webhookId: "w1",
      secret: "s",
      payloadUrl: "u",
      types: [],
    });
    expect(reg.size).toBe(1);
    reg.remove("100");
    expect(reg.size).toBe(0);
    expect(reg.get("100")).toBeUndefined();
  });

  it("persists to backing store", () => {
    const { mkdtempSync, rmSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "wh-secrets-test-"));
    const filePath = join(dir, "secrets.json");

    const store = new JsonFileWebhookSecretStore(filePath);
    const reg = new WebhookSecretRegistry(store);

    reg.set("42", {
      webhookId: "w99",
      secret: "persist-test",
      payloadUrl: "https://example.com",
      types: ["Todo"],
    });

    // Load from a fresh registry backed by the same file
    const reg2 = new WebhookSecretRegistry(new JsonFileWebhookSecretStore(filePath));
    const entry = reg2.get("42");
    expect(entry).toBeDefined();
    expect(entry!.secret).toBe("persist-test");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// HMAC verification in handleBasecampWebhook integration test
// ---------------------------------------------------------------------------

describe("handleBasecampWebhook — HMAC authentication", () => {
  const webhookSecret = "hmac-test-secret-xyz";

  beforeEach(() => {
    vi.clearAllMocks();
    // Seed a webhook secret into the registry so HMAC verification can find it
    const reg = getWebhookSecretRegistry("default");
    reg.set("100", {
      webhookId: "w1",
      secret: webhookSecret,
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: ["Comment"],
    });
  });

  afterEach(() => {
    // Clean up registries
    setWebhookStateDir("");
  });

  it("accepts request with valid HMAC signature (no query token needed)", async () => {
    const body = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 100, name: "Test" } },
      creator: { id: 2, name: "Tester" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signPayload(webhookSecret, timestamp, body);

    const req = mockReq("POST", "/webhooks/basecamp", body, {
      "x-basecamp-signature": signature,
      "x-basecamp-timestamp": timestamp,
    });
    const res = mockRes();
    await handleBasecampWebhook(req, res);

    expect(res.status).toBe(200);
  });

  it("rejects request with invalid HMAC signature", async () => {
    const body = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 100, name: "Test" } },
      creator: { id: 2, name: "Tester" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));

    const req = mockReq("POST", "/webhooks/basecamp", body, {
      "x-basecamp-signature": "sha256=invalid",
      "x-basecamp-timestamp": timestamp,
    });
    const res = mockRes();
    await handleBasecampWebhook(req, res);

    expect(res.status).toBe(403);
    expect(res.body).toContain("Invalid webhook signature or token");
  });

  it("rejects request with expired HMAC timestamp", async () => {
    const body = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 100, name: "Test" } },
      creator: { id: 2, name: "Tester" },
    });
    // 10 minutes ago — beyond the 5-minute window
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const signature = signPayload(webhookSecret, oldTimestamp, body);

    const req = mockReq("POST", "/webhooks/basecamp", body, {
      "x-basecamp-signature": signature,
      "x-basecamp-timestamp": oldTimestamp,
    });
    const res = mockRes();
    await handleBasecampWebhook(req, res);

    expect(res.status).toBe(403);
  });

  it("uses bucket-scoped secret when resolveAccountForBucket returns concrete account ID", async () => {
    // Seed a secret on a different account "acct-42"
    const scopedSecret = "bucket-scoped-secret-42";
    const reg = getWebhookSecretRegistry("acct-42");
    reg.set("777", {
      webhookId: "w-scoped",
      secret: scopedSecret,
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: ["Comment"],
    });

    // Make resolveAccountForBucket return the concrete account ID for bucket 777
    vi.mocked(resolveAccountForBucket).mockReturnValue("acct-42");

    const body = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 777, name: "Scoped" } },
      creator: { id: 2, name: "Tester" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signPayload(scopedSecret, timestamp, body);

    const req = mockReq("POST", "/webhooks/basecamp", body, {
      "x-basecamp-signature": signature,
      "x-basecamp-timestamp": timestamp,
    });
    const res = mockRes();
    await handleBasecampWebhook(req, res);

    expect(res.status).toBe(200);
  });

  it("rejects HMAC when bucket-scoped account has wrong secret", async () => {
    // Seed a secret on "acct-42" but sign with a different secret
    const reg = getWebhookSecretRegistry("acct-42");
    reg.set("777", {
      webhookId: "w-scoped",
      secret: "actual-secret",
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: ["Comment"],
    });

    vi.mocked(resolveAccountForBucket).mockReturnValue("acct-42");

    const body = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 777, name: "Scoped" } },
      creator: { id: 2, name: "Tester" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signPayload("wrong-secret", timestamp, body);

    const req = mockReq("POST", "/webhooks/basecamp", body, {
      "x-basecamp-signature": signature,
      "x-basecamp-timestamp": timestamp,
    });
    const res = mockRes();
    await handleBasecampWebhook(req, res);

    expect(res.status).toBe(403);
  });

  it("fails closed when bucket resolves to an account with no secrets", async () => {
    // Account "acct-empty" has an empty registry (no secrets registered).
    // The "default" account has a valid secret (seeded in beforeEach).
    // Bucket 888 resolves to "acct-empty" — should NOT fall back to default's secret.
    getWebhookSecretRegistry("acct-empty"); // ensure registry exists but empty

    vi.mocked(resolveAccountForBucket).mockReturnValue("acct-empty");

    const body = JSON.stringify({
      kind: "comment_created",
      created_at: "2025-01-01T00:00:00Z",
      recording: { id: 1, type: "Comment", bucket: { id: 888, name: "Empty" } },
      creator: { id: 2, name: "Tester" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    // Sign with the default account's secret — should be rejected
    const signature = signPayload(webhookSecret, timestamp, body);

    const req = mockReq("POST", "/webhooks/basecamp", body, {
      "x-basecamp-signature": signature,
      "x-basecamp-timestamp": timestamp,
    });
    const res = mockRes();
    await handleBasecampWebhook(req, res);

    expect(res.status).toBe(403);
  });
});
