import { describe, expect, it } from "vitest";
import {
  extractAttachmentSgids,
  extractMentionSgids,
  formatMentionTag,
  htmlToPlainText,
  mentionsAgent,
  parseMentions,
  personIdFromSgid,
  stripAttachmentTags,
} from "../src/mentions/parse.js";

const mentionTag = (sgid: string) =>
  `<bc-attachment sgid="${sgid}" content-type="application/vnd.basecamp.mention"></bc-attachment>`;

const mentionTagAlt = (sgid: string) =>
  `<bc-attachment content-type="application/vnd.basecamp.mention" sgid="${sgid}"></bc-attachment>`;

const fileAttachment = (sgid: string) =>
  `<bc-attachment sgid="${sgid}" content-type="application/pdf"></bc-attachment>`;

describe("extractAttachmentSgids", () => {
  it("extracts SGIDs from bc-attachment tags", () => {
    const html = mentionTag("sgid://bc3/Person/1");
    expect(extractAttachmentSgids(html)).toEqual(["sgid://bc3/Person/1"]);
  });

  it("returns empty array when no tags", () => {
    expect(extractAttachmentSgids("<div>Hello</div>")).toEqual([]);
    expect(extractAttachmentSgids("")).toEqual([]);
  });

  it("deduplicates", () => {
    const sgid = "sgid://bc3/Person/42";
    const html = mentionTag(sgid) + mentionTag(sgid);
    expect(extractAttachmentSgids(html)).toEqual([sgid]);
  });

  it("handles multiple attachments with different SGIDs", () => {
    const html =
      mentionTag("sgid://bc3/Person/1") + fileAttachment("sgid://bc3/Recording/99") + mentionTag("sgid://bc3/Person/2");
    const result = extractAttachmentSgids(html);
    expect(result).toEqual(["sgid://bc3/Person/1", "sgid://bc3/Recording/99", "sgid://bc3/Person/2"]);
  });
});

describe("extractMentionSgids", () => {
  it("extracts mention-typed bc-attachments", () => {
    const html = mentionTag("sgid://bc3/Person/12345");
    expect(extractMentionSgids(html)).toEqual(["sgid://bc3/Person/12345"]);
  });

  it("handles sgid before content-type ordering", () => {
    const html = mentionTag("sgid://bc3/Person/100");
    expect(extractMentionSgids(html)).toEqual(["sgid://bc3/Person/100"]);
  });

  it("handles content-type before sgid ordering", () => {
    const html = mentionTagAlt("sgid://bc3/Person/200");
    expect(extractMentionSgids(html)).toEqual(["sgid://bc3/Person/200"]);
  });

  it("ignores non-mention attachments", () => {
    const html = fileAttachment("sgid://bc3/Recording/55");
    expect(extractMentionSgids(html)).toEqual([]);
  });

  it("deduplicates", () => {
    const sgid = "sgid://bc3/Person/7";
    const html = mentionTag(sgid) + mentionTagAlt(sgid);
    expect(extractMentionSgids(html)).toEqual([sgid]);
  });

  it("extracts multiple distinct mentions", () => {
    const html = mentionTag("sgid://bc3/Person/1") + mentionTag("sgid://bc3/Person/2");
    expect(extractMentionSgids(html)).toEqual(["sgid://bc3/Person/1", "sgid://bc3/Person/2"]);
  });
});

describe("personIdFromSgid", () => {
  it("extracts person ID from bc3 SGID", () => {
    expect(personIdFromSgid("sgid://bc3/Person/12345")).toBe("12345");
  });

  it("extracts person ID from bc SGID", () => {
    expect(personIdFromSgid("sgid://bc/Person/99")).toBe("99");
  });

  it("returns null for non-Person SGIDs", () => {
    expect(personIdFromSgid("sgid://bc3/Recording/123")).toBeNull();
  });

  it("returns null for random strings", () => {
    expect(personIdFromSgid("not-an-sgid")).toBeNull();
    expect(personIdFromSgid("")).toBeNull();
  });
});

