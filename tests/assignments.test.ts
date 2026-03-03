import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  BasecampAssignmentTodo,
  ResolvedBasecampAccount,
} from "../src/types.js";
import { normalizeAssignmentTodo } from "../src/inbound/normalize.js";

// ---------------------------------------------------------------------------
// Mock basecamp-client
// ---------------------------------------------------------------------------

const mockClient = {
  raw: {
    GET: vi.fn(),
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
    constructor(msg: string, code: string) { super(msg); this.code = code; }
  },
}));

vi.mock("../src/metrics.js", () => ({
  recordUnknownKind: vi.fn(),
}));

vi.mock("../src/outbound/send.js", () => ({
  resolveCircleInfoCached: vi.fn(() => undefined),
}));

import { pollAssignments } from "../src/inbound/assignments.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockAccount: ResolvedBasecampAccount = {
  accountId: "test-acct",
  enabled: true,
  personId: "999",
  displayName: "Clawdito",
  attachableSgid: "sgid://bc3/Person/999",
  token: "test-token",
  tokenSource: "config",
  config: { personId: "999", basecampAccountId: "2914079" },
};

function makeTodo(overrides: Partial<BasecampAssignmentTodo> = {}): BasecampAssignmentTodo {
  return {
    id: 100,
    content: "Fix the widget",
    title: "Fix the widget",
    app_url: "https://3.basecamp.com/2914079/buckets/500/todos/100",
    created_at: "2025-01-15T10:00:00Z",
    updated_at: "2025-01-15T12:00:00Z",
    bucket: { id: 500, name: "Test Project" },
    assignees: [{ id: 999, name: "Clawdito" }],
    creator: { id: 42, name: "Alice", email_address: "alice@example.com" },
    ...overrides,
  };
}

