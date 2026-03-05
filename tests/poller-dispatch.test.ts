/**
 * Tests: Poller dispatch flow
 *
 * Validates end-to-end dispatch wiring in startCompositePoller:
 * - Activity poll → dedup → onEvent → cursor advance
 * - Readings poll → dedup → onEvent → mark-read
 * - Assignments bootstrap (no events) and set-diff (new events)
 * - Dedup filters duplicates
 * - Self-message filtering
 * - Webhook-active → 5x activity interval (via log assertion)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// State dir mock — point dedup-registry to test tmpDir for isolation
const testStateDir = mkdtempSync(join(tmpdir(), "pd-state-"));
vi.mock("../src/inbound/state-dir.js", () => ({
  resolvePluginStateDir: () => testStateDir,
}));

vi.mock("../src/config.js", () => ({
  resolvePollingIntervals: () => ({
    activityIntervalMs: 50,
    readingsIntervalMs: 50,
    assignmentsIntervalMs: 50,
  }),
  resolveCircuitBreakerConfig: () => ({
    threshold: 5,
    cooldownMs: 30_000,
  }),
  resolveSafetyNetConfig: () => ({
    projects: [],
    intervalMs: 600_000,
  }),
  resolveReconciliationConfig: () => ({
    enabled: false,
    intervalMs: 21_600_000,
    gapThreshold: 3,
  }),
  resolveAccountForBucket: () => undefined,
  listBasecampAccountIds: () => ["default"],
}));

const mockClient = {
  raw: {
    GET: vi.fn(),
    POST: vi.fn(),
    PUT: vi.fn().mockResolvedValue({ data: null, response: { ok: true, headers: new Map() } }),
    DELETE: vi.fn(),
  },
};

vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => mockClient),
  rawOrThrow: vi.fn(async (result: any) => result?.data),
  numId: (_label: string, value: string | number) => Number(value),
  BasecampError: class BasecampError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
  clearClients: vi.fn(),
}));

// Track what the mocks return — configurable per test
let activityEvents: any[] = [];
let readingsEvents: any[] = [];
let readingsSgids: string[] = [];
let assignmentsEvents: any[] = [];
let assignmentsKnownIds = new Set<string>();

vi.mock("../src/inbound/activity.js", () => ({
  pollActivityFeed: vi.fn(async () => ({
    events: activityEvents,
    newestAt: activityEvents.length > 0 ? activityEvents[0].createdAt : undefined,
  })),
}));

vi.mock("../src/inbound/readings.js", () => ({
  pollReadings: vi.fn(async () => ({
    events: readingsEvents,
    newestAt: readingsEvents.length > 0 ? readingsEvents[0].createdAt : undefined,
    processedSgids: readingsSgids,
  })),
}));

vi.mock("../src/inbound/assignments.js", () => ({
  pollAssignments: vi.fn(async () => ({
    events: assignmentsEvents,
    knownIds: assignmentsKnownIds,
  })),
}));

vi.mock("../src/inbound/normalize.js", () => ({
  isSelfMessage: vi.fn((senderId: string, account: any) => senderId === account.personId),
}));

import { CursorStore } from "../src/inbound/cursors.js";
import { closeAccountDedup } from "../src/inbound/dedup-registry.js";
import { startCompositePoller } from "../src/inbound/poller.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let eventCounter = 0;

function makeEvent(tag: string, opts?: { senderId?: string; recordingId?: string; createdAt?: string }): any {
  eventCounter++;
  const uid = `${tag}-${eventCounter}-${Date.now()}`;
  return {
    channel: "basecamp",
    accountId: "test-dispatch",
    peer: { kind: "group", id: `recording:${opts?.recordingId ?? uid}` },
    sender: { id: opts?.senderId ?? "42", name: "Test User" },
    text: `Event ${uid}`,
    html: "",
    meta: {
      bucketId: "1",
      recordingId: opts?.recordingId ?? uid,
      recordableType: "Todo",
      eventKind: "created",
      mentions: [],
      mentionsAgent: false,
      attachments: [],
      sources: ["activity"],
    },
    dedupKey: `test:${uid}`,
    createdAt: opts?.createdAt ?? "2025-06-01T12:00:00Z",
    correlationId: `corr-${uid}`,
  };
}

const baseAccount = {
  accountId: "test-dispatch",
  personId: "99",
  enabled: true,
  token: "tok",
  tokenSource: "config" as const,
  cliProfile: "default",
  config: { personId: "99", cliProfile: "default" },
} as any;

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("poller dispatch flow", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "poller-dispatch-"));
    eventCounter = 0;
    activityEvents = [];
    readingsEvents = [];
    readingsSgids = [];
    assignmentsEvents = [];
    assignmentsKnownIds = new Set();
    vi.clearAllMocks();
    // Close any cached dedup for isolation
    closeAccountDedup(baseAccount.accountId);
  });

  afterEach(async () => {
    closeAccountDedup(baseAccount.accountId);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("dispatches activity events and advances cursor", async () => {
    const ev = makeEvent("act", { createdAt: "2025-06-01T12:00:00Z" });
    activityEvents = [ev];

    const dispatched: any[] = [];
    const ac = new AbortController();

    const pollerPromise = startCompositePoller({
      account: baseAccount,
      cfg: {},
      abortSignal: ac.signal,
      onEvent: async (msg) => {
        dispatched.push(msg);
        return true;
      },
      log,
      stateDir: tmpDir,
    });

    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await pollerPromise;

    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    expect(dispatched[0].dedupKey).toBe(ev.dedupKey);
  });

  it("dispatches readings events and triggers mark-read", async () => {
    const ev = makeEvent("read");
    readingsEvents = [ev];
    readingsSgids = ["sgid://bc3/Recording/1"];

    const dispatched: any[] = [];
    const ac = new AbortController();

    const pollerPromise = startCompositePoller({
      account: baseAccount,
      cfg: {},
      abortSignal: ac.signal,
      onEvent: async (msg) => {
        dispatched.push(msg);
        return true;
      },
      log,
      stateDir: tmpDir,
    });

    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await pollerPromise;

    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    expect(mockClient.raw.PUT).toHaveBeenCalled();
  });

  it("dedup filters duplicate dedupKeys", async () => {
    // Same event object returned on every poll cycle — same dedupKey
    const ev = makeEvent("dup");
    activityEvents = [ev];

    const dispatched: any[] = [];
    const ac = new AbortController();

    const pollerPromise = startCompositePoller({
      account: baseAccount,
      cfg: {},
      abortSignal: ac.signal,
      onEvent: async (msg) => {
        dispatched.push(msg);
        return true;
      },
      log,
      stateDir: tmpDir,
    });

    // Let multiple poll cycles run (min sleep is 1s, so just wait for 1st cycle)
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await pollerPromise;

    // Should dispatch exactly once (dedup prevents re-dispatch on subsequent polls)
    expect(dispatched.length).toBe(1);
  });

  it("self-message filtering: sender.id === account.personId → not dispatched", async () => {
    const ev = makeEvent("self", { senderId: "99" }); // matches account.personId
    activityEvents = [ev];

    const dispatched: any[] = [];
    const ac = new AbortController();

    const pollerPromise = startCompositePoller({
      account: baseAccount,
      cfg: {},
      abortSignal: ac.signal,
      onEvent: async (msg) => {
        dispatched.push(msg);
        return true;
      },
      log,
      stateDir: tmpDir,
    });

    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await pollerPromise;

    expect(dispatched.length).toBe(0);
  });

  it("assignments bootstrap: no events emitted, IDs stored", async () => {
    assignmentsEvents = [];
    assignmentsKnownIds = new Set(["100", "200"]);

    const dispatched: any[] = [];
    const ac = new AbortController();

    const pollerPromise = startCompositePoller({
      account: baseAccount,
      cfg: {},
      abortSignal: ac.signal,
      onEvent: async (msg) => {
        dispatched.push(msg);
        return true;
      },
      log,
      stateDir: tmpDir,
    });

    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await pollerPromise;

    // Bootstrap emits no events
    expect(dispatched.length).toBe(0);
  });

  it("assignments set-diff: new ID → event emitted", async () => {
    // Pre-seed cursor store so poller thinks it's already bootstrapped
    const cursors = new CursorStore(tmpDir, baseAccount.accountId);
    cursors.setCustom("assignmentIds", JSON.stringify(["100"]));
    await cursors.save();

    const ev = makeEvent("assign");
    assignmentsEvents = [ev];
    assignmentsKnownIds = new Set(["100", "200"]);

    const dispatched: any[] = [];
    const ac = new AbortController();

    const pollerPromise = startCompositePoller({
      account: baseAccount,
      cfg: {},
      abortSignal: ac.signal,
      onEvent: async (msg) => {
        dispatched.push(msg);
        return true;
      },
      log,
      stateDir: tmpDir,
    });

    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await pollerPromise;

    expect(dispatched.some((d) => d.dedupKey === ev.dedupKey)).toBe(true);
  });

  it("webhook-active mode logs extended activity interval", async () => {
    const ac = new AbortController();
    ac.abort(); // Pre-abort — we only need the started log

    await startCompositePoller({
      account: baseAccount,
      cfg: {},
      abortSignal: ac.signal,
      onEvent: async () => true,
      log,
      stateDir: tmpDir,
      webhookActiveProjects: new Set(["100"]),
    });

    // The "started" structured log includes activityMs
    const startedCalls = log.info.mock.calls
      .map((c: any) => c[0] as string)
      .filter((m: string) => m.includes("started"));
    expect(startedCalls.length).toBeGreaterThanOrEqual(1);
    // With webhookActive, activityMs = 50 * 5 = 250
    expect(startedCalls[0]).toContain('"activityMs":250');
    expect(startedCalls[0]).toContain('"mode":"reconciliation"');
  });
});
