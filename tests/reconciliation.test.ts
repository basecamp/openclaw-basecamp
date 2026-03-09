/**
 * Tests: reconciliation.ts
 *
 * Validates runReconciliation with mocked client + real EventDedup.
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
import { runReconciliation } from "../src/inbound/reconciliation.js";
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
