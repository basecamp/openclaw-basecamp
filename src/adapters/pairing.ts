/**
 * Basecamp pairing adapter (SPEC §3.6) — built on the SDK text pairing
 * adapter. Allowlist entries are numeric Basecamp person IDs (with
 * `basecamp:`/`bc:` prefixes stripped); pairing/approval notifications are
 * delivered as Basecamp Pings via the circles endpoint (not in the OpenAPI
 * spec — raw client). Challenge issuance itself lives in the inbound
 * ingress path (dispatch.ts) via createChannelPairingChallengeIssuer.
 */

import { createPairingPrefixStripper, createTextPairingAdapter } from "openclaw/plugin-sdk/channel-pairing";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import { getClient, rawOrThrow } from "../basecamp-client.js";
import { resolveBasecampAccount } from "../config.js";
import type { ChannelPairingAdapter } from "../sdk-types.js";
import type { ResolvedBasecampAccount } from "../types.js";

/** Post a Ping line to a person. Best-effort delivery for pairing notices. */
export async function sendPairingPing(account: ResolvedBasecampAccount, personId: string, text: string): Promise<void> {
  const client = getClient(account);
  // Circles endpoint is not in the OpenAPI spec — raw client with loose types.
  await rawOrThrow(
    await client.raw.POST(
      `/circles/people/${personId}/lines.json` as never,
      {
        body: { content: `<p>${text}</p>` },
      } as never,
    ),
  );
}

export const basecampPairingAdapter: ChannelPairingAdapter = createTextPairingAdapter({
  idLabel: "basecampPersonId",
  message: PAIRING_APPROVED_MESSAGE,
  normalizeAllowEntry: createPairingPrefixStripper(/^(basecamp|bc):/i),
  notify: async ({ cfg, id, message }) => {
    const account = resolveBasecampAccount(cfg);
    try {
      await sendPairingPing(account, String(id), message);
    } catch {
      // Ping delivery is best-effort; the person can check their status
      // via `openclaw pairing list` if they don't receive the message.
    }
  },
});
