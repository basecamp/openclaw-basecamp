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
 *
 * Generic API tools:
 *   basecamp_api_read     — GET any Basecamp 3 resource
 *   basecamp_api_write    — POST/PUT/DELETE any Basecamp 3 resource
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
  columnId: Type.Number({ description: "Target column ID to move the card to" }),
});

const PostMessageParams = Type.Object({
  bucketId: Type.String({ description: "Basecamp project (bucket) ID" }),
  messageBoardId: Type.String({ description: "Message board ID to post to" }),
  subject: Type.String({ description: "Message subject/title" }),
  content: Type.Optional(Type.String({ description: "Message body content (Basecamp HTML or plain text)" })),
  categoryId: Type.Optional(Type.Number({ description: "Message type/category ID" })),
});

const AnswerCheckinParams = Type.Object({
  bucketId: Type.String({ description: "Basecamp project (bucket) ID" }),
  questionId: Type.String({ description: "Check-in question ID to answer" }),
  content: Type.String({ description: "Answer content (Basecamp HTML or plain text)" }),
});

const ApiReadParams = Type.Object({
  path: Type.String({ description: "Basecamp API path (e.g., /buckets/123/todos/456.json)" }),
  query: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "URL query parameters (e.g., {completed: 'true'})" })),
});

const ApiWriteParams = Type.Object({
  method: Type.Union([
    Type.Literal("POST"),
    Type.Literal("PUT"),
    Type.Literal("DELETE"),
  ], { description: "HTTP method" }),
  path: Type.String({ description: "Basecamp API path" }),
  body: Type.Optional(Type.Unknown({ description: "JSON request body" })),
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
    await bcqPut(path, {
      extraFlags: ["-d", JSON.stringify({ column_id: columnId })],
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
  if (categoryId) body.category_id = categoryId;

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
// Path validation — reject inputs that could confuse the bcq CLI
// ---------------------------------------------------------------------------

const API_PATH_RE = /^\/[^\s]*$/;

function validateApiPath(path: string): string | undefined {
  if (!API_PATH_RE.test(path)) {
    return "Invalid API path: must start with '/' and contain no whitespace";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// apiRead — GET any Basecamp 3 resource
// ---------------------------------------------------------------------------

type ApiReadInput = Static<typeof ApiReadParams>;

async function executeApiRead(
  _toolCallId: string,
  rawParams: unknown,
) {
  const { path, query } = rawParams as ApiReadInput;

  const pathError = validateApiPath(path);
  if (pathError) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: pathError }) }],
      details: { ok: false, error: pathError },
    };
  }

  let effectivePath = path;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams(query);
    const separator = effectivePath.includes("?") ? "&" : "?";
    effectivePath = `${effectivePath}${separator}${params.toString()}`;
  }

  try {
    const result = await bcqApiGet(effectivePath);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data: result }) }],
      details: { ok: true },
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: String(err) }) }],
      details: { ok: false, error: String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// apiWrite — POST/PUT/DELETE any Basecamp 3 resource
// ---------------------------------------------------------------------------

type ApiWriteInput = Static<typeof ApiWriteParams>;

async function executeApiWrite(
  _toolCallId: string,
  rawParams: unknown,
) {
  const { method, path, body } = rawParams as ApiWriteInput;

  const pathError = validateApiPath(path);
  if (pathError) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: pathError }) }],
      details: { ok: false, error: pathError },
    };
  }

  try {
    let result: unknown;
    const bodyStr = body != null ? JSON.stringify(body) : undefined;

    switch (method) {
      case "POST":
        result = await bcqApiPost(path, bodyStr);
        break;
      case "PUT":
        result = (await bcqPut(path, bodyStr ? { extraFlags: ["-d", bodyStr] } : {})).data;
        break;
      case "DELETE":
        result = (await bcqDelete(path)).data;
        break;
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data: result }) }],
      details: { ok: true },
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
  {
    name: "basecamp_api_read",
    label: "Read Basecamp API",
    description:
      "Read any Basecamp 3 resource. The projectId (bucketId) is always " +
      "available in event metadata.\n\n" +
      "Key paths:\n" +
      "- /projects.json — list projects\n" +
      "- /projects/{projectId}.json — project details + dock (todoset ID, message board ID, schedule ID, card table ID, vault ID)\n" +
      "- /projects/{projectId}/people.json — project members\n" +
      "- /people.json — all people in the account\n" +
      "- /buckets/{projectId}/todos/{todoId}.json — todo details\n" +
      "- /buckets/{projectId}/todolists/{todolistId}/todos.json — list todos\n" +
      "- /buckets/{projectId}/todosets/{todosetId}/todolists.json — list todolists\n" +
      "- /buckets/{projectId}/recordings/{recordingId}/comments.json — comments\n" +
      "- /buckets/{projectId}/documents/{documentId}.json — document content\n" +
      "- /buckets/{projectId}/card_tables/cards/{cardId}.json — card details\n" +
      "- /buckets/{projectId}/card_tables/{cardTableId}/columns.json — columns\n" +
      "- /buckets/{projectId}/messages/{messageId}.json — message content\n" +
      "- /buckets/{projectId}/schedules/{scheduleId}/entries.json — schedule entries\n\n" +
      "Use query params for filtering, e.g. query: {completed: 'true'}",
    parameters: ApiReadParams,
    execute: executeApiRead,
  },
  {
    name: "basecamp_api_write",
    label: "Write Basecamp API",
    description:
      "Create, update, or delete any Basecamp 3 resource.\n\n" +
      "Common operations:\n" +
      "- POST /buckets/{id}/recordings/{id}/comments.json — add comment\n" +
      "- PUT /buckets/{id}/todos/{id}.json — update todo (content, assignees, due_on)\n" +
      "- POST /buckets/{id}/todolists/{id}/todos.json — create todo\n" +
      "- POST /buckets/{id}/message_boards/{id}/messages.json — post message\n" +
      "- PUT /buckets/{id}/card_tables/cards/{id}/moves.json — move card\n" +
      "- POST /buckets/{id}/documents/{id}.json — create document\n" +
      "- POST /buckets/{id}/schedules/{id}/entries.json — create schedule entry\n\n" +
      "Body should be a JSON object matching the Basecamp 3 API.",
    parameters: ApiWriteParams,
    execute: executeApiWrite,
  },
];
