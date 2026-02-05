/**
 * Basecamp setup adapter — handles CLI `openclaw setup basecamp` operations.
 *
 * Manages account ID resolution, name application, input validation,
 * and config application for Basecamp accounts.
 */

import type { OpenClawConfig, ChannelSetupAdapter, ChannelSetupInput } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId, applyAccountNameToChannelSection } from "openclaw/plugin-sdk";
import type { BasecampChannelConfig } from "../types.js";

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

export const basecampSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),

  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: "basecamp",
      accountId,
      name,
    }),

  validateInput: ({ input }) => {
    // Basecamp accounts require a personId (set during onboarding or via config).
    // The setup command accepts token, tokenFile, or bcq profile for auth.
    if (!input.token && !input.tokenFile && !input.useEnv) {
      // bcq auth is acceptable — no token needed if bcqProfile is configured
      return null;
    }
    return null;
  },

  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: "basecamp",
      accountId,
      name: input.name,
    });

    const section = getBasecampSection(namedConfig) ?? {};
    const accounts = (section.accounts ?? {}) as Record<string, Record<string, unknown>>;
    const existingAccount = accounts[accountId] ?? {};

    const tokenConfig = input.tokenFile
      ? { tokenFile: input.tokenFile }
      : input.token
        ? { token: input.token }
        : {};

    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...namedConfig,
        channels: {
          ...namedConfig.channels,
          basecamp: {
            ...section,
            enabled: true,
            accounts: {
              ...accounts,
              [accountId]: {
                ...existingAccount,
                enabled: true,
                ...tokenConfig,
              },
            },
          },
        },
      };
    }

    return {
      ...namedConfig,
      channels: {
        ...namedConfig.channels,
        basecamp: {
          ...section,
          enabled: true,
          accounts: {
            ...accounts,
            [accountId]: {
              ...existingAccount,
              enabled: true,
              ...tokenConfig,
            },
          },
        },
      },
    };
  },
};
