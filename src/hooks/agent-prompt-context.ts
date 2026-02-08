/**
 * Surface-specific prompt context for Basecamp.
 * Maps Basecamp recordable types to prompt style hints.
 */

/** Map of recordable type strings to prompt hints. */
const SURFACE_PROMPTS: Record<string, string> = {
  "Chat::Transcript": [
    "You are responding in a Basecamp Campfire chat room.",
    "Keep responses concise and conversational — this is a real-time group chat.",
    "Use short paragraphs. Avoid walls of text.",
    "Match the casual tone of chat. No formal greetings or sign-offs.",
  ].join(" "),

  "Chat::Line": [
    "You are responding to a Campfire chat message.",
    "Keep responses concise and conversational.",
    "Use short paragraphs. Match the casual chat tone.",
  ].join(" "),

  "Todo": [
    "You are commenting on a Basecamp to-do.",
    "Be detailed and actionable. Reference specific tasks and steps.",
    "Structure your response clearly — use lists for action items.",
    "Focus on helping the assignee complete the to-do.",
  ].join(" "),

  "Kanban::Card": [
    "You are commenting on a Basecamp Card Table card.",
    "Focus on the card's context, including its current column position.",
    "Be concise but thorough. Structure feedback clearly.",
  ].join(" "),

  "Kanban::Triage": [
    "You are commenting on a Basecamp Card Table card.",
    "Focus on the card's context and triage status.",
    "Be concise but thorough.",
  ].join(" "),

  "Question": [
    "You are answering a Basecamp check-in question.",
    "Be direct and structured. Match the question format.",
    "Keep your answer focused on what was asked.",
  ].join(" "),

  "Message": [
    "You are commenting on a Basecamp Message Board post.",
    "Be thorough and well-structured. Use headings and lists where appropriate.",
    "This is a longer-form discussion context.",
  ].join(" "),

  "Circle": [
    "You are in a direct Basecamp Ping conversation.",
    "Be helpful and personal. This is a private conversation.",
    "You can be more detailed since it's a focused 1:1 or small group chat.",
  ].join(" "),

  "Comment": [
    "You are responding to a comment on a Basecamp recording.",
    "Be concise and relevant to the discussion thread.",
    "Reference the parent context when appropriate.",
  ].join(" "),
};

/**
 * Extract surface-specific prompt context from dispatch metadata.
 *
 * Parses the UntrustedContext entries to find the recordableType,
 * then returns the matching surface prompt.
 */
export function getSurfacePrompt(untrustedContext: string[]): string | undefined {
  for (const line of untrustedContext) {
    const match = line.match(/\[basecamp\] recordableType=(.+)/);
    if (match) {
      const recordableType = match[1]!.trim();
      return SURFACE_PROMPTS[recordableType];
    }
  }
  return undefined;
}
