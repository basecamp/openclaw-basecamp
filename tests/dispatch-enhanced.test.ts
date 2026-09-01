/**
 * Tests: delivery onError logging + dispatch error classification.
 *
 * The turn plan's delivery adapter owns onError; tests dispatch a turn
 * through the fake kernel and drive the captured plan's onError directly.
 */

import { BasecampError } from "@37signals/basecamp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePersonaAccountId } from "../src/config.js";
import { dispatchBasecampEvent } from "../src/dispatch.js";
import { clearBasecampRuntime, setBasecampRuntime } from "../src/runtime.js";
import type { BasecampInboundMessage, ResolvedBasecampAccount } from "../src/types.js";
import { createFakeKernel, type FakeKernel } from "./dispatch-helpers.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/config.js", () => ({
  resolvePersonaAccountId: vi.fn(),
  resolveBasecampAccount: vi.fn(),
  resolveBasecampDmPolicy: vi.fn(() => "open"),
  resolveBasecampAllowFrom: vi.fn(() => []),
  resolveCircuitBreakerConfig: vi.fn(() => ({ threshold: 5, cooldownMs: 300000 })),
  resolveBasecampBucketAllowFrom: vi.fn(() => undefined),
  resolveBasecampHistoryLimit: vi.fn(() => 50),
}));
vi.mock("../src/outbound/send.js", () => ({
  postReplyToEvent: vi.fn(),
}));
vi.mock("../src/outbound/format.js", () => ({
  markdownToBasecampHtml: vi.fn((text: string) => `<p>${text}</p>`),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let kernel: FakeKernel;

const mockCfg: any = {
  channels: {
    basecamp: {
      accounts: { "test-acct": { personId: "999" } },
    },
  },
};

const mockMsg: BasecampInboundMessage = {
  channel: "basecamp",
  accountId: "test-acct",
  peer: { kind: "group", id: "recording:123" },
  parentPeer: { kind: "group", id: "bucket:456" },
  sender: { id: "777", name: "Test User" },
  text: "Hello",
  html: "<p>Hello</p>",
  meta: {
    bucketId: "456",
    recordingId: "123",
    recordableType: "Chat::Transcript",
    eventKind: "created",
    mentions: [],
    mentionsAgent: true,
    attachments: [],
    sources: ["activity_feed"],
  },
  dedupKey: "activity:1",
  createdAt: "2025-01-15T10:00:00Z",
  correlationId: "corr-1",
};

const mockAccount: ResolvedBasecampAccount = {
  accountId: "test-acct",
  enabled: true,
  personId: "999",
  token: "tok-abc",
  tokenSource: "config",
  config: { personId: "999", basecampAccountId: "12345" },
};

const makeLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() });

/** Dispatch the fixture message and return the plan's delivery.onError with the log. */
async function dispatchAndGetOnError() {
  const log = makeLog();
  await dispatchBasecampEvent(mockMsg, { account: mockAccount, cfg: mockCfg, log });
  const onError = kernel.lastPlan().delivery.onError;
  return { onError, log };
}

beforeEach(() => {
  vi.clearAllMocks();
  kernel = createFakeKernel();
  setBasecampRuntime(kernel.runtime as any);
  vi.mocked(resolvePersonaAccountId).mockReturnValue(undefined);
  kernel.runtime.channel.routing.resolveAgentRoute.mockReturnValue({
    agentId: "agent-1",
    matchedBy: "binding.peer",
    sessionKey: "session:abc",
  });
});

afterEach(() => {
  clearBasecampRuntime();
});

// ---------------------------------------------------------------------------
// L4: Enhanced dispatch error logging
// ---------------------------------------------------------------------------

describe("delivery onError logging", () => {
  it("onError logs structured error with event metadata", async () => {
    const { onError, log } = await dispatchAndGetOnError();

    onError(new Error("Connection refused ECONNREFUSED"), { kind: "final" });

    // 2 calls: delivery_failed + dead_letter
    expect(log.error).toHaveBeenCalledTimes(2);
    const errorMsg = log.error.mock.calls[0][0];
    expect(errorMsg).toContain('"agent":"agent-1"');
    expect(errorMsg).toContain('"recording":"123"');
    expect(errorMsg).toContain('"event":"created"');
    expect(errorMsg).toContain('"sender":"777"');
    expect(errorMsg).toContain('"type":"network"');
  });

  it("dead-letter entry carries replay context", async () => {
    const { onError, log } = await dispatchAndGetOnError();

    onError(new Error("boom"), { kind: "final" });

    const deadLetter = log.error.mock.calls[1][0];
    expect(deadLetter).toContain("dead_letter");
    expect(deadLetter).toContain('"bucket":"456"');
    expect(deadLetter).toContain('"peer":"recording:123"');
    expect(deadLetter).toContain('"recordableType":"Chat::Transcript"');
  });

  it("classifies auth errors correctly", async () => {
    const { onError, log } = await dispatchAndGetOnError();
    onError(new Error("401 Unauthorized"), { kind: "final" });
    expect(log.error.mock.calls[0][0]).toContain('"type":"auth"');
  });

  it("classifies routing errors correctly", async () => {
    const { onError, log } = await dispatchAndGetOnError();
    onError(new Error("no route matched"), { kind: "final" });
    expect(log.error.mock.calls[0][0]).toContain('"type":"routing"');
  });

  it("classifies unknown errors correctly", async () => {
    const { onError, log } = await dispatchAndGetOnError();
    onError(new Error("something unexpected happened"), { kind: "final" });
    expect(log.error.mock.calls[0][0]).toContain('"type":"unknown"');
  });

  it("classifies 403 Forbidden as auth", async () => {
    const { onError, log } = await dispatchAndGetOnError();
    onError(new Error("403 Forbidden"), { kind: "final" });
    expect(log.error.mock.calls[0][0]).toContain('"type":"auth"');
  });

  it("classifies ECONNRESET as network", async () => {
    const { onError, log } = await dispatchAndGetOnError();
    onError(new Error("ECONNRESET"), { kind: "final" });
    expect(log.error.mock.calls[0][0]).toContain('"type":"network"');
  });

  it("classifies errors with structured status property as auth", async () => {
    const { onError, log } = await dispatchAndGetOnError();
    const err = new Error("request failed") as any;
    err.status = 401;
    onError(err, { kind: "final" });
    expect(log.error.mock.calls[0][0]).toContain('"type":"auth"');
  });

  it("classifies HTTP 404 as unknown (not routing)", async () => {
    const { onError, log } = await dispatchAndGetOnError();
    onError(new Error("HTTP 404 Not Found"), { kind: "final" });
    expect(log.error.mock.calls[0][0]).toContain('"type":"unknown"');
  });

  it("classifies BasecampError auth_required as auth", async () => {
    const { onError, log } = await dispatchAndGetOnError();
    onError(new BasecampError("auth_required", "Token expired"), { kind: "final" });
    expect(log.error.mock.calls[0][0]).toContain('"type":"auth"');
  });

  it("classifies BasecampError forbidden as auth", async () => {
    const { onError, log } = await dispatchAndGetOnError();
    onError(new BasecampError("forbidden", "Access denied"), { kind: "final" });
    expect(log.error.mock.calls[0][0]).toContain('"type":"auth"');
  });

  it("classifies BasecampError rate_limit correctly", async () => {
    const { onError, log } = await dispatchAndGetOnError();
    onError(new BasecampError("rate_limit", "Too many requests"), { kind: "final" });
    expect(log.error.mock.calls[0][0]).toContain('"type":"rate_limit"');
  });
});
