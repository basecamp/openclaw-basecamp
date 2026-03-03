/**
 * Wrapper around the Basecamp CLI for auth operations.
 *
 * Only auth-related functions remain here — all API access has been migrated
 * to @37signals/basecamp via src/basecamp-client.ts.
 */

import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Re-export from extracted module for backwards compatibility
export { CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker.js";

// ---------------------------------------------------------------------------
// CLI binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the CLI binary name.
 * Env override: BASECAMP_BIN takes priority. Otherwise "basecamp".
 */
export function resolveCliBinaryPath(): string {
  return process.env.BASECAMP_BIN ?? "basecamp";
}

/** Default timeout for CLI commands (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CliOptions {
  /** Basecamp account ID for --account flag. */
  accountId?: string;
  /** CLI profile name for --profile flag (selects credential/config profile). */
  profile?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Extra CLI flags to append. */
  extraFlags?: string[];
}

export interface CliResult<T = unknown> {
  data: T;
  raw: string;
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
    public readonly command: string[],
  ) {
    super(message);
    this.name = "CliError";
  }
}

// ---------------------------------------------------------------------------
// Core CLI execution
// ---------------------------------------------------------------------------

/**
 * Execute a CLI command and return parsed JSON output.
 */
function execCli<T = unknown>(args: string[], opts: CliOptions = {}): Promise<CliResult<T>> {
  const binary = resolveCliBinaryPath();
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

  return new Promise<CliResult<T>>((resolve, reject) => {
    execFile(
      binary,
      fullArgs,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env: { ...process.env },
        encoding: "utf-8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const stderrTrimmed = (stderr as string).trim();
          const stdoutTrimmed = (stdout as string).trim();
          const cmdStr = [binary, ...fullArgs].join(" ");
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
          reject(new CliError(
            `Basecamp CLI failed (${cmdStr}): ${detail}`,
            exitCode,
            stderrTrimmed || stdoutTrimmed,
            [binary, ...fullArgs],
          ));
          return;
        }

        const raw = (stdout as string).trim();
        if (!raw) {
          resolve({ data: [] as unknown as T, raw });
          return;
        }

        try {
          const data = JSON.parse(raw) as T;
          resolve({ data, raw });
        } catch (parseErr) {
          reject(new CliError(
            `Basecamp CLI output is not valid JSON: ${String(parseErr)}`,
            null,
            raw,
            [binary, ...fullArgs],
          ));
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
export async function cliMe(
  opts: CliOptions = {},
): Promise<
  CliResult<{ id: number; name: string; email_address: string; attachable_sgid?: string }>
> {
  return execCli<{ id: number; name: string; email_address: string; attachable_sgid?: string }>(["me"], opts);
}

/**
 * Check that the Basecamp CLI binary exists and return its path.
 */
export async function cliWhich(): Promise<CliResult<{ path: string }>> {
  const binary = resolveCliBinaryPath();
  return new Promise((resolve, reject) => {
    execFile(binary, ["--version"], { timeout: 5_000, encoding: "utf-8" }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new CliError(
            `Basecamp CLI not found: ${error.message}`,
            typeof (error as any).code === "number" ? (error as any).code : null,
            stderr as string,
            [binary, "--version"],
          ),
        );
        return;
      }
      resolve({ data: { path: binary }, raw: (stdout as string).trim() });
    });
  });
}

/**
 * Check the authentication status of a CLI profile.
 * Runs `basecamp auth status` to verify the profile's credentials are valid.
 */
export async function cliAuthStatus(
  opts: CliOptions = {},
): Promise<CliResult<{ authenticated: boolean }>> {
  try {
    const result = await execCli<{ authenticated?: boolean }>(["auth", "status"], opts);
    const authenticated =
      typeof result.data === "object" &&
      result.data !== null &&
      result.data.authenticated === true;
    return { data: { authenticated }, raw: result.raw };
  } catch (err) {
    if (err instanceof CliError) {
      return { data: { authenticated: false }, raw: err.stderr };
    }
    throw err;
  }
}

/**
 * List available CLI profiles.
 * Runs `basecamp profile list` to enumerate configured profiles.
 */
export async function cliProfileList(opts: CliOptions = {}): Promise<CliResult<string[]>> {
  try {
    const result = await execCli<unknown[]>(["profile", "list"], opts);
    const raw = Array.isArray(result.data) ? result.data : [];
    // CLI returns objects like { name, account_id, ... } — extract names
    const profiles = raw.map((entry) =>
      typeof entry === "string" ? entry : (entry as Record<string, unknown>)?.name as string,
    ).filter((n): n is string => typeof n === "string" && n.length > 0);
    return { data: profiles, raw: result.raw };
  } catch (err) {
    if (err instanceof CliError) {
      return { data: [], raw: err.stderr };
    }
    throw err;
  }
}

/**
 * Launch `basecamp auth login` as an interactive subprocess.
 * This opens the browser for Basecamp OAuth and waits for completion.
 */
export async function execCliAuthLogin(
  opts: { profile?: string } = {},
): Promise<void> {
  const binary = resolveCliBinaryPath();
  const args = ["auth", "login"];
  if (opts.profile) {
    args.push("--profile", opts.profile);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      stdio: "inherit",
      env: { ...process.env },
    });

    proc.on("error", (err: Error) => {
      reject(
        new CliError(
          `Basecamp CLI auth login failed to start: ${err.message}`,
          null,
          "",
          [binary, ...args],
        ),
      );
    });

    proc.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new CliError(
            `Basecamp CLI auth login exited with code ${code}`,
            code,
            "",
            [binary, ...args],
          ),
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// CLI credential export (for onboarding — imports CLI's token into plugin)
// ---------------------------------------------------------------------------

/** Shape returned by `basecamp --agent profile list`. */
export interface CliProfile {
  name: string;
  base_url: string;
  account_id?: string;
  authenticated?: boolean;
  active?: boolean;
  default?: boolean;
}

/** Parsed result from CLI credential files. */
export interface CliCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
  clientSecret: string;
}

