/**
 * Wrapper around the Basecamp CLI for auth operations.
 *
 * The CLI was renamed from `bcq` to `basecamp`. This module centralizes
 * binary resolution with automatic fallback: tries `basecamp` first,
 * then falls back to `bcq` for legacy installs.
 *
 * Only auth-related functions remain here — all API access has been migrated
 * to @37signals/basecamp via src/basecamp-client.ts.
 */

import { execFile, spawn } from "node:child_process";

// Re-export from extracted module for backwards compatibility
export { CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker.js";

// ---------------------------------------------------------------------------
// Centralized CLI binary resolution with fallback
// ---------------------------------------------------------------------------

/**
 * Resolve the primary CLI binary name.
 * Env override: BASECAMP_BIN takes priority. Otherwise "basecamp".
 */
export function resolveCliBinaryPath(): string {
  return process.env.BASECAMP_BIN ?? "basecamp";
}

/**
 * Resolve the fallback CLI binary name for legacy installs.
 * Env override: BCQ_BIN takes priority. Otherwise "bcq".
 */
function resolveFallbackBinaryPath(): string {
  return process.env.BCQ_BIN ?? "bcq";
}

/**
 * Execute a CLI command with automatic fallback.
 *
 * Tries the primary binary (`basecamp` or BASECAMP_BIN) first.
 * If it fails with ENOENT (not found), retries with the fallback
 * binary (`bcq` or BCQ_BIN). All other errors propagate immediately.
 *
 * This is the single centralized implementation — no call-site
 * duplication of fallback logic.
 */
function execCliWithFallback(
  args: string[],
  options: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; encoding?: BufferEncoding },
  callback: (error: Error | null, stdout: string, stderr: string, binaryUsed: string) => void,
): void {
  const primary = resolveCliBinaryPath();
  const opts = { ...options, encoding: (options.encoding ?? "utf-8") as BufferEncoding };
  execFile(primary, args, opts, (error, stdout, stderr) => {
    if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      const fallback = resolveFallbackBinaryPath();
      execFile(fallback, args, opts, (error2, stdout2, stderr2) => {
        callback(error2, stdout2 as string, stderr2 as string, fallback);
      });
      return;
    }
    callback(error, stdout as string, stderr as string, primary);
  });
}

/**
 * Spawn a CLI command with automatic fallback.
 *
 * Same ENOENT-based fallback as execCliWithFallback, but for
 * interactive (stdio: "inherit") subprocesses.
 */
function spawnCliWithFallback(
  args: string[],
  options: Parameters<typeof spawn>[2] & {},
): { onError: (cb: (err: Error) => void) => void; onClose: (cb: (code: number | null) => void) => void } {
  const primary = resolveCliBinaryPath();
  let errorCb: (err: Error) => void = () => {};
  let closeCb: (code: number | null) => void = () => {};

  const proc = spawn(primary, args, options);

  proc.on("error", (err: Error) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const fallback = resolveFallbackBinaryPath();
      const proc2 = spawn(fallback, args, options);
      proc2.on("error", errorCb);
      proc2.on("close", closeCb);
      return;
    }
    errorCb(err);
  });
  proc.on("close", (code) => closeCb(code));

  return {
    onError(cb) { errorCb = cb; },
    onClose(cb) { closeCb = cb; },
  };
}

/** Default timeout for bcq commands (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BcqOptions {
  /** Basecamp account ID for --account flag. */
  accountId?: string;
  /** bcq profile name for --profile flag (selects credential/config profile). */
  profile?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Extra CLI flags to append. */
  extraFlags?: string[];
}

export interface BcqResult<T = unknown> {
  data: T;
  raw: string;
}

export class BcqError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
    public readonly command: string[],
  ) {
    super(message);
    this.name = "BcqError";
  }
}

// ---------------------------------------------------------------------------
// Core bcq execution
// ---------------------------------------------------------------------------

/**
 * Execute a CLI command and return parsed JSON output.
 * Uses centralized fallback (basecamp → bcq).
 */
