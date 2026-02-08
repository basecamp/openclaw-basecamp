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
  // Collect code block positions so table parsing can skip them.
  const codeBlockRanges: Array<{ start: number; end: number }> = [];
  html = html.replace(/```([\w.+#/-]*)\n([\s\S]*?)```/g, (_match, lang, code, offset) => {
    const langAttr = lang ? ` class="language-${lang}"` : "";
    const replacement = `<pre${langAttr}>${escapeHtml(code.replace(/\n$/, ""))}</pre>`;
    codeBlockRanges.push({ start: offset, end: offset + _match.length });
    return replacement;
  });

  // --- Tables (pipe tables) ---
  // Must run after fenced code blocks but before inline transforms.
  // Skip matches inside <pre> blocks (already converted from fenced code blocks).
  html = html.replace(/(?:^|\n)((?:\|[^\n]+\|(?:\n|$))+)/g, (_match, block: string, offset: number) => {
    // Check if this match falls inside a <pre> block
    const matchStart = offset;
    const matchEnd = offset + _match.length;
    const preOpenRegex = /<pre[^>]*>/g;
    let preMatch;
    let insidePre = false;
    const tempHtml = html;
    while ((preMatch = preOpenRegex.exec(tempHtml)) !== null) {
      const preStart = preMatch.index;
      const preCloseIdx = tempHtml.indexOf("</pre>", preStart);
      if (preCloseIdx !== -1 && matchStart >= preStart && matchEnd <= preCloseIdx + 6) {
        insidePre = true;
        break;
      }
    }
    if (insidePre) return _match;
    const rows = block.trim().split("\n");
    if (rows.length < 2) return _match;
    // Check if the second row is a separator (contains only |, -, :, spaces)
    if (!/^[\s|:-]+$/.test(rows[1]!)) return _match;

    const parseRow = (row: string) =>
      row
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());

    const headerCells = parseRow(rows[0]!);
    const thead = `<thead><tr>${headerCells.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;

    const bodyRows = rows.slice(2);
    const tbody = bodyRows.length
      ? `<tbody>${bodyRows.map((row) => {
          const cells = parseRow(row);
          return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
        }).join("")}</tbody>`
      : "";

    return tbody
      ? `\n<table>\n${thead}\n${tbody}\n</table>\n`
      : `\n<table>\n${thead}\n</table>\n`;
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
      if (/^<(pre|ul|ol|blockquote|h[1-6]|hr|table)/i.test(trimmed)) {
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
    .replace(/<\/?(p|div|h[1-6]|blockquote|pre|ul|ol|li|hr|table|thead|tbody|tr|th|td)[^>]*>/gi, "\n")
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
