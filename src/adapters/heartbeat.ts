/**
 * Basecamp heartbeat adapter — delivery health checks.
 *
 * Implements ChannelHeartbeatAdapter for verifying auth readiness
 * and resolving heartbeat message recipients.
 *
 * For all token sources, uses the SDK client to verify the access token
 * is valid (auto-refreshing for OAuth accounts).
 */

import type { ChannelHeartbeatAdapter } from "openclaw/plugin-sdk";
import { getClient } from "../basecamp-client.js";
import { resolveBasecampAccount } from "../config.js";

export const basecampHeartbeatAdapter: ChannelHeartbeatAdapter = {
  checkReady: async ({ cfg, accountId }) => {
    const account = resolveBasecampAccount(cfg, accountId);

    if (account.tokenSource === "none") {
      return { ok: false, reason: "No authentication configured" };
    }

    try {
      const client = getClient(account);
      await client.authorization.getInfo();
      return { ok: true, reason: "Basecamp connection ready" };
    } catch (err) {
      return { ok: false, reason: `Auth check failed: ${String(err)}` };
    }
  },

  resolveRecipients: ({ cfg, opts }) => {
    // Explicit recipients from opts
    if (opts?.to) {
      return {
        recipients: [opts.to],
        source: "explicit",
      };
    }

    // allowFrom contains person IDs, but ping peer IDs require circle bucket
    // IDs (not person IDs). We cannot map person IDs to ping targets without
    // an API call to discover the circle. Return empty — heartbeat delivery
    // for Basecamp requires an explicit --to flag with a valid peer ID.
    return { recipients: [], source: "none" };
  },
};
