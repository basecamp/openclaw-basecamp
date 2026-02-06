/**
 * Basecamp pairing adapter — handles DM allowlist entry normalization
 * and approval notifications.
 *
 * Basecamp uses person IDs (numeric strings) for allowlist entries.
 * Pairing approval sends a Ping message to the user via bcq.
 */

import type { ChannelPairingAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk";
import { resolveBasecampAccount } from "../config.js";
import { bcqApiPost } from "../bcq.js";

export const basecampPairingAdapter: ChannelPairingAdapter = {
  idLabel: "basecampPersonId",

  normalizeAllowEntry: (entry) => {
    // Strip common prefixes like "basecamp:" or "bc:"
    const stripped = entry.replace(/^(basecamp|bc):/i, "").trim();
    // Person IDs are numeric — return as-is
    return stripped;
  },

  notifyApproval: async ({ cfg, id }) => {
    // Resolve the default account to get the bcq profile
    const account = resolveBasecampAccount(cfg);
    const profile = account.bcqProfile;

    // Send a Ping message to the person via bcq
    // bcq campfire dm sends a DM (Ping) to a person by ID
    try {
      await bcqApiPost(
        `/circles/people/${id}/lines.json`,
        JSON.stringify({ content: `<p>${PAIRING_APPROVED_MESSAGE}</p>` }),
        account.config.bcqAccountId ?? account.accountId,
        profile,
      );
    } catch {
      // Ping delivery is best-effort; the person can check their status
      // via `openclaw pairing status` if they don't receive the message.
    }
  },
};
