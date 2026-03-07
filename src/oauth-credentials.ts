/**
 * OAuth credential management for Basecamp channel plugin.
 *
 * Wraps the @37signals/basecamp OAuth building blocks (TokenManager, FileTokenStore)
 * into plugin-aware helpers that resolve paths, cache managers per account,
 * and drive the interactive login flow.
 *
 * NOTE: The @37signals/basecamp TokenManager / FileTokenStore / performInteractiveLogin
 * exports are being built in a parallel SDK PR. These imports will resolve once
 * that PR lands.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  FileTokenStore,
  type OAuthToken,
  performInteractiveLogin,
  refreshToken as sdkRefreshToken,
  TokenManager,
} from "@37signals/basecamp/oauth";
import type { ResolvedBasecampAccount } from "./types.js";

const LAUNCHPAD_TOKEN_ENDPOINT = "https://launchpad.37signals.com/authorization/token";

/** Guidance note shown before prompting for OAuth client credentials. */
export const OAUTH_SETUP_GUIDANCE =
  "You'll need a Basecamp OAuth app. Register one at:\n" +
  "https://launchpad.37signals.com/integrations\n\n" +
  "When creating the app, set the redirect URI to:\n" +
  "http://localhost:14923/callback\n\n" +
  "You can leave the other fields as defaults.";

/** Valid Launchpad OAuth client IDs are 40-character lowercase hex (SHA-1). */
export function isValidLaunchpadClientId(id: string | undefined): id is string {
  return !!id && /^[0-9a-f]{40}$/.test(id);
}

/**
 * Resolve a valid OAuth client ID/secret pair.
 *
 * Priority: valid overrides → valid account config → env vars → persisted client file → throws.
 * Client ID and secret are treated as a pair — if a source's client ID is
 * invalid (e.g. DCR placeholder "dcr-id"), both are discarded and the next
 * source is tried.
 */
