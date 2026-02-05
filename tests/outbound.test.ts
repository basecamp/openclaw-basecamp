import { describe, it, expect } from "vitest";
import {
  resolveOutboundTarget,
  chunkMarkdownText,
} from "../src/adapters/outbound.js";

// ---------------------------------------------------------------------------
// resolveOutboundTarget
// ---------------------------------------------------------------------------

describe("outbound.resolveTarget", () => {
  it("accepts recording:<id>", () => {
    const result = resolveOutboundTarget("recording:123");
    expect(result.ok).toBe(true);
    expect(result.to).toBe("recording:123");
  });

  it("accepts bucket:<id>", () => {
    const result = resolveOutboundTarget("bucket:456");
    expect(result.ok).toBe(true);
    expect(result.to).toBe("bucket:456");
  });

  it("accepts ping:<id>", () => {
    const result = resolveOutboundTarget("ping:789");
    expect(result.ok).toBe(true);
    expect(result.to).toBe("ping:789");
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
