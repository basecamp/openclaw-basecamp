/**
 * Basecamp doctor adapter (SPEC §2.23).
 *
 * Declares the channel's config shape for the shared doctor checks
 * (dmAllowFromMode "topOnly": canonical DM fields live at the channel/account
 * top level; groupModel "route": group access rides on route allowlists) and
 * repairs:
 *   - dangling persona refs (personas → accounts that don't exist)
 *   - dmPolicy "open" without "*" in the effective allowFrom
 *   - cliProfile-only accounts (warn — credentials can't be fabricated)
 *
 * State migrations are intentionally NOT implemented (user waived migrations).
 *
 * This module must stay import-light: `src/doctor-contract-api.ts` re-exports
 * the repair logic for the host's cold-loaded doctor contract.
 */

import { ensureOpenDmPolicyAllowFromWildcard } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelDoctorAdapter } from "../sdk-types.js";
import type { BasecampChannelConfig } from "../types.js";

type DoctorMutation = { config: OpenClawConfig; changes: string[]; warnings?: string[] };

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

/**
 * Pure config repair shared by the runtime doctor adapter and the
 * cold-loaded doctor contract sidecar.
 */
export function repairBasecampConfig({ cfg }: { cfg: OpenClawConfig }): DoctorMutation {
  const section = getBasecampSection(cfg);
  if (!section) {
    return { config: cfg, changes: [], warnings: [] };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  const next: Record<string, unknown> = { ...section };

  // --- Dangling persona refs ---------------------------------------------
  const accounts = (section.accounts ?? {}) as Record<string, Record<string, unknown>>;
  if (section.personas) {
    // virtualAccounts aliases are valid persona targets — they resolve to a
    // concrete account with a project scope at dispatch time.
    const virtualAccounts = (section.virtualAccounts ?? {}) as Record<string, unknown>;
    const cleaned: Record<string, string> = {};
    for (const [agentId, targetAccountId] of Object.entries(section.personas)) {
      if (accounts[targetAccountId] || virtualAccounts[targetAccountId]) {
        cleaned[agentId] = targetAccountId;
      } else {
        changes.push(`channels.basecamp.personas.${agentId}: removed — account "${targetAccountId}" does not exist`);
      }
    }
    if (Object.keys(cleaned).length !== Object.keys(section.personas).length) {
      next.personas = cleaned;
    }
  }

  // --- dmPolicy "open" without "*" in allowFrom ---------------------------
  ensureOpenDmPolicyAllowFromWildcard({
    entry: next,
    mode: "topOnly",
    pathPrefix: "channels.basecamp.",
    changes,
  });
  if (section.accounts) {
    const repairedAccounts: Record<string, Record<string, unknown>> = {};
    let accountsChanged = false;
    const channelPolicy = (next.dmPolicy ?? section.dmPolicy) as string | undefined;
    for (const [accountId, account] of Object.entries(accounts)) {
      const entry: Record<string, unknown> = { ...account };
      const before = changes.length;
      ensureOpenDmPolicyAllowFromWildcard({
        entry,
        mode: "topOnly",
        pathPrefix: `channels.basecamp.accounts.${accountId}.`,
        changes,
      });
      // The helper only sees explicit per-account policies; an account that
      // overrides allowFrom under an inherited channel-level "open" policy
      // still needs the wildcard the schema requires.
      const effectivePolicy = (entry.dmPolicy as string | undefined) ?? channelPolicy;
      const allowFrom = entry.allowFrom as Array<string | number> | undefined;
      if (effectivePolicy === "open" && Array.isArray(allowFrom) && !allowFrom.map(String).includes("*")) {
        entry.allowFrom = [...allowFrom, "*"];
        changes.push(
          `channels.basecamp.accounts.${accountId}.allowFrom: added "*" (inherited dmPolicy "open" requires it)`,
        );
      }
      repairedAccounts[accountId] = changes.length > before ? entry : account;
      accountsChanged = accountsChanged || changes.length > before;
    }
    if (accountsChanged) {
      next.accounts = repairedAccounts;
    }
  }

  // --- cliProfile-only accounts (warn only) -------------------------------
  for (const [accountId, account] of Object.entries(accounts)) {
    if (account.cliProfile && !account.token && !account.tokenFile && !account.oauthTokenFile) {
      warnings.push(
        `channels.basecamp.accounts.${accountId}: only a cliProfile is configured — the CLI profile is ` +
          `setup-time sugar, not runtime auth. Re-run \`openclaw channels add basecamp\` to store credentials.`,
      );
    }
  }

  const config: OpenClawConfig =
    changes.length > 0
      ? {
          ...cfg,
          channels: {
            ...cfg.channels,
            basecamp: next,
          },
        }
      : cfg;

  return { config, changes, warnings };
}

/**
 * Preview variant: reports what `repairConfig` would change without mutating.
 */
export function collectBasecampDoctorWarnings({
  cfg,
  doctorFixCommand,
}: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
}): string[] {
  const { changes, warnings } = repairBasecampConfig({ cfg });
  return [...changes.map((change) => `${change} (run \`${doctorFixCommand}\` to fix)`), ...(warnings ?? [])];
}

export const basecampDoctorAdapter = {
  dmAllowFromMode: "topOnly",
  groupModel: "route",
  collectPreviewWarnings: ({ cfg, doctorFixCommand }) => collectBasecampDoctorWarnings({ cfg, doctorFixCommand }),
  repairConfig: ({ cfg }) => repairBasecampConfig({ cfg }),
} satisfies ChannelDoctorAdapter;
