import { beforeEach, describe, expect, it, vi } from "vitest";

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
  numId: (_label: string, value: string | number) => Number(value),
  rawOrThrow: vi.fn(async (r: any) => {
    if (r?.error) throw new Error("API error");
    return r?.data;
  }),
  BasecampError: class BasecampError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));

vi.mock("../src/config.js", () => ({
  resolveBasecampAccount: vi.fn(() => ({
    accountId: "test-acct",
    enabled: true,
    personId: "999",
    token: "tok-test",
    tokenSource: "config",
    config: { personId: "999", basecampAccountId: "99" },
  })),
}));

vi.mock("../src/outbound/format.js", async () => {
  const { stripHtml } = await vi.importActual<typeof import("../src/outbound/format.js")>("../src/outbound/format.js");
  return { basecampHtmlToPlainText: vi.fn((html: string) => stripHtml(html)) };
});

import { basecampAgentTools } from "../src/adapters/agent-tools.js";

const tools = basecampAgentTools({ cfg: { channels: { basecamp: { accounts: { "test-acct": {} } } } } });

beforeEach(() => {
  vi.clearAllMocks();
});

function findTool(name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe("basecampAgentTools", () => {
  it("exports ten tools", () => {
    expect(tools).toHaveLength(10);
  });

  it("has correct tool names", () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
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
    ]);
  });

  it("all tools have required fields", () => {
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.label).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeTruthy();
      expect(tool.execute).toBeTypeOf("function");
    }
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
    const parsed = JSON.parse(result.content[0].text);
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

  it("omits optional fields when not provided", async () => {
    mockClient.todos.create.mockResolvedValue({ id: 44 });

    await tool.execute("call-3", {
      bucketId: "100",
      todolistId: "200",
      content: "Simple todo",
    });

    const callArgs = mockClient.todos.create.mock.calls[0]!;
    const body = callArgs[1];
    expect(body.content).toBe("Simple todo");
    expect(body.description).toBeUndefined();
    expect(body.assigneeIds).toBeUndefined();
    expect(body.dueOn).toBeUndefined();
    expect(body.startsOn).toBeUndefined();
  });

  it("returns error on API failure", async () => {
    mockClient.todos.create.mockRejectedValue(new Error("403 Forbidden"));

    const result = await tool.execute("call-4", {
      bucketId: "100",
      todolistId: "200",
      content: "Fail",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("403 Forbidden");
    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("403 Forbidden") });
  });
});

// ---------------------------------------------------------------------------
// basecamp_complete_todo
// ---------------------------------------------------------------------------

describe("basecamp_complete_todo", () => {
  const tool = findTool("basecamp_complete_todo");

  it("calls complete on the client", async () => {
    mockClient.todos.complete.mockResolvedValue(undefined);

    const result = await tool.execute("call-5", {
      bucketId: "100",
      todoId: "300",
    });

    expect(mockClient.todos.complete).toHaveBeenCalledWith(300);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, todoId: "300" });
  });

  it("returns error on API failure", async () => {
    mockClient.todos.complete.mockRejectedValue(new Error("500 Server Error"));

    const result = await tool.execute("call-6", {
      bucketId: "100",
      todoId: "300",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("500 Server Error");
  });
});

// ---------------------------------------------------------------------------
// basecamp_reopen_todo
// ---------------------------------------------------------------------------

describe("basecamp_reopen_todo", () => {
  const tool = findTool("basecamp_reopen_todo");

  it("calls uncomplete on the client", async () => {
    mockClient.todos.uncomplete.mockResolvedValue(undefined);

    const result = await tool.execute("call-7", {
      bucketId: "100",
      todoId: "300",
    });

    expect(mockClient.todos.uncomplete).toHaveBeenCalledWith(300);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, todoId: "300" });
  });

  it("returns error on API failure", async () => {
    mockClient.todos.uncomplete.mockRejectedValue(new Error("404 Not Found"));

    const result = await tool.execute("call-8", {
      bucketId: "100",
      todoId: "300",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("404 Not Found");
  });
});

// ---------------------------------------------------------------------------
// basecamp_read_history
// ---------------------------------------------------------------------------

