import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/bcq.js", () => ({
  bcqApiPost: vi.fn(),
  bcqPut: vi.fn(),
  bcqDelete: vi.fn(),
}));

import { basecampAgentTools } from "../src/adapters/agent-tools.js";
import { bcqApiPost, bcqDelete } from "../src/bcq.js";

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
  it("exports three tools", () => {
    expect(basecampAgentTools).toHaveLength(3);
  });

  it("has correct tool names", () => {
    const names = basecampAgentTools.map((t) => t.name);
    expect(names).toEqual([
      "basecamp_create_todo",
      "basecamp_complete_todo",
      "basecamp_reopen_todo",
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
      "100",
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
      "100",
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
      undefined,
      "100",
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
      { accountId: "100" },
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
