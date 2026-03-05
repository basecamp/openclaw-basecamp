/**
 * DF-005 → DF-010: Webhook authentication integration tests.
 *
 * Validates token auth, HMAC auth, bucket-scoped secret resolution,
 * and fail-closed semantics across multi-account configurations.
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/dispatch.js", () => ({
  dispatchBasecampEvent: vi.fn().mockResolvedValue(true),
}));

const mockLoadConfig = vi.fn();
vi.mock("../../src/runtime.js", () => ({
  getBasecampRuntime: vi.fn(() => ({
    config: { loadConfig: mockLoadConfig },
  })),
}));

const mockResolveAccount = vi.fn();
const mockResolveDefaultId = vi.fn(() => "default");
const mockResolveWebhookSecret = vi.fn();
const mockResolveAccountForBucket = vi.fn();
const mockListAccountIds = vi.fn(() => ["default"]);

vi.mock("../../src/config.js", () => ({
  resolveBasecampAccount: (...args: unknown[]) => mockResolveAccount(...args),
  resolveDefaultBasecampAccountId: (...args: unknown[]) => mockResolveDefaultId(...args),
  resolveWebhookSecret: (...args: unknown[]) => mockResolveWebhookSecret(...args),
  resolveAccountForBucket: (...args: unknown[]) => mockResolveAccountForBucket(...args),
  listBasecampAccountIds: (...args: unknown[]) => mockListAccountIds(...args),
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
      dedupKey: `webhook:auth-${seq}`,
      createdAt: `2025-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    };
  }),
  isSelfMessage: vi.fn(() => false),
}));

let _testStateDir = "";
vi.mock("../../src/inbound/state-dir.js", () => ({
  resolvePluginStateDir: vi.fn(() => _testStateDir),
}));

vi.mock("../../src/inbound/dedup-registry.js", () => {
  // Lightweight in-memory dedup mock — no SQLite dependency
  const seen = new Set<string>();
  return {
    getAccountDedup: vi.fn(() => ({
      isDuplicate: (key: string) => {
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      },
      flush: vi.fn(),
      size: seen.size,
    })),
    closeAccountDedup: vi.fn(() => {
      seen.clear();
    }),
    closeAllAccountDedup: vi.fn(() => {
      seen.clear();
    }),
    flushAccountDedup: vi.fn(),
  };
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchBasecampEvent } from "../../src/dispatch.js";
import { closeAllAccountDedup } from "../../src/inbound/dedup-registry.js";
import { getWebhookSecretRegistry, handleBasecampWebhook } from "../../src/inbound/webhooks.js";
import { clearMetrics } from "../../src/metrics.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultAccount = {
  accountId: "default",
  enabled: true,
  personId: "1",
  token: "",
  tokenSource: "none" as const,
  config: { personId: "1" },
};

function acct(id: string) {
  return { ...defaultAccount, accountId: id };
}

function defaultConfig(overrides?: Record<string, unknown>) {
  return {
    channels: {
      basecamp: {
        accounts: { default: { personId: "1" } },
        ...overrides,
      },
    },
  };
}

function webhookBody(bucketId = 1, recordingId = 1) {
  return JSON.stringify({
    kind: "line_created",
    recording: { id: recordingId, type: "Chat::Line", bucket: { id: bucketId, type: "Project" } },
    creator: { id: 2, name: "Tester" },
  });
}

function signPayload(body: string, secret: string, timestamp?: string): { signature: string; timestamp: string } {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const signedPayload = `${ts}.${body}`;
  const hmac = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  return { signature: `sha256=${hmac}`, timestamp: ts };
}

function makeReq(
  body: string,
  opts?: { token?: string; hmacSignature?: string; hmacTimestamp?: string },
): IncomingMessage {
  const url = opts?.token ? `/webhooks/basecamp?token=${opts.token}` : "/webhooks/basecamp";

  const headers: Record<string, string> = {
    host: "localhost",
    "content-type": "application/json",
  };
  if (opts?.hmacSignature) headers["x-basecamp-signature"] = opts.hmacSignature;
  if (opts?.hmacTimestamp) headers["x-basecamp-timestamp"] = opts.hmacTimestamp;

  const { Readable } = require("node:stream");
  const req = new Readable({
    read() {
      this.push(body);
      this.push(null);
    },
  }) as IncomingMessage;
  req.method = "POST";
  req.url = url;
  req.headers = headers;
  return req;
}

function makeRes(): ServerResponse & { statusCode: number; body: string } {
  const res: any = {
    statusCode: 0,
    body: "",
    writeHead(code: number) {
      res.statusCode = code;
      return res;
    },
    end(data?: string) {
      res.body = data ?? "";
      return res;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dogfooding — webhook auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMetrics();
    dedupSeq = 0;
    _testStateDir = mkdtempSync(join(tmpdir(), "dogfood-auth-"));
    closeAllAccountDedup();

    // Default config
    mockLoadConfig.mockReturnValue(defaultConfig({ webhookSecret: "tok-auth" }));
    mockResolveWebhookSecret.mockReturnValue("tok-auth");
    mockResolveAccount.mockReturnValue(defaultAccount);
    mockResolveAccountForBucket.mockReturnValue(undefined);
    mockListAccountIds.mockReturnValue(["default"]);
  });

  afterEach(() => {
    closeAllAccountDedup();
    rmSync(_testStateDir, { recursive: true, force: true });
  });

  // DF-005: correct query-string token
  it("DF-005: accepts request with correct query-string token", async () => {
    const body = webhookBody();
    const req = makeReq(body, { token: "tok-auth" });
    const res = makeRes();
    await handleBasecampWebhook(req, res);

    expect(res.statusCode).toBe(200);
    expect(dispatchBasecampEvent).toHaveBeenCalled();
  });

  // DF-006: wrong query-string token
  it("DF-006: rejects request with wrong query-string token", async () => {
    const body = webhookBody();
    const req = makeReq(body, { token: "wrong" });
    const res = makeRes();
    await handleBasecampWebhook(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Invalid webhook signature or token");
    expect(dispatchBasecampEvent).not.toHaveBeenCalled();
  });

  // DF-007: no auth configured at all
  it("DF-007: returns 403 'not configured' when no auth methods exist", async () => {
    mockResolveWebhookSecret.mockReturnValue(undefined);
    mockLoadConfig.mockReturnValue(defaultConfig());
    // No HMAC secrets registered, no webhookSecret

    const body = webhookBody();
    const req = makeReq(body);
    const res = makeRes();
    await handleBasecampWebhook(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("not configured");
    expect(dispatchBasecampEvent).not.toHaveBeenCalled();
  });

  // DF-008: bucket-scoped HMAC — correct account's secret
  it("DF-008: authenticates via bucket-scoped HMAC with correct account secret", async () => {
    // Set up multi-account config with virtualAccounts
    mockResolveWebhookSecret.mockReturnValue(undefined); // no token fallback
    mockLoadConfig.mockReturnValue({
      channels: {
        basecamp: {
          accounts: {
            "acct-a": { personId: "10" },
            "acct-b": { personId: "20" },
          },
          virtualAccounts: {
            "scope-a": { accountId: "acct-a", bucketId: "100" },
            "scope-b": { accountId: "acct-b", bucketId: "200" },
          },
        },
      },
    });
    mockResolveAccountForBucket.mockImplementation((_cfg: unknown, bucketId: string) => {
      if (bucketId === "100") return "acct-a";
      if (bucketId === "200") return "acct-b";
      return undefined;
    });
    mockResolveAccount.mockReturnValue(acct("acct-a"));
    mockListAccountIds.mockReturnValue(["acct-a", "acct-b"]);

    // Seed HMAC secret for acct-a
    const secretA = "secret-for-acct-a";
    const registry = getWebhookSecretRegistry("acct-a");
    registry.set("proj-1", { webhookId: "wh-1", secret: secretA, payloadUrl: "http://x", types: [] });

    const body = webhookBody(100, 1);
    const { signature, timestamp } = signPayload(body, secretA);

    const req = makeReq(body, { hmacSignature: signature, hmacTimestamp: timestamp });
    const res = makeRes();
    await handleBasecampWebhook(req, res);

    expect(res.statusCode).toBe(200);
    expect(dispatchBasecampEvent).toHaveBeenCalled();
  });

  // DF-009: bucket-scoped HMAC — wrong account's secret
  it("DF-009: rejects HMAC from wrong account when bucket is scoped", async () => {
    mockResolveWebhookSecret.mockReturnValue(undefined);
    mockLoadConfig.mockReturnValue({
      channels: {
        basecamp: {
          accounts: {
            "acct-a": { personId: "10" },
            "acct-b": { personId: "20" },
          },
          virtualAccounts: {
            "scope-a": { accountId: "acct-a", bucketId: "100" },
            "scope-b": { accountId: "acct-b", bucketId: "200" },
          },
        },
      },
    });
    mockResolveAccountForBucket.mockImplementation((_cfg: unknown, bucketId: string) => {
      if (bucketId === "100") return "acct-a";
      if (bucketId === "200") return "acct-b";
      return undefined;
    });
    mockListAccountIds.mockReturnValue(["acct-a", "acct-b"]);

    // Seed secret for acct-b only
    const secretB = "secret-for-acct-b";
    const registryB = getWebhookSecretRegistry("acct-b");
    registryB.set("proj-2", { webhookId: "wh-2", secret: secretB, payloadUrl: "http://x", types: [] });

    // Sign with acct-b's secret, but bucket maps to acct-a
    const body = webhookBody(100, 2);
    const { signature, timestamp } = signPayload(body, secretB);

    const req = makeReq(body, { hmacSignature: signature, hmacTimestamp: timestamp });
    const res = makeRes();
    await handleBasecampWebhook(req, res);

    expect(res.statusCode).toBe(403);
    expect(dispatchBasecampEvent).not.toHaveBeenCalled();
  });

  // DF-010: fail-closed when scoped account has empty registry
  it("DF-010: fail-closed — does not fall back to other accounts when scoped registry is empty", async () => {
    mockResolveWebhookSecret.mockReturnValue(undefined);
    mockLoadConfig.mockReturnValue({
      channels: {
        basecamp: {
          accounts: {
            "acct-a": { personId: "10" },
            "acct-b": { personId: "20" },
          },
          virtualAccounts: {
            "scope-a": { accountId: "acct-a", bucketId: "100" },
            "scope-b": { accountId: "acct-b", bucketId: "200" },
          },
        },
      },
    });
    mockResolveAccountForBucket.mockImplementation((_cfg: unknown, bucketId: string) => {
      if (bucketId === "100") return "acct-a";
      if (bucketId === "200") return "acct-b";
      return undefined;
    });
    mockListAccountIds.mockReturnValue(["acct-a", "acct-b"]);

    // Seed secret for acct-b, but bucket maps to acct-a (empty)
    const secretB = "secret-for-acct-b";
    const registryB = getWebhookSecretRegistry("acct-b");
    registryB.set("proj-2", { webhookId: "wh-2", secret: secretB, payloadUrl: "http://y", types: [] });

    // acct-a has NO secrets — should fail closed, NOT try acct-b's
    const body = webhookBody(100, 3);
    const { signature, timestamp } = signPayload(body, secretB);

    const req = makeReq(body, { hmacSignature: signature, hmacTimestamp: timestamp });
    const res = makeRes();
    await handleBasecampWebhook(req, res);

    expect(res.statusCode).toBe(403);
    expect(dispatchBasecampEvent).not.toHaveBeenCalled();
  });
});