describe("basecamp_read_history", () => {
  const tool = findTool("basecamp_read_history");

  it("fetches campfire lines", async () => {
    mockClient.raw.GET.mockResolvedValue({
      data: [
        { id: 1, content: "<p>Hello</p>", created_at: "2025-01-01T10:00:00Z", creator: { id: 10, name: "Alice" } },
        { id: 2, content: "<p>World</p>", created_at: "2025-01-01T10:01:00Z", creator: { id: 20, name: "Bob" } },
      ],
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-9", {
      bucketId: "100",
      recordingId: "200",
      type: "campfire",
    });

    expect(mockClient.raw.GET).toHaveBeenCalledWith("/buckets/100/chats/200/lines.json", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(2);
    expect(parsed.messages).toEqual([
      { id: 1, sender: "Alice", senderId: 10, text: "Hello", timestamp: "2025-01-01T10:00:00Z" },
      { id: 2, sender: "Bob", senderId: 20, text: "World", timestamp: "2025-01-01T10:01:00Z" },
    ]);
  });

  it("fetches recording comments", async () => {
    mockClient.raw.GET.mockResolvedValue({
      data: [
        {
          id: 5,
          content: "<strong>Done</strong>",
          created_at: "2025-01-01T12:00:00Z",
          creator: { id: 30, name: "Charlie" },
        },
      ],
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-10", {
      bucketId: "100",
      recordingId: "300",
      type: "comments",
    });

    expect(mockClient.raw.GET).toHaveBeenCalledWith("/buckets/100/recordings/300/comments.json", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.messages[0].sender).toBe("Charlie");
    expect(parsed.messages[0].text).toBe("Done");
  });

  it("respects limit parameter", async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      content: `<p>Message ${i}</p>`,
      created_at: `2025-01-01T10:${String(i).padStart(2, "0")}:00Z`,
      creator: { id: 1, name: "Alice" },
    }));
    mockClient.raw.GET.mockResolvedValue({
      data: entries,
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-11", {
      bucketId: "100",
      recordingId: "200",
      type: "campfire",
      limit: 5,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(5);
    // Should return the last 5 entries (most recent)
    expect(parsed.messages[0].id).toBe(25);
    expect(parsed.messages[4].id).toBe(29);
  });

  it("caps limit at 50", async () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      id: i,
      content: `<p>M${i}</p>`,
      created_at: "2025-01-01T10:00:00Z",
      creator: { id: 1, name: "A" },
    }));
    mockClient.raw.GET.mockResolvedValue({
      data: entries,
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-12", {
      bucketId: "100",
      recordingId: "200",
      type: "campfire",
      limit: 100,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(50);
  });

  it("defaults to 20 entries when limit not specified", async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      content: `<p>M${i}</p>`,
      created_at: "2025-01-01T10:00:00Z",
      creator: { id: 1, name: "A" },
    }));
    mockClient.raw.GET.mockResolvedValue({
      data: entries,
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-13", {
      bucketId: "100",
      recordingId: "200",
      type: "campfire",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(20);
  });

  it("handles empty results", async () => {
    mockClient.raw.GET.mockResolvedValue({
      data: [],
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-14", {
      bucketId: "100",
      recordingId: "200",
      type: "comments",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(0);
    expect(parsed.messages).toEqual([]);
  });

  it("handles non-array response gracefully", async () => {
    mockClient.raw.GET.mockResolvedValue({
      data: null,
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-15", {
      bucketId: "100",
      recordingId: "200",
      type: "campfire",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(0);
  });

  it("returns error on API failure", async () => {
    mockClient.raw.GET.mockRejectedValue(new Error("503 Service Unavailable"));

    const result = await tool.execute("call-16", {
      bucketId: "100",
      recordingId: "200",
      type: "campfire",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("503 Service Unavailable");
  });

  it("handles entries with missing creator", async () => {
    mockClient.raw.GET.mockResolvedValue({
      data: [{ id: 1, content: "<p>No creator</p>", created_at: "2025-01-01T10:00:00Z" }],
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-17", {
      bucketId: "100",
      recordingId: "200",
      type: "comments",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.messages[0].sender).toBe("unknown");
    expect(parsed.messages[0].senderId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// basecamp_add_boost
// ---------------------------------------------------------------------------

describe("basecamp_add_boost", () => {
  const tool = findTool("basecamp_add_boost");

  it("boosts a recording with default content", async () => {
    mockClient.boosts.createForRecording.mockResolvedValue({ id: 99 });

    const result = await tool.execute("call-18", {
      bucketId: "100",
      recordingId: "500",
    });

    expect(mockClient.boosts.createForRecording).toHaveBeenCalledWith(500, { content: "👍" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, boostId: 99 });
    expect(result.details).toEqual({ ok: true, boostId: 99 });
  });

  it("boosts a recording with custom emoji", async () => {
    mockClient.boosts.createForRecording.mockResolvedValue({ id: 101 });

    const result = await tool.execute("call-19", {
      bucketId: "100",
      recordingId: "500",
      content: "🎉",
    });

    expect(mockClient.boosts.createForRecording).toHaveBeenCalledWith(500, { content: "🎉" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, boostId: 101 });
  });

  it("returns error on API failure", async () => {
    mockClient.boosts.createForRecording.mockRejectedValue(new Error("422 Unprocessable"));

    const result = await tool.execute("call-20", {
      bucketId: "100",
      recordingId: "500",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("422 Unprocessable");
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

    const result = await tool.execute("call-21", {
      bucketId: "100",
      cardId: "600",
      columnId: 700,
    });

    expect(mockClient.cards.move).toHaveBeenCalledWith(600, { columnId: 700 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, cardId: "600", columnId: 700 });
    expect(result.details).toEqual({ ok: true, cardId: "600", columnId: 700 });
  });

  it("returns error on API failure", async () => {
    mockClient.cards.move.mockRejectedValue(new Error("404 Not Found"));

    const result = await tool.execute("call-22", {
      bucketId: "100",
      cardId: "600",
      columnId: 700,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("404 Not Found");
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

    const result = await tool.execute("call-23", {
      bucketId: "100",
      messageBoardId: "200",
      subject: "Weekly Update",
    });

    expect(mockClient.messages.create).toHaveBeenCalledWith(200, {
      subject: "Weekly Update",
      content: undefined,
      categoryId: undefined,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, messageId: 800, subject: "Weekly Update" });
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

  it("omits optional fields when not provided", async () => {
    mockClient.messages.create.mockResolvedValue({ id: 802 });

    await tool.execute("call-25", {
      bucketId: "100",
      messageBoardId: "200",
      subject: "Simple",
    });

    const callArgs = mockClient.messages.create.mock.calls[0]!;
    const body = callArgs[1];
    expect(body.subject).toBe("Simple");
    expect(body.content).toBeUndefined();
    expect(body.categoryId).toBeUndefined();
  });

  it("returns error on API failure", async () => {
    mockClient.messages.create.mockRejectedValue(new Error("403 Forbidden"));

    const result = await tool.execute("call-26", {
      bucketId: "100",
      messageBoardId: "200",
      subject: "Fail",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("403 Forbidden");
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
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, answerId: 900 });
    expect(result.details).toEqual({ ok: true, answerId: 900 });
  });

  it("returns error on API failure", async () => {
    mockClient.checkins.createAnswer.mockRejectedValue(new Error("422 Unprocessable"));

    const result = await tool.execute("call-28", {
      bucketId: "100",
      questionId: "300",
      content: "Fail",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("422 Unprocessable");
    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("422 Unprocessable") });
  });
});

// ---------------------------------------------------------------------------
// basecamp_api_read
// ---------------------------------------------------------------------------

describe("basecamp_api_read", () => {
  const tool = findTool("basecamp_api_read");

  it("reads a resource by path", async () => {
    const todoData = { id: 42, content: "Buy milk", completed: false };
    mockClient.raw.GET.mockResolvedValue({
      data: todoData,
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-read-1", {
      path: "/buckets/100/todos/42.json",
    });

    expect(mockClient.raw.GET).toHaveBeenCalledWith("/buckets/100/todos/42.json", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, data: todoData });
    expect(result.details).toEqual({ ok: true, data: todoData });
  });

  it("appends query parameters", async () => {
    mockClient.raw.GET.mockResolvedValue({
      data: [],
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    await tool.execute("call-read-2", {
      path: "/buckets/100/todolists/200/todos.json",
      query: { completed: "true", page: "2" },
    });

    const calledPath = mockClient.raw.GET.mock.calls[0]![0];
    expect(calledPath).toContain("/buckets/100/todolists/200/todos.json?");
    expect(calledPath).toContain("completed=true");
    expect(calledPath).toContain("page=2");
  });

  it("reads project list", async () => {
    const projects = [
      { id: 1, name: "Project A" },
      { id: 2, name: "Project B" },
    ];
    mockClient.raw.GET.mockResolvedValue({
      data: projects,
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-read-3", {
      path: "/projects.json",
    });

    expect(mockClient.raw.GET).toHaveBeenCalledWith("/projects.json", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual(projects);
  });

  it("reads people list", async () => {
    mockClient.raw.GET.mockResolvedValue({
      data: [{ id: 10, name: "Alice" }],
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-read-4", {
      path: "/people.json",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveLength(1);
  });

  it("returns error on API failure", async () => {
    mockClient.raw.GET.mockRejectedValue(new Error("404 Not Found"));

    const result = await tool.execute("call-read-5", {
      path: "/buckets/999/todos/999.json",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("404 Not Found");
    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("404 Not Found") });
  });

  it("handles empty query params", async () => {
    mockClient.raw.GET.mockResolvedValue({
      data: {},
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    await tool.execute("call-read-6", {
      path: "/projects.json",
      query: {},
    });

    expect(mockClient.raw.GET).toHaveBeenCalledWith("/projects.json", {});
  });

  it("rejects path not starting with /", async () => {
    const result = await tool.execute("call-read-bad-1", {
      path: "-flag-injection",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("must start with '/'");
    expect(mockClient.raw.GET).not.toHaveBeenCalled();
  });

  it("rejects path with whitespace", async () => {
    const result = await tool.execute("call-read-bad-2", {
      path: "/buckets/100/todos.json --some-flag",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("no whitespace");
    expect(mockClient.raw.GET).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// basecamp_api_write
// ---------------------------------------------------------------------------

describe("basecamp_api_write", () => {
  const tool = findTool("basecamp_api_write");

  it("creates a resource with POST", async () => {
    mockClient.raw.POST.mockResolvedValue({
      data: { id: 50, content: "New todo" },
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-write-1", {
      method: "POST",
      path: "/buckets/100/todolists/200/todos.json",
      body: { content: "New todo" },
    });

    expect(mockClient.raw.POST).toHaveBeenCalledWith("/buckets/100/todolists/200/todos.json", {
      body: { content: "New todo" },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, data: { id: 50, content: "New todo" } });
  });

  it("updates a resource with PUT", async () => {
    mockClient.raw.PUT.mockResolvedValue({
      data: { id: 42, content: "Updated" },
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-write-2", {
      method: "PUT",
      path: "/buckets/100/todos/42.json",
      body: { content: "Updated", due_on: "2025-12-31" },
    });

    expect(mockClient.raw.PUT).toHaveBeenCalledWith("/buckets/100/todos/42.json", {
      body: { content: "Updated", due_on: "2025-12-31" },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("deletes a resource with DELETE", async () => {
    mockClient.raw.DELETE.mockResolvedValue({
      data: undefined,
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-write-3", {
      method: "DELETE",
      path: "/buckets/100/recordings/42/boost.json",
    });

    expect(mockClient.raw.DELETE).toHaveBeenCalledWith("/buckets/100/recordings/42/boost.json", {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("handles POST without body", async () => {
    mockClient.raw.POST.mockResolvedValue({
      data: undefined,
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    const result = await tool.execute("call-write-4", {
      method: "POST",
      path: "/buckets/100/todos/42/completion.json",
    });

    expect(mockClient.raw.POST).toHaveBeenCalledWith("/buckets/100/todos/42/completion.json", { body: undefined });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("handles PUT without body", async () => {
    mockClient.raw.PUT.mockResolvedValue({
      data: {},
      error: undefined,
      response: { ok: true, headers: new Headers() },
    });

    await tool.execute("call-write-5", {
      method: "PUT",
      path: "/buckets/100/some/path.json",
    });

    expect(mockClient.raw.PUT).toHaveBeenCalledWith("/buckets/100/some/path.json", { body: undefined });
  });

  it("returns error on POST failure", async () => {
    mockClient.raw.POST.mockRejectedValue(new Error("422 Unprocessable"));

    const result = await tool.execute("call-write-6", {
      method: "POST",
      path: "/buckets/100/todolists/200/todos.json",
      body: { content: "" },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("422 Unprocessable");
  });

  it("returns error on PUT failure", async () => {
    mockClient.raw.PUT.mockRejectedValue(new Error("404 Not Found"));

    const result = await tool.execute("call-write-7", {
      method: "PUT",
      path: "/buckets/999/todos/999.json",
      body: { content: "nope" },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("404 Not Found");
  });

  it("returns error on DELETE failure", async () => {
    mockClient.raw.DELETE.mockRejectedValue(new Error("403 Forbidden"));

    const result = await tool.execute("call-write-8", {
      method: "DELETE",
      path: "/buckets/100/recordings/42.json",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("403 Forbidden");
  });

  it("rejects path not starting with /", async () => {
    const result = await tool.execute("call-write-bad-1", {
      method: "POST",
      path: "--dangerous-flag",
      body: { content: "test" },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("must start with '/'");
    expect(mockClient.raw.POST).not.toHaveBeenCalled();
  });

  it("rejects path with whitespace", async () => {
    const result = await tool.execute("call-write-bad-2", {
      method: "PUT",
      path: "/buckets/100/todos/42.json\t--inject",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("no whitespace");
    expect(mockClient.raw.PUT).not.toHaveBeenCalled();
  });
});
