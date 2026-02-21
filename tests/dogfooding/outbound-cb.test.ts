/**
 * DF-018 → DF-021: Outbound circuit breaker integration tests.
 *
 * Validates the CB lifecycle through dispatch: trip on threshold,
 * half-open probe, recovery, re-trip, and failure attribution to outbound account.
 *
 * The CB records failures inside execBcq (below postReplyToEvent), so these
 * tests exercise two layers:
 *   - Direct CB state machine + metrics sync (DF-018, DF-019, DF-020)
 *   - Full dispatch pipeline with failure attribution (DF-021)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchBasecampEvent } from "../../src/dispatch.js";
import type { BasecampInboundMessage, ResolvedBasecampAccount } from "../../src/types.js";
import { CircuitBreaker } from "../../src/bcq.js";
import { getAccountMetrics, clearMetrics, recordCircuitBreakerState, recordDispatchFailure } from "../../src/metrics.js";

// ---------------------------------------------------------------------------
// Mocks — only needed for DF-021 (full dispatch pipeline)
// ---------------------------------------------------------------------------

const mockLoadConfig = vi.fn();
const mockResolveRoute = vi.fn();
const mockDispatchReply = vi.fn();

vi.mock("../../src/runtime.js", () => ({
  getBasecampRuntime: vi.fn(() => ({
    config: { loadConfig: mockLoadConfig },
    channel: {
      routing: { resolveAgentRoute: (...args: unknown[]) => mockResolveRoute(...args) },
      reply: { dispatchReplyWithBufferedBlockDispatcher: (...args: unknown[]) => mockDispatchReply(...args) },
    },
  })),
}));

const mockResolvePersona = vi.fn(() => undefined);
const mockResolveAccount = vi.fn();
vi.mock("../../src/config.js", () => ({
  resolvePersonaAccountId: (...args: unknown[]) => mockResolvePersona(...args),
  resolveBasecampAccount: (...args: unknown[]) => mockResolveAccount(...args),
  resolveBasecampDmPolicy: vi.fn(() => "open"),
  resolveBasecampAllowFrom: vi.fn(() => []),
  resolveCircuitBreakerConfig: vi.fn(() => ({ threshold: 2, cooldownMs: 50 })),
}));

const mockPostReply = vi.fn();
vi.mock("../../src/outbound/send.js", () => ({
  postReplyToEvent: (...args: unknown[]) => mockPostReply(...args),
}));
vi.mock("../../src/outbound/format.js", () => ({
  markdownToBasecampHtml: vi.fn((t: string) => `<p>${t}</p>`),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const inboundAccount: ResolvedBasecampAccount = {
  accountId: "acct-a",
  enabled: true,
  personId: "999",
  token: "tok-a",
  tokenSource: "config",
  config: { personId: "999", bcqAccountId: "11111" },
};

const personaAccount: ResolvedBasecampAccount = {
  accountId: "acct-b",
  enabled: true,
  personId: "888",
  token: "tok-b",
  tokenSource: "config",
  config: { personId: "888", bcqAccountId: "22222" },
};

function makeMsg(seq: number): BasecampInboundMessage {
  return {
    channel: "basecamp",
    accountId: "acct-a",
    peer: { kind: "group", id: "recording:1" },
    parentPeer: { kind: "group", id: "bucket:456" },
    sender: { id: "777", name: "Test User" },
    text: `msg-${seq}`,
    html: `<p>msg-${seq}</p>`,
    meta: {
      bucketId: "456",
      recordingId: String(seq),
      recordableType: "Chat::Transcript",
      eventKind: "created",
      mentions: [],
      mentionsAgent: true,
      attachments: [],
      sources: ["activity_feed"],
    },
    dedupKey: `test:cb-${seq}`,
    createdAt: "2025-01-15T10:00:00Z",
  } as BasecampInboundMessage;
}

// ---------------------------------------------------------------------------
// Tests — CB state machine + metrics (DF-018, 019, 020)
// ---------------------------------------------------------------------------

describe("dogfooding — outbound circuit breaker state machine", () => {
  beforeEach(() => {
    clearMetrics();
  });

  // DF-018: CB trips after threshold failures
  it("DF-018: circuit breaker opens after threshold failures with correct metrics", () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 50 });
    const accountId = "acct-outbound";
    const key = "outbound";

    // Record failures up to threshold
    cb.recordFailure(key);
    cb.recordFailure(key); // trips at threshold=2

    expect(cb.isOpen(key)).toBe(true);

    // Sync metrics (simulating what dispatch does after onError)
    const state = cb.getState(key)!;
    recordCircuitBreakerState(accountId, key, {
      state: "open",
      failures: state.failures,
      trippedAt: state.trippedAt,
    });

    // Also record dispatch failures
    recordDispatchFailure(accountId);
    recordDispatchFailure(accountId);
    recordDispatchFailure(accountId);

    const metrics = getAccountMetrics(accountId);
    expect(metrics).toBeDefined();
    expect(metrics!.dispatchFailureCount).toBe(3);
    expect(metrics!.circuitBreaker[key]).toBeDefined();
    expect(metrics!.circuitBreaker[key].state).toBe("open");
  });

  // DF-019: half-open probe succeeds, CB resets
  it("DF-019: half-open probe success resets circuit breaker to closed", async () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 50 });
    const accountId = "acct-outbound";
    const key = "outbound";

    // Trip the breaker
    cb.recordFailure(key);
    cb.recordFailure(key);
    expect(cb.isOpen(key)).toBe(true);

    // Sync as open
    recordCircuitBreakerState(accountId, key, {
      state: "open",
      failures: cb.getState(key)!.failures,
      trippedAt: cb.getState(key)!.trippedAt,
    });
    expect(getAccountMetrics(accountId)!.circuitBreaker[key].state).toBe("open");

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 80));

    // Half-open probe: isOpen returns false (allows one through)
    expect(cb.isOpen(key)).toBe(false);

    // Probe succeeds
    cb.recordSuccess(key);
    expect(cb.isOpen(key)).toBe(false);

    // Sync as closed
    const state = cb.getState(key)!;
    recordCircuitBreakerState(accountId, key, {
      state: "closed",
      failures: state.failures,
      trippedAt: state.trippedAt,
    });

    const metrics = getAccountMetrics(accountId);
    expect(metrics!.circuitBreaker[key].state).toBe("closed");
    expect(metrics!.circuitBreaker[key].failures).toBe(0);
  });

  // DF-020: half-open probe fails, CB re-trips
  it("DF-020: half-open probe failure re-trips circuit breaker to open", async () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 50 });
    const accountId = "acct-outbound";
    const key = "outbound";

    // Trip
    cb.recordFailure(key);
    cb.recordFailure(key);

    // Wait for cooldown
    await new Promise((r) => setTimeout(r, 80));

    // Half-open probe
    expect(cb.isOpen(key)).toBe(false); // allowed through

    // Probe fails
    cb.recordFailure(key);
    expect(cb.isOpen(key)).toBe(true); // re-tripped

    // Sync as open
    recordCircuitBreakerState(accountId, key, {
      state: "open",
      failures: cb.getState(key)!.failures,
      trippedAt: cb.getState(key)!.trippedAt,
    });

    const metrics = getAccountMetrics(accountId);
    expect(metrics!.circuitBreaker[key].state).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Tests — dispatch failure attribution (DF-021)
// ---------------------------------------------------------------------------

describe("dogfooding — outbound failure attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMetrics();

    mockResolveRoute.mockReturnValue({
      agentId: "agent-1",
      matchedBy: "peer",
      sessionKey: "sess-1",
    });
    mockResolveAccount.mockReturnValue(inboundAccount);
    mockLoadConfig.mockReturnValue({
      channels: {
        basecamp: {
          accounts: { "acct-a": { personId: "999", bcqAccountId: "11111" } },
          circuitBreaker: { threshold: 2, cooldownMs: 50 },
        },
      },
    });

    // Wire dispatch to call deliver → onError
    mockDispatchReply.mockImplementation(async (opts: any) => {
      try {
        await opts.dispatcherOptions.deliver({ text: "agent reply" }, {});
      } catch (err) {
        opts.dispatcherOptions.onError(err);
      }
    });
  });

  // DF-021: persona routes outbound to different account — failure attributed correctly
  it("DF-021: dispatch failure attributed to outbound persona account, not inbound", async () => {
    mockResolvePersona.mockReturnValue("acct-b");
    mockResolveAccount.mockImplementation((_cfg: unknown, id: string) => {
      if (id === "acct-b") return personaAccount;
      return inboundAccount;
    });
    mockLoadConfig.mockReturnValue({
      channels: {
        basecamp: {
          accounts: {
            "acct-a": { personId: "999", bcqAccountId: "11111" },
            "acct-b": { personId: "888", bcqAccountId: "22222" },
          },
          personas: { "agent-1": "acct-b" },
          circuitBreaker: { threshold: 2, cooldownMs: 50 },
        },
      },
    });

    mockPostReply.mockResolvedValue({ ok: false, error: "503 Unavailable" });

    await dispatchBasecampEvent(makeMsg(30), { account: inboundAccount });

    // dispatchFailureCount should be on acct-b (outbound persona), NOT acct-a (inbound)
    const metricsB = getAccountMetrics("acct-b");
    expect(metricsB).toBeDefined();
    expect(metricsB!.dispatchFailureCount).toBeGreaterThanOrEqual(1);

    const metricsA = getAccountMetrics("acct-a");
    expect(metricsA?.dispatchFailureCount ?? 0).toBe(0);
  });
});
