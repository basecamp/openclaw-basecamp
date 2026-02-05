/**
 * Basecamp heartbeat adapter — delivery health checks.
 *
 * Implements ChannelHeartbeatAdapter for verifying bcq auth readiness
 * and resolving heartbeat message recipients.
 */

import type { ChannelHeartbeatAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
import type { BasecampChannelConfig } from "../types.js";
import { resolveBasecampAccount } from "../config.js";
import { bcqAuthStatus } from "../bcq.js";

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

export const basecampHeartbeatAdapter: ChannelHeartbeatAdapter = {
  checkReady: async ({ cfg, accountId }) => {
    const account = resolveBasecampAccount(cfg, accountId);

    if (!account.bcqProfile && !account.token) {
      return { ok: false, reason: "No bcq profile or token configured" };
    }

    if (account.bcqProfile) {
      try {
        const result = await bcqAuthStatus({ profile: account.bcqProfile });
        if (!result.data.authenticated) {
          return { ok: false, reason: `bcq profile "${account.bcqProfile}" is not authenticated` };
        }
      } catch (err) {
        return { ok: false, reason: `bcq auth check failed: ${String(err)}` };
      }
    }

    return { ok: true, reason: "Basecamp connection ready" };
  },

  resolveRecipients: ({ cfg, opts }) => {
    // Explicit recipients from opts
    if (opts?.to) {
      return {
        recipients: [opts.to],
        source: "explicit",
      };
    }

    // Map allowFrom entries to ping:<personId> targets
    const section = getBasecampSection(cfg);
    const allowFrom = section?.allowFrom;
    if (allowFrom && allowFrom.length > 0) {
      return {
        recipients: allowFrom.map((id) => `ping:${id}`),
        source: "allowFrom",
      };
    }

    return { recipients: [], source: "none" };
  },
};