function execBcq<T = unknown>(args: string[], opts: BcqOptions = {}): Promise<BcqResult<T>> {
  const fullArgs = ["--agent", ...args];

  if (opts.accountId) {
    fullArgs.push("--account", opts.accountId);
  }

  if (opts.profile) {
    fullArgs.push("--profile", opts.profile);
  }

  if (opts.extraFlags) {
    fullArgs.push(...opts.extraFlags);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<BcqResult<T>>((resolve, reject) => {
    execCliWithFallback(
      fullArgs,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: { ...process.env },
      },
      (error, stdout, stderr, binaryUsed) => {
        if (error) {
          const stderrTrimmed = stderr.trim();
          const stdoutTrimmed = stdout.trim();
          const cmdStr = [binaryUsed, ...fullArgs].join(" ");
          const meaningfulMsg = error.message.replace(/^Command failed:.*$/, "").trim();
          const detail =
            stderrTrimmed ||
            stdoutTrimmed ||
            ((error as any).killed ? "timed out (killed)" : null) ||
            ((error as any).signal ? `killed by ${(error as any).signal}` : null) ||
            meaningfulMsg ||
            `exit code ${(error as any).code ?? "unknown"}`;
          const exitCode =
            typeof (error as any).code === "number" ? (error as any).code :
            typeof (error as any).status === "number" ? (error as any).status :
            null;
          const err = new BcqError(
            `Basecamp CLI failed (${cmdStr}): ${detail}`,
            exitCode,
            stderrTrimmed || stdoutTrimmed,
            [binaryUsed, ...fullArgs],
          );
          reject(err);
          return;
        }

        const raw = stdout.trim();
        if (!raw) {
          resolve({ data: [] as unknown as T, raw });
          return;
        }

        try {
          const data = JSON.parse(raw) as T;
          resolve({ data, raw });
        } catch (parseErr) {
          const err = new BcqError(
            `Basecamp CLI output is not valid JSON: ${String(parseErr)}`,
            null,
            raw,
            [binaryUsed, ...fullArgs],
          );
          reject(err);
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Auth & introspection helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the current user profile for a given account.
 * Useful for resolving the service account's personId at startup.
 */
export async function bcqMe(
  opts: BcqOptions = {},
): Promise<
  BcqResult<{ id: number; name: string; email_address: string; attachable_sgid?: string }>
> {
  return execBcq<{ id: number; name: string; email_address: string; attachable_sgid?: string }>(["me"], opts);
}

/**
 * Check that the Basecamp CLI binary exists and return its path.
 * Tries `basecamp --version`, falls back to `bcq --version`.
 */
export async function bcqWhich(): Promise<BcqResult<{ path: string }>> {
  return new Promise((resolve, reject) => {
    execCliWithFallback(["--version"], { timeout: 5_000 }, (error, stdout, stderr, binaryUsed) => {
      if (error) {
        reject(
          new BcqError(
            `Basecamp CLI not found: ${error.message}`,
            (error as any).code != null ? Number((error as any).code) : null,
            stderr,
            [binaryUsed, "--version"],
          ),
        );
        return;
      }
      resolve({ data: { path: binaryUsed }, raw: stdout.trim() });
    });
  });
}

/**
 * Check the authentication status of a bcq profile.
 * Runs `bcq auth status` to verify the profile's credentials are valid.
 */
export async function bcqAuthStatus(
  opts: BcqOptions = {},
): Promise<BcqResult<{ authenticated: boolean }>> {
  try {
    const result = await execBcq<{ authenticated?: boolean }>(["auth", "status"], opts);
    const authenticated =
      typeof result.data === "object" &&
      result.data !== null &&
      result.data.authenticated === true;
    return { data: { authenticated }, raw: result.raw };
  } catch (err) {
    if (err instanceof BcqError) {
      return { data: { authenticated: false }, raw: err.stderr };
    }
    throw err;
  }
}

/**
 * List available bcq profiles.
 * Runs `bcq profile list` to enumerate configured profiles.
 */
export async function bcqProfileList(opts: BcqOptions = {}): Promise<BcqResult<string[]>> {
  try {
    const result = await execBcq<string[]>(["profile", "list"], opts);
    const profiles = Array.isArray(result.data) ? result.data : [];
    return { data: profiles, raw: result.raw };
  } catch (err) {
    if (err instanceof BcqError) {
      return { data: [], raw: err.stderr };
    }
    throw err;
  }
}

/**
 * Launch `basecamp auth login` as an interactive subprocess.
 * This opens the browser for Basecamp OAuth and waits for completion.
 * Falls back to `bcq auth login` if `basecamp` binary is not found.
 */
export async function execBcqAuthLogin(
  opts: { profile?: string } = {},
): Promise<void> {
  const args = ["auth", "login"];
  if (opts.profile) {
    args.push("--profile", opts.profile);
  }

  return new Promise((resolve, reject) => {
    const handle = spawnCliWithFallback(args, {
      stdio: "inherit",
      env: { ...process.env },
    });

    handle.onError((err: Error) => {
      reject(
        new BcqError(
          `Basecamp CLI auth login failed to start: ${err.message}`,
          null,
          "",
          [resolveCliBinaryPath(), ...args],
        ),
      );
    });

    handle.onClose((code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new BcqError(
            `Basecamp CLI auth login exited with code ${code}`,
            code,
            "",
            [resolveCliBinaryPath(), ...args],
          ),
        );
      }
    });
  });
}
