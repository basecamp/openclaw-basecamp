import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/bcq.js", () => ({
  bcqApiGet: vi.fn(),
  bcqApiPost: vi.fn(),
  bcqPut: vi.fn(),
  bcqDelete: vi.fn(),
}));

vi.mock("../src/outbound/format.js", () => ({
  basecampHtmlToPlainText: vi.fn((html: string) => html.replace(/<[^>]+>/g, "")),
}));

import { basecampAgentTools } from "../src/adapters/agent-tools.js";
import { bcqApiGet, bcqApiPost, bcqPut, bcqDelete } from "../src/bcq.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function findTool(name: string) {
  const tool = basecampAgentTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe("basecampAgentTools", () => {
  it("exports ten tools", () => {
    expect(basecampAgentTools).toHaveLength(10);
  });

  it("has correct tool names", () => {
    const names = basecampAgentTools.map((t) => t.name);
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
    for (const tool of basecampAgentTools) {
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
    vi.mocked(bcqApiPost).mockResolvedValue({ id: 42, title: "Buy milk" });

    const result = await tool.execute("call-1", {
      bucketId: "100",
      todolistId: "200",
      content: "Buy milk",
    });

    expect(bcqApiPost).toHaveBeenCalledWith(
      "/buckets/100/todolists/200/todos.json",
      JSON.stringify({ content: "Buy milk" }),
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, todoId: 42, title: "Buy milk" });
    expect(result.details).toEqual({ ok: true, todoId: 42 });
  });

  it("creates a todo with all optional params", async () => {
    vi.mocked(bcqApiPost).mockResolvedValue({ id: 43 });

    await tool.execute("call-2", {
      bucketId: "100",
      todolistId: "200",
      content: "Review PR",
      description: "<p>Check edge cases</p>",
      assigneeIds: [10, 20],
      dueOn: "2025-03-01",
      startsOn: "2025-02-15",
    });

    expect(bcqApiPost).toHaveBeenCalledWith(
      "/buckets/100/todolists/200/todos.json",
      JSON.stringify({
        content: "Review PR",
        description: "<p>Check edge cases</p>",
        assignee_ids: [10, 20],
        due_on: "2025-03-01",
        starts_on: "2025-02-15",
      }),
    );
  });

  it("omits optional fields when not provided", async () => {
    vi.mocked(bcqApiPost).mockResolvedValue({ id: 44 });

    await tool.execute("call-3", {
      bucketId: "100",
      todolistId: "200",
      content: "Simple todo",
    });

    const bodyArg = vi.mocked(bcqApiPost).mock.calls[0]![1];
    const body = JSON.parse(bodyArg!);
    expect(body).toEqual({ content: "Simple todo" });
    expect(body).not.toHaveProperty("description");
    expect(body).not.toHaveProperty("assignee_ids");
    expect(body).not.toHaveProperty("due_on");
    expect(body).not.toHaveProperty("starts_on");
  });

  it("returns error on API failure", async () => {
    vi.mocked(bcqApiPost).mockRejectedValue(new Error("403 Forbidden"));

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

  it("posts to completion endpoint", async () => {
    vi.mocked(bcqApiPost).mockResolvedValue(undefined);

    const result = await tool.execute("call-5", {
      bucketId: "100",
      todoId: "300",
    });

    expect(bcqApiPost).toHaveBeenCalledWith(
      "/buckets/100/todos/300/completion.json",
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, todoId: "300" });
  });

  it("returns error on API failure", async () => {
    vi.mocked(bcqApiPost).mockRejectedValue(new Error("500 Server Error"));

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

  it("deletes completion endpoint to reopen", async () => {
    vi.mocked(bcqDelete).mockResolvedValue({ data: undefined, raw: "" });

    const result = await tool.execute("call-7", {
      bucketId: "100",
      todoId: "300",
    });

    expect(bcqDelete).toHaveBeenCalledWith(
      "/buckets/100/todos/300/completion.json",
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, todoId: "300" });
  });

  it("returns error on API failure", async () => {
    vi.mocked(bcqDelete).mockRejectedValue(new Error("404 Not Found"));

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
    vi.mocked(bcqApiGet).mockResolvedValue([
      { id: 1, content: "<p>Hello</p>", created_at: "2025-01-01T10:00:00Z", creator: { id: 10, name: "Alice" } },
      { id: 2, content: "<p>World</p>", created_at: "2025-01-01T10:01:00Z", creator: { id: 20, name: "Bob" } },
    ]);

    const result = await tool.execute("call-9", {
      bucketId: "100",
      recordingId: "200",
      type: "campfire",
    });

    expect(bcqApiGet).toHaveBeenCalledWith(
      "/buckets/100/chats/200/lines.json",
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(2);
    expect(parsed.messages).toEqual([
      { id: 1, sender: "Alice", senderId: 10, text: "Hello", timestamp: "2025-01-01T10:00:00Z" },
      { id: 2, sender: "Bob", senderId: 20, text: "World", timestamp: "2025-01-01T10:01:00Z" },
    ]);
  });

  it("fetches recording comments", async () => {
    vi.mocked(bcqApiGet).mockResolvedValue([
      { id: 5, content: "<strong>Done</strong>", created_at: "2025-01-01T12:00:00Z", creator: { id: 30, name: "Charlie" } },
    ]);

    const result = await tool.execute("call-10", {
      bucketId: "100",
      recordingId: "300",
      type: "comments",
    });

    expect(bcqApiGet).toHaveBeenCalledWith(
      "/buckets/100/recordings/300/comments.json",
    );
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
    vi.mocked(bcqApiGet).mockResolvedValue(entries);

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
    vi.mocked(bcqApiGet).mockResolvedValue(entries);

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
    vi.mocked(bcqApiGet).mockResolvedValue(entries);

    const result = await tool.execute("call-13", {
      bucketId: "100",
      recordingId: "200",
      type: "campfire",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(20);
  });

  it("handles empty results", async () => {
    vi.mocked(bcqApiGet).mockResolvedValue([]);

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
    vi.mocked(bcqApiGet).mockResolvedValue(null);

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
    vi.mocked(bcqApiGet).mockRejectedValue(new Error("503 Service Unavailable"));

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
    vi.mocked(bcqApiGet).mockResolvedValue([
      { id: 1, content: "<p>No creator</p>", created_at: "2025-01-01T10:00:00Z" },
    ]);

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
    vi.mocked(bcqApiPost).mockResolvedValue({ id: 99 });

    const result = await tool.execute("call-18", {
      bucketId: "100",
      recordingId: "500",
    });

    expect(bcqApiPost).toHaveBeenCalledWith(
      "/buckets/100/recordings/500/boosts.json",
      JSON.stringify({ content: "👍" }),
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, boostId: 99 });
    expect(result.details).toEqual({ ok: true, boostId: 99 });
  });

  it("boosts a recording with custom emoji", async () => {
    vi.mocked(bcqApiPost).mockResolvedValue({ id: 101 });

    const result = await tool.execute("call-19", {
      bucketId: "100",
      recordingId: "500",
      content: "🎉",
    });

    expect(bcqApiPost).toHaveBeenCalledWith(
      "/buckets/100/recordings/500/boosts.json",
      JSON.stringify({ content: "🎉" }),
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, boostId: 101 });
  });

  it("returns error on API failure", async () => {
    vi.mocked(bcqApiPost).mockRejectedValue(new Error("422 Unprocessable"));

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
    vi.mocked(bcqPut).mockResolvedValue({ data: { id: 1 }, raw: "" });

    const result = await tool.execute("call-21", {
      bucketId: "100",
      cardId: "600",
      columnId: 700,
    });

    expect(bcqPut).toHaveBeenCalledWith(
      "/buckets/100/card_tables/cards/600/moves.json",
      { extraFlags: ["-d", JSON.stringify({ column_id: 700 })] },
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, cardId: "600", columnId: 700 });
    expect(result.details).toEqual({ ok: true, cardId: "600", columnId: 700 });
  });

  it("returns error on API failure", async () => {
    vi.mocked(bcqPut).mockRejectedValue(new Error("404 Not Found"));

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
    vi.mocked(bcqApiPost).mockResolvedValue({ id: 800, subject: "Weekly Update" });

    const result = await tool.execute("call-23", {
      bucketId: "100",
      messageBoardId: "200",
      subject: "Weekly Update",
    });

    expect(bcqApiPost).toHaveBeenCalledWith(
      "/buckets/100/message_boards/200/messages.json",
      JSON.stringify({ subject: "Weekly Update" }),
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, messageId: 800, subject: "Weekly Update" });
    expect(result.details).toEqual({ ok: true, messageId: 800 });
  });

  it("posts a message with content and category", async () => {
    vi.mocked(bcqApiPost).mockResolvedValue({ id: 801, subject: "Announcement" });

    await tool.execute("call-24", {
      bucketId: "100",
      messageBoardId: "200",
      subject: "Announcement",
      content: "<p>Big news!</p>",
      categoryId: 5,
    });

    expect(bcqApiPost).toHaveBeenCalledWith(
      "/buckets/100/message_boards/200/messages.json",
      JSON.stringify({ subject: "Announcement", content: "<p>Big news!</p>", category_id: 5 }),
    );
  });

  it("omits optional fields when not provided", async () => {
    vi.mocked(bcqApiPost).mockResolvedValue({ id: 802 });

    await tool.execute("call-25", {
      bucketId: "100",
      messageBoardId: "200",
      subject: "Simple",
    });

    const bodyArg = vi.mocked(bcqApiPost).mock.calls[0]![1];
    const body = JSON.parse(bodyArg!);
    expect(body).toEqual({ subject: "Simple" });
    expect(body).not.toHaveProperty("content");
    expect(body).not.toHaveProperty("category_id");
  });

  it("returns error on API failure", async () => {
    vi.mocked(bcqApiPost).mockRejectedValue(new Error("403 Forbidden"));

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
    vi.mocked(bcqApiPost).mockResolvedValue({ id: 900 });

    const result = await tool.execute("call-27", {
      bucketId: "100",
      questionId: "300",
      content: "Everything is on track!",
    });

    expect(bcqApiPost).toHaveBeenCalledWith(
      "/buckets/100/questions/300/answers.json",
      JSON.stringify({ content: "Everything is on track!" }),
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, answerId: 900 });
    expect(result.details).toEqual({ ok: true, answerId: 900 });
  });

  it("returns error on API failure", async () => {
    vi.mocked(bcqApiPost).mockRejectedValue(new Error("422 Unprocessable"));

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
    vi.mocked(bcqApiGet).mockResolvedValue(todoData);

    const result = await tool.execute("call-read-1", {
      path: "/buckets/100/todos/42.json",
    });

    expect(bcqApiGet).toHaveBeenCalledWith("/buckets/100/todos/42.json");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, data: todoData });
    expect(result.details).toEqual({ ok: true });
  });

  it("appends query parameters", async () => {
    vi.mocked(bcqApiGet).mockResolvedValue([]);

    await tool.execute("call-read-2", {
      path: "/buckets/100/todolists/200/todos.json",
      query: { completed: "true", page: "2" },
    });

    const calledPath = vi.mocked(bcqApiGet).mock.calls[0]![0];
    expect(calledPath).toContain("/buckets/100/todolists/200/todos.json?");
    expect(calledPath).toContain("completed=true");
    expect(calledPath).toContain("page=2");
  });

  it("reads project list", async () => {
    const projects = [{ id: 1, name: "Project A" }, { id: 2, name: "Project B" }];
    vi.mocked(bcqApiGet).mockResolvedValue(projects);

    const result = await tool.execute("call-read-3", {
      path: "/projects.json",
    });

    expect(bcqApiGet).toHaveBeenCalledWith("/projects.json");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual(projects);
  });

  it("reads people list", async () => {
    vi.mocked(bcqApiGet).mockResolvedValue([{ id: 10, name: "Alice" }]);

    const result = await tool.execute("call-read-4", {
      path: "/people.json",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveLength(1);
  });

  it("returns error on API failure", async () => {
    vi.mocked(bcqApiGet).mockRejectedValue(new Error("404 Not Found"));

    const result = await tool.execute("call-read-5", {
      path: "/buckets/999/todos/999.json",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("404 Not Found");
    expect(result.details).toEqual({ ok: false, error: expect.stringContaining("404 Not Found") });
  });

  it("handles empty query params", async () => {
    vi.mocked(bcqApiGet).mockResolvedValue({});

    await tool.execute("call-read-6", {
      path: "/projects.json",
      query: {},
    });

    expect(bcqApiGet).toHaveBeenCalledWith("/projects.json");
  });
});

// ---------------------------------------------------------------------------
// basecamp_api_write
// ---------------------------------------------------------------------------

describe("basecamp_api_write", () => {
  const tool = findTool("basecamp_api_write");

  it("creates a resource with POST", async () => {
    vi.mocked(bcqApiPost).mockResolvedValue({ id: 50, content: "New todo" });

    const result = await tool.execute("call-write-1", {
      method: "POST",
      path: "/buckets/100/todolists/200/todos.json",
      body: { content: "New todo" },
    });

    expect(bcqApiPost).toHaveBeenCalledWith(
      "/buckets/100/todolists/200/todos.json",
      JSON.stringify({ content: "New todo" }),
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true, data: { id: 50, content: "New todo" } });
  });

  it("updates a resource with PUT", async () => {
    vi.mocked(bcqPut).mockResolvedValue({ data: { id: 42, content: "Updated" }, raw: "" });

    const result = await tool.execute("call-write-2", {
      method: "PUT",
      path: "/buckets/100/todos/42.json",
      body: { content: "Updated", due_on: "2025-12-31" },
    });

    expect(bcqPut).toHaveBeenCalledWith(
      "/buckets/100/todos/42.json",
      { extraFlags: ["-d", JSON.stringify({ content: "Updated", due_on: "2025-12-31" })] },
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("deletes a resource with DELETE", async () => {
    vi.mocked(bcqDelete).mockResolvedValue({ data: undefined, raw: "" });

    const result = await tool.execute("call-write-3", {
      method: "DELETE",
      path: "/buckets/100/recordings/42/boost.json",
    });

    expect(bcqDelete).toHaveBeenCalledWith("/buckets/100/recordings/42/boost.json");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("handles POST without body", async () => {
    vi.mocked(bcqApiPost).mockResolvedValue(undefined);

    const result = await tool.execute("call-write-4", {
      method: "POST",
      path: "/buckets/100/todos/42/completion.json",
    });

    expect(bcqApiPost).toHaveBeenCalledWith(
      "/buckets/100/todos/42/completion.json",
      undefined,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("handles PUT without body", async () => {
    vi.mocked(bcqPut).mockResolvedValue({ data: {}, raw: "" });

    await tool.execute("call-write-5", {
      method: "PUT",
      path: "/buckets/100/some/path.json",
    });

    expect(bcqPut).toHaveBeenCalledWith("/buckets/100/some/path.json", {});
  });

  it("returns error on POST failure", async () => {
    vi.mocked(bcqApiPost).mockRejectedValue(new Error("422 Unprocessable"));

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
    vi.mocked(bcqPut).mockRejectedValue(new Error("404 Not Found"));

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
    vi.mocked(bcqDelete).mockRejectedValue(new Error("403 Forbidden"));

    const result = await tool.execute("call-write-8", {
      method: "DELETE",
      path: "/buckets/100/recordings/42.json",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("403 Forbidden");
  });
});
