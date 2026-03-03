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

import {
  TokenManager,
  FileTokenStore,
  performInteractiveLogin,
  refreshToken as sdkRefreshToken,
  type OAuthToken,
} from "@37signals/basecamp/oauth";
import type { ResolvedBasecampAccount } from "./types.js";
import { homedir } from "node:os";
import { join } from "node:path";

const LAUNCHPAD_TOKEN_ENDPOINT = "https://launchpad.37signals.com/authorization/token";

// ---------------------------------------------------------------------------
// Token file path resolution
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_DIR = join(
  homedir(),
  ".local",
  "share",
  "openclaw",
  "basecamp",
  "tokens",
);

/**
 * Resolve the path for an OAuth token file.
 *
 * When `stateDir` is provided: `{stateDir}/tokens/{accountId}.json`
 * Otherwise: `~/.local/share/openclaw/basecamp/tokens/{accountId}.json`
 */
export function resolveTokenFilePath(
  accountId: string,
  stateDir?: string,
): string {
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
export function createTokenManager(
  account: ResolvedBasecampAccount,
): TokenManager {
  const existing = managerCache.get(account.accountId);
  if (existing) return existing;

  const tokenFilePath =
    account.config.oauthTokenFile ??
    resolveTokenFilePath(account.accountId);

  const store = new FileTokenStore(tokenFilePath);

  const tm = new TokenManager({
    store,
    refreshToken: sdkRefreshToken,
    tokenEndpoint: LAUNCHPAD_TOKEN_ENDPOINT,
    clientId: account.oauthClientId,
    clientSecret: account.oauthClientSecret,
    useLegacyFormat: true, // Launchpad
  });

  managerCache.set(account.accountId, tm);
  return tm;
}

/** Clear all cached TokenManagers (for shutdown / tests). */
export function clearTokenManagers(): void {
  managerCache.clear();
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
  const clientId = overrides?.clientId ?? account.oauthClientId;
  if (!clientId) {
    throw new Error(
      `No OAuth clientId available for account "${account.accountId}". ` +
      `Set oauthClientId on the account or oauth.clientId at the channel level.`,
    );
  }
  const clientSecret = overrides?.clientSecret ?? account.oauthClientSecret;

  const tokenFilePath =
    account.config.oauthTokenFile ??
    resolveTokenFilePath(account.accountId);

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
      const cmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";
      exec(`${cmd} ${JSON.stringify(url)}`);
    }
  };

  return performInteractiveLogin({
    clientId,
    clientSecret,
    store,
    useLegacyFormat: true,
    openBrowser,
    onStatus: (message: string) => {
      console.log(`[basecamp:oauth] ${message}`);
    },
  });
}