const CLI_CONFIG_DIR = join(homedir(), ".config", "basecamp");

/**
 * List CLI profiles as full objects (name, base_url, account_id, etc.).
 */
export async function cliProfileListFull(opts: CliOptions = {}): Promise<CliResult<CliProfile[]>> {
  try {
    const result = await execCli<unknown[]>(["profile", "list"], opts);
    const raw = Array.isArray(result.data) ? result.data : [];
    const profiles = raw.filter(
      (e): e is CliProfile =>
        typeof e === "object" && e !== null &&
        typeof (e as Record<string, unknown>).name === "string" &&
        typeof (e as Record<string, unknown>).base_url === "string",
    );
    return { data: profiles, raw: result.raw };
  } catch (err) {
    if (err instanceof CliError) {
      return { data: [], raw: err.stderr };
    }
    throw err;
  }
}

/**
 * Export the CLI's stored OAuth credentials for a given base URL.
 *
 * Reads `~/.config/basecamp/credentials.json` (tokens keyed by base_url)
 * and `~/.config/basecamp/client.json` (CLI's OAuth client ID/secret).
 * Returns null if credentials are missing or unparseable.
 */
export function exportCliCredentials(baseUrl: string): CliCredentials | null {
  try {
    const credsRaw = readFileSync(join(CLI_CONFIG_DIR, "credentials.json"), "utf-8");
    const creds = JSON.parse(credsRaw) as Record<string, Record<string, unknown>>;
    const entry = creds[baseUrl];
    if (!entry?.access_token || !entry?.refresh_token) return null;

    const clientRaw = readFileSync(join(CLI_CONFIG_DIR, "client.json"), "utf-8");
    const client = JSON.parse(clientRaw) as Record<string, unknown>;
    if (!client.client_id) return null;

    return {
      accessToken: String(entry.access_token),
      refreshToken: String(entry.refresh_token),
      expiresAt: typeof entry.expires_at === "number" ? entry.expires_at : 0,
      clientId: String(client.client_id),
      clientSecret: String(client.client_secret ?? ""),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap token extraction (one-shot, for wizard identity discovery)
// ---------------------------------------------------------------------------

/**
 * Extract a token from the Basecamp CLI for identity discovery during setup.
 * One-shot call — no caching, no retry. Not used at runtime.
 */
export function extractCliBootstrapToken(profile?: string): Promise<string> {
  const binary = resolveCliBinaryPath();
  const args = ["auth", "token", "-q"];
  if (profile) args.push("-P", profile);
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: 10_000, encoding: "utf-8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new CliError(
          `CLI token extraction failed: ${(stderr as string).trim() || error.message}`,
          null,
          (stderr as string).trim(),
          [binary, ...args],
        ));
        return;
      }
      const token = (stdout as string).trim();
      if (!token) {
        reject(new CliError("CLI returned empty token", null, "", [binary, ...args]));
        return;
      }
      resolve(token);
    });
  });
}