describe("parseMentions", () => {
  it("returns array of {sgid, personId} for each mention", () => {
    const html = mentionTag("sgid://bc3/Person/10") + mentionTag("sgid://bc3/Person/20");
    expect(parseMentions(html)).toEqual([
      { sgid: "sgid://bc3/Person/10", personId: "10" },
      { sgid: "sgid://bc3/Person/20", personId: "20" },
    ]);
  });

  it("returns empty array for empty html", () => {
    expect(parseMentions("")).toEqual([]);
  });

  it("returns null personId for non-Person SGIDs in mentions", () => {
    // Contrived: a mention tag whose sgid is not a Person
    const html = mentionTag("sgid://bc3/Circle/5");
    expect(parseMentions(html)).toEqual([{ sgid: "sgid://bc3/Circle/5", personId: null }]);
  });
});

describe("mentionsAgent", () => {
  const agentSgid = "sgid://bc3/Person/999";
  const agentPersonId = "999";

  it("returns true when SGID matches agentSgid", () => {
    const html = mentionTag(agentSgid);
    expect(mentionsAgent(html, agentSgid, undefined)).toBe(true);
  });

  it("returns true when person ID from SGID matches agentPersonId", () => {
    const html = mentionTag("sgid://bc3/Person/999");
    expect(mentionsAgent(html, undefined, agentPersonId)).toBe(true);
  });

  it("returns false when no match", () => {
    const html = mentionTag("sgid://bc3/Person/111");
    expect(mentionsAgent(html, agentSgid, agentPersonId)).toBe(false);
  });

  it("returns false with no mentions in html", () => {
    expect(mentionsAgent("<div>Hello</div>", agentSgid, agentPersonId)).toBe(false);
  });

  it("returns false when both agent identifiers are undefined", () => {
    const html = mentionTag("sgid://bc3/Person/1");
    expect(mentionsAgent(html, undefined, undefined)).toBe(false);
  });
});

describe("formatMentionTag", () => {
  it("builds correct bc-attachment tag string", () => {
    const sgid = "sgid://bc3/Person/42";
    const result = formatMentionTag(sgid);
    expect(result).toBe(
      '<bc-attachment sgid="sgid://bc3/Person/42" content-type="application/vnd.basecamp.mention"></bc-attachment>',
    );
  });
});

describe("stripAttachmentTags", () => {
  it("removes bc-attachment tags preserving surrounding text", () => {
    const html = `Hello ${mentionTag("sgid://bc3/Person/1")} world`;
    expect(stripAttachmentTags(html)).toBe("Hello  world");
  });

  it("handles self-closing bc-attachment tags", () => {
    const html = `before<bc-attachment sgid="sgid://bc3/Person/1" content-type="application/vnd.basecamp.mention"/>after`;
    expect(stripAttachmentTags(html)).toBe("beforeafter");
  });

  it("handles open+close bc-attachment tags", () => {
    const html = `before<bc-attachment sgid="sgid://bc3/Person/1"></bc-attachment>after`;
    expect(stripAttachmentTags(html)).toBe("beforeafter");
  });

  it("strips multiple attachment tags", () => {
    const html = mentionTag("sgid://bc3/Person/1") + " and " + fileAttachment("sgid://bc3/Recording/2");
    expect(stripAttachmentTags(html)).toBe(" and ");
  });
});

describe("htmlToPlainText", () => {
  it("converts div-wrapped text", () => {
    expect(htmlToPlainText("<div>Hello</div>")).toBe("Hello");
  });

  it("converts br to newline", () => {
    expect(htmlToPlainText("line1<br>line2")).toBe("line1\nline2");
    expect(htmlToPlainText("line1<br/>line2")).toBe("line1\nline2");
    expect(htmlToPlainText("line1<br />line2")).toBe("line1\nline2");
  });

  it("decodes HTML entities", () => {
    expect(htmlToPlainText("a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39; g&nbsp;h")).toBe(
      "a & b < c > d \"e\" 'f' g h",
    );
  });

  it("strips all remaining tags", () => {
    expect(htmlToPlainText("<span>text</span>")).toBe("text");
    expect(htmlToPlainText('<a href="#">link</a>')).toBe("link");
  });

  it("collapses triple+ newlines to double", () => {
    expect(htmlToPlainText("a<br><br><br><br>b")).toBe("a\n\nb");
  });

  it("trims leading and trailing whitespace", () => {
    expect(htmlToPlainText("  <div>hello</div>  ")).toBe("hello");
  });
});
