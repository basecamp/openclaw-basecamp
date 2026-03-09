import { describe, expect, it } from "vitest";
import { BasecampError } from "../src/basecamp-client.js";
import { classifyDispatchError } from "../src/dispatch.js";

describe("classifyDispatchError", () => {
  // --- BasecampError structured codes ---

  it("auth_required → auth", () => {
    expect(classifyDispatchError(new BasecampError("auth_required", "auth required"))).toBe("auth");
  });

  it("forbidden → auth", () => {
    expect(classifyDispatchError(new BasecampError("forbidden", "forbidden"))).toBe("auth");
  });

  it("rate_limit → rate_limit", () => {
    expect(classifyDispatchError(new BasecampError("rate_limit", "slow down"))).toBe("rate_limit");
  });

  it("network → network", () => {
    expect(classifyDispatchError(new BasecampError("network", "offline"))).toBe("network");
  });

  it("not_found → not_found", () => {
    expect(classifyDispatchError(new BasecampError("not_found", "gone"))).toBe("not_found");
  });

  it("unknown BasecampError code passes through", () => {
    expect(classifyDispatchError(new BasecampError("api_error", "oops"))).toBe("api_error");
  });

  // --- HTTP status fallbacks ---

  it("status 401 → auth", () => {
    expect(classifyDispatchError({ message: "fail", status: 401 })).toBe("auth");
  });

  it("status 403 → auth", () => {
    expect(classifyDispatchError({ message: "fail", status: 403 })).toBe("auth");
  });

  it("statusCode 403 → auth", () => {
    expect(classifyDispatchError({ message: "fail", statusCode: 403 })).toBe("auth");
  });

  // --- Message-based heuristics ---

  it("unauthorized in message → auth", () => {
    expect(classifyDispatchError(new Error("Request unauthorized"))).toBe("auth");
  });

  it("ETIMEDOUT code → network", () => {
    const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    expect(classifyDispatchError(err)).toBe("network");
  });

  it("ECONNREFUSED code → network", () => {
    const err = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    expect(classifyDispatchError(err)).toBe("network");
  });

  it("ECONNRESET code → network", () => {
    const err = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    expect(classifyDispatchError(err)).toBe("network");
  });

  it("timeout in message → network", () => {
    expect(classifyDispatchError(new Error("request timeout after 30s"))).toBe("network");
  });

  it("fetch in message → network", () => {
    expect(classifyDispatchError(new Error("fetch failed"))).toBe("network");
  });

  it("no route in message → routing", () => {
    expect(classifyDispatchError(new Error("no route found for peer"))).toBe("routing");
  });

  it("unrecognized error → unknown", () => {
    expect(classifyDispatchError(new Error("something weird happened"))).toBe("unknown");
  });

  it("non-Error value → unknown", () => {
    expect(classifyDispatchError("just a string")).toBe("unknown");
  });

  it("null → unknown", () => {
    expect(classifyDispatchError(null)).toBe("unknown");
  });
});
