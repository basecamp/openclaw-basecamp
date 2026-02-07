/**
 * Basecamp message actions adapter — agent write operations.
 *
 * Implements ChannelMessageActionAdapter for Basecamp. The "send" action
 * lets agents post campfire lines and comments via bcq. Additional write
 * actions (createTodo, completeTodo, etc.) will be added in future PRs.
 *
 * Supported actions:
 *   send — Post a campfire line or comment to a Basecamp recording.
 */

import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageActionContext,
  ChannelToolSend,
} from "openclaw/plugin-sdk";
import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk";
import { postCampfireLine, postComment } from "../outbound/send.js";
import { markdownToBasecampHtml } from "../outbound/format.js";
import { resolveBasecampAccount } from "../config.js";

// ---------------------------------------------------------------------------
// Supported action set
// ---------------------------------------------------------------------------

/** Actions this adapter handles. */
const SUPPORTED_ACTIONS: ChannelMessageActionName[] = ["send"];

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const basecampActionsAdapter: ChannelMessageActionAdapter = {
  listActions: () => SUPPORTED_ACTIONS,

  supportsAction: ({ action }) => SUPPORTED_ACTIONS.includes(action),

  supportsButtons: () => false,

  supportsCards: () => false,

  extractToolSend: ({ args }) => {
    const to = args.to;
    if (typeof to !== "string" || !to) return null;
    const accountId = typeof args.accountId === "string" ? args.accountId : undefined;
    return { to, accountId } satisfies ChannelToolSend;
  },

  handleAction: async (ctx: ChannelMessageActionContext) => {
    switch (ctx.action) {
      case "send":
        return handleSend(ctx);
      default:
        return jsonResult({ ok: false, error: `Unsupported action: ${ctx.action}` });
    }
  },
};

// ---------------------------------------------------------------------------
// send — post a campfire line or comment
// ---------------------------------------------------------------------------

/**
 * Handle the "send" action.
 *
 * Required params:
 *   bucketId     — Basecamp project (bucket) ID
 *   text         — Message content (markdown, converted to Basecamp HTML)
 *
 * Plus one of:
 *   transcriptId — Chat transcript ID → posts a campfire line
 *   recordingId  — Recording ID → posts a comment
 *
 * When both transcriptId and recordingId are provided, transcriptId wins
 * (campfire line takes precedence over comment).
 */
async function handleSend(ctx: ChannelMessageActionContext) {
  const { params, cfg, accountId, dryRun } = ctx;

  const bucketId = readStringParam(params, "bucketId", { required: true, label: "Bucket ID" });
  const text = readStringParam(params, "text", { required: true, label: "Message text" });
  const transcriptId = readStringParam(params, "transcriptId");
  const recordingId = readStringParam(params, "recordingId");

  if (!transcriptId && !recordingId) {
    return jsonResult({
      ok: false,
      error: "Either transcriptId (for campfire) or recordingId (for comment) is required",
    });
  }

  const content = markdownToBasecampHtml(text);
  const account = resolveBasecampAccount(cfg, accountId);

  if (dryRun) {
    return jsonResult({
      ok: true,
      dryRun: true,
      target: transcriptId ? "campfire" : "comment",
      bucketId,
      transcriptId,
      recordingId,
      contentPreview: content.slice(0, 200),
    });
  }

  // Campfire line
  if (transcriptId) {
    const result = await postCampfireLine({
      bucketId,
      transcriptId,
      content,
      accountId: account.config.bcqAccountId ?? account.accountId,
      profile: account.bcqProfile,
    });
    return jsonResult({
      ok: result.ok,
      target: "campfire",
      recordingId: result.recordingId,
      error: result.error,
    });
  }

  // Comment
  const result = await postComment({
    bucketId,
    recordingId: recordingId!,
    content,
    accountId: account.config.bcqAccountId ?? account.accountId,
    profile: account.bcqProfile,
  });
  return jsonResult({
    ok: result.ok,
    target: "comment",
    commentId: result.commentId,
    error: result.error,
  });
}
