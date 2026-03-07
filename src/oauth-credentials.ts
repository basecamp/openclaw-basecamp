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

import { homedir } from "node:os";
import { join } from "node:path";
import {
  FileTokenStore,
  type OAuthToken,
  performInteractiveLogin,
  refreshToken as sdkRefreshToken,
  TokenManager,
} from "@37signals/basecamp/oauth";
import type { ResolvedBasecampAccount } from "./types.js";

const LAUNCHPAD_TOKEN_ENDPOINT = "https://launchpad.37signals.com/authorization/token";

/**
 * Built-in Launchpad OAuth client ID for the OpenClaw Basecamp plugin.
 *
 * This is a public identifier (like Basecamp CLI's launchpadClientID) — it
 * identifies the app to Launchpad but is not a secret. The SDK negotiates
 * PKCE automatically, so a client secret is optional.
 */
const DEFAULT_LAUNCHPAD_CLIENT_ID = "37275cfbf73bb6a1140c9f255eefd9f6ac9be2ef";

/** Valid Launchpad OAuth client IDs are 40-character lowercase hex (SHA-1). */
export function isValidLaunchpadClientId(id: string | undefined): id is string {
  return !!id && /^[0-9a-f]{40}$/.test(id);
}

/**
 * Resolve a valid OAuth client ID/secret pair.
 *
 * Priority: valid overrides → valid account config → env vars → built-in default.
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

  return { clientId: DEFAULT_LAUNCHPAD_CLIENT_ID, clientSecret: undefined };
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

  return performInteractiveLogin({
    clientId: oauthClient.clientId,
    clientSecret: oauthClient.clientSecret,
    store,
    useLegacyFormat: true,
    openBrowser,
    onStatus: (message: string) => {
      console.log(`[basecamp:oauth] ${message}`);
    },
  });
}
