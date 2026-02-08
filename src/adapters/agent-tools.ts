/**
 * Basecamp agent tools — channel-specific tools agents can invoke.
 *
 * These are registered via the `agentTools` slot on ChannelPlugin and let
 * agents perform Basecamp-specific operations during response generation.
 *
 * Write tools:
 *   basecamp_create_todo    — Create a new to-do in a to-do list
 *   basecamp_complete_todo  — Mark a to-do as complete
 *   basecamp_reopen_todo    — Mark a to-do as incomplete
 *   basecamp_add_boost      — Add a boost (reaction) to any recording
 *   basecamp_move_card      — Move a card to a different column in a card table
 *   basecamp_post_message   — Post a new message to a message board
 *   basecamp_answer_checkin — Answer a check-in question
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

const AddBoostParams = Type.Object({
  bucketId: Type.String({ description: "Basecamp project (bucket) ID" }),
  recordingId: Type.String({ description: "Recording ID to boost (any recording: comment, todo, campfire line, etc.)" }),
  content: Type.Optional(Type.String({ description: "Boost content — an emoji or short celebratory text (e.g., '👍', '🎉', 'Congrats!'). Defaults to '👍'." })),
});

const MoveCardParams = Type.Object({
  bucketId: Type.String({ description: "Basecamp project (bucket) ID" }),
  cardId: Type.String({ description: "Card recording ID to move" }),
  columnId: Type.String({ description: "Target column ID to move the card to" }),
});

const PostMessageParams = Type.Object({
  bucketId: Type.String({ description: "Basecamp project (bucket) ID" }),
  messageBoardId: Type.String({ description: "Message board ID to post to" }),
  subject: Type.String({ description: "Message subject/title" }),
  content: Type.Optional(Type.String({ description: "Message body content (Basecamp HTML or plain text)" })),
  categoryId: Type.Optional(Type.String({ description: "Message type/category ID" })),
});

const AnswerCheckinParams = Type.Object({
  bucketId: Type.String({ description: "Basecamp project (bucket) ID" }),
  questionId: Type.String({ description: "Check-in question ID to answer" }),
  content: Type.String({ description: "Answer content (Basecamp HTML or plain text)" }),
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
    await bcqApiPost(path);
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
    await bcqDelete(path);
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
// addBoost — react to any recording with an emoji or text
// ---------------------------------------------------------------------------

type AddBoostInput = Static<typeof AddBoostParams>;

async function executeAddBoost(
  _toolCallId: string,
  rawParams: unknown,
) {
  const params = rawParams as AddBoostInput;
  const { bucketId, recordingId } = params;
  const content = params.content || "👍";
  const path = `/buckets/${bucketId}/recordings/${recordingId}/boosts.json`;

  try {
    const result = await bcqApiPost<{ id?: number }>(
      path,
      JSON.stringify({ content }),
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, boostId: result?.id }) }],
      details: { ok: true, boostId: result?.id },
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: String(err) }) }],
      details: { ok: false, error: String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// moveCard — move a card to a different column in a card table
// ---------------------------------------------------------------------------

type MoveCardInput = Static<typeof MoveCardParams>;

async function executeMoveCard(
  _toolCallId: string,
  rawParams: unknown,
) {
  const { bucketId, cardId, columnId } = rawParams as MoveCardInput;
  const path = `/buckets/${bucketId}/card_tables/cards/${cardId}/moves.json`;

  try {
    const result = await bcqPut<{ id?: number }>(path, {
      extraFlags: ["-d", JSON.stringify({ column_id: Number(columnId) })],
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, cardId, columnId }) }],
      details: { ok: true, cardId, columnId },
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: String(err) }) }],
      details: { ok: false, error: String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// postMessage — post a new message to a message board
// ---------------------------------------------------------------------------

type PostMessageInput = Static<typeof PostMessageParams>;

async function executePostMessage(
  _toolCallId: string,
  rawParams: unknown,
) {
  const { bucketId, messageBoardId, subject, content, categoryId } = rawParams as PostMessageInput;
  const path = `/buckets/${bucketId}/message_boards/${messageBoardId}/messages.json`;
  const body: Record<string, unknown> = { subject };
  if (content) body.content = content;
  if (categoryId) body.category_id = Number(categoryId);

  try {
    const result = await bcqApiPost<{ id?: number; subject?: string }>(
      path,
      JSON.stringify(body),
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, messageId: result?.id, subject: result?.subject }) }],
      details: { ok: true, messageId: result?.id },
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: String(err) }) }],
      details: { ok: false, error: String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// answerCheckin — answer a check-in question
// ---------------------------------------------------------------------------

type AnswerCheckinInput = Static<typeof AnswerCheckinParams>;

async function executeAnswerCheckin(
  _toolCallId: string,
  rawParams: unknown,
) {
  const { bucketId, questionId, content } = rawParams as AnswerCheckinInput;
  const path = `/buckets/${bucketId}/questions/${questionId}/answers.json`;

  try {
    const result = await bcqApiPost<{ id?: number }>(
      path,
      JSON.stringify({ content }),
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, answerId: result?.id }) }],
      details: { ok: true, answerId: result?.id },
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
    const entries = await bcqApiGet<BasecampCommentOrLine[]>(path);
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
  {
    name: "basecamp_add_boost",
    label: "Add Basecamp Boost",
    description:
      "Add a boost (reaction) to any Basecamp recording — comment, to-do, campfire line, message, etc. " +
      "Content can be an emoji or short celebratory text. Defaults to '👍' if not specified.",
    parameters: AddBoostParams,
    execute: executeAddBoost,
  },
  {
    name: "basecamp_move_card",
    label: "Move Basecamp Card",
    description:
      "Move a card to a different column in a Basecamp card table. " +
      "Requires the project (bucket) ID, card recording ID, and target column ID.",
    parameters: MoveCardParams,
    execute: executeMoveCard,
  },
  {
    name: "basecamp_post_message",
    label: "Post Basecamp Message",
    description:
      "Post a new message to a Basecamp message board. " +
      "Requires the project (bucket) ID, message board ID, and subject. " +
      "Optionally include body content and a message category/type ID.",
    parameters: PostMessageParams,
    execute: executePostMessage,
  },
  {
    name: "basecamp_answer_checkin",
    label: "Answer Basecamp Check-in",
    description:
      "Answer a Basecamp check-in question. " +
      "Requires the project (bucket) ID, question ID, and answer content.",
    parameters: AnswerCheckinParams,
    execute: executeAnswerCheckin,
  },
];
