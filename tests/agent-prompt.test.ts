import { describe, expect, it } from "vitest";
import { basecampAgentPromptAdapter } from "../src/adapters/agent-prompt.js";

function cfg(basecamp?: Record<string, unknown>) {
  if (!basecamp) return {} as any;
  return { channels: { basecamp } } as any;
}

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

  // --- Dynamic hint tests ---

  it("adds project-scoped hint for virtual account", () => {
    const hints = basecampAgentPromptAdapter.messageToolHints!({
      cfg: cfg({
        virtualAccounts: {
          "project-x": { accountId: "main", bucketId: "12345" },
        },
      }),
      accountId: "project-x",
    });
    const joined = hints.join(" ");

    expect(joined).toContain("project-scoped");
    expect(joined).toContain("bucket 12345");
  });

  it("does not add project-scoped hint for non-virtual account", () => {
    const hints = basecampAgentPromptAdapter.messageToolHints!({
      cfg: cfg({
        virtualAccounts: {
          "project-x": { accountId: "main", bucketId: "12345" },
        },
      }),
      accountId: "main",
    });
    const joined = hints.join(" ");

    expect(joined).not.toContain("project-scoped");
  });

  it("adds persona mapping hint when personas configured", () => {
    const hints = basecampAgentPromptAdapter.messageToolHints!({
      cfg: cfg({
        personas: { "agent-1": "account-a", "agent-2": "account-b" },
      }),
    });
    const joined = hints.join(" ");

    expect(joined).toContain("persona mappings");
    expect(joined).toContain("different Basecamp identities");
  });

  it("does not add persona hint when no personas configured", () => {
    const hints = basecampAgentPromptAdapter.messageToolHints!({
      cfg: cfg({ personas: {} }),
    });
    const joined = hints.join(" ");

    expect(joined).not.toContain("persona");
  });

  it("adds requireMention hint when buckets have requireMention", () => {
    const hints = basecampAgentPromptAdapter.messageToolHints!({
      cfg: cfg({
        buckets: {
          "111": { requireMention: true },
          "222": { requireMention: false },
          "333": { requireMention: true },
        },
      }),
    });
    const joined = hints.join(" ");

    expect(joined).toContain("require @mention");
    expect(joined).toContain("111");
    expect(joined).toContain("333");
    expect(joined).not.toContain("222");
  });

  it("does not add requireMention hint when no buckets require it", () => {
    const hints = basecampAgentPromptAdapter.messageToolHints!({
      cfg: cfg({
        buckets: {
          "111": { requireMention: false },
        },
      }),
    });
    const joined = hints.join(" ");

    expect(joined).not.toContain("require @mention");
  });

  it("returns only static hints when config has no dynamic sections", () => {
    const staticHints = basecampAgentPromptAdapter.messageToolHints!({
      cfg: {} as any,
    });
    const withEmpty = basecampAgentPromptAdapter.messageToolHints!({
      cfg: cfg({}),
    });

    expect(staticHints).toEqual(withEmpty);
  });
});
