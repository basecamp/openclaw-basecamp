/**
 * Error scenario tests for Basecamp CLI failure paths.
 *
 * Mocks node:child_process to simulate various CLI failure modes
 * (timeout, invalid JSON, auth failure, empty output, network errors).
 *
 * Only auth-related functions remain in basecamp-cli.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { cliMe, cliAuthStatus, bcqWhich, bcqProfileList, execBcqAuthLogin, CliError } from "../src/basecamp-cli.js";
import { execFile, spawn } from "node:child_process";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// CliError class
// ---------------------------------------------------------------------------

describe("CliError", () => {
  it("has correct name, message, exitCode, stderr, command", () => {
    const err = new CliError("test error", 42, "stderr output", ["basecamp", "me"]);
    expect(err.name).toBe("CliError");
    expect(err.message).toBe("test error");
    expect(err.exitCode).toBe(42);
    expect(err.stderr).toBe("stderr output");
    expect(err.command).toEqual(["basecamp", "me"]);
    expect(err).toBeInstanceOf(Error);
  });

  it("accepts null exitCode for non-process errors", () => {
    const err = new CliError("parse error", null, "", []);
    expect(err.exitCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cliAuthStatus failure paths
// ---------------------------------------------------------------------------

describe("cliAuthStatus error scenarios", () => {
  it("returns authenticated=false on CliError", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("not authenticated") as any;
      err.code = 1;
      cb(err, "", "Not authenticated");
      return {} as any;
    });

    const result = await cliAuthStatus();
    expect(result.data.authenticated).toBe(false);
  });

  it("returns authenticated=false when response lacks authenticated field", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, JSON.stringify({ status: "unknown" }), "");
      return {} as any;
    });

    const result = await cliAuthStatus();
    expect(result.data.authenticated).toBe(false);
  });

  it("returns authenticated=true when response has authenticated=true", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, JSON.stringify({ authenticated: true }), "");
      return {} as any;
    });

    const result = await cliAuthStatus();
    expect(result.data.authenticated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cliMe failure paths
// ---------------------------------------------------------------------------

describe("cliMe error scenarios", () => {
  it("throws CliError on network error", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("ECONNREFUSED") as any;
      err.code = null;
      cb(err, "", "ECONNREFUSED");
      return {} as any;
    });

    await expect(cliMe()).rejects.toThrow(CliError);
  });

  it("throws CliError with stderr on process failure", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("process failed") as any;
      err.code = 2;
      cb(err, "", "basecamp: command not found");
      return {} as any;
    });

    try {
      await cliMe();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.exitCode).toBe(2);
      expect(cliErr.stderr).toContain("command not found");
    }
  });
});

// ---------------------------------------------------------------------------
// ENOENT fallback in execCliWithFallback
// ---------------------------------------------------------------------------

describe("execCliWithFallback ENOENT fallback", () => {
  let savedBcqBin: string | undefined;
  let savedBasecampBin: string | undefined;

  beforeEach(() => {
    savedBcqBin = process.env.BCQ_BIN;
    savedBasecampBin = process.env.BASECAMP_BIN;
  });

  afterEach(() => {
    if (savedBcqBin === undefined) delete process.env.BCQ_BIN;
    else process.env.BCQ_BIN = savedBcqBin;
    if (savedBasecampBin === undefined) delete process.env.BASECAMP_BIN;
    else process.env.BASECAMP_BIN = savedBasecampBin;
  });

  it("retries with bcq fallback when primary binary returns ENOENT", async () => {
    let callCount = 0;
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("not found") as any;
        err.code = "ENOENT";
        cb(err, "", "");
      } else {
        cb(null, JSON.stringify({ id: 1, name: "Test", email_address: "t@t.com" }), "");
      }
      return {} as any;
    });

    const result = await bcqMe();
    expect(callCount).toBe(2);
    expect(result.data.id).toBe(1);
    // Second call should use fallback binary "bcq"
    const secondCall = vi.mocked(execFile).mock.calls[1];
    expect(secondCall[0]).toBe("bcq");
  });

  it("uses BCQ_BIN env override for fallback binary", async () => {
    process.env.BCQ_BIN = "/custom/bcq-bin";
    let callCount = 0;
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("not found") as any;
        err.code = "ENOENT";
        cb(err, "", "");
      } else {
        cb(null, JSON.stringify({ id: 2, name: "Custom", email_address: "c@c.com" }), "");
      }
      return {} as any;
    });

    const result = await bcqMe();
    expect(callCount).toBe(2);
    expect(result.data.id).toBe(2);
    const secondCall = vi.mocked(execFile).mock.calls[1];
    expect(secondCall[0]).toBe("/custom/bcq-bin");
  });

  it("propagates BcqError when both primary and fallback fail", async () => {
    let callCount = 0;
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("not found") as any;
        err.code = "ENOENT";
        cb(err, "", "");
      } else {
        const err = new Error("fallback failed") as any;
        err.code = 1;
        cb(err, "", "fallback also missing");
      }
      return {} as any;
    });

    await expect(bcqMe()).rejects.toThrow(BcqError);
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// execBcq flag building
// ---------------------------------------------------------------------------

describe("execBcq flag building", () => {
  beforeEach(() => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, JSON.stringify({ id: 1, name: "Test", email_address: "t@t.com" }), "");
      return {} as any;
    });
  });

  it("includes --account flag when accountId is set", async () => {
    await bcqMe({ accountId: "123" });
    const args = vi.mocked(execFile).mock.calls[0][1] as string[];
    expect(args).toContain("--account");
    expect(args).toContain("123");
    const accountIdx = args.indexOf("--account");
    expect(args[accountIdx + 1]).toBe("123");
  });

  it("includes --profile flag when profile is set", async () => {
    await bcqMe({ profile: "work" });
    const args = vi.mocked(execFile).mock.calls[0][1] as string[];
    expect(args).toContain("--profile");
    expect(args).toContain("work");
    const profileIdx = args.indexOf("--profile");
    expect(args[profileIdx + 1]).toBe("work");
  });

  it("appends extraFlags", async () => {
    await bcqMe({ extraFlags: ["--verbose"] });
    const args = vi.mocked(execFile).mock.calls[0][1] as string[];
    expect(args).toContain("--verbose");
  });
});

// ---------------------------------------------------------------------------
// execBcq error shapes
// ---------------------------------------------------------------------------

describe("execBcq error shapes", () => {
  it("reports 'timed out' when killed=true", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("Command failed: basecamp --agent me") as any;
      err.killed = true;
      err.code = null;
      cb(err, "", "");
      return {} as any;
    });

    try {
      await bcqMe();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BcqError);
      expect((err as BcqError).message).toContain("timed out");
    }
  });

  it("reports 'killed by SIGTERM' when signal is present", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("Command failed: basecamp --agent me") as any;
      err.killed = false;
      err.signal = "SIGTERM";
      err.code = null;
      cb(err, "", "");
      return {} as any;
    });

    try {
      await bcqMe();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BcqError);
      expect((err as BcqError).message).toContain("killed by SIGTERM");
    }
  });

  it("uses error.status as exitCode fallback", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("process exited") as any;
      err.status = 2;
      cb(err, "", "some stderr");
      return {} as any;
    });

    try {
      await bcqMe();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BcqError);
      expect((err as BcqError).exitCode).toBe(2);
    }
  });

  it("returns empty array when stdout is empty", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, "", "");
      return {} as any;
    });

    const result = await bcqMe();
    expect(result.data).toEqual([]);
    expect(result.raw).toBe("");
  });

  it("throws BcqError on JSON parse failure", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, 'not json {', "");
      return {} as any;
    });

    try {
      await bcqMe();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BcqError);
      expect((err as BcqError).message).toContain("not valid JSON");
    }
  });
});

// ---------------------------------------------------------------------------
// bcqWhich
// ---------------------------------------------------------------------------

describe("bcqWhich", () => {
  it("returns the binary path on success", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, "basecamp v1.2.3", "");
      return {} as any;
    });

    const result = await bcqWhich();
    expect(result.data.path).toBe("basecamp");
    expect(result.raw).toBe("basecamp v1.2.3");
  });

  it("throws BcqError on failure", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("not found") as any;
      err.code = 127;
      cb(err, "", "command not found");
      return {} as any;
    });

    await expect(bcqWhich()).rejects.toThrow(BcqError);
  });

  it("falls back to bcq on ENOENT", async () => {
    let callCount = 0;
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("not found") as any;
        err.code = "ENOENT";
        cb(err, "", "");
      } else {
        cb(null, "bcq v1.0.0", "");
      }
      return {} as any;
    });

    const result = await bcqWhich();
    expect(callCount).toBe(2);
    expect(result.data.path).toBe("bcq");
    expect(result.raw).toBe("bcq v1.0.0");
  });
});

// ---------------------------------------------------------------------------
// bcqProfileList
// ---------------------------------------------------------------------------

describe("bcqProfileList", () => {
  it("returns parsed array", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, JSON.stringify(["default", "work"]), "");
      return {} as any;
    });

    const result = await bcqProfileList();
    expect(result.data).toEqual(["default", "work"]);
  });

  it("returns empty array on BcqError", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("failed") as any;
      err.code = 1;
      cb(err, "", "no profiles");
      return {} as any;
    });

    const result = await bcqProfileList();
    expect(result.data).toEqual([]);
    expect(result.raw).toBe("no profiles");
  });

  it("rethrows non-BcqError errors", async () => {
    vi.mocked(execFile).mockImplementation(() => {
      throw new TypeError("unexpected");
    });

    await expect(bcqProfileList()).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// bcqAuthStatus non-BcqError rethrow
// ---------------------------------------------------------------------------

describe("bcqAuthStatus non-BcqError rethrow", () => {
  it("rethrows TypeError instead of catching it", async () => {
    vi.mocked(execFile).mockImplementation(() => {
      throw new TypeError("unexpected type error");
    });

    await expect(bcqAuthStatus()).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// spawnCliWithFallback / execBcqAuthLogin
// ---------------------------------------------------------------------------

function mockSpawnHandle() {
  const handlers: Record<string, Function> = {};
  return {
    on: vi.fn((event: string, cb: Function) => { handlers[event] = cb; }),
    _emit(event: string, ...args: any[]) { queueMicrotask(() => handlers[event]?.(...args)); },
  };
}

describe("execBcqAuthLogin", () => {
  let savedBcqBin: string | undefined;
  let savedBasecampBin: string | undefined;

  beforeEach(() => {
    savedBcqBin = process.env.BCQ_BIN;
    savedBasecampBin = process.env.BASECAMP_BIN;
  });

  afterEach(() => {
    if (savedBcqBin === undefined) delete process.env.BCQ_BIN;
    else process.env.BCQ_BIN = savedBcqBin;
    if (savedBasecampBin === undefined) delete process.env.BASECAMP_BIN;
    else process.env.BASECAMP_BIN = savedBasecampBin;
  });

  it("resolves on exit code 0", async () => {
    const handle = mockSpawnHandle();
    vi.mocked(spawn).mockReturnValue(handle as any);

    const promise = execBcqAuthLogin();
    handle._emit("close", 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with BcqError on non-zero exit code", async () => {
    const handle = mockSpawnHandle();
    vi.mocked(spawn).mockReturnValue(handle as any);

    const promise = execBcqAuthLogin();
    handle._emit("close", 1);
    await expect(promise).rejects.toThrow(BcqError);
    await expect(promise).rejects.toThrow(/exited with code 1/);
  });

  it("passes --profile flag to spawn", async () => {
    const handle = mockSpawnHandle();
    vi.mocked(spawn).mockReturnValue(handle as any);

    const promise = execBcqAuthLogin({ profile: "work" });
    handle._emit("close", 0);
    await promise;

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--profile");
    expect(spawnArgs).toContain("work");
    const profileIdx = spawnArgs.indexOf("--profile");
    expect(spawnArgs[profileIdx + 1]).toBe("work");
  });

  it("falls back to bcq binary on ENOENT", async () => {
    const primaryHandle = mockSpawnHandle();
    const fallbackHandle = mockSpawnHandle();
    let callCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return primaryHandle as any;
      return fallbackHandle as any;
    });

    const promise = execBcqAuthLogin();

    // Primary emits ENOENT error, triggering fallback
    const enoentErr = new Error("not found") as any;
    enoentErr.code = "ENOENT";
    primaryHandle._emit("error", enoentErr);

    // Wait a tick for fallback spawn to be set up, then close it successfully
    await new Promise((r) => setTimeout(r, 10));
    fallbackHandle._emit("close", 0);

    await expect(promise).resolves.toBeUndefined();
    expect(callCount).toBe(2);
    const secondBinary = vi.mocked(spawn).mock.calls[1][0];
    expect(secondBinary).toBe("bcq");
  });

  it("rejects on non-ENOENT spawn error", async () => {
    const handle = mockSpawnHandle();
    vi.mocked(spawn).mockReturnValue(handle as any);

    const promise = execBcqAuthLogin();
    const eaccesErr = new Error("permission denied") as any;
    eaccesErr.code = "EACCES";
    handle._emit("error", eaccesErr);

    await expect(promise).rejects.toThrow(BcqError);
    await expect(promise).rejects.toThrow(/failed to start/);
  });
});
