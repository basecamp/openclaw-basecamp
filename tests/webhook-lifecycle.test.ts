import { beforeEach, describe, expect, it, vi } from "vitest";

const mockClient = {
  webhooks: { list: vi.fn(), delete: vi.fn() },
  raw: {
    POST: vi.fn(),
  },
};

vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => mockClient),
  numId: (_label: string, value: string | number) => Number(value),
  rawOrThrow: vi.fn(async (r: any) => {
    if (r?.error) throw new Error("API error");
    return r?.data;
  }),
  BasecampError: class BasecampError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));

import type { WebhookLifecycleConfig } from "../src/inbound/webhook-lifecycle.js";
import { deactivateWebhooks, reconcileWebhooks } from "../src/inbound/webhook-lifecycle.js";
import { WebhookSecretRegistry } from "../src/inbound/webhook-secrets.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ACCOUNT = {
  accountId: "test-account",
  token: "test-token",
  tokenSource: "config" as const,
  cliProfile: undefined,
  config: { basecampAccountId: "12345" },
  scopedBucketId: undefined,
};

function makeConfig(overrides?: Partial<WebhookLifecycleConfig>): WebhookLifecycleConfig {
  return {
    payloadUrl: "https://example.com/webhooks/basecamp",
    projects: ["100", "200"],
    types: ["Todo", "Comment"],
    account: TEST_ACCOUNT as any,
    ...overrides,
  };
}

function mockLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// reconcileWebhooks
// ---------------------------------------------------------------------------

