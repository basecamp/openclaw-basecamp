/**
 * Integration test (SPEC §4.4): run the real `runChannelInboundEvent` from
 * openclaw/plugin-sdk/channel-inbound end to end over the Basecamp turn
 * adapter, with a fake reply dispatcher injected into the assembled turn.
 *
 * This proves the adapter's ingest/classify/preflight/resolveTurn output is
 * accepted by the real kernel: admission handling, routed-turn assembly,
 * session recording, and dispatch through the injected dispatcher.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  resolvePersonaAccountId: vi.fn(() => undefined),
  resolveBasecampAccount: vi.fn(),
  resolveBasecampDmPolicy: vi.fn(() => "open"),
  resolveBasecampAllowFrom: vi.fn(() => []),
  resolveCircuitBreakerConfig: vi.fn(() => ({ threshold: 5, cooldownMs: 300000 })),
  resolveBasecampBucketAllowFrom: vi.fn(() => undefined),
}));
vi.mock("../src/outbound/send.js", () => ({
  postReplyToEvent: vi.fn(async () => ({ ok: true, messageId: "posted-1" })),
}));
vi.mock("../src/outbound/format.js", () => ({
  markdownToBasecampHtml: vi.fn((text: string) => `<p>${text}</p>`),
}));

import { buildChannelInboundEventContext, runChannelInboundEvent } from "openclaw/plugin-sdk/channel-inbound";
import { dispatchBasecampEvent } from "../src/dispatch.js";
import { clearBasecampRuntime, setBasecampRuntime } from "../src/runtime.js";
import type { BasecampInboundMessage, ResolvedBasecampAccount } from "../src/types.js";

const account: ResolvedBasecampAccount = {
  accountId: "test-acct",
  enabled: true,
  personId: "999",
  token: "tok",
  tokenSource: "config",
  config: { personId: "999", basecampAccountId: "12345" },
};

const cfg: any = {
  channels: { basecamp: { accounts: { "test-acct": { personId: "999" } } } },
};

const msg: BasecampInboundMessage = {
  channel: "basecamp",
  accountId: "test-acct",
  peer: { kind: "group", id: "recording:123" },
  parentPeer: { kind: "group", id: "bucket:456" },
  sender: { id: "777", name: "Test User" },
  text: "Hello agent",
  html: "<p>Hello agent</p>",
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
  dedupKey: "activity:kernel-1",
  createdAt: "2025-01-15T10:00:00Z",
  correlationId: "corr-kernel-1",
};

describe("real kernel integration", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "kernel-int-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    setBasecampRuntime({
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "agent-1",
            matchedBy: "binding.peer",
            sessionKey: "agent:agent-1:basecamp:group:recording:123",
          })),
        },
        // Real kernel surface — no fake mini-kernel here.
        inbound: { buildContext: buildChannelInboundEventContext, run: runChannelInboundEvent },
        pairing: {
          readAllowFromStore: vi.fn(async () => []),
          upsertPairingRequest: vi.fn(async () => ({ code: "PAIR-1", created: true })),
        },
      },
    } as any);
  });

  afterEach(() => {
    clearBasecampRuntime();
    delete process.env.OPENCLAW_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("dispatches a routed turn through the real kernel with a fake dispatcher", async () => {
    const dispatched: any[] = [];
    const fakeDispatcher = vi.fn(async (params: any) => {
      dispatched.push(params);
      // Deliver one reply through the plan's delivery adapter via the
      // kernel-provided dispatcher.
      await params.dispatcher.enqueue?.({ text: "kernel reply" });
      return { queuedFinal: true };
    });

    const result = await dispatchBasecampEvent(msg, {
      account,
      cfg,
      dispatchReplyFromConfig: fakeDispatcher,
    });

    expect(result).toBe(true);
    expect(fakeDispatcher).toHaveBeenCalledTimes(1);
    const params = dispatched[0];
    expect(params.cfg).toBe(cfg);
    expect(params.ctx).toMatchObject({
      Body: "Hello agent",
      From: "basecamp:777",
      ChatType: "group",
      AgentId: "agent-1",
      OriginatingChannel: "basecamp",
    });
  });

  it("drops gated events inside the real kernel without invoking the dispatcher", async () => {
    const fakeDispatcher = vi.fn(async () => ({ queuedFinal: false }));
    const selfMsg = { ...msg, sender: { id: "999", name: "Bot" } };

    const result = await dispatchBasecampEvent(selfMsg, {
      account,
      cfg,
      dispatchReplyFromConfig: fakeDispatcher,
    });

    expect(result).toBe(false);
    expect(fakeDispatcher).not.toHaveBeenCalled();
  });
});
