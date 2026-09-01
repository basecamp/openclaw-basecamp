/**
 * Basecamp agent tools — plugin-owned tools registered via `api.registerTool`
 * (SPEC §2.9). The catalog of names + manifest metadata lives in
 * `src/tools/catalog.ts`; this module supplies the implementations.
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
 *
 * Registration-time contract: the factory runs in "full" AND "tool-discovery"
 * mode. In the latter there is no plugin runtime and no live config, so the
 * factory only builds descriptors — config, the acting account, and the SDK
 * client are all resolved lazily inside `execute` from the tool context.
 *
 * Acting account: `ctx.agentId` → `channels.basecamp.personas[agentId]`,
 * falling back to the channel's default account. This is what lets several
 * personas share one gateway and still write to Basecamp as themselves.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { type AgentToolResult, jsonResult } from "openclaw/plugin-sdk/tool-results";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import type { BasecampClient } from "../basecamp-client.js";
import { getClient, numId, rawOrThrow } from "../basecamp-client.js";
import { resolveBasecampAccount, resolveDefaultBasecampAccountId, resolvePersonaAccountId } from "../config.js";
import { basecampHtmlToPlainText } from "../outbound/format.js";
import { BASECAMP_TOOL_NAMES, type BasecampToolName } from "../tools/catalog.js";
import type { ResolvedBasecampAccount } from "../types.js";

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
  type: Type.Union([Type.Literal("comments"), Type.Literal("campfire")], {
    description: "Type of history: 'comments' for recording comments, 'campfire' for chat lines",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of messages to return (default 20, max 50)",
      minimum: 1,
      maximum: 50,
    }),
  ),
});

const AddBoostParams = Type.Object({
  bucketId: Type.String({ description: "Basecamp project (bucket) ID" }),
  recordingId: Type.String({
    description: "Recording ID to boost (any recording: comment, todo, campfire line, etc.)",
  }),
  content: Type.Optional(
    Type.String({
      description:
        "Boost content — an emoji or short celebratory text (e.g., '👍', '🎉', 'Congrats!'). Defaults to '👍'.",
    }),
  ),
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
  query: Type.Optional(
    Type.Record(Type.String(), Type.String(), { description: "URL query parameters (e.g., {completed: 'true'})" }),
  ),
});

const ApiWriteParams = Type.Object({
  method: Type.Union([Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("DELETE")], {
    description: "HTTP method",
  }),
  path: Type.String({ description: "Basecamp API path" }),
  body: Type.Optional(Type.Unknown({ description: "JSON request body" })),
});

/** Raw comment/line shape from the Basecamp API. */
type BasecampCommentOrLine = {
  id?: number;
  content?: string;
  created_at?: string;
  creator?: { id?: number; name?: string };
};

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// Tool results — `{ ok: true, ...data }` / `{ ok: false, error }` in both the
// model-facing text and `details`. Agent skills parse the `ok` discriminator,
// so failures are encoded rather than thrown.
// ---------------------------------------------------------------------------

export type BasecampToolDetails = ({ ok: true } & Record<string, unknown>) | { ok: false; error: string };
export type BasecampToolResult = AgentToolResult<BasecampToolDetails>;

const toolOk = (data: Record<string, unknown>): BasecampToolResult => jsonResult({ ok: true as const, ...data });
const toolErr = (error: string): BasecampToolResult => jsonResult({ ok: false as const, error });

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

const API_PATH_RE = /^\/[^\s]*$/;

function validateApiPath(path: string): string | undefined {
  return API_PATH_RE.test(path) ? undefined : "Invalid API path: must start with '/' and contain no whitespace";
}

// ---------------------------------------------------------------------------
// Acting account + client resolution (lazy, per execute)
// ---------------------------------------------------------------------------

/**
 * Latest config snapshot visible to a tool call. `getRuntimeConfig` is the
 * host's live accessor (survives config reloads); the two snapshots are the
 * fallbacks the context contract allows.
 */
export function resolveToolConfig(ctx: OpenClawPluginToolContext): OpenClawConfig | undefined {
  return ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
}

/**
 * The Basecamp account a tool call acts as: the agent's persona mapping when
 * one exists, otherwise the channel default (`default`, or the sole/first
 * configured account when no account is literally named `default`).
 */
export function resolveToolAccount(cfg: OpenClawConfig, agentId: string | undefined): ResolvedBasecampAccount {
  const personaAccountId = agentId ? resolvePersonaAccountId(cfg, agentId) : undefined;
  return resolveBasecampAccount(cfg, personaAccountId ?? resolveDefaultBasecampAccountId(cfg));
}

type ToolClientResolution =
  | { ok: true; client: BasecampClient; account: ResolvedBasecampAccount }
  | { ok: false; error: string };

