/**
 * Wrapper around the bcq CLI for Basecamp API access.
 *
 * bcq is at ~/.local/bin/bcq. The --agent flag enables JSON+quiet output.
 * Phase 1 uses bcq for all Basecamp API access; native API replaces polling in Phase 2.
 */

import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const BCQ_PATH = process.env.BCQ_BIN ?? join(homedir(), ".local", "bin", "bcq");

/** Default timeout for bcq commands (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  retryable?: (err: BcqError) => boolean;
}

export interface CircuitBreakerOptions {
  threshold?: number;
  cooldownMs?: number;
}

export interface BcqOptions {
  /** Basecamp account ID for --account flag. */
  accountId?: string;
  /** bcq profile name for --profile flag (selects credential/config profile). */
  profile?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Extra CLI flags to append. */
  extraFlags?: string[];
  /** Retry options for transient failures. */
  retry?: RetryOptions;
  /** Circuit breaker to fail fast on repeated failures. */
  circuitBreaker?: { instance: CircuitBreaker; key: string };
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
// Error classification
// ---------------------------------------------------------------------------

const TRANSIENT_PATTERNS = ["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET"];
const SERVER_ERROR_PATTERNS = ["5xx", "500", "501", "502", "503", "504"];
const PERMANENT_PATTERNS = [
  "401",
  "403",
  "Unauthorized",
  "Forbidden",
  "404",
  "Not Found",
  "422",
  "Unprocessable",
];

export function isRetryableError(err: BcqError): boolean {
  // JSON parse errors (exitCode null, no process error) are not retryable
  if (err.exitCode === null) return false;

  const { stderr } = err;

  // Permanent errors — never retry
  if (PERMANENT_PATTERNS.some((p) => stderr.includes(p))) return false;

  // Transient network errors
  if (TRANSIENT_PATTERNS.some((p) => stderr.includes(p))) return true;

  // Server errors (5xx) with exit code 1
  if (err.exitCode === 1 && SERVER_ERROR_PATTERNS.some((p) => stderr.includes(p))) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  const maxDelayMs = opts?.maxDelayMs ?? 30000;
  const jitter = opts?.jitter ?? true;
  const classify = opts?.retryable ?? isRetryableError;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!(err instanceof BcqError) || !classify(err)) throw err;
      if (attempt + 1 >= maxAttempts) break;

      let delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      if (jitter) {
        delay -= delay * Math.random() * 0.25;
      }
      await sleep(delay);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

interface CircuitState {
  failures: number;
  trippedAt: number | null;
  cooldownMs: number;
  /** True while a half-open probe is in flight — blocks other callers. */
  halfOpenProbe: boolean;
}

export class CircuitBreaker {
  private circuits = new Map<string, CircuitState>();
  private threshold: number;
  private cooldownMs: number;

  constructor(opts?: CircuitBreakerOptions) {
    this.threshold = opts?.threshold ?? 5;
    this.cooldownMs = opts?.cooldownMs ?? 5 * 60 * 1000;
  }

  isOpen(key: string): boolean {
    const state = this.circuits.get(key);
    if (!state || state.trippedAt === null) return false;
    const elapsed = Date.now() - state.trippedAt;
    if (elapsed >= state.cooldownMs) {
      // Half-open: allow exactly one probe through
      if (state.halfOpenProbe) return true;
      state.halfOpenProbe = true;
      return false;
    }
    return true;
  }

  recordFailure(key: string): void {
    const state = this.circuits.get(key) ?? {
      failures: 0,
      trippedAt: null,
      cooldownMs: this.cooldownMs,
      halfOpenProbe: false,
    };
    state.failures++;
    state.halfOpenProbe = false;
    if (state.failures >= this.threshold) {
      state.trippedAt = Date.now();
    }
    this.circuits.set(key, state);
  }

  recordSuccess(key: string): void {
    const state = this.circuits.get(key);
    if (!state) return;
    state.failures = 0;
    state.trippedAt = null;
    state.halfOpenProbe = false;
  }

  reset(key: string): void {
    this.circuits.delete(key);
  }

  getState(key: string): { failures: number; trippedAt: number | null } | undefined {
    const state = this.circuits.get(key);
    if (!state) return undefined;
    return { failures: state.failures, trippedAt: state.trippedAt };
  }
}

// ---------------------------------------------------------------------------
// Core bcq execution
// ---------------------------------------------------------------------------

/**
 * Execute a bcq command and return parsed JSON output.
 */
