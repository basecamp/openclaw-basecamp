/**
 * Basecamp status adapter — probes account health and builds snapshots.
 *
 * Uses bcq to verify authentication and connectivity. Builds the
 * ChannelAccountSnapshot used by `openclaw status` output.
 */

import type { ChannelStatusAdapter, ChannelAccountSnapshot } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { ResolvedBasecampAccount } from "../types.js";
import { bcqAuthStatus } from "../bcq.js";
import type { BcqOptions } from "../bcq.js";

export type BasecampProbe = {
  ok: boolean;
  authenticated: boolean;
  error?: string;
};

export const basecampStatusAdapter: ChannelStatusAdapter<ResolvedBasecampAccount, BasecampProbe> = {
  defaultRuntime: {
    accountId: DEFAULT_ACCOUNT_ID,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  },

  probeAccount: async ({ account }) => {
    const bcqOpts: BcqOptions = {};
    if (account.bcqProfile) {
      bcqOpts.profile = account.bcqProfile;
    }
    if (account.host) {
      bcqOpts.host = account.host;
    }

    try {
      const result = await bcqAuthStatus(bcqOpts);
      return {
        ok: result.data.authenticated,
        authenticated: result.data.authenticated,
      };
    } catch (err) {
      return {
        ok: false,
        authenticated: false,
        error: String(err),
      };
    }
  },

  buildAccountSnapshot: ({ account, runtime, probe }) => {
    const configured = Boolean(
      account.token?.trim() || account.config.tokenFile || account.bcqProfile,
    );
    return {
      accountId: account.accountId,
      name: account.displayName,
      enabled: account.enabled,
      configured,
      tokenSource: account.tokenSource,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
    };
  },

  buildChannelSummary: ({ snapshot }) => ({
    configured: snapshot.configured ?? false,
    tokenSource: snapshot.tokenSource ?? "none",
    running: snapshot.running ?? false,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
    probe: snapshot.probe,
  }),
};
