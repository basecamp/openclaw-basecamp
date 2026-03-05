import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock basecamp-client (transitive dep via outbound/send.js)
vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => ({})),
  numId: (_label: string, value: string | number) => Number(value),
  rawOrThrow: vi.fn(async (result: any) => result?.data),
  BasecampError: class BasecampError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
  clearClients: vi.fn(),
}));

vi.mock("../src/mentions/parse.js", () => ({
  mentionsAgent: vi.fn(() => false),
  extractAttachmentSgids: vi.fn(() => []),
  htmlToPlainText: vi.fn((s: string) => s),
}));

vi.mock("../src/metrics.js", () => ({
  recordUnknownKind: vi.fn(),
}));
vi.mock("../src/outbound/send.js", () => ({
  resolveCircleInfoCached: vi.fn(() => undefined),
}));

import {
  normalizeActivityEvent,
  normalizeAssignmentTodo,
  normalizeReadingsEvent,
  normalizeWebhookPayload,
} from "../src/inbound/normalize.js";
import type { ResolvedBasecampAccount } from "../src/types.js";

const mockAccount: ResolvedBasecampAccount = {
  accountId: "test-account",
  enabled: true,
  personId: "999",
  token: "test-token",
  tokenSource: "config",
  config: { personId: "999" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("correlation IDs", () => {
  it("normalizeActivityEvent generates a correlationId", async () => {
    const msg = await normalizeActivityEvent(
      {
        id: 1,
        kind: "comment_created",
        action: "created",
        created_at: "2025-01-01T00:00:00Z",
        bucket: { id: 100, name: "Test" },
        creator: { id: 10, name: "Alice" },
        recording: { id: 200, type: "Comment" },
      },
      mockAccount,
    );

    expect(msg!.correlationId).toBeTruthy();
    expect(typeof msg!.correlationId).toBe("string");
    expect(msg!.correlationId.length).toBeGreaterThan(0);
  });

  it("normalizeReadingsEvent generates a correlationId", () => {
    const msg = normalizeReadingsEvent(
      {
        id: 2,
        type: "Message",
        created_at: "2025-01-01T00:00:00Z",
        app_url: "https://3.basecamp.com/1/buckets/100/messages/300",
      },
      mockAccount,
    );

    expect(msg).not.toBeNull();
    expect(msg!.correlationId).toBeTruthy();
    expect(typeof msg!.correlationId).toBe("string");
  });

  it("normalizeAssignmentTodo generates a correlationId", () => {
    const msg = normalizeAssignmentTodo(
      {
        id: 3,
        content: "Review PR",
        bucket: { id: 100, name: "Test" },
      },
      mockAccount,
    );

    expect(msg.correlationId).toBeTruthy();
    expect(typeof msg.correlationId).toBe("string");
  });

  it("normalizeWebhookPayload generates a correlationId", async () => {
    const msg = await normalizeWebhookPayload(
      {
        id: 4,
        kind: "comment_created",
        created_at: "2025-01-01T00:00:00Z",
        recording: {
          id: 400,
          type: "Comment",
          bucket: { id: 100, name: "Test" },
        },
        creator: { id: 10, name: "Alice" },
      },
      mockAccount,
    );

    expect(msg!.correlationId).toBeTruthy();
    expect(typeof msg!.correlationId).toBe("string");
  });

  it("each call generates a unique correlationId", async () => {
    const msg1 = await normalizeActivityEvent(
      {
        id: 10,
        kind: "comment_created",
        action: "created",
        created_at: "2025-01-01T00:00:00Z",
        bucket: { id: 100, name: "Test" },
        creator: { id: 10, name: "Alice" },
      },
      mockAccount,
    );

    const msg2 = await normalizeActivityEvent(
      {
        id: 11,
        kind: "comment_created",
        action: "created",
        created_at: "2025-01-01T00:01:00Z",
        bucket: { id: 100, name: "Test" },
        creator: { id: 10, name: "Alice" },
      },
      mockAccount,
    );

    expect(msg1!.correlationId).not.toBe(msg2!.correlationId);
  });
});
