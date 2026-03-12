/**
 * Basecamp SDK client factory.
 *
 * Creates and caches BasecampClient instances per account.
 * Handles token resolution from multiple sources (config, tokenFile, oauth).
 */

import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";
import {
  type BasecampClient,
  BasecampError,
  type BasecampHooks,
  createBasecampClient,
  errorFromResponse,
  isBasecampError,
} from "@37signals/basecamp";
import type { ResolvedBasecampAccount } from "./types.js";

export { BasecampError, isBasecampError };
export type { BasecampClient };

// ---------------------------------------------------------------------------
// Client cache
// ---------------------------------------------------------------------------

const clientCache = new Map<string, BasecampClient>();

/**
 * Get or create a BasecampClient for the given account.
 * Clients are cached by accountId.
 */
export function getClient(account: ResolvedBasecampAccount): BasecampClient {
  const cacheKey = account.accountId;
  const existing = clientCache.get(cacheKey);
  if (existing) return existing;

  const basecampAccountId = resolveNumericAccountId(account);
  const tokenProvider = resolveTokenProvider(account);

  const hooks: BasecampHooks = {
    onRetry(info, _attempt, error, delayMs) {
      console.warn(
        `[basecamp:sdk:${cacheKey}] retry #${info.attempt} ${info.method} ${info.url} ` +
          `(${error.message}, backoff ${delayMs}ms)`,
      );
    },
  };

  const client = createBasecampClient({
    accountId: basecampAccountId,
    accessToken: tokenProvider,
    enableRetry: true,
    enableCache: false,
    hooks,
  });

  clientCache.set(cacheKey, client);
  return client;
}

/** Clear all cached clients (for shutdown). */
export function clearClients(): void {
  clientCache.clear();
}

/** Clear the cached client for a single account. */
export function clearClient(accountId: string): void {
  clientCache.delete(accountId);
}

// ---------------------------------------------------------------------------
// Account ID resolution
// ---------------------------------------------------------------------------

function resolveNumericAccountId(account: ResolvedBasecampAccount): string {
  const id = account.config.basecampAccountId ?? (/^\d+$/.test(account.accountId) ? account.accountId : undefined);
  if (!id) {
    throw new Error(
      `Cannot resolve numeric Basecamp account ID for "${account.accountId}". ` +
        `Set channels.basecamp.accounts.${account.accountId}.basecampAccountId`,
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

function resolveTokenProvider(account: ResolvedBasecampAccount): string | (() => Promise<string>) {
  switch (account.tokenSource) {
    case "config":
      return account.token;

    case "tokenFile":
      // If token was already loaded (gateway startup), use it directly
      if (account.token) return account.token;
      // Otherwise, load on demand
      return async () => {
        if (!account.config.tokenFile) {
          throw new Error(`No tokenFile configured for account "${account.accountId}"`);
        }
        return readTokenFile(account.config.tokenFile);
      };

    case "oauth": {
      // Lazy import + lazy init: the dynamic import and TokenManager creation
      // happen on the first token request, avoiding sync import issues.
      let tmPromise: Promise<{ getToken(): Promise<string> }> | null = null;
      return async () => {
        if (!tmPromise) {
          tmPromise = import("./oauth-credentials.js").then(({ createTokenManager }) => createTokenManager(account));
        }
        const tm = await tmPromise;
        return tm.getToken();
      };
    }

    case "none":
      throw new Error(
        `No authentication configured for account "${account.accountId}". ` +
          `Set token, tokenFile, or oauthTokenFile.`,
      );
  }
}

/** Read a token from a file path, expanding ~ to homedir. */
async function readTokenFile(filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  let resolved: string;
  if (filePath === "~") {
    resolved = homedir();
  } else if (filePath.startsWith("~/")) {
    resolved = pathResolve(homedir(), filePath.slice(2));
  } else {
    resolved = pathResolve(filePath);
  }
  const content = await readFile(resolved, "utf-8");
  return content.trim();
}

// ---------------------------------------------------------------------------
// ID coercion helper
// ---------------------------------------------------------------------------

/**
 * Coerce a string or number ID to a number for SDK typed service calls.
 * The plugin stores all IDs as strings, but SDK methods require numbers.
 */
export function numId(label: string, value: string | number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${label} ID: ${JSON.stringify(value)}`);
  return n;
}

// ---------------------------------------------------------------------------
// rawOrThrow helper
// ---------------------------------------------------------------------------

/**
 * Unwrap a raw openapi-fetch response, throwing BasecampError on failure.
 * Use for client.raw.GET/POST/PUT/DELETE calls that return { data, error, response }
 * instead of auto-throwing.
 */
export async function rawOrThrow<T>(result: { data?: T; error?: unknown; response: Response }): Promise<T> {
  if (!result.response.ok || result.error) {
    throw await errorFromResponse(result.response, result.response.headers.get("X-Request-Id") ?? undefined);
  }
  return result.data as T;
}
