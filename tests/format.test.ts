import { describe, it, expect } from "vitest";
import {
  markdownToBasecampHtml,
  stripHtml,
  basecampHtmlToPlainText,
} from "../src/outbound/format.js";

// ---------------------------------------------------------------------------
// markdownToBasecampHtml
// ---------------------------------------------------------------------------
describe("markdownToBasecampHtml", () => {
  it("returns empty string for empty input", () => {
    expect(markdownToBasecampHtml("")).toBe("");
  });

  it("passes plain text through unchanged", () => {
    expect(markdownToBasecampHtml("hello world")).toBe("hello world");
  });

  it("does not escape HTML in plain text (only inside code)", () => {
    // escapeHtml is only applied inside fenced code blocks and inline code
    const result = markdownToBasecampHtml('Tom & Jerry < "cats" > dogs');
    expect(result).toBe('Tom & Jerry < "cats" > dogs');
  });

  it("escapes HTML special characters inside inline code", () => {
    const result = markdownToBasecampHtml('`& < > "`');
    expect(result).toContain("&amp;");
    expect(result).toContain("&lt;");
    expect(result).toContain("&gt;");
    expect(result).toContain("&quot;");
  });

  // Bold
  it("converts **bold** to <strong>", () => {
    expect(markdownToBasecampHtml("**bold**")).toBe("<strong>bold</strong>");
  });

  it("converts __bold__ to <strong>", () => {
    expect(markdownToBasecampHtml("__bold__")).toBe("<strong>bold</strong>");
  });

  // Italic
  it("converts *italic* to <em>", () => {
    expect(markdownToBasecampHtml("*italic*")).toBe("<em>italic</em>");
  });

  it("converts _italic_ to <em>", () => {
    expect(markdownToBasecampHtml("_italic_")).toBe("<em>italic</em>");
  });

  // Strikethrough
  it("converts ~~strike~~ to <del>", () => {
    expect(markdownToBasecampHtml("~~strike~~")).toBe("<del>strike</del>");
  });

  // Inline code
  it("converts `inline code` to <code>", () => {
    expect(markdownToBasecampHtml("`inline code`")).toBe(
      "<code>inline code</code>"
    );
  });

  it("HTML-escapes content inside inline code", () => {
    expect(markdownToBasecampHtml("`<div>&</div>`")).toBe(
      "<code>&lt;div&gt;&amp;&lt;/div&gt;</code>"
    );
  });

  // Fenced code blocks
  it("converts fenced code blocks to <pre>", () => {
    const md = "```js\nconst x = 1;\n```";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain('<pre class="language-js">');
    expect(result).toContain("const x = 1;");
    expect(result).toContain("</pre>");
  });

  it("HTML-escapes content inside fenced code blocks", () => {
    const md = "```\n<div>hello</div>\n```";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain("&lt;div&gt;");
  });

  it("preserves code block content without HTML-escaping markdown chars", () => {
    // The regex-based converter HTML-escapes code block content (< > & "),
    // but markdown chars like ** are not HTML special chars, so they pass
    // through escapeHtml unchanged. Subsequent inline transforms may still
    // match inside <pre> — a known limitation of the regex approach.
    const md = "```\nconst a = 1 < 2 && b > 0;\n```";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain("<pre>");
    expect(result).toContain("&lt;");
    expect(result).toContain("&amp;&amp;");
    expect(result).toContain("&gt;");
  });

  // Headings
  it("converts # Heading to <h1>", () => {
    expect(markdownToBasecampHtml("# Heading")).toBe("<h1>Heading</h1>");
  });

  it("converts ## Heading to <h2>", () => {
    expect(markdownToBasecampHtml("## Heading")).toBe("<h2>Heading</h2>");
  });

  it("converts ### through ###### to corresponding heading levels", () => {
    expect(markdownToBasecampHtml("### H3")).toBe("<h3>H3</h3>");
    expect(markdownToBasecampHtml("#### H4")).toBe("<h4>H4</h4>");
    expect(markdownToBasecampHtml("##### H5")).toBe("<h5>H5</h5>");
    expect(markdownToBasecampHtml("###### H6")).toBe("<h6>H6</h6>");
  });

  // Links
  it("converts [text](url) to <a>", () => {
    expect(markdownToBasecampHtml("[click here](https://example.com)")).toBe(
      '<a href="https://example.com">click here</a>'
    );
  });

  // Unordered lists
  it("converts unordered list items to <ul><li>", () => {
    const md = "- apple\n- banana";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain("<ul>");
    expect(result).toContain("<li>apple</li>");
    expect(result).toContain("<li>banana</li>");
    expect(result).toContain("</ul>");
  });

  // Ordered lists
  it("converts ordered list items to <ol><li>", () => {
    const md = "1. first\n2. second";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain("<ol>");
    expect(result).toContain("<li>first</li>");
    expect(result).toContain("<li>second</li>");
    expect(result).toContain("</ol>");
  });

  // Blockquotes
  it("converts > blockquote to <blockquote>", () => {
    const md = "> quoted text";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain("<blockquote>");
    expect(result).toContain("quoted text");
    expect(result).toContain("</blockquote>");
  });

  // Horizontal rules
  it("converts --- to <hr>", () => {
    const md = "above\n\n---\n\nbelow";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain("<hr>");
  });

  // Fenced code block language attribute
  it("adds language class to code block when language is specified", () => {
    const md = "```typescript\nconst x = 1;\n```";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain('<pre class="language-typescript">');
    expect(result).toContain("const x = 1;");
    expect(result).toContain("</pre>");
  });

  it("handles code block languages with special chars (c++, objective-c)", () => {
    const md = "```c++\nint main() {}\n```";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain('<pre class="language-c++">');
  });

  it("produces plain <pre> when no language is specified", () => {
    const md = "```\nconst x = 1;\n```";
    const result = markdownToBasecampHtml(md);
    expect(result).toBe("<pre>const x = 1;</pre>");
  });

  // Tables
  it("converts a simple 2-column table", () => {
    const md = "| Header 1 | Header 2 |\n|----------|----------|\n| Cell 1   | Cell 2   |";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain("<table>");
    expect(result).toContain("<thead><tr><th>Header 1</th><th>Header 2</th></tr></thead>");
    expect(result).toContain("<tbody><tr><td>Cell 1</td><td>Cell 2</td></tr></tbody>");
    expect(result).toContain("</table>");
  });

  it("converts a table with 3+ columns", () => {
    const md = "| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain("<th>A</th><th>B</th><th>C</th>");
    expect(result).toContain("<tr><td>1</td><td>2</td><td>3</td></tr>");
    expect(result).toContain("<tr><td>4</td><td>5</td><td>6</td></tr>");
  });

  it("converts table cells containing inline formatting", () => {
    const md = "| Name | Status |\n|------|--------|\n| **bold** | `code` |";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain("<table>");
    // Inline transforms run after table conversion, so bold/code are converted
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<code>code</code>");
  });

  it("converts a table with empty cells", () => {
    const md = "| A | B |\n|---|---|\n|   | x |";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain("<td></td><td>x</td>");
  });

  it("handles a table mixed with other markdown content", () => {
    const md = "# Title\n\n| H1 | H2 |\n|----|----|\n| a  | b  |\n\nSome text after.";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain("<h1>Title</h1>");
    expect(result).toContain("<table>");
    expect(result).toContain("<th>H1</th>");
    expect(result).toContain("<td>a</td>");
    expect(result).toContain("Some text after.");
  });

  it("does not convert pipe-table-like text inside a fenced code block", () => {
    const md = "```\n| A | B |\n|---|---|\n| x | y |\n```";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain("<pre>");
    expect(result).not.toContain("<table>");
    expect(result).not.toContain("<th>");
  });

  it("handles a table with header only (no body rows)", () => {
    const md = "| H1 | H2 |\n|---|---|";
    const result = markdownToBasecampHtml(md);
    expect(result).toContain("<table>");
    expect(result).toContain("<thead>");
    expect(result).not.toContain("<tbody>");
  });

  // Nested formatting
  it("handles nested bold and italic", () => {
    const result = markdownToBasecampHtml("**bold and *italic***");
    expect(result).toContain("<strong>");
    expect(result).toContain("<em>");
  });
});

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------
describe("stripHtml", () => {
  it("strips inline HTML tags and returns text", () => {
    expect(stripHtml("<strong>bold</strong>")).toBe("bold");
  });

  it("converts <br> to newline", () => {
    expect(stripHtml("line1<br>line2")).toBe("line1\nline2");
  });

  it("converts <br /> to newline", () => {
    expect(stripHtml("line1<br />line2")).toBe("line1\nline2");
  });

  it("adds newlines around block elements", () => {
    const result = stripHtml("<p>paragraph</p><div>block</div>");
    expect(result).toContain("paragraph");
    expect(result).toContain("block");
    // Block tags get replaced with newlines, collapsing whitespace
    expect(result).toMatch(/paragraph\n+block/);
  });

  it("decodes &amp; entity", () => {
    expect(stripHtml("Tom &amp; Jerry")).toBe("Tom & Jerry");
  });

  it("decodes &lt; entity", () => {
    expect(stripHtml("a &lt; b")).toBe("a < b");
  });

  it("decodes &gt; entity", () => {
    expect(stripHtml("a &gt; b")).toBe("a > b");
  });

  it("decodes &quot; entity", () => {
    expect(stripHtml("say &quot;hello&quot;")).toBe('say "hello"');
  });

  it("strips table elements to plain text", () => {
    const html = "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>";
    const result = stripHtml(html);
    expect(result).toContain("A");
    expect(result).toContain("B");
    expect(result).toContain("1");
    expect(result).toContain("2");
    expect(result).not.toContain("<");
  });

  it("collapses three or more consecutive newlines to two", () => {
    const result = stripHtml("a<p></p><p></p><p></p>b");
    // Multiple block-element replacements produce many newlines; they collapse
    expect(result).not.toMatch(/\n{3,}/);
  });
});

// ---------------------------------------------------------------------------
// basecampHtmlToPlainText
// ---------------------------------------------------------------------------
describe("basecampHtmlToPlainText", () => {
  it("returns empty string for empty input", () => {
    expect(basecampHtmlToPlainText("")).toBe("");
  });

  it("returns empty string for falsy input", () => {
    // @ts-expect-error testing falsy values
    expect(basecampHtmlToPlainText(undefined)).toBe("");
    // @ts-expect-error testing falsy values
    expect(basecampHtmlToPlainText(null)).toBe("");
  });

  it("converts simple HTML to plain text", () => {
    expect(basecampHtmlToPlainText("<strong>hello</strong> world")).toBe(
      "hello world"
    );
  });

  it("delegates to stripHtml for full processing", () => {
    const html = "<p>line one</p><p>line two</p>";
    // basecampHtmlToPlainText and stripHtml should produce the same output
    expect(basecampHtmlToPlainText(html)).toBe(stripHtml(html));
  });
});
