/**
 * Basecamp pairing adapter — handles DM allowlist entry normalization
 * and approval notifications.
 *
 * Basecamp uses person IDs (numeric strings) for allowlist entries.
 * Pairing approval sends a Ping message to the user via the Basecamp API.
 */

import type { ChannelPairingAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk";
import { getClient, rawOrThrow } from "../basecamp-client.js";
import { resolveBasecampAccount } from "../config.js";

export const basecampPairingAdapter: ChannelPairingAdapter = {
  idLabel: "basecampPersonId",

  normalizeAllowEntry: (entry) => {
    // Strip common prefixes like "basecamp:" or "bc:"
    const stripped = entry.replace(/^(basecamp|bc):/i, "").trim();
    // Person IDs are numeric — return as-is
    return stripped;
  },

  notifyApproval: async ({ cfg, id }) => {
    const account = resolveBasecampAccount(cfg);

    // Send a Ping message to the person via the circles endpoint.
    // This is NOT in the OpenAPI spec — use raw client.
    try {
      const client = getClient(account);
      await rawOrThrow(
        await client.raw.POST(`/circles/people/${id}/lines.json` as any, {
          body: { content: `<p>${PAIRING_APPROVED_MESSAGE}</p>` } as any,
        }),
      );
    } catch {
      // Ping delivery is best-effort; the person can check their status
      // via `openclaw pairing status` if they don't receive the message.
    }
  },
};
