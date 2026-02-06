import { describe, it, expect } from "vitest";
import { basecampAgentPromptAdapter } from "../src/adapters/agent-prompt.js";

describe("agentPrompt.messageToolHints", () => {
  it("returns non-empty array of hints", () => {
    const hints = basecampAgentPromptAdapter.messageToolHints!({
      cfg: {} as any,
    });

    expect(hints.length).toBeGreaterThan(0);
  });

  it("contains Basecamp terminology", () => {
    const hints = basecampAgentPromptAdapter.messageToolHints!({
      cfg: {} as any,
    });
    const joined = hints.join(" ");

    expect(joined).toContain("recording:");
    expect(joined).toContain("bucket:");
    expect(joined).toContain("ping:");
    expect(joined).toContain("Campfire");
    expect(joined).toContain("Ping");
    expect(joined).toContain("Card Table");
  });

  it("mentions bc-attachment SGID format", () => {
    const hints = basecampAgentPromptAdapter.messageToolHints!({
      cfg: {} as any,
    });
    const joined = hints.join(" ");

    expect(joined).toContain("bc-attachment");
    expect(joined).toContain("SGID");
  });

  it("describes threading model", () => {
    const hints = basecampAgentPromptAdapter.messageToolHints!({
      cfg: {} as any,
    });
    const joined = hints.join(" ");

    expect(joined).toContain("flat");
    expect(joined).toContain("no nested threads");
  });
});
