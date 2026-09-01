/**
 * Canonical Basecamp agent tool catalog (SPEC §1.3, §2.9).
 *
 * This module is the single source of truth for the tool names the plugin
 * owns and the manifest `toolMetadata` each carries. It is deliberately
 * import-free: the manifest generator, the contract tests, and the runtime
 * registration in `src/adapters/agent-tools.ts` all read the same list, and
 * none of them should have to load the Basecamp SDK to learn a tool name.
 *
 * `openclaw.plugin.json#contracts.tools` must equal `BASECAMP_TOOL_NAMES`
 * (in order) — the loader refuses `api.registerTool` for undeclared names.
 */

export const BASECAMP_TOOL_NAMES = [
  "basecamp_create_todo",
  "basecamp_complete_todo",
  "basecamp_reopen_todo",
  "basecamp_read_history",
  "basecamp_add_boost",
  "basecamp_move_card",
  "basecamp_post_message",
  "basecamp_answer_checkin",
  "basecamp_api_read",
  "basecamp_api_write",
] as const;

export type BasecampToolName = (typeof BASECAMP_TOOL_NAMES)[number];

/**
 * Manifest `toolMetadata` per tool: reads are safe to replay after an
 * incomplete model turn; everything else changes durable Basecamp state.
 */
export type BasecampToolMetadata = { replaySafe: true } | { sideEffecting: true };

export const BASECAMP_TOOL_METADATA = {
  basecamp_create_todo: { sideEffecting: true },
  basecamp_complete_todo: { sideEffecting: true },
  basecamp_reopen_todo: { sideEffecting: true },
  basecamp_read_history: { replaySafe: true },
  basecamp_add_boost: { sideEffecting: true },
  basecamp_move_card: { sideEffecting: true },
  basecamp_post_message: { sideEffecting: true },
  basecamp_answer_checkin: { sideEffecting: true },
  basecamp_api_read: { replaySafe: true },
  basecamp_api_write: { sideEffecting: true },
} as const satisfies Record<BasecampToolName, BasecampToolMetadata>;

export function isBasecampToolName(name: string): name is BasecampToolName {
  return (BASECAMP_TOOL_NAMES as readonly string[]).includes(name);
}
