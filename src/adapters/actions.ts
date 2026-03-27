/**
 * Basecamp message actions adapter — agent write operations.
 *
 * Implements ChannelMessageActionAdapter for Basecamp.
 *
 * Supported actions:
 *   send  — Post a campfire line or comment to a Basecamp recording.
 *   react — Add a boost (reaction) to any Basecamp recording.
 */

import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import type { ChannelToolSend } from "openclaw/plugin-sdk/tool-send";
import { getClient, numId } from "../basecamp-client.js";
import { resolveBasecampAccount } from "../config.js";
import { markdownToBasecampHtml } from "../outbound/format.js";
import { postCampfireLine, postComment } from "../outbound/send.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap a payload as a JSON agent tool result (inlined; removed from barrel export). */
function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
}

// ---------------------------------------------------------------------------
// Supported action set
// ---------------------------------------------------------------------------

/** Actions this adapter handles. */
const SUPPORTED_ACTIONS: ChannelMessageActionName[] = ["send", "react"];

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const basecampActionsAdapter: ChannelMessageActionAdapter = {
  describeMessageTool: () => ({ actions: SUPPORTED_ACTIONS }),

  supportsAction: ({ action }) => SUPPORTED_ACTIONS.includes(action),

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
      case "react":
        return handleReact(ctx);
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

  // Enforce virtual-account bucket scoping: if the account is scoped to a
  // specific bucket, reject sends targeting a different bucket.
  if (account.scopedBucketId && bucketId !== String(account.scopedBucketId)) {
    return jsonResult({
      ok: false,
      error: `Account "${account.accountId}" is scoped to bucket ${account.scopedBucketId}, cannot send to bucket ${bucketId}`,
    });
  }

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
      account,
    });
    if (!result.ok) {
      return jsonResult({ ok: false, target: "campfire", error: result.message });
    }
    return jsonResult({ ok: true, target: "campfire", recordingId: result.recordingId });
  }

  // Comment
  const result = await postComment({
    bucketId,
    recordingId: recordingId!,
    content,
    account,
  });
  if (!result.ok) {
    return jsonResult({ ok: false, target: "comment", error: result.message });
  }
  return jsonResult({ ok: true, target: "comment", commentId: result.commentId });
}

// ---------------------------------------------------------------------------
// react — add a boost (reaction) to any recording
// ---------------------------------------------------------------------------

async function handleReact(ctx: ChannelMessageActionContext) {
  const { params, cfg, accountId, dryRun } = ctx;

  const bucketId = readStringParam(params, "bucketId", { required: true, label: "Bucket ID" });
  const recordingId = readStringParam(params, "recordingId", { required: true, label: "Recording ID" });
  const emoji = readStringParam(params, "emoji") || "👍";

  const account = resolveBasecampAccount(cfg, accountId);

  // Enforce virtual-account bucket scoping
  if (account.scopedBucketId && bucketId !== String(account.scopedBucketId)) {
    return jsonResult({
      ok: false,
      error: `Account "${account.accountId}" is scoped to bucket ${account.scopedBucketId}, cannot react in bucket ${bucketId}`,
    });
  }

  if (dryRun) {
    return jsonResult({ ok: true, dryRun: true, target: "boost", bucketId, recordingId, emoji });
  }

  try {
    const client = getClient(account);
    const result = await client.boosts.createForRecording(numId("recording", recordingId), { content: emoji });
    return jsonResult({ ok: true, target: "boost", boostId: (result as any)?.id });
  } catch (err) {
    console.error(`[basecamp:${accountId}] react error: bucket=${bucketId} recording=${recordingId}`, err);
    return jsonResult({ ok: false, error: String(err) });
  }
}
