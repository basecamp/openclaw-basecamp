/**
 * Import-light OAuth constants shared by config and setup surfaces.
 *
 * `src/oauth-credentials.ts` pulls in `@37signals/basecamp/oauth` at module
 * load; these pure helpers live here so `src/config.ts` (and through it the
 * setup entry, SPEC §1.4) can validate OAuth client IDs without dragging the
 * Basecamp SDK into the setup-entry import graph. Re-exported from
 * `src/oauth-credentials.ts` for existing callers.
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
