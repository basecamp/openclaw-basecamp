/**
 * Basecamp outbound adapter — target validation and markdown-aware chunking.
 *
 * Provides resolveTarget for pre-send validation and chunkMarkdownText
 * for splitting long agent output within Basecamp's 10K character limit.
 *
 * IMPORTANT: Direct sendText delivery is not supported. Basecamp outbound
 * delivery requires bucket/recording/recordableType context that a bare
 * peer ID cannot provide. All agent replies flow through the dispatch
 * bridge (dispatch.ts → postReplyToEvent), which has full context from
 * the originating inbound event.
 */

/** Basecamp's per-message character limit. Shared by channel config and dispatch. */
export const BASECAMP_TEXT_CHUNK_LIMIT = 10_000;

export type ResolveTargetResult = { ok: true; to: string } | { ok: false; error: string };

/**
 * Validate an outbound target for direct sendText delivery.
 *
 * Currently always returns ok:false — direct sendText delivery is not
 * supported for Basecamp targets. Peer IDs (recording:<id>, ping:<id>)
 * lack the bucketId/recordableType context needed for API calls.
 *
 * Agent replies are delivered through the dispatch bridge's deliver
 * callback, which has full context from the inbound event.
 */
export function resolveOutboundTarget(to: string): ResolveTargetResult {
  if (!to) {
    return { ok: false, error: "Target is empty" };
  }
  // Recognize valid Basecamp peer formats for clear error messages
  if (/^(recording|ping):\d+$/.test(to)) {
    return {
      ok: false,
      error:
        `Basecamp target "${to}" requires bucket context for delivery. ` +
        `Direct sendText is not supported — agent replies use the dispatch bridge`,
    };
  }
  if (/^bucket:\d+$/.test(to)) {
    return {
      ok: false,
      error: `"${to}" is a project scope, not a conversation target`,
    };
  }
  return {
    ok: false,
    error: `Invalid Basecamp target "${to}". Expected recording:<id> or ping:<id>`,
  };
}

/**
 * Split text into chunks that fit within a character limit.
 *
 * Strategy (in priority order):
 * 1. Split on paragraph boundaries (double newline), keeping fenced code
 *    blocks intact as single "paragraphs"
 * 2. Fall back to sentence boundaries (. ! ?)
 * 3. Fall back to word boundaries (space)
 */
export function chunkMarkdownText(text: string, limit: number): string[] {
  if (!text) return [];
  if (text.length <= limit) return [text];

  // Split into paragraphs, keeping fenced code blocks as single units
  const paragraphs = splitPreservingCodeBlocks(text);
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
 * Split text on paragraph boundaries while keeping fenced code blocks
 * (```...```) together as single units.
 */
function splitPreservingCodeBlocks(text: string): string[] {
  const parts: string[] = [];
  const codeBlockRe = /```[\s\S]*?```/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(text)) !== null) {
    // Text before this code block: split on paragraph boundaries
    if (match.index > lastIdx) {
      const before = text.slice(lastIdx, match.index);
      parts.push(...before.split(/\n\n/).filter(Boolean));
    }
    // Code block kept as single unit
    parts.push(match[0]);
    lastIdx = codeBlockRe.lastIndex;
  }

  // Trailing text after the last code block
  if (lastIdx < text.length) {
    parts.push(...text.slice(lastIdx).split(/\n\n/).filter(Boolean));
  }

  return parts;
}

/**
 * Split a long block of text (single paragraph) by sentences,
 * then by words if needed.
 */
function splitLongBlock(text: string, limit: number): string[] {
  // Try sentence splitting first. Note: this simple regex may incorrectly
  // split on abbreviations (e.g. "Dr.") or decimals (e.g. "3.14"), but
  // this is acceptable for agent output chunking.
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
