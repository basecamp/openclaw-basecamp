import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

vi.mock("../src/runtime.js", () => ({
  getBasecampRuntime: vi.fn(() => ({
    state: { resolveStateDir: () => tmpDir },
  })),
}));

import {
  closeAccountDedup,
  closeAllAccountDedup,
  getAccountDedup,
} from "../src/inbound/dedup-registry.js";
import * as sqliteStore from "../src/inbound/dedup-store-sqlite.js";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "dedup-reg-"));
});

afterEach(() => {
  closeAllAccountDedup();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** The plugin state dir resolvePluginStateDir() derives from the mock. */
function stateDir(): string {
  return join(tmpDir, "plugins", "basecamp");
}

describe("dedup-registry", () => {
  it("returns same instance for repeated calls with same accountId", () => {
    const a = getAccountDedup("a");
    const b = getAccountDedup("a");
    expect(a).toBe(b);
  });

  it("returns different instances for different accounts", () => {
    const a = getAccountDedup("a");
    const b = getAccountDedup("b");
    expect(a).not.toBe(b);
  });

  it("cross-source live dedup via shared secondary key", () => {
    const dedup = getAccountDedup("x");
    const secKey = "rec:kind:ts";

    // Activity source records event with secondary key
    expect(dedup.isDuplicate("activity:1", secKey)).toBe(false);

    // Webhook source checks a different primary key but same secondary key
    expect(dedup.isDuplicate("webhook:2", secKey)).toBe(true);
  });

  it("closeAccountDedup flushes, closes, and evicts — next get returns fresh instance", () => {
    const first = getAccountDedup("c");
    first.isDuplicate("activity:1");

    closeAccountDedup("c");

    const second = getAccountDedup("c");
    expect(second).not.toBe(first);
  });

  it("closeAllAccountDedup closes all — subsequent gets return new instances", () => {
    const a = getAccountDedup("all-a");
    const b = getAccountDedup("all-b");

    closeAllAccountDedup();

    const a2 = getAccountDedup("all-a");
    const b2 = getAccountDedup("all-b");
    // Use strict identity check to avoid vitest serializing EventDedup on failure
    expect(a2 !== a).toBe(true);
    expect(b2 !== b).toBe(true);
  });

  it("creates sqlite file in stateDir", () => {
    getAccountDedup("acct1");
    const dbFile = join(stateDir(), "dedup-acct1.sqlite");
    expect(existsSync(dbFile)).toBe(true);
  });

  it("rebinds when resolved stateDir changes (e.g. fallback → runtime)", () => {
    const first = getAccountDedup("rebind");
    first.isDuplicate("activity:1");

    const oldDir = tmpDir;

    // Simulate runtime becoming available — stateDir changes
    tmpDir = mkdtempSync(join(tmpdir(), "dedup-reg-rebind-"));

    const second = getAccountDedup("rebind");
    expect(second).not.toBe(first);

    // New instance uses the new stateDir
    const dbFile = join(tmpDir, "plugins", "basecamp", "dedup-rebind.sqlite");
    expect(existsSync(dbFile)).toBe(true);

    // Clean up the extra dir
    closeAccountDedup("rebind");
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = oldDir;
  });

  it("fail-open: returns in-memory EventDedup on DB open error and logs warning", () => {
    const spy = vi.spyOn(sqliteStore, "openDedupDb").mockImplementation(() => {
      throw new Error("EPERM: permission denied");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const dedup = getAccountDedup("broken");

      // Should still work (in-memory)
      expect(dedup.isDuplicate("activity:1")).toBe(false);
      expect(dedup.isDuplicate("activity:1")).toBe(true);

      // Warning was logged
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]![0]).toContain("falling back to in-memory");

      // Cached — same instance, no retry storm
      expect(getAccountDedup("broken")).toBe(dedup);
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("recovery after fail-open: evict via close, then get returns SQLite-backed instance", () => {
    // Phase 1: force fail-open
    const spy = vi.spyOn(sqliteStore, "openDedupDb").mockImplementation(() => {
      throw new Error("EPERM: permission denied");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const memDedup = getAccountDedup("recover");
    expect(warnSpy).toHaveBeenCalledOnce();

    spy.mockRestore();
    warnSpy.mockRestore();

    // Phase 2: evict the in-memory entry
    closeAccountDedup("recover");

    // Phase 3: openDedupDb restored — should get SQLite-backed instance
    const sqlDedup = getAccountDedup("recover");
    expect(sqlDedup).not.toBe(memDedup);

    // Verify SQLite file was created (proves it went through the real path)
    const dbFile = join(stateDir(), "dedup-recover.sqlite");
    expect(existsSync(dbFile)).toBe(true);
  });
});