describe("reconcileWebhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates webhooks for projects with no existing match", async () => {
    mockClient.webhooks.list.mockResolvedValue([]);
    mockClient.raw.POST.mockResolvedValue({
      data: {
        id: 1,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: ["Todo", "Comment"],
        secret: "new-secret-abc",
      },
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const registry = new WebhookSecretRegistry();
    const log = mockLog();
    const result = await reconcileWebhooks(makeConfig(), registry, log);

    expect(result.created).toEqual(["100", "200"]);
    expect(result.existing).toEqual([]);
    expect(result.failed).toEqual([]);

    // Verify secrets were persisted
    const entry100 = registry.get("100");
    expect(entry100).toBeDefined();
    expect(entry100!.secret).toBe("new-secret-abc");
    expect(entry100!.webhookId).toBe("1");

    // Both projects should have called create via raw.POST
    expect(mockClient.raw.POST).toHaveBeenCalledTimes(2);
  });

  it("registers pre-existing webhook with no registry entry as existing", async () => {
    mockClient.webhooks.list.mockResolvedValue([
      {
        id: 42,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: ["Todo", "Comment"],
      },
    ]);

    const registry = new WebhookSecretRegistry();
    const log = mockLog();
    const result = await reconcileWebhooks(makeConfig(), registry, log);

    // Pre-existing webhook is recorded as existing (no secret recovery)
    expect(result.existing).toEqual(["100", "200"]);
    expect(result.recovered).toEqual([]);
    expect(result.created).toEqual([]);

    // No delete/recreate — just register what we found
    expect(mockClient.webhooks.delete).not.toHaveBeenCalled();
    expect(mockClient.raw.POST).not.toHaveBeenCalled();

    // Registry should have entry with empty secret
    const entry = registry.get("100");
    expect(entry).toBeDefined();
    expect(entry!.secret).toBe("");
    expect(entry!.webhookId).toBe("42");
  });

  it("does not overwrite existing registry entries for matched webhooks", async () => {
    mockClient.webhooks.list.mockResolvedValue([
      {
        id: 42,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: ["Comment", "Todo"],
      },
    ]);

    const registry = new WebhookSecretRegistry();
    // Pre-populate with known secret
    registry.set("100", {
      webhookId: "42",
      secret: "known-secret",
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: ["Comment", "Todo"],
    });

    const result = await reconcileWebhooks(makeConfig({ projects: ["100"] }), registry);

    expect(result.existing).toEqual(["100"]);
    // Secret should be preserved
    expect(registry.get("100")!.secret).toBe("known-secret");
  });

  it("deletes and recreates webhook when types differ", async () => {
    mockClient.webhooks.list.mockResolvedValue([
      {
        id: 42,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: ["Todo"],
      },
    ]);
    mockClient.webhooks.delete.mockResolvedValue(undefined);
    mockClient.raw.POST.mockResolvedValue({
      data: {
        id: 43,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: ["Todo", "Comment"],
        secret: "new-secret",
      },
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const registry = new WebhookSecretRegistry();
    const log = mockLog();
    const result = await reconcileWebhooks(makeConfig({ projects: ["100"] }), registry, log);

    // Old webhook should be deleted, new one created
    expect(mockClient.webhooks.delete).toHaveBeenCalledWith(42);
    expect(mockClient.raw.POST).toHaveBeenCalledTimes(1);
    expect(result.created).toEqual(["100"]);
    expect(registry.get("100")!.secret).toBe("new-secret");
    expect(registry.get("100")!.webhookId).toBe("43");
    expect(log.info).toHaveBeenCalledWith("webhook_types_changed", expect.any(Object));
  });

  it("succeeds when BC3 returns no secret (token auth expected)", async () => {
    mockClient.webhooks.list.mockResolvedValue([]);
    mockClient.raw.POST.mockResolvedValue({
      data: {
        id: 50,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: ["Todo", "Comment"],
        // No secret — expected for BC3
      },
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const registry = new WebhookSecretRegistry();
    const log = mockLog();
    const result = await reconcileWebhooks(makeConfig({ projects: ["100"] }), registry, log);

    // No-secret is not a failure — BC3 never returns secrets
    expect(result.created).toEqual(["100"]);
    expect(result.failed).toEqual([]);
    expect(registry.get("100")!.secret).toBe("");
    expect(log.info).toHaveBeenCalledWith(
      "webhook_create_no_secret",
      expect.objectContaining({
        project: "100",
      }),
    );
  });

  it("records failed projects when create returns no ID", async () => {
    mockClient.webhooks.list.mockResolvedValue([]);
    mockClient.raw.POST.mockResolvedValue({
      data: {} as any,
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const registry = new WebhookSecretRegistry();
    const log = mockLog();
    const result = await reconcileWebhooks(makeConfig(), registry, log);

    expect(result.failed).toEqual(["100", "200"]);
    expect(result.created).toEqual([]);
    expect(log.error).toHaveBeenCalled();
  });

  it("records failed projects on thrown errors", async () => {
    mockClient.webhooks.list.mockRejectedValue(new Error("network error"));
    mockClient.raw.POST.mockRejectedValue(new Error("network error"));

    const registry = new WebhookSecretRegistry();
    const log = mockLog();
    const result = await reconcileWebhooks(makeConfig(), registry, log);

    expect(result.failed).toEqual(["100", "200"]);
    expect(log.error).toHaveBeenCalled();
  });

  it("treats list failure as empty and attempts create", async () => {
    mockClient.webhooks.list.mockRejectedValue(new Error("list failed"));
    mockClient.raw.POST.mockResolvedValue({
      data: {
        id: 5,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: [],
        secret: "fresh-secret",
      },
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const registry = new WebhookSecretRegistry();
    const result = await reconcileWebhooks(makeConfig({ projects: ["100"] }), registry);

    expect(result.created).toEqual(["100"]);
    expect(mockClient.raw.POST).toHaveBeenCalledTimes(1);
    expect(registry.get("100")!.secret).toBe("fresh-secret");
  });

  it("ignores inactive webhooks with matching URL", async () => {
    mockClient.webhooks.list.mockResolvedValue([
      {
        id: 10,
        active: false,
        payload_url: "https://example.com/webhooks/basecamp",
        types: [],
      },
    ]);
    mockClient.raw.POST.mockResolvedValue({
      data: {
        id: 11,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: ["Todo", "Comment"],
        secret: "new-secret",
      },
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const registry = new WebhookSecretRegistry();
    const result = await reconcileWebhooks(makeConfig({ projects: ["100"] }), registry);

    // Inactive match should not count — should create new
    expect(result.created).toEqual(["100"]);
    expect(mockClient.raw.POST).toHaveBeenCalledTimes(1);
  });

  it("passes account through to getClient", async () => {
    mockClient.webhooks.list.mockResolvedValue([]);
    mockClient.raw.POST.mockResolvedValue({
      data: {
        id: 1,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        secret: "s",
      },
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const registry = new WebhookSecretRegistry();
    const { getClient } = await import("../src/basecamp-client.js");
    await reconcileWebhooks(makeConfig({ projects: ["100"] }), registry);

    expect(getClient).toHaveBeenCalledWith(TEST_ACCOUNT);
  });

  it("does not recover when existing secret is non-empty", async () => {
    mockClient.webhooks.list.mockResolvedValue([
      {
        id: 42,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: ["Todo", "Comment"],
      },
    ]);

    const registry = new WebhookSecretRegistry();
    // Pre-populate with a real secret
    registry.set("100", {
      webhookId: "42",
      secret: "known-secret",
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: ["Todo", "Comment"],
    });

    const result = await reconcileWebhooks(makeConfig({ projects: ["100"] }), registry);

    expect(result.existing).toEqual(["100"]);
    expect(result.recovered).toEqual([]);
    expect(mockClient.webhooks.delete).not.toHaveBeenCalled();
    expect(mockClient.raw.POST).not.toHaveBeenCalled();
    expect(registry.get("100")!.secret).toBe("known-secret");
  });

  it("treats empty-secret existing webhook as existing without recovery attempt", async () => {
    mockClient.webhooks.list.mockResolvedValue([
      {
        id: 42,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: ["Todo", "Comment"],
      },
    ]);

    const registry = new WebhookSecretRegistry();
    // Pre-populate with empty secret (BC3 behavior)
    registry.set("100", {
      webhookId: "42",
      secret: "",
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: ["Todo", "Comment"],
    });

    const log = mockLog();
    const result = await reconcileWebhooks(makeConfig({ projects: ["100"] }), registry, log);

    // Should be existing — no delete/recreate
    expect(result.existing).toEqual(["100"]);
    expect(result.recovered).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(mockClient.webhooks.delete).not.toHaveBeenCalled();
    expect(mockClient.raw.POST).not.toHaveBeenCalled();
  });

  it("idempotent: pre-existing webhook with empty secret on subsequent calls", async () => {
    // First call: webhook exists, no registry entry yet
    mockClient.webhooks.list.mockResolvedValue([
      {
        id: 42,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: ["Todo", "Comment"],
      },
    ]);

    const registry = new WebhookSecretRegistry();
    const log = mockLog();

    const result1 = await reconcileWebhooks(makeConfig({ projects: ["100"] }), registry, log);
    expect(result1.existing).toEqual(["100"]);

    // Second call: same state
    vi.clearAllMocks();
    mockClient.webhooks.list.mockResolvedValue([
      {
        id: 42,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: ["Todo", "Comment"],
      },
    ]);

    const result2 = await reconcileWebhooks(makeConfig({ projects: ["100"] }), registry, log);

    expect(result2.existing).toEqual(["100"]);
    expect(mockClient.webhooks.delete).not.toHaveBeenCalled();
    expect(mockClient.raw.POST).not.toHaveBeenCalled();
  });

  it("creates webhook without types when config types array is empty", async () => {
    mockClient.webhooks.list.mockResolvedValue([]);
    mockClient.raw.POST.mockResolvedValue({
      data: {
        id: 1,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        secret: "s",
      },
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const registry = new WebhookSecretRegistry();
    await reconcileWebhooks(makeConfig({ projects: ["100"], types: [] }), registry);

    // raw.POST should be called with body that doesn't include types
    const postCallArgs = mockClient.raw.POST.mock.calls[0]!;
    const postBody = postCallArgs[1]?.body;
    expect(postBody).toEqual({ payload_url: "https://example.com/webhooks/basecamp" });
    expect(postBody).not.toHaveProperty("types");
  });
});

// ---------------------------------------------------------------------------
// deactivateWebhooks
// ---------------------------------------------------------------------------

describe("deactivateWebhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes webhooks for projects with registry entries", async () => {
    mockClient.webhooks.delete.mockResolvedValue(undefined);

    const registry = new WebhookSecretRegistry();
    registry.set("100", {
      webhookId: "1",
      secret: "s",
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: [],
    });
    registry.set("200", {
      webhookId: "2",
      secret: "s",
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: [],
    });

    const log = mockLog();
    await deactivateWebhooks(makeConfig(), registry, log);

    expect(mockClient.webhooks.delete).toHaveBeenCalledTimes(2);
    expect(mockClient.webhooks.delete).toHaveBeenCalledWith(1);
    expect(mockClient.webhooks.delete).toHaveBeenCalledWith(2);

    // Registry entries should be removed after deletion
    expect(registry.get("100")).toBeUndefined();
    expect(registry.get("200")).toBeUndefined();
  });

  it("skips projects with no registry entry", async () => {
    const registry = new WebhookSecretRegistry();
    // Only "100" has an entry — "200" does not
    registry.set("100", {
      webhookId: "1",
      secret: "s",
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: [],
    });

    mockClient.webhooks.delete.mockResolvedValue(undefined);

    await deactivateWebhooks(makeConfig(), registry);

    expect(mockClient.webhooks.delete).toHaveBeenCalledTimes(1);
    expect(mockClient.webhooks.delete).toHaveBeenCalledWith(1);
  });

  it("logs errors but does not throw when delete fails", async () => {
    mockClient.webhooks.delete.mockRejectedValue(new Error("delete failed"));

    const registry = new WebhookSecretRegistry();
    registry.set("100", {
      webhookId: "1",
      secret: "s",
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: [],
    });

    const log = mockLog();
    // Should not throw
    await deactivateWebhooks(makeConfig(), registry, log);

    expect(log.error).toHaveBeenCalled();
    // Registry entry should NOT be removed on failure
    expect(registry.get("100")).toBeDefined();
  });

  it("skips deletion when registry payloadUrl does not match config", async () => {
    const registry = new WebhookSecretRegistry();
    registry.set("100", {
      webhookId: "1",
      secret: "s",
      payloadUrl: "https://other-deployment.example.com/webhooks/basecamp",
      types: [],
    });

    await deactivateWebhooks(makeConfig(), registry);

    // Should NOT have called delete — different payloadUrl means different deployment
    expect(mockClient.webhooks.delete).not.toHaveBeenCalled();
    // Registry entry should be preserved
    expect(registry.get("100")).toBeDefined();
  });
});
