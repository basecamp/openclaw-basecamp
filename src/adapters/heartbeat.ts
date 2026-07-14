/**
 * Basecamp heartbeat adapter — delivery health checks.
 *
 * Implements ChannelHeartbeatAdapter for verifying auth readiness.
 *
 * For all token sources, uses the SDK client to verify the access token
 * is valid (auto-refreshing for OAuth accounts).
 */

import type { ChannelHeartbeatAdapter } from "openclaw/plugin-sdk/channel-runtime";
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
};
