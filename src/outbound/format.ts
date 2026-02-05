/**
 * Markdown to Basecamp HTML converter.
 *
 * Basecamp rich text supports: strong, em, code, pre, a, br,
 * ul, ol, li, blockquote, h1-h6, del.
 *
 * This is a lightweight regex-based converter — no heavy AST library.
 * It handles the common Markdown constructs that agents produce.
 */

/** Escape HTML special characters. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert a Markdown string to Basecamp-compatible HTML.
 *
 * Handles: headings, bold, italic, strikethrough, inline code,
 * fenced code blocks, links, blockquotes, unordered/ordered lists,
 * and line breaks.
 */
export function markdownToBasecampHtml(md: string): string {
  if (!md) return "";

  let html = md;

  // --- Fenced code blocks (``` ... ```) ---
  // Must run before inline transforms to avoid mangling code contents.
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`;
  });

  // --- Inline code (`...`) ---
  // Run before other inline transforms.
  html = html.replace(/`([^`\n]+)`/g, (_match, code) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  // --- Blockquotes ---
  // Collect consecutive > lines into a single <blockquote>.
  html = html.replace(/(?:^|\n)((?:> ?.+(?:\n|$))+)/g, (_match, block: string) => {
    const inner = block
      .split("\n")
      .map((line: string) => line.replace(/^> ?/, ""))
      .join("\n")
      .trim();
    return `\n<blockquote>${inner}</blockquote>\n`;
  });

  // --- Headings (# through ######) ---
  html = html.replace(/^(#{1,6})\s+(.+)$/gm, (_match, hashes: string, content: string) => {
    const level = hashes.length;
    return `<h${level}>${content.trim()}</h${level}>`;
  });

  // --- Bold (**text** or __text__) ---
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // --- Italic (*text* or _text_) ---
  // Avoid matching inside URLs or already-processed tags.
  html = html.replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, "<em>$1</em>");
  html = html.replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, "<em>$1</em>");

  // --- Strikethrough (~~text~~) ---
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // --- Links [text](url) ---
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // --- Unordered lists ---
  html = html.replace(/(?:^|\n)((?:[ \t]*[-*+] .+(?:\n|$))+)/g, (_match, block: string) => {
    const items = block
      .trim()
      .split("\n")
      .map((line: string) => `<li>${line.replace(/^[ \t]*[-*+] /, "").trim()}</li>`)
      .join("\n");
    return `\n<ul>\n${items}\n</ul>\n`;
  });

  // --- Ordered lists ---
  html = html.replace(/(?:^|\n)((?:[ \t]*\d+\. .+(?:\n|$))+)/g, (_match, block: string) => {
    const items = block
      .trim()
      .split("\n")
      .map((line: string) => `<li>${line.replace(/^[ \t]*\d+\. /, "").trim()}</li>`)
      .join("\n");
    return `\n<ol>\n${items}\n</ol>\n`;
  });

  // --- Horizontal rules (---, ***, ___) ---
  html = html.replace(/^[-*_]{3,}$/gm, "<hr>");

  // --- Line breaks ---
  // Double newline = paragraph break, single newline = <br>.
  // First collapse triple+ newlines to double.
  html = html.replace(/\n{3,}/g, "\n\n");

  // Convert remaining single newlines to <br> (but not inside block elements).
  // We do a simple pass: split on double-newline (paragraph boundaries), then
  // convert single newlines within each paragraph to <br>.
  const paragraphs = html.split("\n\n");
  html = paragraphs
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return "";
      // Don't add <br> inside block-level elements
      if (/^<(pre|ul|ol|blockquote|h[1-6]|hr)/i.test(trimmed)) {
        return trimmed;
      }
      return trimmed.replace(/\n/g, "<br>\n");
    })
    .filter(Boolean)
    .join("<br>\n<br>\n");

  return html.trim();
}

/**
 * Strip HTML tags for plain-text fallback.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|h[1-6]|blockquote|pre|ul|ol|li|hr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract plain text from Basecamp HTML content.
 * Used for inbound message processing — converts HTML to readable text.
 */
export function basecampHtmlToPlainText(html: string): string {
  if (!html) return "";
  return stripHtml(html);
}
