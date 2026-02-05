import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CursorStore } from "../src/inbound/cursors.js";

describe("CursorStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cursors-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads empty cursors from nonexistent file", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    const cursors = await store.load();
    expect(cursors).toEqual({});
  });

  it("round-trips activitySince through save and load", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();
    store.setActivitySince("2025-01-01T00:00:00Z");
    await store.save();

    const store2 = new CursorStore(tmpDir, "acct-1");
    const loaded = await store2.load();
    expect(loaded.activitySince).toBe("2025-01-01T00:00:00Z");
  });

  it("round-trips readingsSince through save and load", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();
    store.setReadingsSince("2025-06-15T12:00:00Z");
    await store.save();

    const store2 = new CursorStore(tmpDir, "acct-1");
    const loaded = await store2.load();
    expect(loaded.readingsSince).toBe("2025-06-15T12:00:00Z");
  });

  it("round-trips activityPage through save and load", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();
    store.setActivityPage("page-token-abc");
    await store.save();

    const store2 = new CursorStore(tmpDir, "acct-1");
    const loaded = await store2.load();
    expect(loaded.activityPage).toBe("page-token-abc");
  });

  it("round-trips custom cursors through save and load", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();
    store.setCustom("webhook-seq", "42");
    await store.save();

    const store2 = new CursorStore(tmpDir, "acct-1");
    const loaded = await store2.load();
    expect(loaded.custom).toEqual({ "webhook-seq": "42" });
  });

  it("isDirty starts false, becomes true after set, false after save", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();
    expect(store.isDirty).toBe(false);

    store.setActivitySince("2025-01-01T00:00:00Z");
    expect(store.isDirty).toBe(true);

    await store.save();
    expect(store.isDirty).toBe(false);
  });

  it("setCustom and getCustom work correctly", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();

    expect(store.getCustom("missing")).toBeUndefined();

    store.setCustom("foo", "bar");
    expect(store.getCustom("foo")).toBe("bar");

    store.setCustom("foo", "baz");
    expect(store.getCustom("foo")).toBe("baz");
  });

  it("does not write file when not dirty (mtime unchanged)", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();
    store.setActivitySince("2025-01-01T00:00:00Z");
    await store.save();

    const filePath = join(tmpDir, "cursors-acct-1.json");
    const before = (await stat(filePath)).mtimeMs;

    // Small delay to ensure mtime would differ if file were written
    await new Promise((r) => setTimeout(r, 50));

    // Load again and save without changes
    const store2 = new CursorStore(tmpDir, "acct-1");
    await store2.load();
    await store2.save(); // not dirty, should be no-op

    const after = (await stat(filePath)).mtimeMs;
    expect(after).toBe(before);
  });

  it("creates directory recursively if it does not exist", async () => {
    const nestedDir = join(tmpDir, "a", "b", "c");
    const store = new CursorStore(nestedDir, "acct-1");
    await store.load();
    store.setActivitySince("2025-01-01T00:00:00Z");
    await store.save();

    const fileStat = await stat(join(nestedDir, "cursors-acct-1.json"));
    expect(fileStat.isFile()).toBe(true);
  });
});
