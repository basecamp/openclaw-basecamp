/**
 * Basecamp outbound adapter — target validation and markdown-aware chunking.
 *
 * Provides resolveTarget for pre-send validation and chunkMarkdownText
 * for splitting long agent output within Basecamp's 10K character limit.
 */

const VALID_TARGET = /^(recording|bucket|ping):\d+$/;

export type ResolveTargetResult =
  | { ok: true; to: string }
  | { ok: false; error: string };

/**
 * Validate an outbound target string before attempting delivery.
 * Must match recording:<id>, bucket:<id>, or ping:<id>.
 */
export function resolveOutboundTarget(to: string): ResolveTargetResult {
  if (!to) {
    return { ok: false, error: "Target is empty" };
  }
  if (VALID_TARGET.test(to)) {
    return { ok: true, to };
  }
  return {
    ok: false,
    error: `Invalid Basecamp target "${to}". Expected recording:<id>, bucket:<id>, or ping:<id>`,
  };
}

/**
 * Split text into chunks that fit within a character limit.
 *
 * Strategy (in priority order):
 * 1. Split on paragraph boundaries (double newline)
 * 2. Fall back to sentence boundaries (. ! ?)
 * 3. Fall back to word boundaries (space)
 *
 * Code blocks (```) are kept intact when they fit within the limit.
 */
export function chunkMarkdownText(text: string, limit: number): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];

  // Split into paragraphs (double newline)
  const paragraphs = text.split(/\n\n/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    // Check if adding this paragraph would exceed limit
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    // Flush current if non-empty
    if (current) {
      chunks.push(current);
      current = "";
    }

    // If the single paragraph fits, start a new chunk with it
    if (para.length <= limit) {
      current = para;
      continue;
    }

    // Paragraph is too long — split further
    const subChunks = splitLongBlock(para, limit);
    // Add all complete sub-chunks
    for (let i = 0; i < subChunks.length - 1; i++) {
      chunks.push(subChunks[i]!);
    }
    // The last sub-chunk becomes the current buffer
    current = subChunks[subChunks.length - 1] ?? "";
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * Split a long block of text (single paragraph) by sentences,
 * then by words if needed.
 */
function splitLongBlock(text: string, limit: number): string[] {
  // Try sentence splitting first
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g);
  if (sentences && sentences.length > 1) {
    return mergeSegments(sentences, limit);
  }

  // Fall back to word splitting
  const words = text.split(/\s+/);
  return mergeSegments(
    words.map((w, i) => (i < words.length - 1 ? w + " " : w)),
    limit,
  );
}

/**
 * Merge an array of text segments into chunks that fit within the limit.
 */
function mergeSegments(segments: string[], limit: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const seg of segments) {
    const trimmed = seg.trimEnd();
    const candidate = current ? current + seg : seg;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current.trimEnd());
      current = "";
    }

    // If single segment exceeds limit, force-push it (can't split further)
    if (trimmed.length > limit) {
      chunks.push(trimmed);
    } else {
      current = seg;
    }
  }

  if (current.trimEnd()) {
    chunks.push(current.trimEnd());
  }

  return chunks;
}
