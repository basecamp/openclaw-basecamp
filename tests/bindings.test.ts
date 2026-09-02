/**
 * Tests: configured-binding provider (SPEC §2.21).
 *
 * A binding on `bucket:<id>` matches every recording inside the project;
 * exact recording bindings outrank bucket bindings via matchPriority. The
 * recording→bucket index supplies the parent for cold lookups.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BINDING_MATCH_PRIORITY_BUCKET,
  BINDING_MATCH_PRIORITY_EXACT,
  basecampBindingsProvider,
  normalizeBindingConversationId,
} from "../src/adapters/bindings.js";
import { closeAllRecordingIndexes, getRecordingIndex } from "../src/inbound/recording-index.js";

const provider = basecampBindingsProvider;

/** Minimal AgentBinding rule; the provider only reads match.peer via conversationId. */
const rule = (peerId: string) =>
  ({ agentId: "agent-1", match: { channel: "basecamp", peer: { kind: "group", id: peerId } } }) as any;

const compile = (peerId: string) =>
  provider.compileConfiguredBinding({ binding: rule(peerId), conversationId: peerId });

const match = (bindingPeer: string, conversationId: string, parentConversationId?: string) => {
  const compiled = compile(bindingPeer);
  if (!compiled) throw new Error(`binding ${bindingPeer} did not compile`);
  return provider.matchInboundConversation({
    binding: rule(bindingPeer),
    compiledBinding: compiled,
    conversationId,
    parentConversationId,
  });
};

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "bc-bindings-"));
});

afterEach(async () => {
  await closeAllRecordingIndexes();
  rmSync(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// normalizeBindingConversationId
// ---------------------------------------------------------------------------

describe("normalizeBindingConversationId", () => {
  it("accepts canonical peers and strips channel prefixes", () => {
    expect(normalizeBindingConversationId("bucket:456")).toBe("bucket:456");
    expect(normalizeBindingConversationId("basecamp:recording:123")).toBe("recording:123");
    expect(normalizeBindingConversationId(" bc:ping:9 ")).toBe("ping:9");
  });

  it("treats bare numerics as recordings and rejects foreign ids", () => {
    expect(normalizeBindingConversationId("123")).toBe("recording:123");
    expect(normalizeBindingConversationId("slack:C1")).toBeUndefined();
    expect(normalizeBindingConversationId("bucket:abc")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// compileConfiguredBinding
// ---------------------------------------------------------------------------

describe("bindings.compileConfiguredBinding", () => {
  it("compiles bucket bindings as top-level conversations", () => {
    expect(compile("bucket:456")).toEqual({ conversationId: "bucket:456" });
  });

  it("compiles recording bindings with the indexed bucket parent", async () => {
    const index = await getRecordingIndex("bind-acct", stateDir);
    index.record("123", { bucketId: "456", recordableType: "Kanban::Card" });

    expect(compile("recording:123")).toEqual({ conversationId: "recording:123", parentConversationId: "bucket:456" });
    expect(compile("recording:999")).toEqual({ conversationId: "recording:999" });
  });

  it("returns null for ids that are not Basecamp peers", () => {
    expect(compile("slack:C123")).toBeNull();
    expect(compile("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchInboundConversation
// ---------------------------------------------------------------------------

describe("bindings.matchInboundConversation", () => {
  it("matches a recording inside a bound bucket through the inbound parent peer", () => {
    expect(match("bucket:456", "recording:123", "bucket:456")).toEqual({
      conversationId: "recording:123",
      parentConversationId: "bucket:456",
      matchPriority: BINDING_MATCH_PRIORITY_BUCKET,
    });
  });

  it("matches a recording inside a bound bucket through the recording index when no parent is given", async () => {
    const index = await getRecordingIndex("bind-acct", stateDir);
    index.record("123", { bucketId: "456", recordableType: "Chat::Transcript" });

    expect(match("bucket:456", "recording:123")).toMatchObject({
      conversationId: "recording:123",
      parentConversationId: "bucket:456",
      matchPriority: BINDING_MATCH_PRIORITY_BUCKET,
    });
  });

  it("does not match recordings in other buckets, or unknown recordings", () => {
    expect(match("bucket:456", "recording:123", "bucket:789")).toBeNull();
    expect(match("bucket:456", "recording:123")).toBeNull();
  });

  it("matches the bucket conversation itself at exact priority", () => {
    expect(match("bucket:456", "bucket:456")).toEqual({
      conversationId: "bucket:456",
      matchPriority: BINDING_MATCH_PRIORITY_EXACT,
    });
  });

  it("ranks an exact recording binding above the bucket binding for the same event", () => {
    const exact = match("recording:123", "recording:123", "bucket:456");
    const bucket = match("bucket:456", "recording:123", "bucket:456");
    expect(exact?.matchPriority).toBe(BINDING_MATCH_PRIORITY_EXACT);
    expect(bucket?.matchPriority).toBe(BINDING_MATCH_PRIORITY_BUCKET);
    expect(exact!.matchPriority!).toBeGreaterThan(bucket!.matchPriority!);
  });

  it("does not let a recording binding match sibling recordings", () => {
    expect(match("recording:123", "recording:124", "bucket:456")).toBeNull();
  });

  it("matches ping bindings only on the same ping", () => {
    expect(match("ping:9", "ping:9")).toEqual({
      conversationId: "ping:9",
      matchPriority: BINDING_MATCH_PRIORITY_EXACT,
    });
    expect(match("ping:9", "ping:10")).toBeNull();
  });

  it("normalizes prefixed and bare inbound ids before matching", () => {
    expect(match("bucket:456", "basecamp:123", "bc:bucket:456")).toMatchObject({ conversationId: "recording:123" });
  });

  it("returns null for foreign conversation ids", () => {
    expect(match("bucket:456", "slack:C1", "bucket:456")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveCommandConversation
// ---------------------------------------------------------------------------

describe("bindings.resolveCommandConversation", () => {
  const resolve = provider.resolveCommandConversation!;
  const base = { accountId: "acct" };

  it("prefers the originating target, then the command target, then the fallback", () => {
    expect(
      resolve({ ...base, originatingTo: "recording:1", commandTo: "recording:2", fallbackTo: "recording:3" }),
    ).toEqual({
      conversationId: "recording:1",
    });
    expect(resolve({ ...base, commandTo: "bc:recording:2", fallbackTo: "recording:3" })).toEqual({
      conversationId: "recording:2",
    });
    expect(resolve({ ...base, fallbackTo: "bucket:3" })).toEqual({ conversationId: "bucket:3" });
  });

  it("skips candidates that are not Basecamp peers", () => {
    expect(resolve({ ...base, originatingTo: "slack:C1", commandTo: "ping:5" })).toEqual({ conversationId: "ping:5" });
    expect(resolve({ ...base, originatingTo: "slack:C1" })).toBeNull();
    expect(resolve(base)).toBeNull();
  });

  it("attaches the indexed bucket parent for recordings", async () => {
    const index = await getRecordingIndex("bind-acct", stateDir);
    index.record("77", { bucketId: "456", recordableType: "Todo" });

    expect(resolve({ ...base, originatingTo: "recording:77" })).toEqual({
      conversationId: "recording:77",
      parentConversationId: "bucket:456",
    });
  });
});

describe("bindings.selfParentConversationByDefault", () => {
  it("is on: buckets and pings are their own parent", () => {
    expect(provider.selfParentConversationByDefault).toBe(true);
  });
});
