import { describe, expect, it } from "vitest";
import { basecampMessagingAdapter } from "../src/adapters/messaging.js";

// ---------------------------------------------------------------------------
// normalizeTarget
// ---------------------------------------------------------------------------

describe("messaging.normalizeTarget", () => {
  const normalize = basecampMessagingAdapter.normalizeTarget!;

  it("passes through recording:<id>", () => {
    expect(normalize("recording:123")).toBe("recording:123");
  });

  it("passes through bucket:<id>", () => {
    expect(normalize("bucket:456")).toBe("bucket:456");
  });

  it("passes through ping:<id>", () => {
    expect(normalize("ping:789")).toBe("ping:789");
  });

  it("converts bare numeric to recording:<id>", () => {
    expect(normalize("42")).toBe("recording:42");
  });

  it("strips basecamp: prefix from recording:<id>", () => {
    expect(normalize("basecamp:recording:100")).toBe("recording:100");
  });

  it("strips basecamp: prefix from bare numeric", () => {
    expect(normalize("basecamp:55")).toBe("recording:55");
  });

  it("returns undefined for unrecognized input", () => {
    expect(normalize("slack:C123")).toBeUndefined();
    expect(normalize("hello world")).toBeUndefined();
    expect(normalize("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// targetResolver.looksLikeId
// ---------------------------------------------------------------------------

describe("messaging.targetResolver.looksLikeId", () => {
  const looksLikeId = basecampMessagingAdapter.targetResolver!.looksLikeId!;

  it("recognizes recording:<id>", () => {
    expect(looksLikeId("recording:123")).toBe(true);
  });

  it("recognizes bucket:<id>", () => {
    expect(looksLikeId("bucket:456")).toBe(true);
  });

  it("recognizes ping:<id>", () => {
    expect(looksLikeId("ping:789")).toBe(true);
  });

  it("recognizes bare numeric", () => {
    expect(looksLikeId("42")).toBe(true);
  });

  it("recognizes basecamp: prefixed", () => {
    expect(looksLikeId("basecamp:recording:100")).toBe(true);
    expect(looksLikeId("basecamp:55")).toBe(true);
  });

  it("rejects non-Basecamp targets", () => {
    expect(looksLikeId("slack:C123")).toBe(false);
    expect(looksLikeId("hello")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// targetResolver.hint
// ---------------------------------------------------------------------------

describe("messaging.targetResolver.hint", () => {
  it("provides format hint", () => {
    expect(basecampMessagingAdapter.targetResolver!.hint).toBe("recording:<id> | bucket:<id> | ping:<id>");
  });
});

// ---------------------------------------------------------------------------
// formatTargetDisplay
// ---------------------------------------------------------------------------

describe("messaging.formatTargetDisplay", () => {
  const format = basecampMessagingAdapter.formatTargetDisplay!;

  it("formats recording targets", () => {
    expect(format({ target: "recording:123" })).toBe("Recording 123");
  });

  it("formats bucket targets", () => {
    expect(format({ target: "bucket:456" })).toBe("Project 456");
  });

  it("formats ping targets", () => {
    expect(format({ target: "ping:789" })).toBe("Ping 789");
  });

  it("returns raw target for unrecognized format", () => {
    expect(format({ target: "unknown:abc" })).toBe("unknown:abc");
  });
});

// ---------------------------------------------------------------------------
// SPEC §2.20: target prefixes, chat-type inference, session grammar
// ---------------------------------------------------------------------------

describe("messaging.targetPrefixes", () => {
  it("declares basecamp and bc prefixes", () => {
    expect(basecampMessagingAdapter.targetPrefixes).toEqual(["basecamp", "bc"]);
  });

  it("normalizeTarget strips the bc: alias too", () => {
    expect(basecampMessagingAdapter.normalizeTarget!("bc:recording:123")).toBe("recording:123");
    expect(basecampMessagingAdapter.normalizeTarget!("bc:456")).toBe("recording:456");
  });
});

describe("messaging.inferTargetChatType", () => {
  const infer = basecampMessagingAdapter.inferTargetChatType!;

  it("pings are direct", () => {
    expect(infer({ to: "ping:789" })).toBe("direct");
    expect(infer({ to: "basecamp:ping:789" })).toBe("direct");
  });

  it("recordings and buckets are group", () => {
    expect(infer({ to: "recording:123" })).toBe("group");
    expect(infer({ to: "bucket:456" })).toBe("group");
    expect(infer({ to: "123" })).toBe("group");
  });

  it("returns undefined for non-Basecamp targets", () => {
    expect(infer({ to: "user@example.com" })).toBeUndefined();
  });
});

describe("messaging.resolveSessionConversation", () => {
  it("returns bucket parent candidates for indexed recordings", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { getRecordingIndex, closeRecordingIndex } = await import("../src/inbound/recording-index.js");

    const stateDir = mkdtempSync(join(tmpdir(), "msg-index-"));
    const index = await getRecordingIndex("msg-test-acct", stateDir);
    index.record("31337", { bucketId: "9000", recordableType: "Kanban::Card" });

    const resolved = basecampMessagingAdapter.resolveSessionConversation!({ kind: "group", rawId: "recording:31337" });
    expect(resolved).toEqual({
      id: "recording:31337",
      baseConversationId: "bucket:9000",
      parentConversationCandidates: ["bucket:9000"],
    });

    await closeRecordingIndex("msg-test-acct");
  });

  it("returns the bare conversation when the recording is unknown", () => {
    const resolved = basecampMessagingAdapter.resolveSessionConversation!({
      kind: "group",
      rawId: "recording:40404040",
    });
    expect(resolved).toEqual({ id: "recording:40404040" });
  });

  it("buckets have no parent", () => {
    const resolved = basecampMessagingAdapter.resolveSessionConversation!({ kind: "group", rawId: "bucket:456" });
    expect(resolved).toEqual({ id: "bucket:456" });
  });
});

describe("messaging.resolveOutboundSessionRoute", () => {
  const resolveRoute = basecampMessagingAdapter.resolveOutboundSessionRoute!;
  const cfg = {} as never;

  it("routes pings as direct conversations", async () => {
    const route = await resolveRoute({ cfg, agentId: "agent-1", accountId: "acct", target: "ping:789" });
    expect(route).toMatchObject({
      chatType: "direct",
      to: "ping:789",
      peer: { kind: "direct", id: "ping:789" },
      recipientSessionExact: true,
    });
    expect(route!.sessionKey).toContain("agent-1");
  });

  it("routes recordings as group conversations", async () => {
    const route = await resolveRoute({ cfg, agentId: "agent-1", accountId: "acct", target: "bc:recording:123" });
    expect(route).toMatchObject({
      chatType: "group",
      to: "recording:123",
      peer: { kind: "group", id: "recording:123" },
    });
  });

  it("returns null for non-Basecamp targets", async () => {
    expect(await resolveRoute({ cfg, agentId: "agent-1", accountId: "acct", target: "slack:C123" })).toBeNull();
  });
});