function resolveOAuthClient(
  account: ResolvedBasecampAccount,
  overrides?: { clientId?: string; clientSecret?: string },
): { clientId: string; clientSecret: string | undefined } {
  // Overrides are validated too — callers (onboarding, hatch) may pass
  // invalid values from config without realizing it.
  if (isValidLaunchpadClientId(overrides?.clientId)) {
    return { clientId: overrides.clientId, clientSecret: overrides.clientSecret };
  }

  if (isValidLaunchpadClientId(account.oauthClientId)) {
    return { clientId: account.oauthClientId, clientSecret: account.oauthClientSecret };
  }

  const envClientId = process.env.LAUNCHPAD_CLIENT_ID;
  const envClientSecret = process.env.LAUNCHPAD_CLIENT_SECRET;
  if (isValidLaunchpadClientId(envClientId)) {
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  // Check companion client file saved during a previous login
  const tokenFilePath = account.config.oauthTokenFile ?? resolveTokenFilePath(account.accountId);
  const persisted = loadPersistedClient(tokenFilePath);
  if (persisted) {
    return { clientId: persisted.clientId, clientSecret: persisted.clientSecret };
  }

  throw new Error(
    "No OAuth client configured for Basecamp. " +
      "Run `openclaw channels add` and select Basecamp to set up credentials, " +
      "or set the LAUNCHPAD_CLIENT_ID and LAUNCHPAD_CLIENT_SECRET environment variables.",
  );
}

// ---------------------------------------------------------------------------
// Token file path resolution
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_DIR = join(homedir(), ".local", "share", "openclaw", "basecamp", "tokens");

/**
 * Resolve the path for an OAuth token file.
 *
 * When `stateDir` is provided: `{stateDir}/tokens/{accountId}.json`
 * Otherwise: `~/.local/share/openclaw/basecamp/tokens/{accountId}.json`
 */
export function resolveTokenFilePath(accountId: string, stateDir?: string): string {
  const dir = stateDir ? join(stateDir, "tokens") : DEFAULT_TOKEN_DIR;
  return join(dir, `${accountId}.json`);
}

// ---------------------------------------------------------------------------
// Persisted OAuth client credentials
// ---------------------------------------------------------------------------

/**
 * Resolve the path for the companion OAuth client file.
 *
 * Stored alongside the token file: `{tokenDir}/{accountId}.client.json`.
 * Contains `{ clientId, clientSecret? }` so that token refresh works
 * even when the original env vars / overrides aren't present.
 */
export function resolveClientFilePath(tokenFilePath: string): string {
  if (tokenFilePath.endsWith(".json")) {
    return tokenFilePath.replace(/\.json$/, ".client.json");
  }
  return `${tokenFilePath}.client.json`;
}

type PersistedClient = { clientId: string; clientSecret?: string };

function loadPersistedClient(tokenFilePath: string): PersistedClient | undefined {
  try {
    const data = JSON.parse(readFileSync(resolveClientFilePath(tokenFilePath), "utf-8")) as PersistedClient;
    if (isValidLaunchpadClientId(data.clientId)) return data;
  } catch {
    // File doesn't exist or is malformed — not an error
  }
  return undefined;
}

function persistClient(tokenFilePath: string, client: { clientId: string; clientSecret?: string }): void {
  const clientPath = resolveClientFilePath(tokenFilePath);
  try {
    const dir = dirname(clientPath);
    mkdirSync(dir, { recursive: true });
    // Atomic write: temp file → rename (prevents partial reads on crash)
    const tmp = join(dir, `.client-${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret }), {
      mode: 0o600,
    });
    renameSync(tmp, clientPath);
  } catch {
    // Best-effort — don't fail the login over this
  }
}

// ---------------------------------------------------------------------------
// TokenManager cache
// ---------------------------------------------------------------------------

const managerCache = new Map<string, TokenManager>();

/**
 * Get or create a TokenManager for the given account.
 *
 * Managers are cached per accountId so that repeated `getToken()` calls
 * share a single refresh mutex and file store.
 */
export function createTokenManager(account: ResolvedBasecampAccount): TokenManager {
  const existing = managerCache.get(account.accountId);
  if (existing) return existing;

  const tokenFilePath = account.config.oauthTokenFile ?? resolveTokenFilePath(account.accountId);

  const store = new FileTokenStore(tokenFilePath);

  const oauthClient = resolveOAuthClient(account);

  const tm = new TokenManager({
    store,
    refreshToken: sdkRefreshToken,
    tokenEndpoint: LAUNCHPAD_TOKEN_ENDPOINT,
    clientId: oauthClient.clientId,
    clientSecret: oauthClient.clientSecret,
    useLegacyFormat: true, // Launchpad
  });

  managerCache.set(account.accountId, tm);
  return tm;
}

/** Clear all cached TokenManagers (for shutdown / tests). */
export function clearTokenManagers(): void {
  managerCache.clear();
}

/** Clear the cached TokenManager for a single account. */
export function clearTokenManager(accountId: string): void {
  managerCache.delete(accountId);
}

// ---------------------------------------------------------------------------
// Interactive login
// ---------------------------------------------------------------------------

/**
 * Run the interactive OAuth login flow for an account.
 *
 * Opens the user's browser to the Launchpad authorization page, waits for
 * the callback, exchanges the code for tokens, and persists them to disk.
 *
 * @returns The obtained OAuth token.
 */
export async function interactiveLogin(
  account: ResolvedBasecampAccount,
  overrides?: { clientId?: string; clientSecret?: string },
): Promise<OAuthToken> {
  const oauthClient = resolveOAuthClient(account, overrides);

  const tokenFilePath = account.config.oauthTokenFile ?? resolveTokenFilePath(account.accountId);

  const store = new FileTokenStore(tokenFilePath);

  // Open browser: use the `open` package if available, fall back to platform command
  const openBrowser = async (url: string): Promise<void> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const open = (await import(/* @vite-ignore */ "open" as string)).default as (url: string) => Promise<unknown>;
      await open(url);
    } catch {
      // Fallback: spawn platform-native opener
      const { exec } = await import("node:child_process");
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      exec(`${cmd} ${JSON.stringify(url)}`);
    }
  };

  const token = await performInteractiveLogin({
    clientId: oauthClient.clientId,
    clientSecret: oauthClient.clientSecret,
    store,
    useLegacyFormat: true,
    openBrowser,
    onStatus: (message: string) => {
      console.log(`[basecamp:oauth] ${message}`);
    },
  });

  // Persist client credentials alongside the token so that subsequent
  // token refreshes work without env vars or config overrides.
  persistClient(tokenFilePath, oauthClient);

  return token;
}