/** Helper to set up raw.GET mock for assignments response */
function mockAssignmentsResponse(data: any) {
  mockClient.raw.GET.mockResolvedValue({
    data,
    error: undefined,
    response: { ok: true, headers: new Headers() },
  });
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

// ---------------------------------------------------------------------------
// normalizeAssignmentTodo
// ---------------------------------------------------------------------------

describe("normalizeAssignmentTodo", () => {
  it("produces a BasecampInboundMessage with correct fields", () => {
    const todo = makeTodo();
    const msg = normalizeAssignmentTodo(todo, mockAccount);

    expect(msg.channel).toBe("basecamp");
    expect(msg.accountId).toBe("test-acct");
    expect(msg.text).toBe("Fix the widget");
    expect(msg.meta.bucketId).toBe("500");
    expect(msg.meta.recordingId).toBe("100");
    expect(msg.meta.recordableType).toBe("Todo");
    expect(msg.meta.eventKind).toBe("assigned");
    expect(msg.meta.assignedToAgent).toBe(true);
    expect(msg.meta.sources).toEqual(["assignments"]);
    expect(msg.meta.assignees).toEqual(["999"]);
    expect(msg.peer).toEqual({ kind: "group", id: "recording:100" });
    expect(msg.parentPeer).toEqual({ kind: "group", id: "bucket:500" });
    expect(msg.sender.id).toBe("42");
    expect(msg.sender.name).toBe("Alice");
    expect(msg.dedupKey).toMatch(/^direct:/);
  });

  it("uses updated_at for createdAt timestamp", () => {
    const todo = makeTodo({ updated_at: "2025-02-01T00:00:00Z" });
    const msg = normalizeAssignmentTodo(todo, mockAccount);
    expect(msg.createdAt).toBe("2025-02-01T00:00:00Z");
  });

  it("falls back to created_at when updated_at is absent", () => {
    const todo = makeTodo({ updated_at: undefined });
    const msg = normalizeAssignmentTodo(todo, mockAccount);
    expect(msg.createdAt).toBe("2025-01-15T10:00:00Z");
  });

  it("handles missing creator gracefully", () => {
    const todo = makeTodo({ creator: undefined });
    const msg = normalizeAssignmentTodo(todo, mockAccount);
    expect(msg.sender.id).toBe("unknown");
    expect(msg.sender.name).toBe("Unknown");
  });

  it("includes due_on when present", () => {
    const todo = makeTodo({ due_on: "2025-03-01" });
    const msg = normalizeAssignmentTodo(todo, mockAccount);
    expect(msg.meta.dueOn).toBe("2025-03-01");
  });

  it("omits due_on when null", () => {
    const todo = makeTodo({ due_on: null });
    const msg = normalizeAssignmentTodo(todo, mockAccount);
    expect(msg.meta.dueOn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pollAssignments
// ---------------------------------------------------------------------------

describe("pollAssignments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bootstraps on first poll — records IDs, emits nothing", async () => {
    mockAssignmentsResponse({
      priorities: [makeTodo({ id: 1 }), makeTodo({ id: 2 })],
      non_priorities: [makeTodo({ id: 3 })],
    });

    const result = await pollAssignments({
      account: mockAccount,
      knownIds: new Set(),
      isBootstrap: true,
      log,
    });

    expect(result.events).toHaveLength(0);
    expect(result.knownIds).toEqual(new Set(["1", "2", "3"]));
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("bootstrap: recording 3 existing assignments"),
    );
  });

  it("emits events for newly assigned todos", async () => {
    mockAssignmentsResponse({
      priorities: [makeTodo({ id: 1 }), makeTodo({ id: 2 })],
      non_priorities: [makeTodo({ id: 3 })],
    });

    const result = await pollAssignments({
      account: mockAccount,
      knownIds: new Set(["1"]), // already knew about todo 1
      isBootstrap: false,
      log,
    });

    expect(result.events).toHaveLength(2); // todos 2 and 3 are new
    expect(result.events[0].meta.recordingId).toBe("2");
    expect(result.events[1].meta.recordingId).toBe("3");
    expect(result.knownIds).toEqual(new Set(["1", "2", "3"]));
  });

  it("emits nothing when all todos are already known", async () => {
    mockAssignmentsResponse({
      priorities: [makeTodo({ id: 1 })],
      non_priorities: [],
    });

    const result = await pollAssignments({
      account: mockAccount,
      knownIds: new Set(["1"]),
      isBootstrap: false,
      log,
    });

    expect(result.events).toHaveLength(0);
    expect(result.knownIds).toEqual(new Set(["1"]));
  });

  it("removes completed/unassigned IDs from knownIds", async () => {
    // Previously knew about 1, 2, 3 — now only 1 remains
    mockAssignmentsResponse({
      priorities: [makeTodo({ id: 1 })],
      non_priorities: [],
    });

    const result = await pollAssignments({
      account: mockAccount,
      knownIds: new Set(["1", "2", "3"]),
      isBootstrap: false,
      log,
    });

    expect(result.events).toHaveLength(0); // no new assignments
    expect(result.knownIds).toEqual(new Set(["1"])); // 2 and 3 dropped
  });

  it("handles empty response (no assignments)", async () => {
    mockAssignmentsResponse({ priorities: [], non_priorities: [] });

    const result = await pollAssignments({
      account: mockAccount,
      knownIds: new Set(["1"]),
      isBootstrap: false,
      log,
    });

    expect(result.events).toHaveLength(0);
    expect(result.knownIds).toEqual(new Set());
  });

  it("handles flat array response shape", async () => {
    mockAssignmentsResponse([makeTodo({ id: 10 }), makeTodo({ id: 20 })]);

    const result = await pollAssignments({
      account: mockAccount,
      knownIds: new Set(),
      isBootstrap: false,
      log,
    });

    expect(result.events).toHaveLength(2);
    expect(result.knownIds).toEqual(new Set(["10", "20"]));
  });

  it("continues processing when individual normalization fails", async () => {
    mockAssignmentsResponse({
      priorities: [
        { id: 1 } as any, // missing bucket — will throw
        makeTodo({ id: 2 }),
      ],
      non_priorities: [],
    });

    const result = await pollAssignments({
      account: mockAccount,
      knownIds: new Set(),
      isBootstrap: false,
      log,
    });

    // One failed, one succeeded
    expect(result.events).toHaveLength(1);
    expect(result.events[0].meta.recordingId).toBe("2");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to normalize assignment todo id=1"),
    );
  });

  it("all events have assignedToAgent=true", async () => {
    mockAssignmentsResponse({
      priorities: [makeTodo({ id: 1 }), makeTodo({ id: 2 })],
      non_priorities: [],
    });

    const result = await pollAssignments({
      account: mockAccount,
      knownIds: new Set(),
      isBootstrap: false,
      log,
    });

    for (const event of result.events) {
      expect(event.meta.assignedToAgent).toBe(true);
      expect(event.meta.eventKind).toBe("assigned");
    }
  });

  it("flattens nested children into top-level assignments", async () => {
    mockAssignmentsResponse({
      priorities: [
        makeTodo({
          id: 10,
          children: [
            makeTodo({ id: 11 }),
            makeTodo({ id: 12, children: [makeTodo({ id: 13 })] }),
          ],
        }),
      ],
      non_priorities: [],
    });

    const result = await pollAssignments({
      account: mockAccount,
      knownIds: new Set(),
      isBootstrap: false,
      log,
    });

    // Parent (10) + child (11) + child (12) + grandchild (13)
    expect(result.events).toHaveLength(4);
    const ids = result.events.map((e) => e.meta.recordingId).sort();
    expect(ids).toEqual(["10", "11", "12", "13"]);
    expect(result.knownIds).toEqual(new Set(["10", "11", "12", "13"]));
  });

  it("uses actual type field from API response", async () => {
    const todo = makeTodo({ id: 50, type: "ScheduleEntry" });
    const msg = normalizeAssignmentTodo(todo, mockAccount);
    expect(msg.meta.recordableType).toBe("Schedule::Entry");
  });

  it("dedup key includes updated_at to handle reassignment", async () => {
    const todo1 = makeTodo({ id: 100, updated_at: "2025-01-15T12:00:00Z" });
    const todo2 = makeTodo({ id: 100, updated_at: "2025-01-16T08:00:00Z" });
    const msg1 = normalizeAssignmentTodo(todo1, mockAccount);
    const msg2 = normalizeAssignmentTodo(todo2, mockAccount);
    // Same recording ID but different updated_at → different dedup keys
    expect(msg1.dedupKey).not.toBe(msg2.dedupKey);
  });
});
