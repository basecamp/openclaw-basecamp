/**
 * Error scenario tests for Basecamp CLI failure paths.
 *
 * Mocks node:child_process to simulate various CLI failure modes
 * (timeout, invalid JSON, auth failure, empty output, network errors).
 *
 * Only auth-related functions remain in basecamp-cli.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn() };
});

import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  CliError,
  cliAuthStatus,
  cliMe,
  cliProfileList,
  cliProfileListFull,
  cliWhich,
  execCliAuthLogin,
  exportCliCredentials,
  resolveCliBinaryPath,
} from "../src/basecamp-cli.js";

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
// Binary resolution contract — no bcq fallback
// ---------------------------------------------------------------------------

describe("CLI binary resolution", () => {
  it("resolves to BASECAMP_BIN when set", () => {
    const original = process.env.BASECAMP_BIN;
    try {
      process.env.BASECAMP_BIN = "/opt/bin/basecamp-custom";
      expect(resolveCliBinaryPath()).toBe("/opt/bin/basecamp-custom");
    } finally {
      if (original === undefined) delete process.env.BASECAMP_BIN;
      else process.env.BASECAMP_BIN = original;
    }
  });

  it("resolves to 'basecamp' by default", () => {
    const original = process.env.BASECAMP_BIN;
    try {
      delete process.env.BASECAMP_BIN;
      expect(resolveCliBinaryPath()).toBe("basecamp");
    } finally {
      if (original !== undefined) process.env.BASECAMP_BIN = original;
    }
  });

  it("propagates ENOENT directly — no fallback retry", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("spawn basecamp ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      cb(err, "", "");
      return {} as any;
    });

    await expect(cliWhich()).rejects.toThrow(CliError);
    // execFile called exactly once — no fallback attempt
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("cliWhich exitCode is null for non-numeric error codes like ENOENT", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("spawn basecamp ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      cb(err, "", "");
      return {} as any;
    });

    try {
      await cliWhich();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// cliMe flag building
// ---------------------------------------------------------------------------

describe("cliMe flag building", () => {
  beforeEach(() => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, JSON.stringify({ id: 1, name: "Test", email_address: "t@t.com" }), "");
      return {} as any;
    });
  });

  it("includes --account flag when accountId is set", async () => {
    await cliMe({ accountId: "123" });
    const args = vi.mocked(execFile).mock.calls[0][1] as string[];
    expect(args).toContain("--account");
    expect(args).toContain("123");
    const accountIdx = args.indexOf("--account");
    expect(args[accountIdx + 1]).toBe("123");
  });

  it("includes --profile flag when profile is set", async () => {
    await cliMe({ profile: "work" });
    const args = vi.mocked(execFile).mock.calls[0][1] as string[];
    expect(args).toContain("--profile");
    expect(args).toContain("work");
    const profileIdx = args.indexOf("--profile");
    expect(args[profileIdx + 1]).toBe("work");
  });

  it("appends extraFlags", async () => {
    await cliMe({ extraFlags: ["--verbose"] });
    const args = vi.mocked(execFile).mock.calls[0][1] as string[];
    expect(args).toContain("--verbose");
  });
});

// ---------------------------------------------------------------------------
// execBcq error shapes
// ---------------------------------------------------------------------------

describe("cliMe error shapes", () => {
  it("reports 'timed out' when killed=true", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("Command failed: basecamp --agent me") as any;
      err.killed = true;
      err.code = null;
      cb(err, "", "");
      return {} as any;
    });

    try {
      await cliMe();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("timed out");
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
      await cliMe();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("killed by SIGTERM");
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
      await cliMe();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(2);
    }
  });

  it("returns empty array when stdout is empty", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, "", "");
      return {} as any;
    });

    const result = await cliMe();
    expect(result.data).toEqual([]);
    expect(result.raw).toBe("");
  });

  it("throws CliError on JSON parse failure", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, "not json {", "");
      return {} as any;
    });

    try {
      await cliMe();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("not valid JSON");
    }
  });
});

// ---------------------------------------------------------------------------
// bcqWhich
// ---------------------------------------------------------------------------

describe("cliWhich", () => {
  it("returns the binary path on success", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, "basecamp v1.2.3", "");
      return {} as any;
    });

    const result = await cliWhich();
    expect(result.data.path).toBe("basecamp");
    expect(result.raw).toBe("basecamp v1.2.3");
  });

  it("throws CliError on failure", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("not found") as any;
      err.code = 127;
      cb(err, "", "command not found");
      return {} as any;
    });

    await expect(cliWhich()).rejects.toThrow(CliError);
  });
});

// ---------------------------------------------------------------------------
// cliProfileList
// ---------------------------------------------------------------------------

describe("cliProfileList", () => {
  it("returns parsed array", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, JSON.stringify(["default", "work"]), "");
      return {} as any;
    });

    const result = await cliProfileList();
    expect(result.data).toEqual(["default", "work"]);
  });

  it("returns empty array on CliError", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("failed") as any;
      err.code = 1;
      cb(err, "", "no profiles");
      return {} as any;
    });

    const result = await cliProfileList();
    expect(result.data).toEqual([]);
    expect(result.raw).toBe("no profiles");
  });

  it("rethrows non-CliError errors", async () => {
    vi.mocked(execFile).mockImplementation(() => {
      throw new TypeError("unexpected");
    });

    await expect(cliProfileList()).rejects.toThrow(TypeError);
  });

  it("extracts names from object-shaped profile entries", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(
        null,
        JSON.stringify([
          { name: "prod", base_url: "https://3.basecampapi.com" },
          { name: "dev", base_url: "http://3.basecamp.localhost:3001" },
        ]),
        "",
      );
      return {} as any;
    });

    const result = await cliProfileList();
    expect(result.data).toEqual(["prod", "dev"]);
  });

  it("handles mixed string and object entries", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, JSON.stringify(["legacy-profile", { name: "new-profile", base_url: "https://3.basecampapi.com" }]), "");
      return {} as any;
    });

    const result = await cliProfileList();
    expect(result.data).toEqual(["legacy-profile", "new-profile"]);
  });
});

// ---------------------------------------------------------------------------
// cliProfileListFull
// ---------------------------------------------------------------------------

describe("cliProfileListFull", () => {
  it("returns full profile objects", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(
        null,
        JSON.stringify([
          { name: "prod", base_url: "https://3.basecampapi.com", authenticated: true },
          { name: "dev", base_url: "http://localhost:3001", active: true },
        ]),
        "",
      );
      return {} as any;
    });

    const result = await cliProfileListFull();
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toEqual(expect.objectContaining({ name: "prod", base_url: "https://3.basecampapi.com" }));
    expect(result.data[1]).toEqual(expect.objectContaining({ name: "dev", active: true }));
  });

  it("filters out entries missing name or base_url", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(
        null,
        JSON.stringify([
          { name: "valid", base_url: "https://example.com" },
          { name: "no-url" },
          { base_url: "https://no-name.com" },
          "string-entry",
        ]),
        "",
      );
      return {} as any;
    });

    const result = await cliProfileListFull();
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.name).toBe("valid");
  });

  it("returns empty array on CliError", async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      const err = new Error("failed") as any;
      err.code = 1;
      cb(err, "", "error");
      return {} as any;
    });

    const result = await cliProfileListFull();
    expect(result.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// exportCliCredentials
// ---------------------------------------------------------------------------

describe("exportCliCredentials", () => {
  it("exports credentials for a matching base URL", () => {
    vi.mocked(readFileSync).mockImplementation((filePath: any) => {
      if (String(filePath).includes("credentials.json")) {
        return JSON.stringify({
          "https://3.basecampapi.com": {
            access_token: "at-123",
            refresh_token: "rt-456",
            expires_at: 1770188269,
          },
        });
      }
      if (String(filePath).includes("client.json")) {
        return JSON.stringify({ client_id: "abcdef0123456789abcdef0123456789abcdef01", client_secret: "cs-xyz" });
      }
      throw new Error("unexpected file");
    });

    const result = exportCliCredentials("https://3.basecampapi.com");
    expect(result).toEqual({
      accessToken: "at-123",
      refreshToken: "rt-456",
      expiresAt: 1770188269,
      clientId: "abcdef0123456789abcdef0123456789abcdef01",
      clientSecret: "cs-xyz",
    });
  });

  it("returns null when base URL not found in credentials", () => {
    vi.mocked(readFileSync).mockImplementation((filePath: any) => {
      if (String(filePath).includes("credentials.json")) {
        return JSON.stringify({ "https://other.com": { access_token: "x", refresh_token: "y" } });
      }
      return "{}";
    });

    expect(exportCliCredentials("https://3.basecampapi.com")).toBeNull();
  });

  it("returns null when credentials file is missing", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(exportCliCredentials("https://3.basecampapi.com")).toBeNull();
  });

  it("returns null when client_id is a DCR placeholder", () => {
    vi.mocked(readFileSync).mockImplementation((filePath: any) => {
      if (String(filePath).includes("credentials.json")) {
        return JSON.stringify({
          "https://3.basecampapi.com": { access_token: "at", refresh_token: "rt" },
        });
      }
      return JSON.stringify({ client_id: "dcr-id", client_secret: "cs" });
    });

    expect(exportCliCredentials("https://3.basecampapi.com")).toBeNull();
  });

  it("returns null when client_id is not 40-char hex", () => {
    vi.mocked(readFileSync).mockImplementation((filePath: any) => {
      if (String(filePath).includes("credentials.json")) {
        return JSON.stringify({
          "https://3.basecampapi.com": { access_token: "at", refresh_token: "rt" },
        });
      }
      return JSON.stringify({ client_id: "short-id", client_secret: "cs" });
    });

    expect(exportCliCredentials("https://3.basecampapi.com")).toBeNull();
  });

  it("returns null when client.json lacks client_id", () => {
    vi.mocked(readFileSync).mockImplementation((filePath: any) => {
      if (String(filePath).includes("credentials.json")) {
        return JSON.stringify({
          "https://3.basecampapi.com": { access_token: "at", refresh_token: "rt" },
        });
      }
      return JSON.stringify({});
    });

    expect(exportCliCredentials("https://3.basecampapi.com")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bcqAuthStatus non-CliError rethrow
// ---------------------------------------------------------------------------

describe("cliAuthStatus non-CliError rethrow", () => {
  it("rethrows TypeError instead of catching it", async () => {
    vi.mocked(execFile).mockImplementation(() => {
      throw new TypeError("unexpected type error");
    });

    await expect(cliAuthStatus()).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// execCliAuthLogin
// ---------------------------------------------------------------------------

function mockSpawnHandle() {
  const handlers: Record<string, Function> = {};
  return {
    on: vi.fn((event: string, cb: Function) => {
      handlers[event] = cb;
    }),
    _emit(event: string, ...args: any[]) {
      queueMicrotask(() => handlers[event]?.(...args));
    },
  };
}

describe("execCliAuthLogin", () => {
  it("resolves on exit code 0", async () => {
    const handle = mockSpawnHandle();
    vi.mocked(spawn).mockReturnValue(handle as any);

    const promise = execCliAuthLogin();
    handle._emit("close", 0);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with CliError on non-zero exit code", async () => {
    const handle = mockSpawnHandle();
    vi.mocked(spawn).mockReturnValue(handle as any);

    const promise = execCliAuthLogin();
    handle._emit("close", 1);
    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toThrow(/exited with code 1/);
  });

  it("passes --profile flag to spawn", async () => {
    const handle = mockSpawnHandle();
    vi.mocked(spawn).mockReturnValue(handle as any);

    const promise = execCliAuthLogin({ profile: "work" });
    handle._emit("close", 0);
    await promise;

    const spawnArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--profile");
    expect(spawnArgs).toContain("work");
    const profileIdx = spawnArgs.indexOf("--profile");
    expect(spawnArgs[profileIdx + 1]).toBe("work");
  });

  it("rejects on non-ENOENT spawn error", async () => {
    const handle = mockSpawnHandle();
    vi.mocked(spawn).mockReturnValue(handle as any);

    const promise = execCliAuthLogin();
    const eaccesErr = new Error("permission denied") as any;
    eaccesErr.code = "EACCES";
    handle._emit("error", eaccesErr);

    await expect(promise).rejects.toThrow(CliError);
    await expect(promise).rejects.toThrow(/failed to start/);
  });
});
