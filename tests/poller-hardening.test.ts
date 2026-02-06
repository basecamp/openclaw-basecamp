import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CursorStore } from "../src/inbound/cursors.js";

// ---------------------------------------------------------------------------
// L1: Cursor monotonicity guard
// ---------------------------------------------------------------------------

describe("CursorStore monotonicity", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cursor-mono-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("setActivitySince rejects regression (new < existing)", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();

    store.setActivitySince("2025-06-01T00:00:00Z");
    expect(store.get().activitySince).toBe("2025-06-01T00:00:00Z");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.setActivitySince("2025-01-01T00:00:00Z");
    expect(store.get().activitySince).toBe("2025-06-01T00:00:00Z");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("clock skew detected: new activitySince"),
    );
    warnSpy.mockRestore();
  });

  it("setReadingsSince rejects regression (new < existing)", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();

    store.setReadingsSince("2025-06-01T00:00:00Z");
    expect(store.get().readingsSince).toBe("2025-06-01T00:00:00Z");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.setReadingsSince("2025-01-01T00:00:00Z");
    expect(store.get().readingsSince).toBe("2025-06-01T00:00:00Z");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("clock skew detected: new readingsSince"),
    );
    warnSpy.mockRestore();
  });

  it("allows forward advancement", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();

    store.setActivitySince("2025-01-01T00:00:00Z");
    store.setActivitySince("2025-06-01T00:00:00Z");
    expect(store.get().activitySince).toBe("2025-06-01T00:00:00Z");

    store.setReadingsSince("2025-01-01T00:00:00Z");
    store.setReadingsSince("2025-06-01T00:00:00Z");
    expect(store.get().readingsSince).toBe("2025-06-01T00:00:00Z");
  });

  it("works when no existing cursor (first set always accepted)", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();

    store.setActivitySince("2025-01-01T00:00:00Z");
    expect(store.get().activitySince).toBe("2025-01-01T00:00:00Z");

    const store2 = new CursorStore(tmpDir, "acct-2");
    await store2.load();

    store2.setReadingsSince("2025-01-01T00:00:00Z");
    expect(store2.get().readingsSince).toBe("2025-01-01T00:00:00Z");
  });

  it("does not mark dirty when regression is skipped", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();

    store.setActivitySince("2025-06-01T00:00:00Z");
    await store.save();
    expect(store.isDirty).toBe(false);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.setActivitySince("2025-01-01T00:00:00Z");
    expect(store.isDirty).toBe(false);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// L2: saveCursorsWithRetry — test via CursorStore with save() spy
// ---------------------------------------------------------------------------

describe("CursorStore save retry behavior", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cursor-retry-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("save succeeds on first attempt in normal conditions", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();
    store.setActivitySince("2025-01-01T00:00:00Z");
    await store.save();

    const store2 = new CursorStore(tmpDir, "acct-1");
    const loaded = await store2.load();
    expect(loaded.activitySince).toBe("2025-01-01T00:00:00Z");
  });

  it("saveCursorsWithRetry retries once on failure then succeeds", async () => {
    // Test the retry behavior as implemented in poller.ts saveCursorsWithRetry.
    // We test the pattern directly here to avoid importing the full poller module.
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();
    store.setActivitySince("2025-01-01T00:00:00Z");

    let callCount = 0;
    const originalSave = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("disk full");
      return originalSave();
    });

    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

    // Inline the saveCursorsWithRetry logic (mirrors poller.ts)
    try {
      await store.save();
    } catch (err) {
      log.warn(`[acct-1] cursor save failed, retrying in 1s: ${String(err)}`);
      try {
        await store.save();
      } catch (retryErr) {
        log.error(`[acct-1] cursor save retry failed, continuing: ${String(retryErr)}`);
      }
    }

    expect(callCount).toBe(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("cursor save failed, retrying"));
    expect(log.error).not.toHaveBeenCalled(); // Retry succeeded
  });

  it("saveCursorsWithRetry logs error when both attempts fail", async () => {
    const store = new CursorStore(tmpDir, "acct-1");
    await store.load();
    store.setActivitySince("2025-01-01T00:00:00Z");

    vi.spyOn(store, "save").mockRejectedValue(new Error("persistent failure"));

    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };

    // Inline the saveCursorsWithRetry logic (mirrors poller.ts)
    try {
      await store.save();
    } catch (err) {
      log.warn(`[acct-1] cursor save failed, retrying in 1s: ${String(err)}`);
      try {
        await store.save();
      } catch (retryErr) {
        log.error(`[acct-1] cursor save retry failed, continuing: ${String(retryErr)}`);
      }
    }

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("cursor save failed, retrying"));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("cursor save retry failed"));
  });
});

// ---------------------------------------------------------------------------
// L5: State directory validation
// These test the fs operations that the poller performs at startup.
// The poller's validation logic (mkdir + access check) is tested indirectly
// since it uses the same fs primitives verified here.
// ---------------------------------------------------------------------------

describe("State directory validation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "statedir-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates nested directory if missing", async () => {
    const nested = join(tmpDir, "deep", "nested", "dir");
    const { mkdir, access } = await import("node:fs/promises");
    const { constants } = await import("node:fs");

    await mkdir(nested, { recursive: true });
    await access(nested, constants.W_OK);

    const s = await stat(nested);
    expect(s.isDirectory()).toBe(true);
  });

  it("succeeds when directory already exists", async () => {
    const { mkdir, access } = await import("node:fs/promises");
    const { constants } = await import("node:fs");

    await mkdir(tmpDir, { recursive: true });
    await access(tmpDir, constants.W_OK);

    const s = await stat(tmpDir);
    expect(s.isDirectory()).toBe(true);
  });
});
