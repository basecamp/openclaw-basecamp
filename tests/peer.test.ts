import { describe, expect, it, vi } from "vitest";

vi.mock("../src/metrics.js", () => ({
  recordUnknownKind: vi.fn(),
}));
vi.mock("../src/outbound/send.js", () => ({
  resolveCircleInfoCached: vi.fn(() => undefined),
}));

import { resolveBasecampPeer, resolveParentPeer } from "../src/inbound/normalize.js";

describe("resolveBasecampPeer", () => {
  it("Chat::Line with parentRecordingId returns parent recording peer", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Line",
      recordingId: "100",
      parentRecordingId: "200",
      bucketId: "1",
    });
    expect(peer).toEqual({ kind: "group", id: "recording:200" });
  });

  it("Chat::Line without parentRecordingId returns own recording peer", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Line",
      recordingId: "100",
      bucketId: "1",
    });
    expect(peer).toEqual({ kind: "group", id: "recording:100" });
  });

  it("Comment with parentRecordingId returns parent recording peer", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Comment",
      recordingId: "300",
      parentRecordingId: "400",
      bucketId: "1",
    });
    expect(peer).toEqual({ kind: "group", id: "recording:400" });
  });

  it("Chat::Transcript returns own recording peer", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Transcript",
      recordingId: "500",
      bucketId: "1",
    });
    expect(peer).toEqual({ kind: "group", id: "recording:500" });
  });

  it("Kanban::Card returns own recording peer", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Kanban::Card",
      recordingId: "600",
      bucketId: "1",
    });
    expect(peer).toEqual({ kind: "group", id: "recording:600" });
  });

  it("Todo returns own recording peer", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Todo",
      recordingId: "700",
      bucketId: "1",
    });
    expect(peer).toEqual({ kind: "group", id: "recording:700" });
  });

  it("Message returns own recording peer", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Message",
      recordingId: "800",
      bucketId: "1",
    });
    expect(peer).toEqual({ kind: "group", id: "recording:800" });
  });

  it("Ping with <=2 participants returns dm peer", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Transcript",
      recordingId: "900",
      bucketId: "50",
      isPing: true,
      participantCount: 2,
    });
    expect(peer).toEqual({ kind: "dm", id: "ping:50" });
  });

  it("Ping with >2 participants returns group peer", () => {
    const peer = resolveBasecampPeer({
      recordableType: "Chat::Transcript",
      recordingId: "900",
      bucketId: "50",
      isPing: true,
      participantCount: 5,
    });
    expect(peer).toEqual({ kind: "group", id: "ping:50" });
  });
});

describe("resolveParentPeer", () => {
  it("non-ping returns bucket peer", () => {
    const peer = resolveParentPeer("42", false);
    expect(peer).toEqual({ kind: "group", id: "bucket:42" });
  });

  it("ping returns undefined", () => {
    const peer = resolveParentPeer("42", true);
    expect(peer).toBeUndefined();
  });
});
