/**
 * Error scenario tests for bcq failure paths.
 *
 * Mocks node:child_process to simulate various bcq failure modes
 * (timeout, invalid JSON, auth failure, empty output, network errors).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { bcqGet, bcqMe, bcqTimeline, bcqAuthStatus, BcqError } from "../src/bcq.js";
import { execFile } from "node:child_process";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// BcqError class
// ---------------------------------------------------------------------------

describe("BcqError", () => {
  it("has correct name, message, exitCode, stderr, command", () => {
    const err = new BcqError("test error", 42, "stderr output", ["bcq", "me"]);
    expect(err.name).toBe("BcqError");
    expect(err.message).toBe("test error");
    expect(err.exitCode).toBe(42);
    expect(err.stderr).toBe("stderr output");
    expect(err.command).toEqual(["bcq", "me"]);
    expect(err).toBeInstanceOf(Error);
  });

  it("accepts null exitCode for non-process errors", () => {
    const err = new BcqError("parse error", null, "", []);
    expect(err.exitCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bcqGet error paths
// ---------------------------------------------------------------------------

describe("bcqGet error scenarios", () => {
  it("throws BcqError on timeout (killed process)", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("Command timed out") as any;
      err.killed = true;
      err.code = null;
      cb(err, "", "");
      return {} as any;
    });

    await expect(bcqGet("/test.json")).rejects.toThrow(BcqError);
    await expect(bcqGet("/test.json")).rejects.toThrow(/timed out/i);
  });

  it("throws BcqError on invalid JSON output", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, "not valid json{{{", "");
      return {} as any;
    });

    await expect(bcqGet("/test.json")).rejects.toThrow(BcqError);
    await expect(bcqGet("/test.json")).rejects.toThrow(/not valid JSON/i);
  });

  it("throws BcqError with correct properties on auth failure", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("exit code 1") as any;
      err.code = 1;
      cb(err, "", "HTTP 401 Unauthorized");
      return {} as any;
    });

    try {
      await bcqGet("/test.json");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BcqError);
      const bcqErr = err as BcqError;
      expect(bcqErr.exitCode).toBe(1);
      expect(bcqErr.stderr).toContain("401");
    }
  });

  it("returns empty array for empty stdout", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, "", "");
      return {} as any;
    });

    const result = await bcqGet("/test.json");
    expect(result.data).toEqual([]);
  });

  it("returns empty array for whitespace-only stdout", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, "   \n  ", "");
      return {} as any;
    });

    const result = await bcqGet("/test.json");
    expect(result.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// bcqAuthStatus failure paths
// ---------------------------------------------------------------------------

describe("bcqAuthStatus error scenarios", () => {
  it("returns authenticated=false on BcqError", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("not authenticated") as any;
      err.code = 1;
      cb(err, "", "Not authenticated");
      return {} as any;
    });

    const result = await bcqAuthStatus();
    expect(result.data.authenticated).toBe(false);
  });

  it("returns authenticated=false when response lacks authenticated field", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, JSON.stringify({ status: "unknown" }), "");
      return {} as any;
    });

    const result = await bcqAuthStatus();
    expect(result.data.authenticated).toBe(false);
  });

  it("returns authenticated=true when response has authenticated=true", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, JSON.stringify({ authenticated: true }), "");
      return {} as any;
    });

    const result = await bcqAuthStatus();
    expect(result.data.authenticated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bcqMe failure paths
// ---------------------------------------------------------------------------

describe("bcqMe error scenarios", () => {
  it("throws BcqError on network error", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("ECONNREFUSED") as any;
      err.code = null;
      cb(err, "", "ECONNREFUSED");
      return {} as any;
    });

    await expect(bcqMe()).rejects.toThrow(BcqError);
  });

  it("throws BcqError with stderr on process failure", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("process failed") as any;
      err.code = 2;
      cb(err, "", "bcq: command not found");
      return {} as any;
    });

    try {
      await bcqMe();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BcqError);
      const bcqErr = err as BcqError;
      expect(bcqErr.exitCode).toBe(2);
      expect(bcqErr.stderr).toContain("command not found");
    }
  });
});

// ---------------------------------------------------------------------------
// bcqTimeline with unexpected but valid JSON
// ---------------------------------------------------------------------------

describe("bcqTimeline error scenarios", () => {
  it("handles unexpected but valid JSON shape", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, JSON.stringify({ unexpected: true }), "");
      return {} as any;
    });

    const result = await bcqTimeline();
    expect(result.data).toEqual({ unexpected: true });
  });

  it("handles valid JSON array", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, JSON.stringify([{ id: 1 }, { id: 2 }]), "");
      return {} as any;
    });

    const result = await bcqTimeline<any[]>();
    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe(1);
  });
});
