/**
 * Wrapper around the bcq CLI for Basecamp API access.
 *
 * bcq is at ~/.local/bin/bcq. The --agent flag enables JSON+quiet output.
 * Phase 1 uses bcq for all Basecamp API access; native API replaces polling in Phase 2.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const BCQ_PATH = process.env.BCQ_BIN ?? join(homedir(), ".local", "bin", "bcq");

/** Default timeout for bcq commands (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BcqOptions {
  /** Basecamp account ID for --account flag. */
  accountId?: string;
  /** bcq profile name for --profile flag (selects credential/config profile). */
  profile?: string;
  /** Basecamp host override (e.g., "3.basecampapi.localhost:3001" for local dev). */
  host?: string;
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

/**
 * Execute a bcq command and return parsed JSON output.
 */
function execBcq<T = unknown>(
  args: string[],
  opts: BcqOptions = {},
): Promise<BcqResult<T>> {
  const fullArgs = ["--agent", ...args];

  if (opts.accountId) {
    fullArgs.push("--account", opts.accountId);
  }

  if (opts.profile) {
    fullArgs.push("--profile", opts.profile);
  }

  if (opts.host) {
    fullArgs.push("--host", opts.host);
  }

  if (opts.extraFlags) {
    fullArgs.push(...opts.extraFlags);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    execFile(
      BCQ_PATH,
      fullArgs,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new BcqError(
              `bcq failed: ${error.message}`,
              error.code != null ? Number(error.code) : null,
              stderr,
              [BCQ_PATH, ...fullArgs],
            ),
          );
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
          reject(
            new BcqError(
              `bcq output is not valid JSON: ${String(parseErr)}`,
              null,
              raw,
              [BCQ_PATH, ...fullArgs],
            ),
          );
        }
      },
    );
  });
}

/**
 * GET a Basecamp API endpoint via bcq.
 *
 * @example
 *   const result = await bcqGet("/projects/123/timelines.json", { accountId: "abc" });
 */
export async function bcqGet<T = unknown>(
  path: string,
  opts: BcqOptions = {},
): Promise<BcqResult<T>> {
  return execBcq<T>(["api", "get", path], opts);
}

/**
 * POST to a Basecamp API endpoint via bcq.
 *
 * @example
 *   const result = await bcqPost("/buckets/1/chats/2/lines.json", {
 *     accountId: "abc",
 *     extraFlags: ["-d", JSON.stringify({ content: "<p>Hello</p>" })],
 *   });
 */
export async function bcqPost<T = unknown>(
  path: string,
  opts: BcqOptions = {},
): Promise<BcqResult<T>> {
  return execBcq<T>(["api", "post", path], opts);
}

/**
 * PUT to a Basecamp API endpoint via bcq.
 */
export async function bcqPut<T = unknown>(
  path: string,
  opts: BcqOptions = {},
): Promise<BcqResult<T>> {
  return execBcq<T>(["api", "put", path], opts);
}

/**
 * DELETE a Basecamp API endpoint via bcq.
 */
export async function bcqDelete<T = unknown>(
  path: string,
  opts: BcqOptions = {},
): Promise<BcqResult<T>> {
  return execBcq<T>(["api", "delete", path], opts);
}

/**
 * Fetch the current user profile for a given account.
 * Useful for resolving the service account's personId at startup.
 */
export async function bcqMe(
  opts: BcqOptions = {},
): Promise<BcqResult<{ id: number; name: string; email_address: string; attachable_sgid?: string }>> {
  return execBcq(["me"], opts);
}

// ---------------------------------------------------------------------------
// Dedicated command wrappers (prefer these over raw bcq api calls)
// ---------------------------------------------------------------------------

/**
 * Fetch the account-wide activity timeline via `bcq timeline`.
 * Returns an array of timeline events (newest first).
 */
export async function bcqTimeline<T = unknown>(
  opts: BcqOptions = {},
): Promise<BcqResult<T>> {
  return execBcq<T>(["timeline"], opts);
}

/**
 * Fetch readings (Hey! menu) via `bcq api get /my/readings.json`.
 * No dedicated bcq command exists yet — uses raw API.
 */
export async function bcqReadings<T = unknown>(
  opts: BcqOptions = {},
): Promise<BcqResult<T>> {
  return execBcq<T>(["api", "get", "/my/readings.json"], opts);
}

// ---------------------------------------------------------------------------
// bcq introspection helpers (used at startup for validation & diagnostics)
// ---------------------------------------------------------------------------

/**
 * Check that the bcq binary exists and return its path.
 * Runs `which bcq` (or checks the known path) to verify availability.
 */
export async function bcqWhich(): Promise<BcqResult<{ path: string }>> {
  return new Promise((resolve, reject) => {
    execFile(
      BCQ_PATH,
      ["--version"],
      { timeout: 5_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new BcqError(
              `bcq not found or not executable at ${BCQ_PATH}: ${error.message}`,
              error.code != null ? Number(error.code) : null,
              stderr,
              [BCQ_PATH, "--version"],
            ),
          );
          return;
        }
        resolve({ data: { path: BCQ_PATH }, raw: stdout.trim() });
      },
    );
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
    const result = await execBcq<{ authenticated?: boolean }>(
      ["auth", "status"],
      opts,
    );
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
export async function bcqProfileList(
  opts: BcqOptions = {},
): Promise<BcqResult<string[]>> {
  try {
    const result = await execBcq<string[]>(["profile", "list"], opts);
    const profiles = Array.isArray(result.data) ? result.data : [];
    return { data: profiles, raw: result.raw };
  } catch (err) {
    if (err instanceof BcqError) {
      // If the command doesn't exist or returns error, return empty list
      return { data: [], raw: err.stderr };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Simplified API helpers (used by outbound/send.ts and other modules)
// ---------------------------------------------------------------------------

/**
 * Simple GET that returns parsed JSON data directly.
 * Convenience wrapper around bcqGet for callers that just want the data.
 */
export async function bcqApiGet<T = unknown>(
  path: string,
  accountId?: string,
  host?: string,
  profile?: string,
): Promise<T> {
  const result = await bcqGet<T>(path, { accountId, host, profile });
  return result.data;
}

/**
 * Simple POST that returns parsed JSON data directly.
 * Body is passed as the -d flag value.
 */
export async function bcqApiPost<T = unknown>(
  path: string,
  body?: string,
  accountId?: string,
  host?: string,
  profile?: string,
): Promise<T> {
  const opts: BcqOptions = { accountId, host, profile };
  if (body) {
    opts.extraFlags = ["-d", body];
  }
  const result = await bcqPost<T>(path, opts);
  return result.data;
}
