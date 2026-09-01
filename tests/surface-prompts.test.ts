import { describe, expect, it } from "vitest";
import { getSurfacePrompt } from "../src/dispatch.js";

describe("getSurfacePrompt", () => {
  it("returns campfire prompt for Chat::Transcript", () => {
    const prompt = getSurfacePrompt("Chat::Transcript");
    expect(prompt).toContain("Campfire");
    expect(prompt).toContain("concise");
  });

  it("returns campfire prompt for Chat::Line", () => {
    const prompt = getSurfacePrompt("Chat::Line");
    expect(prompt).toContain("Campfire");
    expect(prompt).toContain("concise");
  });

  it("returns todo prompt for Todo", () => {
    const prompt = getSurfacePrompt("Todo");
    expect(prompt).toContain("to-do");
    expect(prompt).toContain("actionable");
  });

  it("returns card prompt for Kanban::Card", () => {
    const prompt = getSurfacePrompt("Kanban::Card");
    expect(prompt).toContain("Card Table");
    expect(prompt).toContain("column");
  });

  it("returns check-in prompt for Question", () => {
    const prompt = getSurfacePrompt("Question");
    expect(prompt).toContain("check-in");
  });

  it("returns message board prompt for Message", () => {
    const prompt = getSurfacePrompt("Message");
    expect(prompt).toContain("Message Board");
  });

  it("returns ping prompt for Circle", () => {
    const prompt = getSurfacePrompt("Circle");
    expect(prompt).toContain("Ping");
  });

  it("returns comment prompt for Comment", () => {
    const prompt = getSurfacePrompt("Comment");
    expect(prompt).toContain("comment");
  });

  it("returns undefined for unknown recordable types", () => {
    expect(getSurfacePrompt("Unknown::Type")).toBeUndefined();
  });
});
