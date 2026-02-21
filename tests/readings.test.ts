import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  BasecampReadingsEntry,
  ResolvedBasecampAccount,
} from "../src/types.js";

vi.mock("../src/bcq.js", () => ({
  bcqReadings: vi.fn(),
}));
vi.mock("../src/metrics.js", () => ({
  recordUnknownKind: vi.fn(),
}));
vi.mock("../src/outbound/send.js", () => ({
  resolveCircleInfoCached: vi.fn(() => undefined),
}));

import { bcqReadings } from "../src/bcq.js";
import { recordUnknownKind } from "../src/metrics.js";
import { pollReadings } from "../src/inbound/readings.js";

const mockAccount: ResolvedBasecampAccount = {
  accountId: "test-acct",
  enabled: true,
  personId: "999",
  token: "test-token",
  tokenSource: "config",
  config: { personId: "999" },
};

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

function makeReading(overrides: Partial<BasecampReadingsEntry> = {}): BasecampReadingsEntry {
  return {
    id: 1,
    created_at: "2025-01-15T10:00:00Z",
    type: "Comment",
    title: "A comment",
    app_url: "https://3.basecamp.com/2914079/buckets/100/comments/200",
    readable_sgid: "sgid://bc3/Comment/200",
    creator: { id: 42, name: "Alice" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pollReadings", () => {
  it("normalizes known types and collects processedSgids", async () => {
    vi.mocked(bcqReadings).mockResolvedValue({
      data: {
        unreads: [makeReading({ id: 1 }), makeReading({ id: 2, readable_sgid: "sgid://bc3/Comment/201" })],
      },
      raw: "",
    });

    const result = await pollReadings({ account: mockAccount, log });

    expect(result.events).toHaveLength(2);
    expect(result.processedSgids).toEqual(["sgid://bc3/Comment/200", "sgid://bc3/Comment/201"]);
    expect(result.newestAt).toBe("2025-01-15T10:00:00Z");
  });

  it("unknown reading type: returns no event but still marks SGID as processed", async () => {
    const unknownReading = makeReading({
      id: 10,
      type: "FutureWidget",
      readable_sgid: "sgid://bc3/FutureWidget/10",
      unread_at: "2025-01-16T08:00:00Z",
    });
    vi.mocked(bcqReadings).mockResolvedValue({
      data: { unreads: [unknownReading] },
      raw: "",
    });

    const result = await pollReadings({ account: mockAccount, log });

    // No events emitted (unknown type is dropped)
    expect(result.events).toHaveLength(0);
    // But the SGID is collected — prevents re-polling the same item next cycle
    expect(result.processedSgids).toContain("sgid://bc3/FutureWidget/10");
    // And newestAt is advanced
    expect(result.newestAt).toBe("2025-01-16T08:00:00Z");
    // And the unknown kind metric was recorded
    expect(recordUnknownKind).toHaveBeenCalledWith("test-acct", "FutureWidget");
  });

  it("mix of known and unknown types: both advance cursor", async () => {
    vi.mocked(bcqReadings).mockResolvedValue({
      data: {
        unreads: [
          makeReading({ id: 1, unread_at: "2025-01-15T10:00:00Z" }),
          makeReading({
            id: 2,
            type: "FutureWidget",
            readable_sgid: "sgid://bc3/FutureWidget/2",
            unread_at: "2025-01-16T12:00:00Z",
          }),
        ],
      },
      raw: "",
    });

    const result = await pollReadings({ account: mockAccount, log });

    expect(result.events).toHaveLength(1); // only the Comment
    expect(result.processedSgids).toHaveLength(2); // both marked processed
    // newestAt should be the later timestamp from the unknown item
    expect(result.newestAt).toBe("2025-01-16T12:00:00Z");
  });

  it("empty unreads returns empty result", async () => {
    vi.mocked(bcqReadings).mockResolvedValue({
      data: { unreads: [] },
      raw: "",
    });

    const result = await pollReadings({ account: mockAccount, log });

    expect(result.events).toHaveLength(0);
    expect(result.processedSgids).toHaveLength(0);
    expect(result.newestAt).toBeUndefined();
  });

  it("null response returns empty result", async () => {
    vi.mocked(bcqReadings).mockResolvedValue({ data: null, raw: "" });

    const result = await pollReadings({ account: mockAccount, log });

    expect(result.events).toHaveLength(0);
    expect(result.processedSgids).toHaveLength(0);
  });
});
