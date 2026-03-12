/**
 * Tests: safety-net.ts
 *
 * Validates pollSafetyNet with mocked SDK client + mocked dock-cache.
 * Covers snapshot diffing (appeared, moved, assigned, disappeared),
 * check-in answer detection, serialization, error handling, and
 * invalidateDockCache on 404/410 errors.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock dock-cache
// ---------------------------------------------------------------------------

vi.mock("../src/inbound/dock-cache.js", () => ({
  resolveDockToolIds: vi.fn(),
  invalidateDockCache: vi.fn(),
  clearDockCache: vi.fn(),
}));

// Mock basecamp-client for BasecampError
vi.mock("../src/basecamp-client.js", () => {
  class BasecampError extends Error {
    code: string;
    httpStatus?: number;
    retryable: boolean;
    constructor(code: string, message: string, opts?: { httpStatus?: number }) {
      super(message);
      this.name = "BasecampError";
      this.code = code;
      this.httpStatus = opts?.httpStatus;
      this.retryable = false;
    }
  }
  return {
    BasecampError,
    isBasecampError: (err: unknown): err is InstanceType<typeof BasecampError> => err instanceof BasecampError,
  };
});

import { invalidateDockCache, resolveDockToolIds } from "../src/inbound/dock-cache.js";
import type {
  DisappearedPending,
  ProjectSnapshot,
  SafetyNetPollOptions,
  SafetyNetSnapshot,
} from "../src/inbound/safety-net.js";
import {
  deserializePending,
  deserializeSnapshot,
  pollSafetyNet,
  serializePending,
  serializeSnapshot,
} from "../src/inbound/safety-net.js";
import type { ResolvedBasecampAccount } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const account: ResolvedBasecampAccount = {
  accountId: "test",
  enabled: true,
  personId: "42",
  token: "tok",
  tokenSource: "config",
  config: { personId: "42" },
};

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

function makeClient() {
  return {
    cardTables: { get: vi.fn() },
    cards: { list: vi.fn() },
    recordings: { list: vi.fn() },
    checkins: { listQuestions: vi.fn(), listAnswers: vi.fn() },
  };
}

function setupDock(ids: { cardTableId?: number; todosetId?: number; questionnaireId?: number }) {
  vi.mocked(resolveDockToolIds).mockResolvedValue(ids);
}

function emptySnapshot(projectId: number): SafetyNetSnapshot {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: {
      [String(projectId)]: { cards: {}, todos: {}, checkins: {} },
    },
  };
}

function snapshotWithCards(projectId: number, cards: ProjectSnapshot["cards"]): SafetyNetSnapshot {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: {
      [String(projectId)]: { cards, todos: {}, checkins: {} },
    },
  };
}

function snapshotWithTodos(projectId: number, todos: ProjectSnapshot["todos"]): SafetyNetSnapshot {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: {
      [String(projectId)]: { cards: {}, todos, checkins: {} },
    },
  };
}

function snapshotWithCheckins(projectId: number, checkins: ProjectSnapshot["checkins"]): SafetyNetSnapshot {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: {
      [String(projectId)]: { cards: {}, todos: {}, checkins },
    },
  };
}

function baseOpts(client: any, overrides?: Partial<SafetyNetPollOptions>): SafetyNetPollOptions {
  return {
    account,
    client,
    projectIds: [1],
    previousSnapshot: undefined,
    previousPending: undefined,
    isDeepCrawl: false,
    log,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("safety-net", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Bootstrap ----

  it("bootstrap (no prev snapshot) → snapshot built, zero events", async () => {
    const client = makeClient();
    setupDock({ cardTableId: 10, todosetId: 20, questionnaireId: 30 });
    client.cardTables.get.mockResolvedValue({
      lists: [{ id: 100, title: "Backlog" }],
    });
    client.cards.list.mockResolvedValue([]);
    client.recordings.list.mockResolvedValue([]);
    client.checkins.listQuestions.mockResolvedValue([]);

    const result = await pollSafetyNet(baseOpts(client));

    expect(result.events).toEqual([]);
    expect(result.snapshot.version).toBe(1);
    expect(result.snapshot.projects["1"]).toBeDefined();
  });

  // ---- Card appeared ----

  it("card appeared → created event with delta=true, sources=[direct_poll]", async () => {
    const client = makeClient();
    setupDock({ cardTableId: 10 });
    client.cardTables.get.mockResolvedValue({
      lists: [{ id: 100, title: "Backlog" }],
    });
    client.cards.list.mockResolvedValue([{ id: 501, updated_at: "2026-01-01T00:00:00Z", assignees: [] }]);

    const prev = emptySnapshot(1);
    const result = await pollSafetyNet(baseOpts(client, { previousSnapshot: prev }));

    expect(result.events.length).toBe(1);
    const e = result.events[0];
    expect(e.meta.eventKind).toBe("created");
    expect(e.meta.recordableType).toBe("Kanban::Card");
    expect(e.meta.delta).toBe(true);
    expect(e.meta.sources).toEqual(["direct_poll"]);
  });

  // ---- Card moved ----

  it("card moved → moved event with column + columnPrevious", async () => {
    const client = makeClient();
    setupDock({ cardTableId: 10 });
    client.cardTables.get.mockResolvedValue({
      lists: [{ id: 200, title: "In Progress" }],
    });
    client.cards.list.mockResolvedValue([{ id: 501, updated_at: "2026-01-02T00:00:00Z", assignees: [] }]);

    const prev = snapshotWithCards(1, {
      "501": { columnId: 100, columnName: "Backlog", updatedAt: "2026-01-01T00:00:00Z", assignees: [] },
    });
    const result = await pollSafetyNet(baseOpts(client, { previousSnapshot: prev }));

    const moved = result.events.find((e) => e.meta.eventKind === "moved");
    expect(moved).toBeDefined();
    expect(moved!.meta.column).toBe("In Progress");
    expect(moved!.meta.columnPrevious).toBe("Backlog");
  });

  // ---- Card assignment changed ----

  it("card assignment changed → assigned event with assignedToAgent", async () => {
    const client = makeClient();
    setupDock({ cardTableId: 10 });
    client.cardTables.get.mockResolvedValue({
      lists: [{ id: 100, title: "Backlog" }],
    });
    client.cards.list.mockResolvedValue([
      { id: 501, updated_at: "2026-01-02T00:00:00Z", assignees: [{ id: 42 }, { id: 99 }] },
    ]);

    const prev = snapshotWithCards(1, {
      "501": { columnId: 100, columnName: "Backlog", updatedAt: "2026-01-01T00:00:00Z", assignees: ["99"] },
    });
    const result = await pollSafetyNet(baseOpts(client, { previousSnapshot: prev }));

    const assigned = result.events.find((e) => e.meta.eventKind === "assigned");
    expect(assigned).toBeDefined();
    expect(assigned!.meta.assignedToAgent).toBe(true);
  });

  // ---- Card disappeared (deep crawl, 2 cycles) ----

  it("card disappeared after 2 deep crawl misses", async () => {
    const client = makeClient();
    setupDock({ cardTableId: 10 });
    client.cardTables.get.mockResolvedValue({ lists: [{ id: 100, title: "Backlog" }] });
    client.cards.list.mockResolvedValue([]); // card 501 missing

    const prev = snapshotWithCards(1, {
      "501": { columnId: 100, columnName: "Backlog", updatedAt: "2026-01-01T00:00:00Z", assignees: [] },
    });

    // Deep crawl #1: card missing → pending count=1
    const r1 = await pollSafetyNet(
      baseOpts(client, {
        previousSnapshot: prev,
        isDeepCrawl: true,
      }),
    );
    expect(r1.events.filter((e) => e.meta.eventKind === "disappeared")).toEqual([]);
    expect(r1.pending.entries["card:501"]).toBe(1);

    // Deep crawl #2: still missing → disappeared event
    const r2 = await pollSafetyNet(
      baseOpts(client, {
        previousSnapshot: prev,
        previousPending: r1.pending,
        isDeepCrawl: true,
      }),
    );
    const disappeared = r2.events.find((e) => e.meta.eventKind === "disappeared");
    expect(disappeared).toBeDefined();
    expect(disappeared!.meta.recordableType).toBe("Kanban::Card");
  });

  // ---- Disappeared suppressed on capped crawl ----

  it("card disappeared suppressed on capped (non-deep) crawl", async () => {
    const client = makeClient();
    setupDock({ cardTableId: 10 });
    client.cardTables.get.mockResolvedValue({ lists: [{ id: 100, title: "Backlog" }] });
    client.cards.list.mockResolvedValue([]); // card missing

    const prev = snapshotWithCards(1, {
      "501": { columnId: 100, columnName: "Backlog", updatedAt: "2026-01-01T00:00:00Z", assignees: [] },
    });

    const result = await pollSafetyNet(
      baseOpts(client, {
        previousSnapshot: prev,
        isDeepCrawl: false, // capped
      }),
    );
    // No disappeared detection on capped crawl
    expect(result.events.filter((e) => e.meta.eventKind === "disappeared")).toEqual([]);
  });

  // ---- Card pending reset when present again ----

  it("card pending reset when present again", async () => {
    const client = makeClient();
    setupDock({ cardTableId: 10 });
    client.cardTables.get.mockResolvedValue({ lists: [{ id: 100, title: "Backlog" }] });
    // Card is present
    client.cards.list.mockResolvedValue([{ id: 501, updated_at: "2026-01-01T00:00:00Z", assignees: [] }]);

    const prev = snapshotWithCards(1, {
      "501": { columnId: 100, columnName: "Backlog", updatedAt: "2026-01-01T00:00:00Z", assignees: [] },
    });

    const pendingBefore: DisappearedPending = { entries: { "card:501": 1 } };
    const result = await pollSafetyNet(
      baseOpts(client, {
        previousSnapshot: prev,
        previousPending: pendingBefore,
        isDeepCrawl: true,
      }),
    );

    // Pending counter should be cleared
    expect(result.pending.entries["card:501"]).toBeUndefined();
  });

  // ---- Todo appeared ----

  it("todo appeared → created event", async () => {
    const client = makeClient();
    setupDock({ todosetId: 20 });
    client.recordings.list.mockResolvedValue([
      { id: 601, updated_at: "2026-01-01T00:00:00Z", assignees: [{ id: 99 }] },
    ]);

    const prev = emptySnapshot(1);
    const result = await pollSafetyNet(baseOpts(client, { previousSnapshot: prev }));

    const e = result.events.find((e) => e.meta.recordableType === "Todo");
    expect(e).toBeDefined();
    expect(e!.meta.eventKind).toBe("created");
  });

  // ---- Todo assignment changed ----

  it("todo assignment changed → assigned event", async () => {
    const client = makeClient();
    setupDock({ todosetId: 20 });
    client.recordings.list.mockResolvedValue([
      { id: 601, updated_at: "2026-01-02T00:00:00Z", assignees: [{ id: 42 }] },
    ]);

    const prev = snapshotWithTodos(1, {
      "601": { updatedAt: "2026-01-01T00:00:00Z", assignees: ["99"] },
    });
    const result = await pollSafetyNet(baseOpts(client, { previousSnapshot: prev }));

    const assigned = result.events.find((e) => e.meta.eventKind === "assigned");
    expect(assigned).toBeDefined();
    expect(assigned!.meta.assignedToAgent).toBe(true);
  });

  // ---- Todo disappeared (2 deep misses) ----

  it("todo disappeared after 2 deep crawl misses", async () => {
    const client = makeClient();
    setupDock({ todosetId: 20 });
    client.recordings.list.mockResolvedValue([]); // todo missing

    const prev = snapshotWithTodos(1, {
      "601": { updatedAt: "2026-01-01T00:00:00Z", assignees: [] },
    });

    // Miss 1
    const r1 = await pollSafetyNet(
      baseOpts(client, {
        previousSnapshot: prev,
        isDeepCrawl: true,
      }),
    );
    expect(r1.pending.entries["todo:601"]).toBe(1);

    // Miss 2
    const r2 = await pollSafetyNet(
      baseOpts(client, {
        previousSnapshot: prev,
        previousPending: r1.pending,
        isDeepCrawl: true,
      }),
    );
    const disappeared = r2.events.find((e) => e.meta.eventKind === "disappeared");
    expect(disappeared).toBeDefined();
    expect(disappeared!.meta.recordableType).toBe("Todo");
  });

  // ---- Check-in new answers ----

  it("check-in new answers → checkin_answered per answer", async () => {
    const client = makeClient();
    setupDock({ questionnaireId: 30 });
    client.checkins.listQuestions.mockResolvedValue([{ id: 701 }]);
    client.checkins.listAnswers.mockResolvedValue([{ id: 801 }, { id: 802 }]);

    const prev = snapshotWithCheckins(1, {
      "701": { answerIds: ["801"] }, // only 801 was known
    });
    const result = await pollSafetyNet(baseOpts(client, { previousSnapshot: prev }));

    const checkinEvents = result.events.filter((e) => e.meta.eventKind === "checkin_answered");
    expect(checkinEvents.length).toBe(1);
    expect(checkinEvents[0].meta.recordingId).toBe("802");
  });

  // ---- Dock inaccessible → project skipped ----

  it("dock inaccessible with no previous → project absent from snapshot", async () => {
    const client = makeClient();
    vi.mocked(resolveDockToolIds).mockResolvedValue(undefined);

    const result = await pollSafetyNet(baseOpts(client));
    expect(result.events).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
    expect(result.snapshot.projects["1"]).toBeUndefined();
  });

  it("dock inaccessible with previous → carries forward previous project snapshot", async () => {
    const client = makeClient();
    vi.mocked(resolveDockToolIds).mockResolvedValue(undefined);

    const prev = snapshotWithCards(1, {
      "501": { columnId: 100, columnName: "Backlog", updatedAt: "2026-01-01T00:00:00Z", assignees: [] },
    });
    const result = await pollSafetyNet(baseOpts(client, { previousSnapshot: prev }));

    expect(result.events).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
    // Previous project state carried forward — not dropped
    expect(result.snapshot.projects["1"]).toEqual(prev.projects["1"]);
  });

  // ---- Cards crawl throws → skipped, other types continue ----

  it("cards crawl throws → skipped, other types continue", async () => {
    const client = makeClient();
    setupDock({ cardTableId: 10, todosetId: 20 });

    // Cards crawl will fail
    client.cardTables.get.mockRejectedValue(new Error("cards exploded"));

    // Todos crawl works
    client.recordings.list.mockResolvedValue([{ id: 601, updated_at: "2026-01-01T00:00:00Z", assignees: [] }]);

    const prev = emptySnapshot(1);
    const result = await pollSafetyNet(baseOpts(client, { previousSnapshot: prev }));

    expect(log.warn).toHaveBeenCalled();
    // Todos should still produce events
    const todoEvents = result.events.filter((e) => e.meta.recordableType === "Todo");
    expect(todoEvents.length).toBe(1);
  });

  // ---- Snapshot durability: carry forward on crawl failure ----

  it("cards crawl failure → carries forward previous cards, no false appeared", async () => {
    const client = makeClient();
    setupDock({ cardTableId: 10 });
    client.cardTables.get.mockRejectedValue(new Error("transient"));

    const prev = snapshotWithCards(1, {
      "501": { columnId: 100, columnName: "Backlog", updatedAt: "2026-01-01T00:00:00Z", assignees: [] },
    });
    const result = await pollSafetyNet(baseOpts(client, { previousSnapshot: prev }));

    // No events — previous state carried forward, no diff
    expect(result.events).toEqual([]);
    // Snapshot retains previous cards
    expect(result.snapshot.projects["1"].cards["501"]).toEqual(prev.projects["1"].cards["501"]);
  });

  it("todos crawl failure → carries forward previous todos", async () => {
    const client = makeClient();
    setupDock({ todosetId: 20 });
    client.recordings.list.mockRejectedValue(new Error("transient"));

    const prev = snapshotWithTodos(1, {
      "601": { updatedAt: "2026-01-01T00:00:00Z", assignees: ["42"] },
    });
    const result = await pollSafetyNet(baseOpts(client, { previousSnapshot: prev }));

    expect(result.events).toEqual([]);
    expect(result.snapshot.projects["1"].todos["601"]).toEqual(prev.projects["1"].todos["601"]);
  });

  it("checkins crawl failure → carries forward previous checkins", async () => {
    const client = makeClient();
    setupDock({ questionnaireId: 30 });
    client.checkins.listQuestions.mockRejectedValue(new Error("transient"));

    const prev = snapshotWithCheckins(1, {
      "701": { answerIds: ["801"] },
    });
    const result = await pollSafetyNet(baseOpts(client, { previousSnapshot: prev }));

    expect(result.events).toEqual([]);
    expect(result.snapshot.projects["1"].checkins["701"]).toEqual(prev.projects["1"].checkins["701"]);
  });

  it("crawl failure with no previous → empty snapshot (no carry-forward possible)", async () => {
    const client = makeClient();
    setupDock({ cardTableId: 10 });
    client.cardTables.get.mockRejectedValue(new Error("transient"));

    // No previous snapshot
    const result = await pollSafetyNet(baseOpts(client));

    // Cards remain empty — no previous state to carry forward
    expect(result.snapshot.projects["1"].cards).toEqual({});
  });

  // ---- Serialization round-trips ----

  it("snapshot serialization round-trip", () => {
    const snap: SafetyNetSnapshot = {
      version: 1,
      updatedAt: "2026-01-01T00:00:00Z",
      projects: {
        "1": {
          cards: {
            "501": { columnId: 1, columnName: "Backlog", updatedAt: "2026-01-01T00:00:00Z", assignees: ["42"] },
          },
          todos: {},
          checkins: {},
        },
      },
    };
    const raw = serializeSnapshot(snap);
    const restored = deserializeSnapshot(raw);
    expect(restored).toEqual(snap);
  });

  it("version mismatch → undefined", () => {
    const raw = JSON.stringify({ version: 2, projects: {} });
    expect(deserializeSnapshot(raw)).toBeUndefined();
  });

  it("malformed snapshot JSON → undefined", () => {
    expect(deserializeSnapshot("not json")).toBeUndefined();
  });

  it("pending serialization round-trip", () => {
    const pending: DisappearedPending = { entries: { "card:501": 1, "todo:601": 2 } };
    const raw = serializePending(pending);
    const restored = deserializePending(raw);
    expect(restored).toEqual(pending);
  });

  it("malformed pending JSON → undefined", () => {
    expect(deserializePending("not json")).toBeUndefined();
  });

  // ---- invalidateDockCache called on 404 ----

  it("invalidateDockCache called on 404 from cards crawl", async () => {
    // Access the mock BasecampError from our mock
    const { BasecampError } = await import("../src/basecamp-client.js");
    const client = makeClient();
    setupDock({ cardTableId: 10, todosetId: 20 });

    // Cards crawl throws a 404 BasecampError
    client.cardTables.get.mockRejectedValue(new BasecampError("not_found", "Not found", { httpStatus: 404 }));
    // Todos work fine
    client.recordings.list.mockResolvedValue([]);

    const result = await pollSafetyNet(baseOpts(client));
    expect(invalidateDockCache).toHaveBeenCalledWith(1);
  });

  it("invalidateDockCache called on 410 from todos crawl", async () => {
    const { BasecampError } = await import("../src/basecamp-client.js");
    const client = makeClient();
    setupDock({ todosetId: 20 });

    client.recordings.list.mockRejectedValue(new BasecampError("api_error", "Gone", { httpStatus: 410 }));

    await pollSafetyNet(baseOpts(client));
    expect(invalidateDockCache).toHaveBeenCalledWith(1);
  });

  it("invalidateDockCache called on 404 from checkins crawl", async () => {
    const { BasecampError } = await import("../src/basecamp-client.js");
    const client = makeClient();
    setupDock({ questionnaireId: 30 });

    client.checkins.listQuestions.mockRejectedValue(new BasecampError("not_found", "Not found", { httpStatus: 404 }));

    await pollSafetyNet(baseOpts(client));
    expect(invalidateDockCache).toHaveBeenCalledWith(1);
  });

  it("invalidateDockCache called on httpStatus 404 with non-not_found code", async () => {
    const { BasecampError } = await import("../src/basecamp-client.js");
    const client = makeClient();
    setupDock({ cardTableId: 10, todosetId: 20 });

    // 404 httpStatus but code is "api_error" — should still invalidate
    client.cardTables.get.mockRejectedValue(new BasecampError("api_error", "Not found", { httpStatus: 404 }));
    client.recordings.list.mockResolvedValue([]);

    await pollSafetyNet(baseOpts(client));
    expect(invalidateDockCache).toHaveBeenCalledWith(1);
  });

  it("invalidateDockCache NOT called on non-404/410 error", async () => {
    const client = makeClient();
    setupDock({ cardTableId: 10 });

    client.cardTables.get.mockRejectedValue(new Error("network timeout"));

    await pollSafetyNet(baseOpts(client));
    expect(invalidateDockCache).not.toHaveBeenCalled();
  });

  // ---- Truncated cards suppress disappeared ----

  it("truncated card response suppresses disappeared on deep crawl", async () => {
    const client = makeClient();
    setupDock({ cardTableId: 10 });
    client.cardTables.get.mockResolvedValue({ lists: [{ id: 100, title: "Backlog" }] });
    // Return truncated result (card 501 is not in the result)
    client.cards.list.mockResolvedValue({
      data: [],
      meta: { truncated: true },
    });

    const prev = snapshotWithCards(1, {
      "501": { columnId: 100, columnName: "Backlog", updatedAt: "2026-01-01T00:00:00Z", assignees: [] },
    });

    // Even with 2 deep crawl cycles, truncated results suppress disappeared
    const pending: DisappearedPending = { entries: { "card:501": 1 } };
    const result = await pollSafetyNet(
      baseOpts(client, {
        previousSnapshot: prev,
        previousPending: pending,
        isDeepCrawl: true,
      }),
    );

    expect(result.events.filter((e) => e.meta.eventKind === "disappeared")).toEqual([]);
  });

  // ---- Multiple projects ----

  it("multiple projects processed independently", async () => {
    const client = makeClient();
    vi.mocked(resolveDockToolIds).mockResolvedValue({ todosetId: 20 });
    client.recordings.list
      .mockResolvedValueOnce([{ id: 601, updated_at: "2026-01-01T00:00:00Z", assignees: [] }])
      .mockResolvedValueOnce([{ id: 602, updated_at: "2026-01-01T00:00:00Z", assignees: [] }]);

    const prev: SafetyNetSnapshot = {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {
        "1": { cards: {}, todos: {}, checkins: {} },
        "2": { cards: {}, todos: {}, checkins: {} },
      },
    };

    const result = await pollSafetyNet(
      baseOpts(client, {
        projectIds: [1, 2],
        previousSnapshot: prev,
      }),
    );

    expect(result.events.length).toBe(2);
    expect(result.snapshot.projects["1"]).toBeDefined();
    expect(result.snapshot.projects["2"]).toBeDefined();
  });

  // ---- No dock tools → empty project snapshot ----

  it("no dock tools enabled → empty project snapshot, no events", async () => {
    const client = makeClient();
    setupDock({}); // all tool IDs undefined

    const prev = emptySnapshot(1);
    const result = await pollSafetyNet(baseOpts(client, { previousSnapshot: prev }));

    expect(result.events).toEqual([]);
    expect(result.snapshot.projects["1"]).toBeDefined();
  });
});
