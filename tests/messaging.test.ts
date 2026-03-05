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
