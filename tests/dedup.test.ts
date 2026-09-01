/**
 * Tests: replay-guard semantics (SPEC §2.14).
 *
 * Behavioral rewrite of the old EventDedup tests: the plugin's replay guard
 * wraps openclaw/plugin-sdk/persistent-dedupe with claim → process → commit
 * semantics, source-prefixed primary keys, and cross-source secondary keys.
 * These tests run against the real SDK store under a temp OPENCLAW_STATE_DIR.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBasecampReplayGuard,
  getReplayGuard,
  type ReplayGuard,
  replayPrimaryKey,
  replaySecondaryKey,
  resetReplayGuard,
} from "../src/inbound/replay-guard.js";

describe("replay key helpers", () => {
  it("replayPrimaryKey builds source:id strings", () => {
    expect(replayPrimaryKey("activity", "12345")).toBe("activity:12345");
    expect(replayPrimaryKey("reading", 678)).toBe("reading:678");
    expect(replayPrimaryKey("webhook", "9")).toBe("webhook:9");
  });

  it("replaySecondaryKey builds recordingId:action:createdAt strings", () => {
    expect(replaySecondaryKey("456", "created", "2025-01-15T10:00:00Z")).toBe("456:created:2025-01-15T10:00:00Z");
    expect(replaySecondaryKey(789, "moved", "2025-02-01T00:00:00Z")).toBe("789:moved:2025-02-01T00:00:00Z");
  });
});

describe("replay guard", () => {
  let stateDir: string;
  let guard: ReplayGuard;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "replay-guard-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    guard = createBasecampReplayGuard();
  });

  afterEach(() => {
    guard.clearMemory();
    delete process.env.OPENCLAW_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  const evt = (primaryKey: string, secondaryKey?: string) => ({ accountId: "acct", primaryKey, secondaryKey });

  it("processes an event exactly once", async () => {
    let runs = 0;
    const run = () =>
      guard.processGuarded(evt("activity:1"), async () => {
        runs++;
        return "ok";
      });

    expect(await run()).toEqual({ kind: "processed", value: "ok" });
    expect((await run()).kind).toBe("duplicate");
    expect(runs).toBe(1);
  });

  it("distinct primary keys process independently", async () => {
    expect((await guard.processGuarded(evt("activity:1"), async () => 1)).kind).toBe("processed");
    expect((await guard.processGuarded(evt("activity:2"), async () => 2)).kind).toBe("processed");
  });

  it("collapses cross-source events sharing a secondary key", async () => {
    const secondary = replaySecondaryKey("456", "created", "2025-01-15T10:00:00Z");
    expect((await guard.processGuarded(evt("activity:1", secondary), async () => "a")).kind).toBe("processed");
    // Different source, different primary key, same underlying event
    expect((await guard.processGuarded(evt("webhook:99", secondary), async () => "b")).kind).toBe("duplicate");
  });

  it("does not collapse events with different secondary keys", async () => {
    const s1 = replaySecondaryKey("456", "created", "2025-01-15T10:00:00Z");
    const s2 = replaySecondaryKey("456", "completed", "2025-01-15T11:00:00Z");
    expect((await guard.processGuarded(evt("activity:1", s1), async () => "a")).kind).toBe("processed");
    expect((await guard.processGuarded(evt("activity:2", s2), async () => "b")).kind).toBe("processed");
  });

  it("record marks an event seen without processing", async () => {
    await guard.record(evt("activity:1", "456:created:t"));
    expect(await guard.hasRecent(evt("activity:1"))).toBe(true);
    // Secondary key alone also matches
    expect(await guard.hasRecent(evt("webhook:2", "456:created:t"))).toBe(true);
    expect((await guard.processGuarded(evt("activity:1"), async () => "x")).kind).toBe("duplicate");
  });

  it("hasRecent never claims — a probed event still processes", async () => {
    expect(await guard.hasRecent(evt("activity:1"))).toBe(false);
    expect((await guard.processGuarded(evt("activity:1"), async () => "x")).kind).toBe("processed");
  });

  it("a processing failure releases the claim for retry", async () => {
    await expect(
      guard.processGuarded(evt("activity:1", "456:created:t"), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await guard.hasRecent(evt("activity:1"))).toBe(false);
    expect((await guard.processGuarded(evt("activity:1", "456:created:t"), async () => "retry")).kind).toBe(
      "processed",
    );
  });

  it("a failure on a shared secondary key releases it for the other source", async () => {
    const secondary = replaySecondaryKey("456", "created", "t1");
    await expect(
      guard.processGuarded(evt("activity:1", secondary), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Webhook delivery of the same logical event can now claim it
    expect((await guard.processGuarded(evt("webhook:9", secondary), async () => "wh")).kind).toBe("processed");
  });

  it("concurrent processing of the same event runs once (inflight skip)", async () => {
    let runs = 0;
    const slow = () =>
      guard.processGuarded(evt("activity:1"), async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 20));
        return "done";
      });

    const [a, b] = await Promise.all([slow(), slow()]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["inflight", "processed"]);
    expect(runs).toBe(1);
  });

  it("forget removes committed keys", async () => {
    await guard.record(evt("activity:1", "456:created:t"));
    expect(await guard.forget(evt("activity:1", "456:created:t"))).toBe(true);
    expect(await guard.hasRecent(evt("activity:1"))).toBe(false);
    expect((await guard.processGuarded(evt("activity:1"), async () => "x")).kind).toBe("processed");
  });

  it("isolates accounts by namespace", async () => {
    await guard.record({ accountId: "a", primaryKey: "activity:1" });
    expect(await guard.hasRecent({ accountId: "a", primaryKey: "activity:1" })).toBe(true);
    expect(await guard.hasRecent({ accountId: "b", primaryKey: "activity:1" })).toBe(false);
  });

  it("expires entries after the TTL", async () => {
    const shortGuard = createBasecampReplayGuard({ ttlMs: 30 });
    await shortGuard.record(evt("activity:ttl"));
    expect(await shortGuard.hasRecent(evt("activity:ttl"))).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(await shortGuard.hasRecent(evt("activity:ttl"))).toBe(false);
    shortGuard.clearMemory();
  });
});

describe("shared replay guard", () => {
  afterEach(() => {
    resetReplayGuard();
    delete process.env.OPENCLAW_STATE_DIR;
  });

  it("getReplayGuard returns a process-wide singleton until reset", () => {
    process.env.OPENCLAW_STATE_DIR = mkdtempSync(join(tmpdir(), "replay-shared-"));
    const a = getReplayGuard();
    expect(getReplayGuard()).toBe(a);
    resetReplayGuard();
    expect(getReplayGuard()).not.toBe(a);
  });
});
