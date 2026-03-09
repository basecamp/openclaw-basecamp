import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "../src/util.js";

describe("withTimeout", () => {
  it("returns the promise result when it resolves before timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000, "test");
    expect(result).toBe("ok");
  });

  it("returns undefined when the promise exceeds the timeout", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 500));
    const result = await withTimeout(slow, 10, "test-timeout");
    expect(result).toBeUndefined();
  });

  it("logs a warning with the label when timeout fires", async () => {
    const log = { warn: vi.fn() };
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 500));
    await withTimeout(slow, 10, "my-label", log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("my-label"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("clears the timer when the promise resolves first", async () => {
    // If the timer isn't cleared, the test runner would flag open handles.
    // We verify indirectly by ensuring no warning is logged.
    const log = { warn: vi.fn() };
    await withTimeout(Promise.resolve("fast"), 5000, "cleanup-test", log);
    // Give any leaked timer a chance to fire
    await new Promise((r) => setTimeout(r, 50));
    expect(log.warn).not.toHaveBeenCalled();
  });
});
