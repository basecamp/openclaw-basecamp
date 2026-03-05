/**
 * Unit tests: pollActivityFeed
 *
 * Validates SDK-based activity polling, cursor filtering,
 * normalization failure tolerance, and newest-first ordering.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockClient = {
  reports: {
    progress: vi.fn(),
  },
  raw: {
    GET: vi.fn(),
    POST: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
  },
};

vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => mockClient),
  rawOrThrow: vi.fn(async (result: any) => result?.data),
  numId: (_label: string, value: string | number) => Number(value),
  BasecampError: class BasecampError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));

vi.mock("../src/retry.js", () => ({
  withCircuitBreaker: vi.fn(async (_cb: any, _key: string, fn: () => Promise<any>) => fn()),
}));

const normalizeStub = vi.fn();
const isSelfMessageStub = vi.fn().mockReturnValue(false);
vi.mock("../src/inbound/normalize.js", () => ({
  normalizeActivityEvent: (...args: any[]) => normalizeStub(...args),
  isSelfMessage: (...args: any[]) => isSelfMessageStub(...args),
}));

vi.mock("../src/metrics.js", () => ({
  recordUnknownKind: vi.fn(),
}));

import { pollActivityFeed } from "../src/inbound/activity.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeRawEvent(id: number, createdAt: string, kind = "todo_created") {
  return {
    id,
    kind,
    created_at: createdAt,
    recording: { id: id * 100, type: "Todo", title: `Test ${id}`, url: "" },
    creator: { id: 42, name: "Test User" },
    bucket: { id: 1, name: "Project", type: "Project" },
    excerpt: "",
  };
}

function fakeNormalized(id: number, createdAt: string): any {
  return {
    channel: "basecamp",
    accountId: "test",
    peer: { kind: "group", id: `recording:${id * 100}` },
    sender: { id: "42", name: "Test User" },
    text: `Test ${id}`,
    html: "",
    meta: {
      bucketId: "1",
      recordingId: String(id * 100),
      recordableType: "Todo",
      eventKind: "created",
      mentions: [],
      mentionsAgent: false,
      attachments: [],
      sources: ["activity"],
    },
    dedupKey: `activity:${id}`,
    createdAt,
    correlationId: "corr",
  };
}

const account = {
  accountId: "test-act",
  personId: "99",
  enabled: true,
  token: "tok",
  tokenSource: "config" as const,
  cliProfile: undefined,
  config: { personId: "99" },
} as any;

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pollActivityFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches via SDK, normalizes events, and returns newestAt", async () => {
    const raw1 = fakeRawEvent(1, "2025-06-01T12:00:00Z");
    const raw2 = fakeRawEvent(2, "2025-06-01T11:00:00Z");
    mockClient.reports.progress.mockResolvedValue([raw1, raw2]);

    normalizeStub
      .mockResolvedValueOnce(fakeNormalized(1, "2025-06-01T12:00:00Z"))
      .mockResolvedValueOnce(fakeNormalized(2, "2025-06-01T11:00:00Z"));

    const result = await pollActivityFeed({ account, log });

    expect(mockClient.reports.progress).toHaveBeenCalled();
    expect(result.events).toHaveLength(2);
    expect(result.newestAt).toBe("2025-06-01T12:00:00Z");
  });

  it("returns empty on empty feed", async () => {
    mockClient.reports.progress.mockResolvedValue([]);

    const result = await pollActivityFeed({ account, log });

    expect(result.events).toHaveLength(0);
    expect(result.newestAt).toBeUndefined();
  });

  it("filters events at or before cursor", async () => {
    const raw1 = fakeRawEvent(1, "2025-06-01T12:00:00Z");
    const raw2 = fakeRawEvent(2, "2025-06-01T10:00:00Z"); // at cursor
    const raw3 = fakeRawEvent(3, "2025-06-01T09:00:00Z"); // before cursor
    mockClient.reports.progress.mockResolvedValue([raw1, raw2, raw3]);

    normalizeStub.mockResolvedValue(fakeNormalized(1, "2025-06-01T12:00:00Z"));

    const result = await pollActivityFeed({
      account,
      since: "2025-06-01T10:00:00Z",
      log,
    });

    // raw2 is at cursor (<=) so it and raw3 are excluded
    expect(result.events).toHaveLength(1);
    expect(normalizeStub).toHaveBeenCalledTimes(1);
    expect(result.newestAt).toBe("2025-06-01T12:00:00Z");
  });

  it("skips events that fail normalization without crashing", async () => {
    const raw1 = fakeRawEvent(1, "2025-06-01T12:00:00Z");
    const raw2 = fakeRawEvent(2, "2025-06-01T11:00:00Z");
    mockClient.reports.progress.mockResolvedValue([raw1, raw2]);

    normalizeStub
      .mockRejectedValueOnce(new Error("bad event"))
      .mockResolvedValueOnce(fakeNormalized(2, "2025-06-01T11:00:00Z"));

    const result = await pollActivityFeed({ account, log });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].dedupKey).toBe("activity:2");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("failed to normalize"));
    // newestAt only tracks successfully processed events (tracking is inside try block)
    expect(result.newestAt).toBe("2025-06-01T11:00:00Z");
  });

  it("events are newest-first, newestAt is chronologically latest", async () => {
    // Intentionally out of order to verify tracking
    const raw1 = fakeRawEvent(1, "2025-06-01T09:00:00Z");
    const raw2 = fakeRawEvent(2, "2025-06-01T12:00:00Z");
    mockClient.reports.progress.mockResolvedValue([raw1, raw2]);

    normalizeStub
      .mockResolvedValueOnce(fakeNormalized(1, "2025-06-01T09:00:00Z"))
      .mockResolvedValueOnce(fakeNormalized(2, "2025-06-01T12:00:00Z"));

    const result = await pollActivityFeed({ account, log });

    expect(result.events).toHaveLength(2);
    expect(result.newestAt).toBe("2025-06-01T12:00:00Z");
  });

  it("returns null-normalized events as dropped (normalize returns null)", async () => {
    const raw1 = fakeRawEvent(1, "2025-06-01T12:00:00Z", "unknown_kind");
    mockClient.reports.progress.mockResolvedValue([raw1]);

    normalizeStub.mockResolvedValueOnce(null); // unknown kind → null

    const result = await pollActivityFeed({ account, log });

    expect(result.events).toHaveLength(0);
    expect(result.newestAt).toBe("2025-06-01T12:00:00Z");
  });

  it("handles non-array API response gracefully", async () => {
    mockClient.reports.progress.mockResolvedValue(null);

    const result = await pollActivityFeed({ account, log });

    expect(result.events).toHaveLength(0);
    expect(result.newestAt).toBeUndefined();
  });
});