function execBcq<T = unknown>(args: string[], opts: BcqOptions = {}): Promise<BcqResult<T>> {
  const cb = opts.circuitBreaker;
  if (cb && cb.instance.isOpen(cb.key)) {
    return Promise.reject(
      new BcqError(`Circuit breaker open for ${cb.key}`, null, "", args),
    );
  }

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
          const err = new BcqError(
            `bcq failed: ${error.message}`,
            error.code != null ? Number(error.code) : null,
            stderr,
            [BCQ_PATH, ...fullArgs],
          );
          cb?.instance.recordFailure(cb.key);
          reject(err);
          return;
        }

        const raw = stdout.trim();
        if (!raw) {
          cb?.instance.recordSuccess(cb.key);
          resolve({ data: [] as unknown as T, raw });
          return;
        }

        try {
          const data = JSON.parse(raw) as T;
          cb?.instance.recordSuccess(cb.key);
          resolve({ data, raw });
        } catch (parseErr) {
          const err = new BcqError(
            `bcq output is not valid JSON: ${String(parseErr)}`,
            null,
            raw,
            [BCQ_PATH, ...fullArgs],
          );
          // JSON parse errors are not transient — don't trip the circuit breaker
          reject(err);
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
  const fn = () => execBcq<T>(["api", "get", path], opts);
  return opts.retry ? withRetry(fn, opts.retry) : fn();
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
  const fn = () => execBcq<T>(["api", "post", path], opts);
  return opts.retry ? withRetry(fn, opts.retry) : fn();
}

/**
 * PUT to a Basecamp API endpoint via bcq.
 */
export async function bcqPut<T = unknown>(
  path: string,
  opts: BcqOptions = {},
): Promise<BcqResult<T>> {
  const fn = () => execBcq<T>(["api", "put", path], opts);
  return opts.retry ? withRetry(fn, opts.retry) : fn();
}

/**
 * DELETE a Basecamp API endpoint via bcq.
 */
export async function bcqDelete<T = unknown>(
  path: string,
  opts: BcqOptions = {},
): Promise<BcqResult<T>> {
  const fn = () => execBcq<T>(["api", "delete", path], opts);
  return opts.retry ? withRetry(fn, opts.retry) : fn();
}

/**
 * Fetch the current user profile for a given account.
 * Useful for resolving the service account's personId at startup.
 */
export async function bcqMe(
  opts: BcqOptions = {},
): Promise<
  BcqResult<{ id: number; name: string; email_address: string; attachable_sgid?: string }>
> {
  const fn = () => execBcq<{ id: number; name: string; email_address: string; attachable_sgid?: string }>(["me"], opts);
  return opts.retry ? withRetry(fn, opts.retry) : fn();
}

// ---------------------------------------------------------------------------
// Dedicated command wrappers (prefer these over raw bcq api calls)
// ---------------------------------------------------------------------------

/**
 * Fetch the account-wide activity timeline via `bcq timeline`.
 * Returns an array of timeline events (newest first).
 */
export async function bcqTimeline<T = unknown>(opts: BcqOptions = {}): Promise<BcqResult<T>> {
  const fn = () => execBcq<T>(["timeline"], opts);
  return opts.retry ? withRetry(fn, opts.retry) : fn();
}

/**
 * Fetch readings (Hey! menu) via `bcq api get /my/readings.json`.
 * No dedicated bcq command exists yet — uses raw API.
 */
export async function bcqReadings<T = unknown>(opts: BcqOptions = {}): Promise<BcqResult<T>> {
  const fn = () => execBcq<T>(["api", "get", "/my/readings.json"], opts);
  return opts.retry ? withRetry(fn, opts.retry) : fn();
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
    execFile(BCQ_PATH, ["--version"], { timeout: 5_000 }, (error, stdout, stderr) => {
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
      // If the command doesn't exist or returns error, return empty list
      return { data: [], raw: err.stderr };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Interactive auth helpers (used by channel auth adapter)
// ---------------------------------------------------------------------------

/**
 * Launch `bcq auth login` as an interactive subprocess.
 * This opens the browser for Basecamp OAuth and waits for completion.
 */
export async function execBcqAuthLogin(
  opts: { profile?: string } = {},
): Promise<void> {
  const args = ["auth", "login"];
  if (opts.profile) {
    args.push("--profile", opts.profile);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(BCQ_PATH, args, {
      stdio: "inherit",
      env: { ...process.env },
    });

    proc.on("error", (err: Error) => {
      reject(
        new BcqError(
          `bcq auth login failed to start: ${err.message}`,
          null,
          "",
          [BCQ_PATH, ...args],
        ),
      );
    });

    proc.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new BcqError(
            `bcq auth login exited with code ${code}`,
            code,
            "",
            [BCQ_PATH, ...args],
          ),
        );
      }
    });
  });
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
  profile?: string,
  retry?: RetryOptions,
): Promise<T> {
  const result = await bcqGet<T>(path, { accountId, profile, retry });
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
  profile?: string,
  retry?: RetryOptions,
): Promise<T> {
  const opts: BcqOptions = { accountId, profile, retry };
  if (body) {
    opts.extraFlags = ["-d", body];
  }
  const result = await bcqPost<T>(path, opts);
  return result.data;
}
