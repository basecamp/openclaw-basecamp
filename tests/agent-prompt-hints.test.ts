/**
 * Tests: basecampAgentPromptAdapter formatting hints (SPEC §2.24)
 *
 * inboundFormattingHints must mirror src/outbound/format.ts's actual
 * capabilities; reactionGuidance keeps boost usage minimal.
 */
import { describe, expect, it } from "vitest";

import { basecampAgentPromptAdapter } from "../src/adapters/agent-prompt.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

describe("agentPrompt.inboundFormattingHints", () => {
  const hints = basecampAgentPromptAdapter.inboundFormattingHints!({ cfg: cfg({}) })!;

  it("declares html text markup", () => {
    expect(hints.text_markup).toBe("html");
  });

  it("documents the Markdown constructs format.ts converts", () => {
    const rules = hints.rules.join("\n");
    expect(rules).toContain("bold");
    expect(rules).toContain("italic");
    expect(rules).toContain("strikethrough");
    expect(rules).toContain("code block");
    expect(rules).toContain("links");
    expect(rules).toContain("lists");
    expect(rules).toContain("blockquote");
    expect(rules).toContain("heading");
  });

  it("documents bc-attachment SGID mentions", () => {
    const rules = hints.rules.join("\n");
    expect(rules).toContain("bc-attachment");
    expect(rules).toContain("sgid");
  });

  it("documents the flat comment threading model", () => {
    const rules = hints.rules.join("\n");
    expect(rules).toContain("chat lines");
    expect(rules).toContain("no nested threads");
  });

  it("is stable across calls (fresh array, same content)", () => {
    const again = basecampAgentPromptAdapter.inboundFormattingHints!({ cfg: cfg({}) })!;
    expect(again.rules).toEqual(hints.rules);
    expect(again.rules).not.toBe(hints.rules);
  });
});

describe("agentPrompt.reactionGuidance", () => {
  it("keeps boost guidance minimal", () => {
    expect(basecampAgentPromptAdapter.reactionGuidance!({ cfg: cfg({}) })).toEqual({
      level: "minimal",
      channelLabel: "Basecamp",
    });
  });
});

describe("agentPrompt.messageToolHints (existing behavior retained)", () => {
  it("still returns the static Basecamp hints", () => {
    const hints = basecampAgentPromptAdapter.messageToolHints!({ cfg: cfg({}) });
    expect(hints.join("\n")).toContain("recording:<id>");
  });

  it("adds project-scope context for virtual accounts", () => {
    const hints = basecampAgentPromptAdapter.messageToolHints!({
      cfg: cfg({ virtualAccounts: { scoped: { accountId: "work", bucketId: "42" } } }),
      accountId: "scoped",
    });
    expect(hints.join("\n")).toContain("bucket 42");
  });
});
