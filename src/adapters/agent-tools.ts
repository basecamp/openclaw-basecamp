/**
 * Basecamp agent tools — channel-specific tools agents can invoke.
 *
 * These are registered via the `agentTools` slot on ChannelPlugin and let
 * agents perform Basecamp-specific operations during response generation.
 *
 * Write tools:
 *   basecamp_create_todo   — Create a new to-do in a to-do list
 *   basecamp_complete_todo — Mark a to-do as complete
 *   basecamp_reopen_todo   — Mark a to-do as incomplete
 *
 * Read tools:
 *   basecamp_read_history  — Fetch recent messages/comments for a recording
 */

import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { bcqApiGet, bcqApiPost, bcqPut, bcqDelete } from "../bcq.js";
import { basecampHtmlToPlainText } from "../outbound/format.js";

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const CreateTodoParams = Type.Object({
  bucketId: Type.String({ description: "Basecamp project (bucket) ID" }),
  todolistId: Type.String({ description: "To-do list ID to add the to-do to" }),
  content: Type.String({ description: "To-do title/content text" }),
  description: Type.Optional(Type.String({ description: "Rich text description (Basecamp HTML)" })),
  assigneeIds: Type.Optional(Type.Array(Type.Number(), { description: "Person IDs to assign" })),
  dueOn: Type.Optional(Type.String({ description: "Due date in YYYY-MM-DD format" })),
  startsOn: Type.Optional(Type.String({ description: "Start date in YYYY-MM-DD format" })),
});

const CompleteTodoParams = Type.Object({
  bucketId: Type.String({ description: "Basecamp project (bucket) ID" }),
  todoId: Type.String({ description: "To-do recording ID to complete" }),
});

const ReopenTodoParams = Type.Object({
  bucketId: Type.String({ description: "Basecamp project (bucket) ID" }),
  todoId: Type.String({ description: "To-do recording ID to reopen" }),
});

const ReadHistoryParams = Type.Object({
  bucketId: Type.String({ description: "Basecamp project (bucket) ID" }),
  recordingId: Type.String({ description: "Recording ID (chat transcript, todo, card, message, etc.)" }),
  type: Type.Union([
    Type.Literal("comments"),
    Type.Literal("campfire"),
  ], { description: "Type of history: 'comments' for recording comments, 'campfire' for chat lines" }),
  limit: Type.Optional(Type.Number({
    description: "Maximum number of messages to return (default 20, max 50)",
    minimum: 1,
    maximum: 50,
  })),
});

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

type CreateTodoInput = Static<typeof CreateTodoParams>;

async function executeCreateTodo(
  _toolCallId: string,
  rawParams: unknown,
) {
  const params = rawParams as CreateTodoInput;
  const { bucketId, todolistId, content, description, assigneeIds, dueOn, startsOn } = params;
  const path = `/buckets/${bucketId}/todolists/${todolistId}/todos.json`;
  const body: Record<string, unknown> = { content };
  if (description) body.description = description;
  if (assigneeIds?.length) body.assignee_ids = assigneeIds;
  if (dueOn) body.due_on = dueOn;
  if (startsOn) body.starts_on = startsOn;

  try {
    const result = await bcqApiPost<{ id?: number; title?: string }>(
      path,
      JSON.stringify(body),
      bucketId,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, todoId: result?.id, title: result?.title }) }],
      details: { ok: true, todoId: result?.id },
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: String(err) }) }],
      details: { ok: false, error: String(err) },
    };
  }
}

type CompleteTodoInput = Static<typeof CompleteTodoParams>;

async function executeCompleteTodo(
  _toolCallId: string,
  rawParams: unknown,
) {
  const { bucketId, todoId } = rawParams as CompleteTodoInput;
  const path = `/buckets/${bucketId}/todos/${todoId}/completion.json`;

  try {
    await bcqApiPost(path, undefined, bucketId);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, todoId }) }],
      details: { ok: true, todoId },
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: String(err) }) }],
      details: { ok: false, error: String(err) },
    };
  }
}

type ReopenTodoInput = Static<typeof ReopenTodoParams>;

async function executeReopenTodo(
  _toolCallId: string,
  rawParams: unknown,
) {
  const { bucketId, todoId } = rawParams as ReopenTodoInput;
  const path = `/buckets/${bucketId}/todos/${todoId}/completion.json`;

  try {
    // DELETE /completion.json re-opens a completed todo
    await bcqDelete(path, { accountId: bucketId });
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, todoId }) }],
      details: { ok: true, todoId },
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: String(err) }) }],
      details: { ok: false, error: String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// readHistory — fetch recent messages/comments for context
// ---------------------------------------------------------------------------

/** Raw comment/line shape from the Basecamp API. */
type BasecampCommentOrLine = {
  id?: number;
  content?: string;
  created_at?: string;
  creator?: { id?: number; name?: string };
};

type ReadHistoryInput = Static<typeof ReadHistoryParams>;

const DEFAULT_HISTORY_LIMIT = 20;

async function executeReadHistory(
  _toolCallId: string,
  rawParams: unknown,
) {
  const { bucketId, recordingId, type, limit } = rawParams as ReadHistoryInput;
  const effectiveLimit = Math.min(limit ?? DEFAULT_HISTORY_LIMIT, 50);

  const path = type === "campfire"
    ? `/buckets/${bucketId}/chats/${recordingId}/lines.json`
    : `/buckets/${bucketId}/recordings/${recordingId}/comments.json`;

  try {
    const entries = await bcqApiGet<BasecampCommentOrLine[]>(path, bucketId);
    const items = Array.isArray(entries) ? entries : [];

    // Take the most recent N entries (API returns oldest-first for comments)
    const recent = items.slice(-effectiveLimit);

    const messages = recent.map((entry) => ({
      id: entry.id,
      sender: entry.creator?.name ?? "unknown",
      senderId: entry.creator?.id,
      text: basecampHtmlToPlainText(entry.content ?? ""),
      timestamp: entry.created_at,
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, count: messages.length, messages }) }],
      details: { ok: true, count: messages.length },
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: String(err) }) }],
      details: { ok: false, error: String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// Exported tools array
// ---------------------------------------------------------------------------

export const basecampAgentTools: ChannelAgentTool[] = [
  {
    name: "basecamp_create_todo",
    label: "Create Basecamp To-Do",
    description: "Create a new to-do item in a Basecamp to-do list. Requires the project (bucket) ID and to-do list ID.",
    parameters: CreateTodoParams,
    execute: executeCreateTodo,
  },
  {
    name: "basecamp_complete_todo",
    label: "Complete Basecamp To-Do",
    description: "Mark a Basecamp to-do as complete. Requires the project (bucket) ID and to-do ID.",
    parameters: CompleteTodoParams,
    execute: executeCompleteTodo,
  },
  {
    name: "basecamp_reopen_todo",
    label: "Reopen Basecamp To-Do",
    description: "Reopen a completed Basecamp to-do (mark as incomplete). Requires the project (bucket) ID and to-do ID.",
    parameters: ReopenTodoParams,
    execute: executeReopenTodo,
  },
  {
    name: "basecamp_read_history",
    label: "Read Basecamp History",
    description:
      "Fetch recent messages or comments from a Basecamp recording. " +
      "Use type 'campfire' for chat transcripts or 'comments' for comments on any recording (todo, card, message, etc.). " +
      "Returns up to 50 entries with sender, text, and timestamp.",
    parameters: ReadHistoryParams,
    execute: executeReadHistory,
  },
];
