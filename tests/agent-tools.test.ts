import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/bcq.js", () => ({
  bcqApiGet: vi.fn(),
  bcqApiPost: vi.fn(),
  bcqDelete: vi.fn(),
}));

vi.mock("../src/outbound/format.js", () => ({
  basecampHtmlToPlainText: vi.fn((html: string) => html.replace(/<[^>]+>/g, "")),
}));

import { basecampAgentTools } from "../src/adapters/agent-tools.js";
import { bcqApiGet, bcqApiPost, bcqDelete } from "../src/bcq.js";

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
  it("exports five tools", () => {
    expect(basecampAgentTools).toHaveLength(5);
  });

  it("has correct tool names", () => {
    const names = basecampAgentTools.map((t) => t.name);
    expect(names).toEqual([
      "basecamp_create_todo",
      "basecamp_complete_todo",
      "basecamp_reopen_todo",
      "basecamp_read_history",
      "basecamp_add_boost",
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
