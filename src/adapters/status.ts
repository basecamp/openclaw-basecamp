/**
 * Basecamp status adapter — probes account health and builds snapshots.
 *
 * Uses bcq to verify authentication and connectivity. Builds the
 * ChannelAccountSnapshot used by `openclaw status` output.
 * Enhanced with identity resolution, project audit, persona validation,
 * and status issue collection.
 */

import type { ChannelStatusAdapter, ChannelAccountSnapshot, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { ResolvedBasecampAccount, BasecampChannelConfig, BasecampProject } from "../types.js";
import { bcqAuthStatus, bcqMe, bcqApiGet } from "../bcq.js";
import type { BcqOptions } from "../bcq.js";
import { resolveBasecampAccount } from "../config.js";

export type BasecampProbe = {
  ok: boolean;
  authenticated: boolean;
  personName?: string;
  accountCount?: number;
  error?: string;
};

export type BasecampAudit = {
  projectsAccessible: number;
  personasMapped: number;
  personasValid: number;
  errors: string[];
};

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

export const basecampStatusAdapter: ChannelStatusAdapter<ResolvedBasecampAccount, BasecampProbe, BasecampAudit> = {
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
    if (account.config.bcqAccountId) {
      bcqOpts.accountId = account.config.bcqAccountId;
    }

    try {
      const result = await bcqAuthStatus(bcqOpts);
      if (!result.data.authenticated) {
        return { ok: false, authenticated: false };
      }

      // Also call bcqMe to get identity details
      let personName: string | undefined;
      let accountCount: number | undefined;
      try {
        const meResult = await bcqMe(bcqOpts);
        const data = meResult.data as unknown as {
          name?: string;
          accounts?: unknown[];
        };
        personName = data.name;
        accountCount = Array.isArray(data.accounts) ? data.accounts.length : undefined;
      } catch {
        // Identity fetch is best-effort
      }

      return { ok: true, authenticated: true, personName, accountCount };
    } catch (err) {
      return {
        ok: false,
        authenticated: false,
        error: String(err),
      };
    }
  },

  auditAccount: async ({ account, cfg, probe }) => {
    const errors: string[] = [];
    const opts: BcqOptions = {
      profile: account.bcqProfile,
      accountId: account.config.bcqAccountId,
    };

    // Check project access
    let projectsAccessible = 0;
    try {
      const projects = await bcqApiGet<BasecampProject[]>("/projects.json", opts.accountId, opts.profile);
      if (Array.isArray(projects)) {
        projectsAccessible = projects.length;
      }
    } catch (err) {
      errors.push(`Failed to verify project access: ${String(err)}`);
    }

    // Validate persona mappings
    const section = getBasecampSection(cfg);
    const personas = section?.personas ?? {};
    const accounts = section?.accounts ?? {};
    let personasMapped = 0;
    let personasValid = 0;

    for (const [agentId, targetAccountId] of Object.entries(personas)) {
      personasMapped++;
      if (accounts[targetAccountId]) {
        const resolved = resolveBasecampAccount(cfg, targetAccountId);
        if (resolved.token || resolved.bcqProfile || resolved.config.tokenFile) {
          personasValid++;
        } else {
          errors.push(`Persona "${agentId}" → account "${targetAccountId}": no auth configured`);
        }
      } else {
        errors.push(`Persona "${agentId}" → account "${targetAccountId}": account does not exist`);
      }
    }

    return { projectsAccessible, personasMapped, personasValid, errors };
  },

  buildAccountSnapshot: ({ account, runtime, probe, audit }) => {
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
      audit,
      personName: probe?.personName,
      accountCount: probe?.accountCount,
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

  logSelfId: ({ account }) => {
    const name = account.displayName ?? "unknown";
    console.log(`[basecamp:${account.accountId}] identity: ${name} (personId=${account.personId})`);
  },

  resolveAccountState: ({ account, configured, enabled }) => {
    if (!enabled) return "disabled";
    if (!configured) return "not configured";
    return "configured";
  },

  collectStatusIssues: (accounts) => {
    // Status issues are collected per-channel from the account snapshots.
    // Return issues for accounts with problems.
    return accounts
      .filter((s) => {
        const probe = s.probe as BasecampProbe | undefined;
        return probe && !probe.authenticated;
      })
      .map((s) => ({
        channel: "basecamp" as const,
        accountId: s.accountId,
        kind: "auth" as const,
        message: "Account is not authenticated",
        fix: "Run `bcq auth login` to authenticate",
      }));
  },
};
