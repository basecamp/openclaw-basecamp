/**
 * Tests: recording→bucket index (SPEC §2.15).
 *
 * Populated by every inbound path so outbound cold sends and the messaging
 * session grammar can resolve a recording's owning bucket.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeAllRecordingIndexes,
  closeRecordingIndex,
  findRecordingEntrySync,
  getRecordingIndex,
  recordInboundMessageMappings,
} from "../src/inbound/recording-index.js";

describe("recording index", () => {
  let stateDir: string;

  beforeEach(async () => {
    await closeAllRecordingIndexes();
    stateDir = mkdtempSync(join(tmpdir(), "rec-index-"));
  });

  afterEach(async () => {
    await closeAllRecordingIndexes();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("records and looks up recording→bucket mappings", async () => {
    const index = await getRecordingIndex("acct", stateDir);
    index.record("123", { bucketId: "456", recordableType: "Kanban::Card" });

    expect(index.get("123")).toMatchObject({ bucketId: "456", recordableType: "Kanban::Card" });
    expect(index.get("999")).toBeUndefined();
    expect(index.size()).toBe(1);
  });

  it("is a per-account singleton", async () => {
    const a = await getRecordingIndex("acct", stateDir);
    const b = await getRecordingIndex("acct");
    expect(b).toBe(a);
  });

  it("persists across close/reopen via atomic JSON", async () => {
    const index = await getRecordingIndex("acct", stateDir);
    index.record("123", { bucketId: "456", recordableType: "Todo" });
    await closeRecordingIndex("acct");

    const reopened = await getRecordingIndex("acct", stateDir);
    expect(reopened.get("123")).toMatchObject({ bucketId: "456", recordableType: "Todo" });
  });

  it("re-recording an unchanged mapping does not dirty the file", async () => {
    const index = await getRecordingIndex("acct", stateDir);
    index.record("123", { bucketId: "456", recordableType: "Todo" });
    await index.flush();

    // Same mapping again — flush is a no-op (no throw, still readable)
    index.record("123", { bucketId: "456", recordableType: "Todo" });
    await index.flush();
    expect(index.get("123")).toMatchObject({ bucketId: "456" });
  });

  it("refreshes updatedAt for an unchanged mapping once the refresh interval has passed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const index = await getRecordingIndex("acct", stateDir);
      index.record("123", { bucketId: "456", recordableType: "Todo" });
      const first = index.get("123")!.updatedAt;

      vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
      index.record("123", { bucketId: "456", recordableType: "Todo" });
      expect(index.get("123")!.updatedAt).toBe(first);

      vi.setSystemTime(new Date("2026-01-03T00:00:00Z"));
      index.record("123", { bucketId: "456", recordableType: "Todo" });
      expect(index.get("123")!.updatedAt).toBeGreaterThan(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps pending mappings for the next flush when the write fails", async () => {
    const index = await getRecordingIndex("acct", stateDir);
    index.record("123", { bucketId: "456", recordableType: "Todo" });
    // Occupy the index file path with a directory so the atomic write fails.
    const filePath = join(stateDir, "recording-index-acct.json");
    mkdirSync(filePath, { recursive: true });
    await expect(index.flush()).rejects.toThrow();
    rmSync(filePath, { recursive: true, force: true });

    await index.flush();
    await closeRecordingIndex("acct");
    const reopened = await getRecordingIndex("acct", stateDir);
    expect(reopened.get("123")).toMatchObject({ bucketId: "456" });
  });

  it("recordInboundMessageMappings indexes the event, its routed parent, and ping kind", async () => {
    const index = await getRecordingIndex("acct", stateDir);

    recordInboundMessageMappings(index, {
      peer: { kind: "group", id: "recording:900" },
      meta: { bucketId: "456", recordingId: "901", recordableType: "Chat::Line" },
    });
    expect(index.get("901")).toMatchObject({ recordableType: "Chat::Line", parentRecordingId: "900" });
    expect(index.get("900")).toMatchObject({ recordableType: "Chat::Transcript", bucketId: "456" });

    recordInboundMessageMappings(
      index,
      {
        peer: { kind: "group", id: "recording:910" },
        meta: { bucketId: "456", recordingId: "911", recordableType: "Comment" },
      },
      { id: 910, type: "Todo" },
    );
    expect(index.get("910")).toMatchObject({ recordableType: "Todo" });

    recordInboundMessageMappings(index, {
      peer: { kind: "group", id: "ping:456" },
      meta: { bucketId: "456", recordingId: "920", recordableType: "Chat::Line" },
    });
    expect(index.get("ping:456")).toMatchObject({ chatKind: "group" });
  });

  it("findRecordingEntrySync searches loaded indexes across accounts", async () => {
    const a = await getRecordingIndex("acct-a", stateDir);
    a.record("111", { bucketId: "1", recordableType: "Message" });
    const b = await getRecordingIndex("acct-b", stateDir);
    b.record("222", { bucketId: "2", recordableType: "Comment" });

    expect(findRecordingEntrySync("111")).toMatchObject({ bucketId: "1" });
    expect(findRecordingEntrySync("222")).toMatchObject({ bucketId: "2" });
    expect(findRecordingEntrySync("333")).toBeUndefined();
  });

  it("findRecordingEntrySync stops seeing an account after close", async () => {
    const index = await getRecordingIndex("acct", stateDir);
    index.record("123", { bucketId: "456", recordableType: "Todo" });
    expect(findRecordingEntrySync("123")).toBeDefined();

    await closeRecordingIndex("acct");
    expect(findRecordingEntrySync("123")).toBeUndefined();
  });

  it("closeAllRecordingIndexes flushes and drops every account", async () => {
    const a = await getRecordingIndex("acct-a", stateDir);
    a.record("111", { bucketId: "1", recordableType: "Message" });
    await getRecordingIndex("acct-b", stateDir);

    await closeAllRecordingIndexes();
    expect(findRecordingEntrySync("111")).toBeUndefined();

    // Reopen sees the flushed entry
    const reopened = await getRecordingIndex("acct-a", stateDir);
    expect(reopened.get("111")).toMatchObject({ bucketId: "1" });
  });

  it("closeRecordingIndex on an unknown account is a no-op", async () => {
    await expect(closeRecordingIndex("nope")).resolves.toBeUndefined();
  });
});
