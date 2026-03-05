import { describe, it, expect } from "vitest";
import { getSurfacePrompt } from "../src/hooks/agent-prompt-context.js";

describe("getSurfacePrompt", () => {
  it("returns campfire prompt for Chat::Transcript", () => {
    const ctx = ["[basecamp] recordableType=Chat::Transcript", "[basecamp] eventKind=line_created"];
    const prompt = getSurfacePrompt(ctx);
    expect(prompt).toContain("Campfire");
    expect(prompt).toContain("concise");
  });

  it("returns campfire prompt for Chat::Line", () => {
    const ctx = ["[basecamp] recordableType=Chat::Line"];
    const prompt = getSurfacePrompt(ctx);
    expect(prompt).toContain("Campfire");
    expect(prompt).toContain("concise");
  });

  it("returns todo prompt for Todo", () => {
    const ctx = ["[basecamp] recordableType=Todo"];
    const prompt = getSurfacePrompt(ctx);
    expect(prompt).toContain("to-do");
    expect(prompt).toContain("actionable");
  });

  it("returns card prompt for Kanban::Card", () => {
    const ctx = ["[basecamp] recordableType=Kanban::Card"];
    const prompt = getSurfacePrompt(ctx);
    expect(prompt).toContain("Card Table");
    expect(prompt).toContain("column");
  });

  it("returns undefined for Kanban::Triage (not a recognized recordable type)", () => {
    const ctx = ["[basecamp] recordableType=Kanban::Triage"];
    expect(getSurfacePrompt(ctx)).toBeUndefined();
  });

  it("returns check-in prompt for Question", () => {
    const ctx = ["[basecamp] recordableType=Question"];
    const prompt = getSurfacePrompt(ctx);
    expect(prompt).toContain("check-in");
    expect(prompt).toContain("direct");
  });

  it("returns message board prompt for Message", () => {
    const ctx = ["[basecamp] recordableType=Message"];
    const prompt = getSurfacePrompt(ctx);
    expect(prompt).toContain("Message Board");
    expect(prompt).toContain("thorough");
  });

  it("returns DM prompt for Circle", () => {
    const ctx = ["[basecamp] recordableType=Circle"];
    const prompt = getSurfacePrompt(ctx);
    expect(prompt).toContain("Ping");
    expect(prompt).toContain("private");
  });

  it("returns undefined when no recordableType in context", () => {
    const ctx = ["[basecamp] eventKind=line_created", "[basecamp] bucketId=123 recordingId=456"];
    expect(getSurfacePrompt(ctx)).toBeUndefined();
  });

  it("returns undefined for unknown recordableType", () => {
    const ctx = ["[basecamp] recordableType=SomeUnknownType"];
    expect(getSurfacePrompt(ctx)).toBeUndefined();
  });

  it("handles empty array", () => {
    expect(getSurfacePrompt([])).toBeUndefined();
  });

  it("handles context with other non-basecamp entries", () => {
    const ctx = ["some random context line", "another line", "[basecamp] recordableType=Todo"];
    const prompt = getSurfacePrompt(ctx);
    expect(prompt).toContain("to-do");
  });

  it("uses first recordableType match", () => {
    const ctx = [
      "[basecamp] recordableType=Chat::Line",
      "[basecamp] recordableType=Todo",
    ];
    const prompt = getSurfacePrompt(ctx);
    expect(prompt).toContain("Campfire");
  });

  it("returns comment prompt for Comment", () => {
    const ctx = ["[basecamp] recordableType=Comment"];
    const prompt = getSurfacePrompt(ctx);
    expect(prompt).toContain("comment");
    expect(prompt).toContain("thread");
  });

  it("handles trailing whitespace and \\r in recordableType value", () => {
    const ctx = ["[basecamp] recordableType=Todo\r"];
    const prompt = getSurfacePrompt(ctx);
    expect(prompt).toContain("to-do");
  });

  it("handles trailing spaces in recordableType value", () => {
    const ctx = ["[basecamp] recordableType=Todo  "];
    const prompt = getSurfacePrompt(ctx);
    expect(prompt).toContain("to-do");
  });
});
