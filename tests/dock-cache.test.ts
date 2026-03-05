/**
 * Tests: dock-cache.ts
 *
 * Validates dock tool ID resolution, caching with TTL, invalidation,
 * error handling, and disabled dock item filtering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDockCache, invalidateDockCache, resolveDockToolIds } from "../src/inbound/dock-cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(dock: Array<{ name: string; id: number; enabled?: boolean }>) {
  return {
    projects: {
      get: vi.fn().mockResolvedValue({ dock }),
    },
  };
}

const fullDock = [
  { name: "kanban_board", id: 100, enabled: true },
  { name: "todoset", id: 200, enabled: true },
  { name: "questionnaire", id: 300, enabled: true },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dock-cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearDockCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cache miss → fetches from API and returns DockToolIds", async () => {
    const client = makeClient(fullDock);
    const ids = await resolveDockToolIds(client, 42);

    expect(client.projects.get).toHaveBeenCalledWith(42);
    expect(ids).toEqual({
      cardTableId: 100,
      todosetId: 200,
      questionnaireId: 300,
    });
  });

  it("cache hit within TTL → does NOT re-fetch", async () => {
    const client = makeClient(fullDock);
    await resolveDockToolIds(client, 42);
    expect(client.projects.get).toHaveBeenCalledTimes(1);

    // 30 minutes later — still within 1h TTL
    vi.advanceTimersByTime(30 * 60 * 1000);
    const ids = await resolveDockToolIds(client, 42);
    expect(client.projects.get).toHaveBeenCalledTimes(1);
    expect(ids).toEqual({
      cardTableId: 100,
      todosetId: 200,
      questionnaireId: 300,
    });
  });

  it("cache expired after TTL → re-fetches", async () => {
    const client = makeClient(fullDock);
    await resolveDockToolIds(client, 42);
    expect(client.projects.get).toHaveBeenCalledTimes(1);

    // Advance past 1h TTL
    vi.advanceTimersByTime(61 * 60 * 1000);
    await resolveDockToolIds(client, 42);
    expect(client.projects.get).toHaveBeenCalledTimes(2);
  });

  it("invalidateDockCache evicts entry → next call re-fetches", async () => {
    const client = makeClient(fullDock);
    await resolveDockToolIds(client, 42);
    expect(client.projects.get).toHaveBeenCalledTimes(1);

    invalidateDockCache(42);

    await resolveDockToolIds(client, 42);
    expect(client.projects.get).toHaveBeenCalledTimes(2);
  });

  it("clearDockCache wipes all entries", async () => {
    const client = makeClient(fullDock);
    await resolveDockToolIds(client, 1);
    await resolveDockToolIds(client, 2);
    expect(client.projects.get).toHaveBeenCalledTimes(2);

    clearDockCache();

    await resolveDockToolIds(client, 1);
    await resolveDockToolIds(client, 2);
    expect(client.projects.get).toHaveBeenCalledTimes(4);
  });

  it("client.projects.get throws → returns undefined", async () => {
    const client = {
      projects: {
        get: vi.fn().mockRejectedValue(new Error("network failure")),
      },
    };
    const ids = await resolveDockToolIds(client, 42);
    expect(ids).toBeUndefined();
  });

  it("disabled dock items excluded", async () => {
    const client = makeClient([
      { name: "kanban_board", id: 100, enabled: false },
      { name: "todoset", id: 200, enabled: true },
      { name: "questionnaire", id: 300, enabled: false },
    ]);
    const ids = await resolveDockToolIds(client, 42);
    expect(ids).toEqual({
      todosetId: 200,
    });
    expect(ids!.cardTableId).toBeUndefined();
    expect(ids!.questionnaireId).toBeUndefined();
  });

  it("missing dock items → undefined fields", async () => {
    const client = makeClient([{ name: "todoset", id: 200, enabled: true }]);
    const ids = await resolveDockToolIds(client, 42);
    expect(ids!.cardTableId).toBeUndefined();
    expect(ids!.todosetId).toBe(200);
    expect(ids!.questionnaireId).toBeUndefined();
  });

  it("multiple tools coexist in one dock → all IDs populated", async () => {
    const client = makeClient(fullDock);
    const ids = await resolveDockToolIds(client, 42);
    expect(ids!.cardTableId).toBe(100);
    expect(ids!.todosetId).toBe(200);
    expect(ids!.questionnaireId).toBe(300);
  });

  it("empty dock → empty DockToolIds", async () => {
    const client = makeClient([]);
    const ids = await resolveDockToolIds(client, 42);
    expect(ids).toEqual({});
  });

  it("project response with no dock property → empty DockToolIds", async () => {
    const client = {
      projects: {
        get: vi.fn().mockResolvedValue({}),
      },
    };
    const ids = await resolveDockToolIds(client, 42);
    expect(ids).toEqual({});
  });

  it("different projects cached independently", async () => {
    const client = makeClient(fullDock);
    await resolveDockToolIds(client, 1);
    await resolveDockToolIds(client, 2);
    expect(client.projects.get).toHaveBeenCalledTimes(2);

    // Invalidate one, the other stays cached
    invalidateDockCache(1);
    await resolveDockToolIds(client, 1);
    await resolveDockToolIds(client, 2);
    expect(client.projects.get).toHaveBeenCalledTimes(3); // only project 1 re-fetched
  });

  it("enabled property omitted → item included (default enabled)", async () => {
    const client = makeClient([{ name: "kanban_board", id: 100 }]);
    const ids = await resolveDockToolIds(client, 42);
    expect(ids!.cardTableId).toBe(100);
  });
});
