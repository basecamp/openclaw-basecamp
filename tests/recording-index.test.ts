/**
 * Tests: recording→bucket index (SPEC §2.15).
 *
 * Populated by every inbound path so outbound cold sends and the messaging
 * session grammar can resolve a recording's owning bucket.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAllRecordingIndexes,
  closeRecordingIndex,
  findRecordingEntrySync,
  getRecordingIndex,
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
