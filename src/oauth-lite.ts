/**
 * Import-light OAuth helpers.
 *
 * These live outside oauth-credentials.ts so that modules on the setup-entry
 * import graph (config.ts, channel-setup.ts, adapters/onboarding.ts) can use
 * them without dragging in @37signals/basecamp/oauth. oauth-credentials.ts
 * re-exports them for the rest of the plugin.
 */

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
