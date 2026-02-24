import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/config.js", () => ({
  resolvePollingIntervals: () => ({
    activityIntervalMs: 120_000,
    readingsIntervalMs: 60_000,
    assignmentsIntervalMs: 300_000,
  }),
  resolveCircuitBreakerConfig: () => ({
    threshold: 5,
    cooldownMs: 30_000,
  }),
  resolveSafetyNetConfig: () => ({ projects: [], intervalMs: 600_000 }),
  resolveReconciliationConfig: () => ({ enabled: false, intervalMs: 21_600_000, gapThreshold: 3 }),
  resolveAccountForBucket: () => undefined,
  listBasecampAccountIds: () => ["default"],
}));

vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => ({
    raw: {
      GET: vi.fn(),
      POST: vi.fn(),
      PUT: vi.fn(),
      DELETE: vi.fn(),
    },
  })),
  numId: (_label: string, value: string | number) => Number(value),
  rawOrThrow: vi.fn(async (result: any) => result?.data),
  BasecampError: class BasecampError extends Error {
    code: string;
    constructor(msg: string, code: string) { super(msg); this.code = code; }
  },
  clearClients: vi.fn(),
}));

vi.mock("../src/inbound/activity.js", () => ({
  pollActivityFeed: vi.fn(),
}));
vi.mock("../src/inbound/readings.js", () => ({
  pollReadings: vi.fn(),
}));
vi.mock("../src/inbound/assignments.js", () => ({
  pollAssignments: vi.fn(),
}));
vi.mock("../src/inbound/normalize.js", () => ({
  isSelfMessage: vi.fn().mockReturnValue(false),
}));

// Override withTimeout to use a 50ms deadline instead of the real 5s,
// keeping the actual implementation for correct race semantics.
vi.mock("../src/util.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/util.js")>();
  return {
    ...original,
    withTimeout: (promise: Promise<any>, _ms: number, label: string, log: any) =>
      original.withTimeout(promise, 50, label, log),
  };
});

import { CursorStore } from "../src/inbound/cursors.js";
import { startCompositePoller } from "../src/inbound/poller.js";

// ---------------------------------------------------------------------------
// PF-001: Poller cursor save timeout
// ---------------------------------------------------------------------------

describe("PF-001: poller cursor save timeout", () => {
  let tmpDir: string;
  let saveSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pf-001-"));
  });

  afterEach(async () => {
    saveSpy?.mockRestore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("logs stopped_with_cursor_save_timeout when save hangs", async () => {
    // Make CursorStore.save() return a never-resolving promise
    saveSpy = vi.spyOn(CursorStore.prototype, "save").mockReturnValue(new Promise(() => {}));

    const ac = new AbortController();
    ac.abort(); // Pre-abort — loop body never executes

    const logCalls: Array<{ level: string; msg: string }> = [];
    const log = {
      info: vi.fn((msg: string) => logCalls.push({ level: "info", msg })),
      warn: vi.fn((msg: string) => logCalls.push({ level: "warn", msg })),
      debug: vi.fn(),
      error: vi.fn((msg: string) => logCalls.push({ level: "error", msg })),
    };

    await startCompositePoller({
      account: {
        accountId: "timeout-test",
        enabled: true,
        personId: "1",
        token: "tok",
        tokenSource: "config" as const,
        bcqProfile: "default",
        config: { personId: "1", bcqProfile: "default" },
      },
      cfg: {},
      abortSignal: ac.signal,
      onEvent: async () => false,
      log,
      stateDir: tmpDir,
    });

    // Should have warned about cursor save timeout
    const warnMsgs = logCalls.filter((c) => c.level === "warn").map((c) => c.msg);
    expect(warnMsgs.some((m) => m.includes("stopped_with_cursor_save_timeout"))).toBe(true);

    // Should NOT have logged the normal "stopped" info
    const infoMsgs = logCalls.filter((c) => c.level === "info").map((c) => c.msg);
    expect(infoMsgs.some((m) => /\bstopped\b/.test(m) && !m.includes("stopped_with"))).toBe(false);
  });

  it("logs normal stopped when save succeeds before timeout", async () => {
    // No spy on save — let the real implementation run.
    // Since no cursor changes were made (loop was skipped), save returns immediately via dirty check.

    const ac = new AbortController();
    ac.abort();

    const logCalls: Array<{ level: string; msg: string }> = [];
    const log = {
      info: vi.fn((msg: string) => logCalls.push({ level: "info", msg })),
      warn: vi.fn((msg: string) => logCalls.push({ level: "warn", msg })),
      debug: vi.fn(),
      error: vi.fn(),
    };

    await startCompositePoller({
      account: {
        accountId: "success-test",
        enabled: true,
        personId: "1",
        token: "tok",
        tokenSource: "config" as const,
        bcqProfile: "default",
        config: { personId: "1", bcqProfile: "default" },
      },
      cfg: {},
      abortSignal: ac.signal,
      onEvent: async () => false,
      log,
      stateDir: tmpDir,
    });

    const infoMsgs = logCalls.filter((c) => c.level === "info").map((c) => c.msg);
    expect(infoMsgs.some((m) => /\bstopped\b/.test(m) && !m.includes("stopped_with"))).toBe(true);

    const warnMsgs = logCalls.filter((c) => c.level === "warn").map((c) => c.msg);
    expect(warnMsgs.some((m) => m.includes("stopped_with_cursor_save_timeout"))).toBe(false);
  });
});
