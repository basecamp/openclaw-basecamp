import { decodeEntities, stripTags } from "../util.js";

/**
 * Parse Basecamp bc-attachment SGID tags from HTML content.
 *
 * Basecamp @mentions render as:
 *   <bc-attachment sgid="sgid://bc3/Person/12345" content-type="application/vnd.basecamp.mention"></bc-attachment>
 *
 * This module provides pure regex extraction — no DOM parsing needed.
 */

/** Matches <bc-attachment sgid="..." ...> tags with mention content-type. */
const BC_ATTACHMENT_RE = /<bc-attachment\s[^>]*sgid="([^"]+)"[^>]*>/gi;

/** Matches specifically mention-typed attachments. */
const BC_MENTION_RE =
  /<bc-attachment\s[^>]*sgid="([^"]+)"[^>]*content-type="application\/vnd\.basecamp\.mention"[^>]*>/gi;

/** Alternate ordering: content-type before sgid. */
const BC_MENTION_RE_ALT =
  /<bc-attachment\s[^>]*content-type="application\/vnd\.basecamp\.mention"[^>]*sgid="([^"]+)"[^>]*>/gi;

/** Extract person ID from an SGID like "sgid://bc3/Person/12345" or "sgid://bc/Person/12345". */
const PERSON_SGID_RE = /sgid:\/\/bc[^/]*\/Person\/(\d+)/;

export interface ParsedMention {
  sgid: string;
  personId: string | null;
}

/**
 * Extract all bc-attachment SGIDs from Basecamp HTML content.
 * Returns all attachment SGIDs regardless of content-type.
 */
export function extractAttachmentSgids(html: string): string[] {
  const sgids: string[] = [];
  let match: RegExpExecArray | null;

  BC_ATTACHMENT_RE.lastIndex = 0;
  while ((match = BC_ATTACHMENT_RE.exec(html)) !== null) {
    sgids.push(match[1]);
  }

  return [...new Set(sgids)];
}

/**
 * Extract @mention SGIDs from Basecamp HTML content.
 * Only returns SGIDs from bc-attachment tags with mention content-type.
 */
export function extractMentionSgids(html: string): string[] {
  const sgids: string[] = [];
  let match: RegExpExecArray | null;

  // Try primary pattern (sgid before content-type)
  BC_MENTION_RE.lastIndex = 0;
  while ((match = BC_MENTION_RE.exec(html)) !== null) {
    sgids.push(match[1]);
  }

  // Try alternate pattern (content-type before sgid)
  BC_MENTION_RE_ALT.lastIndex = 0;
  while ((match = BC_MENTION_RE_ALT.exec(html)) !== null) {
    sgids.push(match[1]);
  }

  return [...new Set(sgids)];
}

/**
 * Extract person ID from an SGID string.
 * Returns null if the SGID doesn't represent a Person.
 */
export function personIdFromSgid(sgid: string): string | null {
  const match = PERSON_SGID_RE.exec(sgid);
  return match ? match[1] : null;
}

/**
 * Parse all @mentions from HTML, returning structured mention data.
 */
export function parseMentions(html: string): ParsedMention[] {
  const sgids = extractMentionSgids(html);
  return sgids.map((sgid) => ({
    sgid,
    personId: personIdFromSgid(sgid),
  }));
}

/**
 * Check whether any of the given SGIDs match the agent's identity.
 * Compares against both the agent's attachableSgid and personId.
 */
export function mentionsAgent(html: string, agentSgid: string | undefined, agentPersonId: string | undefined): boolean {
  const mentions = parseMentions(html);
  if (mentions.length === 0) return false;

  for (const mention of mentions) {
    if (agentSgid && mention.sgid === agentSgid) return true;
    if (agentPersonId && mention.personId === agentPersonId) return true;
  }
  return false;
}

/**
 * Build a bc-attachment tag for outbound @mentions.
 */
export function formatMentionTag(sgid: string): string {
  return `<bc-attachment sgid="${sgid}" content-type="application/vnd.basecamp.mention"></bc-attachment>`;
}

/**
 * Strip bc-attachment tags from HTML, leaving just the text content.
 * Useful for extracting plain text from Basecamp HTML.
 */
export function stripAttachmentTags(html: string): string {
  return html.replace(/<bc-attachment[^>]*(?:\/>|><\/bc-attachment>)/gi, "");
}

/**
 * Extract plain text from Basecamp HTML.
 * Handles common Basecamp HTML elements: div, br, p → newlines; strips tags.
 */
export function htmlToPlainText(html: string): string {
  let text = html;
  // Replace block elements and br with newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(?:div|p|h[1-6]|li|blockquote|pre)>/gi, "\n");
  text = text.replace(/<(?:div|p|h[1-6]|li|blockquote|pre)[^>]*>/gi, "");
  // Strip remaining tags (iterative to handle nested)
  text = stripTags(text);
  // Decode common entities (single-pass to avoid double-unescaping)
  text = decodeEntities(text);
  // Collapse multiple newlines
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
