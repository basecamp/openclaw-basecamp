import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cfgWithAccounts } from "./helpers.js";

const mockClient = {
  todos: { create: vi.fn(), complete: vi.fn(), uncomplete: vi.fn() },
  boosts: { createForRecording: vi.fn() },
  cards: { move: vi.fn() },
  messages: { create: vi.fn() },
  checkins: { createAnswer: vi.fn() },
  raw: {
    GET: vi.fn(),
    POST: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
  },
};

vi.mock("../src/basecamp-client.js", () => ({
  getClient: vi.fn(() => mockClient),
  numId: (label: string, value: string | number) => {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Invalid ${label} ID: ${JSON.stringify(value)}`);
    return n;
  },
  rawOrThrow: vi.fn(async (r: any) => {
    if (r?.error) throw new Error("API error");
    return r?.data;
  }),
}));

vi.mock("../src/outbound/format.js", async () => {
  const { stripHtml } = await vi.importActual<typeof import("../src/outbound/format.js")>("../src/outbound/format.js");
  return { basecampHtmlToPlainText: vi.fn((html: string) => stripHtml(html)) };
});

import {
  buildBasecampTools,
  registerBasecampTools,
  resolveToolAccount,
  resolveToolScopeViolation,
} from "../src/adapters/agent-tools.js";
import { getClient } from "../src/basecamp-client.js";
import { BASECAMP_TOOL_METADATA, BASECAMP_TOOL_NAMES, isBasecampToolName } from "../src/tools/catalog.js";

// ---------------------------------------------------------------------------
// Fixtures: real config resolution (no config mock) so persona → account
// mapping is exercised end to end; only the SDK client is faked.
// ---------------------------------------------------------------------------

/** Two concrete accounts, one persona mapping, one dangling persona. */
const baseCfg = cfgWithAccounts(
  {
    main: { token: "tok-main", personId: "999", basecampAccountId: "99" },
    "persona-acct": { token: "tok-persona", personId: "1234", basecampAccountId: "99" },
  },
  { personas: { "persona-agent": "persona-acct", "orphan-agent": "ghost-acct" } },
);

/** SPEC §4.4: stub OpenClawPluginToolContext — the host's live config accessor + agent identity. */
function toolCtx(overrides: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext {
  return { getRuntimeConfig: () => baseCfg, sessionKey: "agent:main:basecamp:recording:1", ...overrides };
}

const tools = buildBasecampTools(toolCtx());

function findTool(name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

/** Account the (mocked) client was built for on the most recent execute. */
function actingAccountId(): string | undefined {
  const calls = vi.mocked(getClient).mock.calls;
  return calls.at(-1)?.[0]?.accountId;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Catalog + registration (SPEC §1.3, §2.9)
// ---------------------------------------------------------------------------

describe("tool catalog", () => {
  it("names ten basecamp_* tools with metadata for each", () => {
    expect(BASECAMP_TOOL_NAMES).toHaveLength(10);
    expect(Object.keys(BASECAMP_TOOL_METADATA).sort()).toEqual([...BASECAMP_TOOL_NAMES].sort());
    for (const name of BASECAMP_TOOL_NAMES) expect(name).toMatch(/^basecamp_[a-z_]+$/);
  });

  it("marks only the two read tools replay-safe; every mutation is side-effecting", () => {
    const replaySafe = BASECAMP_TOOL_NAMES.filter((n) => "replaySafe" in BASECAMP_TOOL_METADATA[n]);
    expect(replaySafe).toEqual(["basecamp_read_history", "basecamp_api_read"]);
    const sideEffecting = BASECAMP_TOOL_NAMES.filter((n) => "sideEffecting" in BASECAMP_TOOL_METADATA[n]);
    expect(sideEffecting).toHaveLength(8);
  });

  it("recognizes catalog names", () => {
    expect(isBasecampToolName("basecamp_api_read")).toBe(true);
    expect(isBasecampToolName("exec")).toBe(false);
  });
});

describe("buildBasecampTools", () => {
  it("builds the catalog's tools, in catalog order", () => {
    expect(tools.map((t) => t.name)).toEqual([...BASECAMP_TOOL_NAMES]);
  });

  it("gives every tool a label, description, TypeBox parameters, and execute", () => {
    for (const tool of tools) {
      expect(tool.label).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toMatchObject({ type: "object" });
      expect(tool.execute).toBeTypeOf("function");
    }
  });

  it("touches neither config nor the client at build time (tool-discovery mode has no runtime)", () => {
    const getRuntimeConfig = vi.fn(() => {
      throw new Error("no runtime in tool-discovery mode");
    });
    const built = buildBasecampTools({ getRuntimeConfig });
    expect(built).toHaveLength(BASECAMP_TOOL_NAMES.length);
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe("registerBasecampTools", () => {
  it("registers one factory declaring exactly the catalog names", () => {
    const api = { registerTool: vi.fn() };
    registerBasecampTools(api);

    expect(api.registerTool).toHaveBeenCalledTimes(1);
    const [factory, opts] = api.registerTool.mock.calls[0]!;
    expect(factory).toBe(buildBasecampTools);
    expect(opts).toEqual({ names: [...BASECAMP_TOOL_NAMES] });
    expect(factory(toolCtx()).map((t: { name: string }) => t.name)).toEqual(opts.names);
  });
});

// ---------------------------------------------------------------------------
// Acting account: ctx.agentId → channels.basecamp.personas → account (SPEC §2.9)
// ---------------------------------------------------------------------------

describe("acting account resolution", () => {
  const params = { bucketId: "100", todoId: "300" };

  async function completeAs(ctx: OpenClawPluginToolContext) {
    mockClient.todos.complete.mockResolvedValue(undefined);
    const tool = buildBasecampTools(ctx).find((t) => t.name === "basecamp_complete_todo")!;
    return tool.execute("call-acct", params);
  }

  it("uses the persona-mapped account for a mapped agent", async () => {
    const result = await completeAs(toolCtx({ agentId: "persona-agent" }));

    expect(result.details).toEqual({ ok: true, todoId: "300" });
    expect(actingAccountId()).toBe("persona-acct");
    expect(vi.mocked(getClient).mock.calls[0]![0]).toMatchObject({ token: "tok-persona", personId: "1234" });
  });

  it("falls back to the channel default account for an unmapped agent", async () => {
    await completeAs(toolCtx({ agentId: "some-other-agent" }));
    expect(actingAccountId()).toBe("main");
  });

  it("falls back to the channel default account when the context carries no agentId", async () => {
    await completeAs(toolCtx());
    expect(actingAccountId()).toBe("main");
  });

  it("prefers an account literally named `default` over the alphabetically first one", () => {
    const cfg = cfgWithAccounts({ aardvark: { token: "a" }, default: { token: "d" } });
    expect(resolveToolAccount(cfg, "nobody").accountId).toBe("default");
    expect(resolveToolAccount(cfg, undefined).accountId).toBe("default");
  });

  it("fails closed when the persona points at an account that does not exist", async () => {
    const result = await completeAs(toolCtx({ agentId: "orphan-agent" }));

    expect(result.details).toEqual({
      ok: false,
      error: expect.stringMatching(/account "ghost-acct" \(persona for agent "orphan-agent"\) has no credentials/),
    });
    expect((result.details as { error: string }).error).toContain("channels.basecamp.accounts.ghost-acct.token");
    expect(getClient).not.toHaveBeenCalled();
    expect(mockClient.todos.complete).not.toHaveBeenCalled();
  });

  it("fails closed when the default account has no credentials", async () => {
    const result = await completeAs(toolCtx({ getRuntimeConfig: () => cfgWithAccounts({}) }));

    expect(result.details).toEqual({
      ok: false,
      error: expect.stringContaining('account "default" has no credentials'),
    });
    expect(getClient).not.toHaveBeenCalled();
  });

  it("fails closed when the context has no config at all", async () => {
    const result = await completeAs({ agentId: "persona-agent" });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("no OpenClaw config") });
    expect(getClient).not.toHaveBeenCalled();
  });

  it("reports a client construction failure as a tool error", async () => {
    vi.mocked(getClient).mockImplementationOnce(() => {
      throw new Error("token file unreadable");
    });
    const result = await completeAs(toolCtx({ agentId: "persona-agent" }));

    expect(result.details).toEqual({
      ok: false,
      error: expect.stringMatching(
        /client for account "persona-acct" \(persona for agent "persona-agent"\) failed: .*token file unreadable/,
      ),
    });
  });

  it("reads the live config accessor first, then the runtime and static snapshots", async () => {
    const liveCfg = cfgWithAccounts({ live: { token: "l" } });
    const runtimeCfg = cfgWithAccounts({ runtime: { token: "r" } });
    const staticCfg = cfgWithAccounts({ static: { token: "s" } });

    await completeAs({ getRuntimeConfig: () => liveCfg, runtimeConfig: runtimeCfg, config: staticCfg });
    expect(actingAccountId()).toBe("live");

    await completeAs({ getRuntimeConfig: () => undefined, runtimeConfig: runtimeCfg, config: staticCfg });
    expect(actingAccountId()).toBe("runtime");

    await completeAs({ config: staticCfg });
    expect(actingAccountId()).toBe("static");
  });

  it("re-resolves the account on every call so config reloads take effect", async () => {
    const before = cfgWithAccounts({ main: { token: "m" } }, { personas: {} });
    const after = cfgWithAccounts(
      { main: { token: "m" }, rotated: { token: "r" } },
      { personas: { agent: "rotated" } },
    );
    const getRuntimeConfig = vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(after);
    mockClient.todos.complete.mockResolvedValue(undefined);
    const tool = buildBasecampTools({ getRuntimeConfig, agentId: "agent" }).find(
      (t) => t.name === "basecamp_complete_todo",
    )!;

    await tool.execute("call-1", params);
    expect(actingAccountId()).toBe("main");
    await tool.execute("call-2", params);
    expect(actingAccountId()).toBe("rotated");
    expect(getRuntimeConfig).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// basecamp_create_todo
// ---------------------------------------------------------------------------

describe("basecamp_create_todo", () => {
  const tool = findTool("basecamp_create_todo");

  it("creates a todo with minimal params", async () => {
    mockClient.todos.create.mockResolvedValue({ id: 42, title: "Buy milk" });

    const result = await tool.execute("call-1", {
      bucketId: "100",
      todolistId: "200",
      content: "Buy milk",
    });

    expect(mockClient.todos.create).toHaveBeenCalledWith(200, {
      content: "Buy milk",
      description: undefined,
      assigneeIds: undefined,
      dueOn: undefined,
      startsOn: undefined,
    });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({ ok: true, todoId: 42, title: "Buy milk" });
    expect(result.details).toEqual({ ok: true, todoId: 42, title: "Buy milk" });
  });

  it("creates a todo with all optional params", async () => {
    mockClient.todos.create.mockResolvedValue({ id: 43 });

    await tool.execute("call-2", {
      bucketId: "100",
      todolistId: "200",
      content: "Review PR",
      description: "<p>Check edge cases</p>",
      assigneeIds: [10, 20],
      dueOn: "2025-03-01",
      startsOn: "2025-02-15",
    });

    expect(mockClient.todos.create).toHaveBeenCalledWith(200, {
      content: "Review PR",
      description: "<p>Check edge cases</p>",
      assigneeIds: [10, 20],
      dueOn: "2025-03-01",
      startsOn: "2025-02-15",
    });
  });

  it("rejects a non-numeric todolist id without calling the API", async () => {
    const result = await tool.execute("call-3", { bucketId: "100", todolistId: "abc", content: "x" });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("Invalid todolist ID") });
    expect(mockClient.todos.create).not.toHaveBeenCalled();
  });

  it("returns error on API failure", async () => {
    mockClient.todos.create.mockRejectedValue(new Error("403 Forbidden"));

    const result = await tool.execute("call-4", {
      bucketId: "100",
      todolistId: "200",
      content: "Fail",
    });

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("403 Forbidden");
    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("403 Forbidden") });
  });
});

// ---------------------------------------------------------------------------
// basecamp_complete_todo / basecamp_reopen_todo
// ---------------------------------------------------------------------------

describe("basecamp_complete_todo", () => {
  const tool = findTool("basecamp_complete_todo");

  it("calls complete on the client", async () => {
    mockClient.todos.complete.mockResolvedValue(undefined);

    const result = await tool.execute("call-5", { bucketId: "100", todoId: "300" });

    expect(mockClient.todos.complete).toHaveBeenCalledWith(300);
    expect(result.details).toEqual({ ok: true, todoId: "300" });
  });

  it("returns error on API failure", async () => {
    mockClient.todos.complete.mockRejectedValue(new Error("500 Server Error"));

    const result = await tool.execute("call-6", { bucketId: "100", todoId: "300" });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("500 Server Error") });
  });
});

describe("basecamp_reopen_todo", () => {
  const tool = findTool("basecamp_reopen_todo");

  it("calls uncomplete on the client", async () => {
    mockClient.todos.uncomplete.mockResolvedValue(undefined);

    const result = await tool.execute("call-7", { bucketId: "100", todoId: "300" });

    expect(mockClient.todos.uncomplete).toHaveBeenCalledWith(300);
    expect(result.details).toEqual({ ok: true, todoId: "300" });
  });

  it("returns error on API failure", async () => {
    mockClient.todos.uncomplete.mockRejectedValue(new Error("404 Not Found"));

    const result = await tool.execute("call-8", { bucketId: "100", todoId: "300" });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("404 Not Found") });
  });
});

// ---------------------------------------------------------------------------
// basecamp_read_history
// ---------------------------------------------------------------------------

describe("basecamp_read_history", () => {
  const tool = findTool("basecamp_read_history");

  const page = (data: unknown) => ({ data, error: undefined, response: { ok: true, headers: new Headers() } });

  it("fetches campfire lines", async () => {
    mockClient.raw.GET.mockResolvedValue(
      page([
        { id: 1, content: "<p>Hello</p>", created_at: "2025-01-01T10:00:00Z", creator: { id: 10, name: "Alice" } },
        { id: 2, content: "<p>World</p>", created_at: "2025-01-01T10:01:00Z", creator: { id: 20, name: "Bob" } },
      ]),
    );

    const result = await tool.execute("call-9", { bucketId: "100", recordingId: "200", type: "campfire" });

    expect(mockClient.raw.GET).toHaveBeenCalledWith("/buckets/100/chats/200/lines.json", {});
    expect(result.details).toEqual({
      ok: true,
      count: 2,
      messages: [
        { id: 1, sender: "Alice", senderId: 10, text: "Hello", timestamp: "2025-01-01T10:00:00Z" },
        { id: 2, sender: "Bob", senderId: 20, text: "World", timestamp: "2025-01-01T10:01:00Z" },
      ],
    });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.details);
  });

  it("fetches recording comments", async () => {
    mockClient.raw.GET.mockResolvedValue(
      page([
        {
          id: 5,
          content: "<strong>Done</strong>",
          created_at: "2025-01-01T12:00:00Z",
          creator: { id: 30, name: "Charlie" },
        },
      ]),
    );

    const result = await tool.execute("call-10", { bucketId: "100", recordingId: "300", type: "comments" });

    expect(mockClient.raw.GET).toHaveBeenCalledWith("/buckets/100/recordings/300/comments.json", {});
    const details = result.details as { count: number; messages: Array<{ sender: string; text: string }> };
    expect(details.count).toBe(1);
    expect(details.messages[0]).toMatchObject({ sender: "Charlie", text: "Done" });
  });

  it("returns the most recent N when limit is given", async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      content: `<p>Message ${i}</p>`,
      created_at: `2025-01-01T10:${String(i).padStart(2, "0")}:00Z`,
      creator: { id: 1, name: "Alice" },
    }));
    mockClient.raw.GET.mockResolvedValue(page(entries));

    const result = await tool.execute("call-11", { bucketId: "100", recordingId: "200", type: "campfire", limit: 5 });

    const details = result.details as { count: number; messages: Array<{ id: number }> };
    expect(details.count).toBe(5);
    expect(details.messages.map((m) => m.id)).toEqual([25, 26, 27, 28, 29]);
  });

  it("caps limit at 50 and defaults to 20", async () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({ id: i, content: `<p>M${i}</p>` }));
    mockClient.raw.GET.mockResolvedValue(page(entries));

    const capped = await tool.execute("call-12", { bucketId: "100", recordingId: "200", type: "campfire", limit: 100 });
    expect((capped.details as { count: number }).count).toBe(50);

    const defaulted = await tool.execute("call-13", { bucketId: "100", recordingId: "200", type: "campfire" });
    expect((defaulted.details as { count: number }).count).toBe(20);
  });

  it("handles empty and non-array responses", async () => {
    mockClient.raw.GET.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page(null));

    const empty = await tool.execute("call-14", { bucketId: "100", recordingId: "200", type: "comments" });
    expect(empty.details).toEqual({ ok: true, count: 0, messages: [] });

    const nonArray = await tool.execute("call-15", { bucketId: "100", recordingId: "200", type: "campfire" });
    expect(nonArray.details).toEqual({ ok: true, count: 0, messages: [] });
  });

  it("returns error on API failure", async () => {
    mockClient.raw.GET.mockRejectedValue(new Error("503 Service Unavailable"));

    const result = await tool.execute("call-16", { bucketId: "100", recordingId: "200", type: "campfire" });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("503 Service Unavailable") });
  });

  it("handles entries with missing creator", async () => {
    mockClient.raw.GET.mockResolvedValue(
      page([{ id: 1, content: "<p>No creator</p>", created_at: "2025-01-01T10:00:00Z" }]),
    );

    const result = await tool.execute("call-17", { bucketId: "100", recordingId: "200", type: "comments" });

    const details = result.details as { messages: Array<{ sender: string; senderId?: number }> };
    expect(details.messages[0].sender).toBe("unknown");
    expect(details.messages[0].senderId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// basecamp_add_boost
// ---------------------------------------------------------------------------

describe("basecamp_add_boost", () => {
  const tool = findTool("basecamp_add_boost");

  it("boosts a recording with default content", async () => {
    mockClient.boosts.createForRecording.mockResolvedValue({ id: 99 });

    const result = await tool.execute("call-18", { bucketId: "100", recordingId: "500" });

    expect(mockClient.boosts.createForRecording).toHaveBeenCalledWith(500, { content: "👍" });
    expect(result.details).toEqual({ ok: true, boostId: 99 });
  });

  it("boosts a recording with custom emoji", async () => {
    mockClient.boosts.createForRecording.mockResolvedValue({ id: 101 });

    const result = await tool.execute("call-19", { bucketId: "100", recordingId: "500", content: "🎉" });

    expect(mockClient.boosts.createForRecording).toHaveBeenCalledWith(500, { content: "🎉" });
    expect(result.details).toEqual({ ok: true, boostId: 101 });
  });

  it("returns error on API failure", async () => {
    mockClient.boosts.createForRecording.mockRejectedValue(new Error("422 Unprocessable"));

    const result = await tool.execute("call-20", { bucketId: "100", recordingId: "500" });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("422 Unprocessable") });
  });
});

// ---------------------------------------------------------------------------
// basecamp_move_card
// ---------------------------------------------------------------------------

describe("basecamp_move_card", () => {
  const tool = findTool("basecamp_move_card");

  it("moves a card to the target column", async () => {
    mockClient.cards.move.mockResolvedValue(undefined);

    const result = await tool.execute("call-21", { bucketId: "100", cardId: "600", columnId: 700 });

    expect(mockClient.cards.move).toHaveBeenCalledWith(600, { columnId: 700 });
    expect(result.details).toEqual({ ok: true, cardId: "600", columnId: 700 });
  });

  it("returns error on API failure", async () => {
    mockClient.cards.move.mockRejectedValue(new Error("404 Not Found"));

    const result = await tool.execute("call-22", { bucketId: "100", cardId: "600", columnId: 700 });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("404 Not Found") });
  });
});

// ---------------------------------------------------------------------------
// basecamp_post_message
// ---------------------------------------------------------------------------

describe("basecamp_post_message", () => {
  const tool = findTool("basecamp_post_message");

  it("posts a message with minimal params", async () => {
    mockClient.messages.create.mockResolvedValue({ id: 800, subject: "Weekly Update" });

    const result = await tool.execute("call-23", { bucketId: "100", messageBoardId: "200", subject: "Weekly Update" });

    expect(mockClient.messages.create).toHaveBeenCalledWith(200, {
      subject: "Weekly Update",
      content: undefined,
      categoryId: undefined,
    });
    expect(result.details).toEqual({ ok: true, messageId: 800, subject: "Weekly Update" });
  });

  it("posts a message with content and category", async () => {
    mockClient.messages.create.mockResolvedValue({ id: 801, subject: "Announcement" });

    await tool.execute("call-24", {
      bucketId: "100",
      messageBoardId: "200",
      subject: "Announcement",
      content: "<p>Big news!</p>",
      categoryId: 5,
    });

    expect(mockClient.messages.create).toHaveBeenCalledWith(200, {
      subject: "Announcement",
      content: "<p>Big news!</p>",
      categoryId: 5,
    });
  });

  it("returns error on API failure", async () => {
    mockClient.messages.create.mockRejectedValue(new Error("403 Forbidden"));

    const result = await tool.execute("call-26", { bucketId: "100", messageBoardId: "200", subject: "Fail" });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("403 Forbidden") });
  });
});

// ---------------------------------------------------------------------------
// basecamp_answer_checkin
// ---------------------------------------------------------------------------

describe("basecamp_answer_checkin", () => {
  const tool = findTool("basecamp_answer_checkin");

  it("answers a check-in question", async () => {
    mockClient.checkins.createAnswer.mockResolvedValue({ id: 900 });

    const result = await tool.execute("call-27", {
      bucketId: "100",
      questionId: "300",
      content: "Everything is on track!",
    });

    expect(mockClient.checkins.createAnswer).toHaveBeenCalledWith(300, { content: "Everything is on track!" });
    expect(result.details).toEqual({ ok: true, answerId: 900 });
  });

  it("returns error on API failure", async () => {
    mockClient.checkins.createAnswer.mockRejectedValue(new Error("422 Unprocessable"));

    const result = await tool.execute("call-28", { bucketId: "100", questionId: "300", content: "Fail" });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("422 Unprocessable") });
  });
});

// ---------------------------------------------------------------------------
// basecamp_api_read
// ---------------------------------------------------------------------------

describe("basecamp_api_read", () => {
  const tool = findTool("basecamp_api_read");

  const page = (data: unknown) => ({ data, error: undefined, response: { ok: true, headers: new Headers() } });

  it("reads a resource by path", async () => {
    const todoData = { id: 42, content: "Buy milk", completed: false };
    mockClient.raw.GET.mockResolvedValue(page(todoData));

    const result = await tool.execute("call-read-1", { path: "/buckets/100/todos/42.json" });

    expect(mockClient.raw.GET).toHaveBeenCalledWith("/buckets/100/todos/42.json", {});
    expect(result.details).toEqual({ ok: true, data: todoData });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ ok: true, data: todoData });
  });

  it("appends query parameters", async () => {
    mockClient.raw.GET.mockResolvedValue(page([]));

    await tool.execute("call-read-2", {
      path: "/buckets/100/todolists/200/todos.json",
      query: { completed: "true", page: "2" },
    });

    expect(mockClient.raw.GET).toHaveBeenCalledWith("/buckets/100/todolists/200/todos.json?completed=true&page=2", {});
  });

  it("joins query parameters onto a path that already has a query string", async () => {
    mockClient.raw.GET.mockResolvedValue(page([]));

    await tool.execute("call-read-2b", { path: "/projects.json?status=archived", query: { page: "3" } });

    expect(mockClient.raw.GET).toHaveBeenCalledWith("/projects.json?status=archived&page=3", {});
  });

  it("ignores empty query params", async () => {
    mockClient.raw.GET.mockResolvedValue(page({}));

    await tool.execute("call-read-6", { path: "/projects.json", query: {} });

    expect(mockClient.raw.GET).toHaveBeenCalledWith("/projects.json", {});
  });

  it("returns error on API failure", async () => {
    mockClient.raw.GET.mockRejectedValue(new Error("404 Not Found"));

    const result = await tool.execute("call-read-5", { path: "/buckets/999/todos/999.json" });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("404 Not Found") });
  });

  it("rejects a path not starting with / without calling the API", async () => {
    const result = await tool.execute("call-read-bad-1", { path: "-flag-injection" });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("must start with '/'") });
    expect(mockClient.raw.GET).not.toHaveBeenCalled();
  });

  it("rejects a path with whitespace without calling the API", async () => {
    const result = await tool.execute("call-read-bad-2", { path: "/buckets/100/todos.json --some-flag" });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("no whitespace") });
    expect(mockClient.raw.GET).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// basecamp_api_write
// ---------------------------------------------------------------------------

describe("basecamp_api_write", () => {
  const tool = findTool("basecamp_api_write");

  const page = (data: unknown) => ({ data, error: undefined, response: { ok: true, headers: new Headers() } });

  it("creates a resource with POST", async () => {
    mockClient.raw.POST.mockResolvedValue(page({ id: 50, content: "New todo" }));

    const result = await tool.execute("call-write-1", {
      method: "POST",
      path: "/buckets/100/todolists/200/todos.json",
      body: { content: "New todo" },
    });

    expect(mockClient.raw.POST).toHaveBeenCalledWith("/buckets/100/todolists/200/todos.json", {
      body: { content: "New todo" },
    });
    expect(result.details).toEqual({ ok: true, data: { id: 50, content: "New todo" } });
  });

  it("updates a resource with PUT", async () => {
    mockClient.raw.PUT.mockResolvedValue(page({ id: 42, content: "Updated" }));

    const result = await tool.execute("call-write-2", {
      method: "PUT",
      path: "/buckets/100/todos/42.json",
      body: { content: "Updated", due_on: "2025-12-31" },
    });

    expect(mockClient.raw.PUT).toHaveBeenCalledWith("/buckets/100/todos/42.json", {
      body: { content: "Updated", due_on: "2025-12-31" },
    });
    expect(result.details).toEqual({ ok: true, data: { id: 42, content: "Updated" } });
  });

  it("deletes a resource with DELETE", async () => {
    mockClient.raw.DELETE.mockResolvedValue(page(undefined));

    const result = await tool.execute("call-write-3", {
      method: "DELETE",
      path: "/buckets/100/recordings/42/boost.json",
    });

    expect(mockClient.raw.DELETE).toHaveBeenCalledWith("/buckets/100/recordings/42/boost.json", {});
    expect(result.details).toEqual({ ok: true, data: undefined });
  });

  it("handles POST and PUT without a body", async () => {
    mockClient.raw.POST.mockResolvedValue(page(undefined));
    mockClient.raw.PUT.mockResolvedValue(page({}));

    await tool.execute("call-write-4", { method: "POST", path: "/buckets/100/todos/42/completion.json" });
    await tool.execute("call-write-5", { method: "PUT", path: "/buckets/100/some/path.json" });

    expect(mockClient.raw.POST).toHaveBeenCalledWith("/buckets/100/todos/42/completion.json", { body: undefined });
    expect(mockClient.raw.PUT).toHaveBeenCalledWith("/buckets/100/some/path.json", { body: undefined });
  });

  it.each([
    ["POST", "422 Unprocessable"],
    ["PUT", "404 Not Found"],
    ["DELETE", "403 Forbidden"],
  ] as const)("returns error on %s failure", async (method, message) => {
    mockClient.raw[method].mockRejectedValue(new Error(message));

    const result = await tool.execute("call-write-err", { method, path: "/buckets/100/todos/42.json", body: {} });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining(message) });
  });

  it("rejects a path not starting with / without calling the API", async () => {
    const result = await tool.execute("call-write-bad-1", {
      method: "POST",
      path: "--dangerous-flag",
      body: { content: "test" },
    });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("must start with '/'") });
    expect(mockClient.raw.POST).not.toHaveBeenCalled();
  });

  it("rejects a path with whitespace without calling the API", async () => {
    const result = await tool.execute("call-write-bad-2", {
      method: "PUT",
      path: "/buckets/100/todos/42.json\t--inject",
    });

    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("no whitespace") });
    expect(mockClient.raw.PUT).not.toHaveBeenCalled();
  });
});

describe("resolveToolScopeViolation", () => {
  const scoped = { accountId: "proj-a", scopedBucketId: "111" } as any;

  it("passes unscoped accounts and matching targets", () => {
    expect(resolveToolScopeViolation({ accountId: "ops" } as any, { bucketId: "222" })).toBeUndefined();
    expect(resolveToolScopeViolation(scoped, { bucketId: "111" })).toBeUndefined();
    expect(resolveToolScopeViolation(scoped, { path: "/buckets/111/todos/9.json" })).toBeUndefined();
    expect(resolveToolScopeViolation(scoped, {})).toBeUndefined();
  });

  it("rejects other buckets and out-of-scope API paths", () => {
    expect(resolveToolScopeViolation(scoped, { bucketId: "222" })).toContain("scoped to bucket 111");
    expect(resolveToolScopeViolation(scoped, { path: "/buckets/222/todos/9.json" })).toContain("scoped to bucket 111");
    expect(resolveToolScopeViolation(scoped, { path: "/projects.json" })).toContain("/buckets/111/");
  });
});

describe("scoped resource ownership verification", () => {
  const scopedCfg = cfgWithAccounts(
    { ops: { token: "tok-ops", personId: "9", basecampAccountId: "99" } },
    {
      virtualAccounts: { "proj-a": { accountId: "ops", bucketId: "111" } },
      personas: { "scoped-agent": "proj-a" },
    },
  );
  const ctx = () => toolCtx({ agentId: "scoped-agent", getRuntimeConfig: () => scopedCfg });
  const completeTool = () => buildBasecampTools(ctx()).find((t) => t.name === "basecamp_complete_todo")!;

  it("rejects a resource the scoped bucket does not own", async () => {
    mockClient.raw.GET.mockResolvedValue({ error: { code: "not_found" } });
    const result = await completeTool().execute("call-scope-1", { bucketId: "111", todoId: "777" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("todoId 777 does not belong");
    expect(mockClient.raw.GET).toHaveBeenCalledWith("/buckets/111/recordings/777/events.json", expect.anything());
    expect(mockClient.todos.complete).not.toHaveBeenCalled();
  });

  it("runs the tool when the resource belongs to the scoped bucket", async () => {
    mockClient.raw.GET.mockResolvedValue({ data: [] });
    mockClient.todos.complete.mockResolvedValue(undefined);
    const result = await completeTool().execute("call-scope-2", { bucketId: "111", todoId: "778" });
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
    expect(mockClient.todos.complete).toHaveBeenCalled();
  });
});