function resolveToolClient(ctx: OpenClawPluginToolContext): ToolClientResolution {
  const cfg = resolveToolConfig(ctx);
  if (!cfg) {
    return { ok: false, error: "Basecamp tools unavailable: no OpenClaw config in the tool context" };
  }

  const account = resolveToolAccount(cfg, ctx.agentId);
  const personaAccountId = ctx.agentId ? resolvePersonaAccountId(cfg, ctx.agentId) : undefined;
  const via = personaAccountId ? ` (persona for agent "${ctx.agentId}")` : "";

  if (account.tokenSource === "none") {
    return {
      ok: false,
      error:
        `Basecamp account "${account.accountId}"${via} has no credentials — ` +
        `set channels.basecamp.accounts.${account.accountId}.token, tokenFile, or oauthTokenFile`,
    };
  }

  try {
    return { ok: true, client: getClient(account), account };
  } catch (err) {
    return { ok: false, error: `Basecamp client for account "${account.accountId}"${via} failed: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Tool definition helper — resolves the client per call, encodes throws.
// ---------------------------------------------------------------------------

type BasecampToolSpec<T extends TSchema> = {
  name: BasecampToolName;
  label: string;
  description: string;
  parameters: T;
  run: (client: BasecampClient, params: Static<T>) => Promise<BasecampToolResult>;
};

/**
 * Project-scope guard for tool targets: a persona mapped to a virtualAccounts
 * alias may only touch its declared bucket. Checks the explicit bucketId
 * params and the /buckets/<id>/ prefix of generic API paths; targetless
 * params pass (nothing to scope).
 */
export function resolveToolScopeViolation(account: ResolvedBasecampAccount, rawParams: unknown): string | undefined {
  const scoped = account.scopedBucketId;
  if (!scoped) return undefined;
  const params = rawParams as { bucketId?: string | number; path?: string };
  if (params.bucketId !== undefined && String(params.bucketId) !== String(scoped)) {
    return (
      `Account "${account.accountId}" is scoped to bucket ${scoped}; ` + `refusing to act on bucket ${params.bucketId}`
    );
  }
  if (params.path !== undefined) {
    const match = params.path.match(/^\/buckets\/(\d+)(?:\/|\.json)/);
    if (!match || match[1] !== String(scoped)) {
      return (
        `Account "${account.accountId}" is scoped to bucket ${scoped}; ` +
        `API paths must start with /buckets/${scoped}/`
      );
    }
  }
  return undefined;
}

function defineBasecampTool<T extends TSchema>(
  ctx: OpenClawPluginToolContext,
  spec: BasecampToolSpec<T>,
): AnyAgentTool {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (_toolCallId, rawParams) => {
      const resolved = resolveToolClient(ctx);
      if (!resolved.ok) return toolErr(resolved.error);
      const scopeError = resolveToolScopeViolation(resolved.account, rawParams);
      if (scopeError) return toolErr(scopeError);
      try {
        return await spec.run(resolved.client, rawParams as Static<T>);
      } catch (err) {
        return toolErr(String(err));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tool factory — `api.registerTool` calls this with the trusted tool context
// ---------------------------------------------------------------------------

/**
 * Build the ten Basecamp tools for one tool context. Pure: touches neither
 * config nor the plugin runtime until a tool actually executes.
 */
export function buildBasecampTools(ctx: OpenClawPluginToolContext): AnyAgentTool[] {
  return [
    defineBasecampTool(ctx, {
      name: "basecamp_create_todo",
      label: "Create Basecamp To-Do",
      description:
        "Create a new to-do item in a Basecamp to-do list. Requires the project (bucket) ID and to-do list ID.",
      parameters: CreateTodoParams,
      run: async (client, params) => {
        const result = await client.todos.create(numId("todolist", params.todolistId), {
          content: params.content,
          description: params.description,
          assigneeIds: params.assigneeIds,
          dueOn: params.dueOn,
          startsOn: params.startsOn,
        });
        return toolOk({ todoId: result.id, title: result.title });
      },
    }),

    defineBasecampTool(ctx, {
      name: "basecamp_complete_todo",
      label: "Complete Basecamp To-Do",
      description: "Mark a Basecamp to-do as complete. Requires the project (bucket) ID and to-do ID.",
      parameters: CompleteTodoParams,
      run: async (client, { todoId }) => {
        await client.todos.complete(numId("todo", todoId));
        return toolOk({ todoId });
      },
    }),

    defineBasecampTool(ctx, {
      name: "basecamp_reopen_todo",
      label: "Reopen Basecamp To-Do",
      description:
        "Reopen a completed Basecamp to-do (mark as incomplete). Requires the project (bucket) ID and to-do ID.",
      parameters: ReopenTodoParams,
      run: async (client, { todoId }) => {
        await client.todos.uncomplete(numId("todo", todoId));
        return toolOk({ todoId });
      },
    }),

    defineBasecampTool(ctx, {
      name: "basecamp_read_history",
      label: "Read Basecamp History",
      description:
        "Fetch recent messages or comments from a Basecamp recording. " +
        "Use type 'campfire' for chat transcripts or 'comments' for comments on any recording (todo, card, message, etc.). " +
        "Returns up to 50 entries with sender, text, and timestamp.",
      parameters: ReadHistoryParams,
      run: async (client, { bucketId, recordingId, type, limit }) => {
        const effectiveLimit = Math.min(limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);

        // Use raw GET for a single page — the API returns oldest-first, and
        // .slice(-N) gives the most recent N from whatever page we get.
        // Typed list methods auto-paginate with maxItems truncating from the
        // front, which would return the oldest N instead.
        const path =
          type === "campfire"
            ? `/buckets/${bucketId}/chats/${recordingId}/lines.json`
            : `/buckets/${bucketId}/recordings/${recordingId}/comments.json`;

        const entries = await rawOrThrow<BasecampCommentOrLine[]>(await client.raw.GET(path as any, {}));
        const items = Array.isArray(entries) ? entries : [];
        const messages = items.slice(-effectiveLimit).map((entry) => ({
          id: entry.id,
          sender: entry.creator?.name ?? "unknown",
          senderId: entry.creator?.id,
          text: basecampHtmlToPlainText(entry.content ?? ""),
          timestamp: entry.created_at,
        }));

        return toolOk({ count: messages.length, messages });
      },
    }),

    defineBasecampTool(ctx, {
      name: "basecamp_add_boost",
      label: "Add Basecamp Boost",
      description:
        "Add a boost (reaction) to any Basecamp recording — comment, to-do, campfire line, message, etc. " +
        "Content can be an emoji or short celebratory text. Defaults to '👍' if not specified.",
      parameters: AddBoostParams,
      run: async (client, params) => {
        const content = params.content || "👍";
        const result = await client.boosts.createForRecording(numId("recording", params.recordingId), { content });
        return toolOk({ boostId: result.id });
      },
    }),

    defineBasecampTool(ctx, {
      name: "basecamp_move_card",
      label: "Move Basecamp Card",
      description:
        "Move a card to a different column in a Basecamp card table. " +
        "Requires the project (bucket) ID, card recording ID, and target column ID.",
      parameters: MoveCardParams,
      run: async (client, { cardId, columnId }) => {
        await client.cards.move(numId("card", cardId), { columnId });
        return toolOk({ cardId, columnId });
      },
    }),

    defineBasecampTool(ctx, {
      name: "basecamp_post_message",
      label: "Post Basecamp Message",
      description:
        "Post a new message to a Basecamp message board. " +
        "Requires the project (bucket) ID, message board ID, and subject. " +
        "Optionally include body content and a message category/type ID.",
      parameters: PostMessageParams,
      run: async (client, { messageBoardId, subject, content, categoryId }) => {
        const result = await client.messages.create(numId("board", messageBoardId), { subject, content, categoryId });
        return toolOk({ messageId: result.id, subject: result.subject });
      },
    }),

    defineBasecampTool(ctx, {
      name: "basecamp_answer_checkin",
      label: "Answer Basecamp Check-in",
      description:
        "Answer a Basecamp check-in question. Requires the project (bucket) ID, question ID, and answer content.",
      parameters: AnswerCheckinParams,
      run: async (client, { questionId, content }) => {
        const result = await client.checkins.createAnswer(numId("question", questionId), { content });
        return toolOk({ answerId: result.id });
      },
    }),

    defineBasecampTool(ctx, {
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
      run: async (client, { path, query }) => {
        const pathError = validateApiPath(path);
        if (pathError) return toolErr(pathError);

        let effectivePath = path;
        if (query && Object.keys(query).length > 0) {
          const params = new URLSearchParams(query);
          const separator = effectivePath.includes("?") ? "&" : "?";
          effectivePath = `${effectivePath}${separator}${params.toString()}`;
        }

        const result = await rawOrThrow(await client.raw.GET(effectivePath as any, {}));
        return toolOk({ data: result });
      },
    }),

    defineBasecampTool(ctx, {
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
      run: async (client, { method, path, body }) => {
        const pathError = validateApiPath(path);
        if (pathError) return toolErr(pathError);

        let result: unknown;
        switch (method) {
          case "POST":
            result = await rawOrThrow(await client.raw.POST(path as any, { body: body as any }));
            break;
          case "PUT":
            result = await rawOrThrow(await client.raw.PUT(path as any, { body: body as any }));
            break;
          case "DELETE":
            result = await rawOrThrow(await client.raw.DELETE(path as any, {}));
            break;
        }
        return toolOk({ data: result });
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Registration — called from the entry's registerFull (full + tool-discovery)
// ---------------------------------------------------------------------------

/**
 * Register the Basecamp tool factory with the host. `names` mirrors the
 * catalog so the loader can attribute ownership without invoking the factory;
 * every name must also be declared in the manifest's `contracts.tools`.
 */
export function registerBasecampTools(api: Pick<OpenClawPluginApi, "registerTool">): void {
  api.registerTool(buildBasecampTools, { names: [...BASECAMP_TOOL_NAMES] });
}
