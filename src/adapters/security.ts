/**
 * Basecamp security adapter — DM policy resolution and config warnings.
 *
 * Extracted from channel.ts inline security object. Adds collectWarnings()
 * to flag configuration issues at startup.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { BasecampChannelConfig, ResolvedBasecampAccount } from "../types.js";

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

export const basecampSecurityAdapter = {
  resolveDmPolicy: ({ cfg, accountId: _accountId, account: _account }: { cfg: OpenClawConfig; accountId?: string | null; account: ResolvedBasecampAccount }) => {
    const section = getBasecampSection(cfg);
    const dmPolicy = section?.dmPolicy ?? "pairing";
    const allowFrom = section?.allowFrom ?? [];
    // DM policy is channel-level (channels.basecamp.dmPolicy), not per-account.
    const basePath = "channels.basecamp.";
    return {
      policy: dmPolicy,
      allowFrom,
      policyPath: `${basePath}dmPolicy`,
      allowFromPath: basePath,
      approveHint: `Add the sender's Basecamp person ID to ${basePath}allowFrom`,
    };
  },

  collectWarnings: async ({ cfg, account: _account }: { cfg: OpenClawConfig; accountId?: string | null; account: ResolvedBasecampAccount }): Promise<string[]> => {
    const section = getBasecampSection(cfg);
    if (!section) return [];

    const warnings: string[] = [];

    // 1. Open DM policy with no allowFrom entries
    if (section.dmPolicy === "open" && (!section.allowFrom || section.allowFrom.length === 0)) {
      warnings.push(
        "dmPolicy is \"open\" with no allowFrom entries — any Basecamp user can DM agents",
      );
    }

    // 2. Persona mapping references non-existent account
    const personas = section.personas ?? {};
    const accounts = section.accounts ?? {};
    for (const [agentId, targetAccountId] of Object.entries(personas)) {
      if (!accounts[targetAccountId]) {
        warnings.push(
          `Persona "${agentId}" maps to account "${targetAccountId}" which does not exist`,
        );
      }
    }

    // 3. Virtual account references non-existent backing account
    const virtualAccounts = section.virtualAccounts ?? {};
    for (const [scopeId, va] of Object.entries(virtualAccounts)) {
      if (!accounts[va.accountId]) {
        warnings.push(
          `Virtual account "${scopeId}" references backing account "${va.accountId}" which does not exist`,
        );
      }
    }

    // 4. Duplicate personId across accounts
    const personIdMap = new Map<string, string[]>();
    for (const [id, acct] of Object.entries(accounts)) {
      const pid = acct.personId;
      if (pid) {
        const existing = personIdMap.get(pid) ?? [];
        existing.push(id);
        personIdMap.set(pid, existing);
      }
    }
    for (const [pid, ids] of personIdMap) {
      if (ids.length > 1) {
        warnings.push(
          `Person ID ${pid} is used by multiple accounts: ${ids.join(", ")}`,
        );
      }
    }

    // 5. Account has no auth configured
    for (const [id, acct] of Object.entries(accounts)) {
      if (!acct.token && !acct.tokenFile && !acct.oauthTokenFile) {
        warnings.push(
          `Account "${id}" has no token, tokenFile, or oauthTokenFile configured`,
        );
      }
    }

    // 6. allowFrom entries that don't look like numeric person IDs
    const allowFrom = section.allowFrom ?? [];
    for (const entry of allowFrom) {
      const str = String(entry);
      if (!/^\d+$/.test(str)) {
        warnings.push(
          `allowFrom entry "${str}" does not look like a numeric person ID`,
        );
      }
    }

    return warnings;
  },
};
