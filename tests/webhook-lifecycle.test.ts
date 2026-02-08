import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/bcq.js", () => ({
  bcqWebhookList: vi.fn(),
  bcqWebhookCreate: vi.fn(),
  bcqWebhookDelete: vi.fn(),
}));

import { bcqWebhookList, bcqWebhookCreate, bcqWebhookDelete } from "../src/bcq.js";
import { WebhookSecretRegistry } from "../src/inbound/webhook-secrets.js";
import { reconcileWebhooks, deactivateWebhooks } from "../src/inbound/webhook-lifecycle.js";
import type { WebhookLifecycleConfig } from "../src/inbound/webhook-lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<WebhookLifecycleConfig>): WebhookLifecycleConfig {
  return {
    payloadUrl: "https://example.com/webhooks/basecamp",
    projects: ["100", "200"],
    types: ["Todo", "Comment"],
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
    vi.mocked(bcqWebhookList).mockResolvedValue({ data: [], raw: "[]" });
    vi.mocked(bcqWebhookCreate).mockResolvedValue({
      data: {
        id: 1,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: ["Todo", "Comment"],
        secret: "new-secret-abc",
      },
      raw: "{}",
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

    // Both projects should have called create
    expect(bcqWebhookCreate).toHaveBeenCalledTimes(2);
  });

  it("skips projects that already have a matching active webhook", async () => {
    vi.mocked(bcqWebhookList).mockResolvedValue({
      data: [
        {
          id: 42,
          active: true,
          payload_url: "https://example.com/webhooks/basecamp",
          types: ["Todo", "Comment"],
        },
      ],
      raw: "[]",
    });

    const registry = new WebhookSecretRegistry();
    const log = mockLog();
    const result = await reconcileWebhooks(makeConfig(), registry, log);

    expect(result.existing).toEqual(["100", "200"]);
    expect(result.created).toEqual([]);
    expect(bcqWebhookCreate).not.toHaveBeenCalled();

    // Should still store the webhook ID (without secret since it's pre-existing)
    const entry = registry.get("100");
    expect(entry).toBeDefined();
    expect(entry!.webhookId).toBe("42");
    expect(entry!.secret).toBe("");
  });

  it("does not overwrite existing registry entries for matched webhooks", async () => {
    vi.mocked(bcqWebhookList).mockResolvedValue({
      data: [
        {
          id: 42,
          active: true,
          payload_url: "https://example.com/webhooks/basecamp",
          types: ["Todo"],
        },
      ],
      raw: "[]",
    });

    const registry = new WebhookSecretRegistry();
    // Pre-populate with known secret
    registry.set("100", {
      webhookId: "42",
      secret: "known-secret",
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: ["Todo"],
    });

    const result = await reconcileWebhooks(
      makeConfig({ projects: ["100"] }),
      registry,
    );

    expect(result.existing).toEqual(["100"]);
    // Secret should be preserved
    expect(registry.get("100")!.secret).toBe("known-secret");
  });

  it("records failed projects when create returns no ID", async () => {
    vi.mocked(bcqWebhookList).mockResolvedValue({ data: [], raw: "[]" });
    vi.mocked(bcqWebhookCreate).mockResolvedValue({
      data: {} as any,
      raw: "{}",
    });

    const registry = new WebhookSecretRegistry();
    const log = mockLog();
    const result = await reconcileWebhooks(makeConfig(), registry, log);

    expect(result.failed).toEqual(["100", "200"]);
    expect(result.created).toEqual([]);
    expect(log.error).toHaveBeenCalled();
  });

  it("records failed projects on thrown errors", async () => {
    vi.mocked(bcqWebhookList).mockRejectedValue(new Error("network error"));
    vi.mocked(bcqWebhookCreate).mockRejectedValue(new Error("network error"));

    const registry = new WebhookSecretRegistry();
    const log = mockLog();
    const result = await reconcileWebhooks(makeConfig(), registry, log);

    expect(result.failed).toEqual(["100", "200"]);
    expect(log.error).toHaveBeenCalled();
  });

  it("treats list failure as empty and attempts create", async () => {
    vi.mocked(bcqWebhookList).mockRejectedValue(new Error("list failed"));
    vi.mocked(bcqWebhookCreate).mockResolvedValue({
      data: {
        id: 5,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: [],
        secret: "fresh-secret",
      },
      raw: "{}",
    });

    const registry = new WebhookSecretRegistry();
    const result = await reconcileWebhooks(
      makeConfig({ projects: ["100"] }),
      registry,
    );

    expect(result.created).toEqual(["100"]);
    expect(bcqWebhookCreate).toHaveBeenCalledTimes(1);
    expect(registry.get("100")!.secret).toBe("fresh-secret");
  });

  it("ignores inactive webhooks with matching URL", async () => {
    vi.mocked(bcqWebhookList).mockResolvedValue({
      data: [
        {
          id: 10,
          active: false,
          payload_url: "https://example.com/webhooks/basecamp",
          types: [],
        },
      ],
      raw: "[]",
    });
    vi.mocked(bcqWebhookCreate).mockResolvedValue({
      data: {
        id: 11,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        types: ["Todo", "Comment"],
        secret: "new-secret",
      },
      raw: "{}",
    });

    const registry = new WebhookSecretRegistry();
    const result = await reconcileWebhooks(
      makeConfig({ projects: ["100"] }),
      registry,
    );

    // Inactive match should not count — should create new
    expect(result.created).toEqual(["100"]);
    expect(bcqWebhookCreate).toHaveBeenCalledTimes(1);
  });

  it("passes bcqOpts through to list and create calls", async () => {
    vi.mocked(bcqWebhookList).mockResolvedValue({ data: [], raw: "[]" });
    vi.mocked(bcqWebhookCreate).mockResolvedValue({
      data: {
        id: 1,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        secret: "s",
      },
      raw: "{}",
    });

    const registry = new WebhookSecretRegistry();
    await reconcileWebhooks(
      makeConfig({
        projects: ["100"],
        bcqOpts: { accountId: "acct-1", profile: "prod" },
      }),
      registry,
    );

    expect(bcqWebhookList).toHaveBeenCalledWith("100", {
      accountId: "acct-1",
      profile: "prod",
    });
    expect(bcqWebhookCreate).toHaveBeenCalledWith(
      "100",
      "https://example.com/webhooks/basecamp",
      ["Todo", "Comment"],
      { accountId: "acct-1", profile: "prod" },
    );
  });

  it("passes undefined types when config types array is empty", async () => {
    vi.mocked(bcqWebhookList).mockResolvedValue({ data: [], raw: "[]" });
    vi.mocked(bcqWebhookCreate).mockResolvedValue({
      data: {
        id: 1,
        active: true,
        payload_url: "https://example.com/webhooks/basecamp",
        secret: "s",
      },
      raw: "{}",
    });

    const registry = new WebhookSecretRegistry();
    await reconcileWebhooks(
      makeConfig({ projects: ["100"], types: [] }),
      registry,
    );

    expect(bcqWebhookCreate).toHaveBeenCalledWith(
      "100",
      "https://example.com/webhooks/basecamp",
      undefined,
      expect.any(Object),
    );
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
    vi.mocked(bcqWebhookDelete).mockResolvedValue({ data: null, raw: "" });

    const registry = new WebhookSecretRegistry();
    registry.set("100", {
      webhookId: "w1",
      secret: "s",
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: [],
    });
    registry.set("200", {
      webhookId: "w2",
      secret: "s",
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: [],
    });

    const log = mockLog();
    await deactivateWebhooks(makeConfig(), registry, log);

    expect(bcqWebhookDelete).toHaveBeenCalledTimes(2);
    expect(bcqWebhookDelete).toHaveBeenCalledWith("100", "w1", expect.any(Object));
    expect(bcqWebhookDelete).toHaveBeenCalledWith("200", "w2", expect.any(Object));

    // Registry entries should be removed after deletion
    expect(registry.get("100")).toBeUndefined();
    expect(registry.get("200")).toBeUndefined();
  });

  it("skips projects with no registry entry", async () => {
    const registry = new WebhookSecretRegistry();
    // Only "100" has an entry — "200" does not
    registry.set("100", {
      webhookId: "w1",
      secret: "s",
      payloadUrl: "https://example.com/webhooks/basecamp",
      types: [],
    });

    vi.mocked(bcqWebhookDelete).mockResolvedValue({ data: null, raw: "" });

    await deactivateWebhooks(makeConfig(), registry);

    expect(bcqWebhookDelete).toHaveBeenCalledTimes(1);
    expect(bcqWebhookDelete).toHaveBeenCalledWith("100", "w1", expect.any(Object));
  });

  it("logs errors but does not throw when delete fails", async () => {
    vi.mocked(bcqWebhookDelete).mockRejectedValue(new Error("delete failed"));

    const registry = new WebhookSecretRegistry();
    registry.set("100", {
      webhookId: "w1",
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
});
