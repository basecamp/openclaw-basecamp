/**
 * Tests: reconciliation.ts
 *
 * Validates runReconciliation with mocked client + real EventDedup,
 * and promotion hysteresis logic (promote after 2 gap cycles, demote
 * after 3 clean cycles, TTL expiry, MAX_PROMOTIONS cap).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// State dir mock — EventDedup needs it for SQLite backend
const testStateDir = mkdtempSync(join(tmpdir(), "rc-state-"));
vi.mock("../src/inbound/state-dir.js", () => ({
  resolvePluginStateDir: () => testStateDir,
}));

import { EventDedup } from "../src/inbound/dedup.js";
import type { PromotionEntry, PromotionState } from "../src/inbound/reconciliation.js";
import {
  deserializePromotionState,
  runReconciliation,
  serializePromotionState,
} from "../src/inbound/reconciliation.js";
import type { ResolvedBasecampAccount } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const account: ResolvedBasecampAccount = {
  accountId: "test",
  enabled: true,
  personId: "1",
  token: "tok",
  tokenSource: "config",
  config: { personId: "1" },
};

function makeClient(events: any[] | Error = []) {
  return {
    reports: {
      progress: events instanceof Error ? vi.fn().mockRejectedValue(events) : vi.fn().mockResolvedValue(events),
    },
  };
}

/** Build a Basecamp activity event with required fields. */
function activityEvent(opts: { id: number; kind: string; created_at?: string; recordingId?: number }) {
  return {
    id: opts.id,
    kind: opts.kind,
    action: "created",
    created_at: opts.created_at ?? new Date().toISOString(),
    bucket: { id: 1, name: "Test" },
    creator: { id: 99, name: "User" },
    recording: opts.recordingId != null ? { id: opts.recordingId } : undefined,
  };
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reconciliation", () => {
  let dedup: EventDedup;

  beforeEach(() => {
    vi.clearAllMocks();
    dedup = new EventDedup({ ttlMs: 60_000 });
  });

  afterEach(() => {
    // EventDedup has no close() — just let it be GC'd
  });

  afterAll(() => {
    rmSync(testStateDir, { recursive: true, force: true });
  });

  // ---- Core reconciliation ----

  it("empty feed → zero gaps", async () => {
    const client = makeClient([]);
    const result = await runReconciliation({
      account,
      client,
      dedup,
      log,
    });
    expect(result.replayed).toBe(0);
    expect(result.unseen).toBe(0);
    expect(result.gapsByType).toEqual({});
  });

  it("all events seen in dedup → zero gaps", async () => {
    // Pre-populate dedup with these events
    dedup.isDuplicate("activity:1");
    dedup.isDuplicate("activity:2");

    const client = makeClient([
      activityEvent({ id: 1, kind: "todo_created" }),
      activityEvent({ id: 2, kind: "todo_completed" }),
    ]);
    const result = await runReconciliation({
      account,
      client,
      dedup,
      log,
    });
    expect(result.replayed).toBe(2);
    expect(result.unseen).toBe(0);
  });

  it("unseen events counted per type", async () => {
    const client = makeClient([
      activityEvent({ id: 1, kind: "todo_created" }),
      activityEvent({ id: 2, kind: "todo_completed" }),
      activityEvent({ id: 3, kind: "kanban_card_created" }),
    ]);
    const result = await runReconciliation({
      account,
      client,
      dedup,
      log,
    });
    expect(result.replayed).toBe(3);
    expect(result.unseen).toBe(3);
    expect(result.gapsByType["Todo"]).toBe(2);
    expect(result.gapsByType["Kanban::Card"]).toBe(1);
  });

  it("events before 24h window skipped", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const client = makeClient([activityEvent({ id: 1, kind: "todo_created", created_at: old })]);
    const result = await runReconciliation({
      account,
      client,
      dedup,
      log,
    });
    expect(result.replayed).toBe(0);
    expect(result.unseen).toBe(0);
  });

  it("non-normalizable kinds skipped", async () => {
    const client = makeClient([activityEvent({ id: 1, kind: "unknown_weird_kind" })]);
    const result = await runReconciliation({
      account,
      client,
      dedup,
      log,
    });
    expect(result.replayed).toBe(0);
    expect(result.unseen).toBe(0);
  });

  it("client.reports.progress throws → safe return", async () => {
    const client = makeClient(new Error("boom"));
    const result = await runReconciliation({
      account,
      client,
      dedup,
      log,
    });
    expect(result.replayed).toBe(0);
    expect(result.unseen).toBe(0);
    expect(result.gapsByType).toEqual({});
    expect(log.error).toHaveBeenCalled();
  });

  it("non-array response → treated as empty", async () => {
    const client = {
      reports: {
        progress: vi.fn().mockResolvedValue(null),
      },
    };
    const result = await runReconciliation({
      account,
      client,
      dedup,
      log,
    });
    expect(result.replayed).toBe(0);
  });

  // ---- Serialization ----

  it("serialization round-trip", () => {
    const promotions: PromotionEntry[] = [
      {
        type: "Todo",
        promotedAt: Date.now(),
        consecutiveGapCycles: 2,
        consecutiveCleanCycles: 0,
      },
    ];
    const gaps = { Todo: 5 };
    const raw = serializePromotionState(promotions, gaps);
    const restored = deserializePromotionState(raw);
    expect(restored).toBeDefined();
    expect(restored!.promotions).toEqual(promotions);
    expect(restored!.previousGaps).toEqual(gaps);
  });

  it("malformed JSON → undefined", () => {
    expect(deserializePromotionState("garbage")).toBeUndefined();
  });

  // ---- Promotion hysteresis ----

  it("gaps below threshold → no promotion", async () => {
    // 1 gap < threshold of 3
    const client = makeClient([activityEvent({ id: 1, kind: "todo_created" })]);
    const result = await runReconciliation({
      account,
      client,
      dedup,
      gapThreshold: 3,
      log,
    });
    expect(result.promotions).toEqual([]);
  });

  it("gaps at threshold, cycle 1 → no promotion yet (need 2 consecutive)", async () => {
    const client = makeClient([
      activityEvent({ id: 1, kind: "todo_created" }),
      activityEvent({ id: 2, kind: "todo_completed" }),
      activityEvent({ id: 3, kind: "todo_assigned" }),
    ]);
    const result = await runReconciliation({
      account,
      client,
      dedup,
      gapThreshold: 3,
      log,
    });
    // First cycle: gaps recorded but no previous gaps → no promotion
    expect(result.promotions).toEqual([]);
    expect(result.gapsByType["Todo"]).toBe(3);
  });

  it("gaps at threshold, cycle 2 → promotion fires", async () => {
    const events = [
      activityEvent({ id: 1, kind: "todo_created" }),
      activityEvent({ id: 2, kind: "todo_completed" }),
      activityEvent({ id: 3, kind: "todo_assigned" }),
    ];
    const client = makeClient(events);

    // Cycle 1
    const r1 = await runReconciliation({
      account,
      client,
      dedup,
      gapThreshold: 3,
      log,
    });
    const state1: PromotionState = {
      promotions: r1.promotions,
      previousGaps: r1.gapsByType,
    };

    // Cycle 2 — same gaps, with previousState from cycle 1
    const client2 = makeClient([
      activityEvent({ id: 4, kind: "todo_created" }),
      activityEvent({ id: 5, kind: "todo_completed" }),
      activityEvent({ id: 6, kind: "todo_assigned" }),
    ]);
    const r2 = await runReconciliation({
      account,
      client: client2,
      dedup,
      gapThreshold: 3,
      promotionState: state1,
      log,
    });
    expect(r2.promotions.length).toBe(1);
    expect(r2.promotions[0].type).toBe("Todo");
  });

  it("existing promotion + 3 clean cycles → demotion", async () => {
    const now = Date.now();
    const existingPromotion: PromotionEntry = {
      type: "Todo",
      promotedAt: now,
      consecutiveGapCycles: 2,
      consecutiveCleanCycles: 0,
    };

    let state: PromotionState = {
      promotions: [existingPromotion],
      previousGaps: {},
    };

    // 3 clean cycles (no gaps)
    for (let i = 0; i < 3; i++) {
      const client = makeClient([]);
      const result = await runReconciliation({
        account,
        client,
        dedup,
        gapThreshold: 3,
        promotionState: state,
        log,
      });
      state = {
        promotions: result.promotions,
        previousGaps: result.gapsByType,
      };
    }
    expect(state.promotions).toEqual([]);
  });

  it("existing promotion + <3 clean cycles → retained", async () => {
    const now = Date.now();
    const entry: PromotionEntry = {
      type: "Todo",
      promotedAt: now,
      consecutiveGapCycles: 2,
      consecutiveCleanCycles: 0,
    };

    const client = makeClient([]); // clean cycle
    const result = await runReconciliation({
      account,
      client,
      dedup,
      gapThreshold: 3,
      promotionState: { promotions: [entry], previousGaps: {} },
      log,
    });
    expect(result.promotions.length).toBe(1);
    expect(result.promotions[0].consecutiveCleanCycles).toBe(1);
  });

  it("TTL expiry → entry dropped", async () => {
    const old = Date.now() - 25 * 60 * 60 * 1000; // >24h ago
    const entry: PromotionEntry = {
      type: "Todo",
      promotedAt: old,
      consecutiveGapCycles: 2,
      consecutiveCleanCycles: 0,
    };

    const client = makeClient([]);
    const result = await runReconciliation({
      account,
      client,
      dedup,
      gapThreshold: 3,
      promotionState: { promotions: [entry], previousGaps: {} },
      log,
    });
    expect(result.promotions).toEqual([]);
  });

  it("MAX_PROMOTIONS cap (3) → 4th type not promoted", async () => {
    // We have 3 promotable types: Kanban::Card, Todo, Question::Answer
    // If all 3 are already promoted and another has gaps, it can't be added
    const now = Date.now();
    const existing: PromotionEntry[] = [
      { type: "Kanban::Card", promotedAt: now, consecutiveGapCycles: 2, consecutiveCleanCycles: 0 },
      { type: "Todo", promotedAt: now, consecutiveGapCycles: 2, consecutiveCleanCycles: 0 },
      { type: "Question::Answer", promotedAt: now, consecutiveGapCycles: 2, consecutiveCleanCycles: 0 },
    ];

    // Feed has gaps for all existing + a non-promotable type
    const client = makeClient([
      activityEvent({ id: 1, kind: "kanban_card_created" }),
      activityEvent({ id: 2, kind: "todo_created" }),
      activityEvent({ id: 3, kind: "question_answer_created" }),
    ]);
    const result = await runReconciliation({
      account,
      client,
      dedup,
      gapThreshold: 1,
      promotionState: { promotions: existing, previousGaps: { "Kanban::Card": 5, Todo: 5, "Question::Answer": 5 } },
      log,
    });
    // All 3 retained, none added beyond 3
    expect(result.promotions.length).toBe(3);
  });

  it("non-promotable type ignored → Message gaps do not promote", async () => {
    const client = makeClient([
      activityEvent({ id: 1, kind: "comment_created" }),
      activityEvent({ id: 2, kind: "comment_created" }),
      activityEvent({ id: 3, kind: "comment_created" }),
    ]);
    // Cycle 1
    const r1 = await runReconciliation({
      account,
      client,
      dedup,
      gapThreshold: 3,
      log,
    });
    // Cycle 2 with previousGaps
    const client2 = makeClient([
      activityEvent({ id: 4, kind: "comment_created" }),
      activityEvent({ id: 5, kind: "comment_created" }),
      activityEvent({ id: 6, kind: "comment_created" }),
    ]);
    const r2 = await runReconciliation({
      account,
      client: client2,
      dedup,
      gapThreshold: 3,
      promotionState: { promotions: [], previousGaps: r1.gapsByType },
      log,
    });
    // Comment::Message is not in PROMOTABLE_TYPES
    expect(r2.promotions).toEqual([]);
  });

  it("client.reports.progress returns preserves existing promotions on error", async () => {
    const entry: PromotionEntry = {
      type: "Todo",
      promotedAt: Date.now(),
      consecutiveGapCycles: 2,
      consecutiveCleanCycles: 0,
    };

    const client = makeClient(new Error("network down"));
    const result = await runReconciliation({
      account,
      client,
      dedup,
      promotionState: { promotions: [entry], previousGaps: {} },
      log,
    });
    // On error, existing promotions are preserved
    expect(result.promotions).toEqual([entry]);
  });

  // ---- sampled flag ----

  it("sampled=false when event count is below maxItems", async () => {
    const client = makeClient([
      activityEvent({ id: 1, kind: "todo_created" }),
      activityEvent({ id: 2, kind: "todo_completed" }),
    ]);
    const result = await runReconciliation({
      account,
      client,
      dedup,
      maxItems: 10,
      log,
    });
    expect(result.sampled).toBe(false);
  });

  it("sampled=true when event count equals maxItems", async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      activityEvent({ id: i + 1, kind: "todo_created" }),
    );
    const client = makeClient(events);
    const result = await runReconciliation({
      account,
      client,
      dedup,
      maxItems: 5,
      log,
    });
    expect(result.sampled).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("capped at 5 events"),
    );
  });

  it("sampled=false on fetch error", async () => {
    const client = makeClient(new Error("boom"));
    const result = await runReconciliation({
      account,
      client,
      dedup,
      log,
    });
    expect(result.sampled).toBe(false);
  });

  it("secondary key matching detects cross-source dedup", async () => {
    // Register an event via secondary key (as if it came through webhooks)
    const recordingId = "12345";
    const eventKind = "created";
    const createdAt = new Date().toISOString();
    const secondaryKey = EventDedup.secondaryKey(recordingId, eventKind, createdAt);
    dedup.isDuplicate("webhook:original", secondaryKey);

    // Reconciliation sees same event via activity feed
    const client = makeClient([
      activityEvent({
        id: 99,
        kind: "todo_created",
        created_at: createdAt,
        recordingId: Number(recordingId),
      }),
    ]);
    const result = await runReconciliation({
      account,
      client,
      dedup,
      log,
    });
    // Should be seen via secondary key match
    expect(result.unseen).toBe(0);
  });
});
