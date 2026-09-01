/**
 * Basecamp presentation contract (SPEC §2.7 / §3.1).
 *
 * Declares what the Basecamp renderer can do and maps portable
 * MessagePresentation blocks to Markdown, which the outbound send path
 * converts to Basecamp HTML via format.ts (title → <h1>, context →
 * <blockquote>, divider → <hr>, table → <table>).
 *
 * Capability facts (probed against the live rich-text API, 2026-08-31,
 * settling SPEC §8 Q4): messages, comments, and Campfire lines sent with
 * content_type "text/html" all preserve <h1>, <hr>, <table>, <details>, and
 * <blockquote>. Basecamp has no interactive buttons/selects and no chart
 * rendering, so those degrade to deterministic fallback text.
 */

import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  type MessagePresentation,
  renderMessagePresentationChartFallbackText,
  renderMessagePresentationFallbackText,
} from "openclaw/plugin-sdk/interactive-runtime";
import { BASECAMP_TEXT_CHUNK_LIMIT } from "../adapters/outbound.js";

/** Derived: no typed subpath exports ChannelPresentationCapabilities by name. */
type ChannelPresentationCapabilities = NonNullable<ChannelOutboundAdapter["presentationCapabilities"]>;

export const BASECAMP_PRESENTATION_CAPABILITIES: ChannelPresentationCapabilities = {
  supported: true,
  buttons: false,
  selects: false,
  context: true,
  divider: true,
  charts: false,
  tables: true,
  limits: {
    text: {
      maxLength: BASECAMP_TEXT_CHUNK_LIMIT,
      encoding: "characters",
      markdownDialect: "markdown",
    },
  },
};

/** Escape pipe characters so cell content cannot break Markdown table rows. */
function escapeTableCell(cell: string | number): string {
  return String(cell).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderTableMarkdown(block: {
  caption: string;
  headers: string[];
  rows: Array<Array<string | number>>;
}): string {
  const lines: string[] = [];
  if (block.caption) lines.push(`**${block.caption}**`, "");
  lines.push(`| ${block.headers.map(escapeTableCell).join(" | ")} |`);
  lines.push(`| ${block.headers.map(() => "---").join(" | ")} |`);
  for (const row of block.rows) {
    lines.push(`| ${row.map(escapeTableCell).join(" | ")} |`);
  }
  return lines.join("\n");
}

/** Render a low-emphasis context block as a Markdown blockquote. */
function renderContextMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * Render a portable presentation to Markdown for the Basecamp send path.
 * Interactive blocks (buttons/selects) and charts use the SDK's deterministic
 * fallback text — Basecamp cannot render them natively. Returns null when the
 * presentation produces no visible content (core then falls back to
 * renderMessagePresentationFallbackText on the whole payload).
 */
export function renderBasecampPresentationMarkdown(presentation: MessagePresentation): string | null {
  const parts: string[] = [];
  if (presentation.title?.trim()) {
    parts.push(`# ${presentation.title.trim()}`);
  }

  for (const block of presentation.blocks) {
    switch (block.type) {
      case "text":
        if (block.text.trim()) parts.push(block.text);
        break;
      case "context":
        if (block.text.trim()) parts.push(renderContextMarkdown(block.text));
        break;
      case "divider":
        parts.push("---");
        break;
      case "table":
        parts.push(renderTableMarkdown(block));
        break;
      case "chart":
        parts.push(renderMessagePresentationChartFallbackText(block));
        break;
      case "buttons":
      case "select": {
        // Delegate to the SDK fallback renderer for a single interactive
        // block so labels/URLs render consistently and callback values stay
        // private (IDs are never exposed).
        const fallback = renderMessagePresentationFallbackText({
          presentation: { blocks: [block] },
        });
        if (fallback.trim()) parts.push(fallback.trim());
        break;
      }
    }
  }

  const rendered = parts.join("\n\n").trim();
  return rendered ? rendered : null;
}
