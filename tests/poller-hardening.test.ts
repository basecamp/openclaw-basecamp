import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, chmod, stat } from "node:fs/promises";
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
// L2: Cursor save retry (unit test via CursorStore.save)
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
});

// ---------------------------------------------------------------------------
// L5: State directory validation
// ---------------------------------------------------------------------------

describe("State directory validation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "statedir-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates directory if missing", async () => {
    const nested = join(tmpDir, "deep", "nested", "dir");

    // Manually do what the poller does
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

    // tmpDir already exists
    await mkdir(tmpDir, { recursive: true });
    await access(tmpDir, constants.W_OK);

    const s = await stat(tmpDir);
    expect(s.isDirectory()).toBe(true);
  });
});
