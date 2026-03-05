import { describe, expect, it, vi } from "vitest";
import { chunkMarkdownText, resolveOutboundTarget } from "../src/adapters/outbound.js";
import { sendBasecampMedia, sendBasecampText } from "../src/outbound/send.js";

// --- Mocks required to import channel.ts without pulling in heavy deps ---
vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  normalizeAccountId: (v: string | undefined | null) => (v ?? "").trim() || "default",
  buildChannelConfigSchema: (schema: unknown) => ({ schema: {} }),
  setAccountEnabledInConfigSection: vi.fn(),
  deleteAccountFromConfigSection: vi.fn(),
}));
vi.mock("../src/runtime.js", () => ({ getBasecampRuntime: vi.fn(() => ({})) }));
vi.mock("../src/dispatch.js", () => ({ dispatchBasecampEvent: vi.fn() }));
vi.mock("../src/basecamp-cli.js", () => ({ cliAuthStatus: vi.fn() }));
vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => ({})),
  numId: (_label: string, value: string | number) => Number(value),
  rawOrThrow: vi.fn(async (result: any) => result?.data),
  BasecampError: class BasecampError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
  clearClients: vi.fn(),
}));
vi.mock("../src/adapters/onboarding.js", () => ({ basecampOnboardingAdapter: {} }));
vi.mock("../src/adapters/setup.js", () => ({ basecampSetupAdapter: {} }));
vi.mock("../src/adapters/status.js", () => ({ basecampStatusAdapter: {} }));
vi.mock("../src/adapters/pairing.js", () => ({ basecampPairingAdapter: {} }));
vi.mock("../src/adapters/directory.js", () => ({ basecampDirectoryAdapter: {} }));
vi.mock("../src/adapters/messaging.js", () => ({ basecampMessagingAdapter: {} }));
vi.mock("../src/adapters/resolver.js", () => ({ basecampResolverAdapter: {} }));
vi.mock("../src/adapters/heartbeat.js", () => ({ basecampHeartbeatAdapter: {} }));
vi.mock("../src/adapters/groups.js", () => ({ basecampGroupAdapter: {} }));
vi.mock("../src/adapters/agent-prompt.js", () => ({ basecampAgentPromptAdapter: {} }));

import { basecampChannel } from "../src/channel.js";

// ---------------------------------------------------------------------------
// resolveOutboundTarget
// ---------------------------------------------------------------------------

describe("outbound.resolveTarget", () => {
  it("rejects recording:<id> — direct send not supported", () => {
    const result = resolveOutboundTarget("recording:123");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bucket context");
    expect(result.error).toContain("dispatch bridge");
  });

  it("rejects bucket:<id> with project scope error", () => {
    const result = resolveOutboundTarget("bucket:456");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("project scope");
  });

  it("rejects ping:<id> — direct send not supported", () => {
    const result = resolveOutboundTarget("ping:789");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bucket context");
    expect(result.error).toContain("dispatch bridge");
  });

  it("rejects empty string", () => {
    const result = resolveOutboundTarget("");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("rejects unknown prefix", () => {
    const result = resolveOutboundTarget("slack:C123");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("slack:C123");
  });

  it("rejects non-numeric ID", () => {
    const result = resolveOutboundTarget("recording:abc");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("recording:abc");
  });

  it("rejects bare text", () => {
    const result = resolveOutboundTarget("hello world");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chunkMarkdownText — paragraph splitting
// ---------------------------------------------------------------------------

describe("outbound.chunkMarkdownText", () => {
  const LIMIT = 100;

  it("returns single chunk for short text", () => {
    const chunks = chunkMarkdownText("Hello world", LIMIT);
    expect(chunks).toEqual(["Hello world"]);
  });

  it("returns empty array for empty string", () => {
    const chunks = chunkMarkdownText("", LIMIT);
    expect(chunks).toEqual([]);
  });

  it("splits on paragraph boundaries", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const chunks = chunkMarkdownText(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be under limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
    }
  });

  it("falls back to sentence splitting when paragraph is too long", () => {
    // Single paragraph with multiple sentences
    const text = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.";
    const chunks = chunkMarkdownText(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it("falls back to word splitting when sentence is too long", () => {
    const text = Array(20).fill("longword").join(" ");
    const chunks = chunkMarkdownText(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it("preserves code blocks intact when possible", () => {
    const code = "```\nconst x = 1;\nconst y = 2;\n```";
    const text = `Before code.\n\n${code}\n\nAfter code.`;
    const chunks = chunkMarkdownText(text, 200);
    const joined = chunks.join("\n\n");
    expect(joined).toContain("```\nconst x = 1;");
    expect(joined).toContain("const y = 2;\n```");
  });

  it("handles text at exactly the limit", () => {
    const text = "x".repeat(100);
    const chunks = chunkMarkdownText(text, 100);
    expect(chunks).toEqual([text]);
  });

  it("handles real-world Basecamp 10K limit", () => {
    // Build a ~25K character string with paragraphs
    const paragraphs = Array(50)
      .fill(null)
      .map((_, i) => `Paragraph ${i}: ${"lorem ipsum dolor sit amet ".repeat(8).trim()}.`);
    const text = paragraphs.join("\n\n");
    const chunks = chunkMarkdownText(text, 10000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10000);
    }
    // All content should be preserved
    const rejoined = chunks.join("\n\n");
    for (const p of paragraphs) {
      expect(rejoined).toContain(p);
    }
  });
});

// ---------------------------------------------------------------------------
// sendBasecampText / sendBasecampMedia — diagnostic stubs
// ---------------------------------------------------------------------------

describe("outbound.sendBasecampText", () => {
  it("throws with diagnostic message for any target", async () => {
    await expect(sendBasecampText({ to: "recording:123", text: "hello" })).rejects.toThrow("dispatch bridge");
  });
});

describe("outbound.sendBasecampMedia", () => {
  it("throws with diagnostic message for any target", async () => {
    await expect(
      sendBasecampMedia({ to: "recording:123", text: "hello", mediaUrl: "https://example.com/img.png" }),
    ).rejects.toThrow("agent tools");
  });
});

// ---------------------------------------------------------------------------
// Outbound adapter contract — both sendText and sendMedia must be present
// ---------------------------------------------------------------------------

describe("outbound adapter contract", () => {
  it("exposes both sendText and sendMedia on the channel plugin", () => {
    expect(typeof basecampChannel.outbound!.sendText).toBe("function");
    expect(typeof (basecampChannel.outbound as any).sendMedia).toBe("function");
  });
});
