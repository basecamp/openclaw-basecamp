/**
 * Basecamp security adapter — DM policy resolution and security audit findings.
 *
 * DM policy resolution goes through the SDK's scoped resolver so per-account
 * dmPolicy/allowFrom (channels.basecamp.accounts.<id>.*) take precedence over
 * the channel-level fields, with config paths computed accordingly
 * (SPEC §2.10). Warnings are structured SecurityAuditFinding[] built with
 * createConditionalWarningCollector.findings (SPEC §2.23).
 */

import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { createConditionalWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelSecurityAdapter, SecurityAuditFinding } from "../sdk-types.js";
import type { BasecampChannelConfig, ResolvedBasecampAccount } from "../types.js";

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

type AccountPolicyFields = { dmPolicy?: string; allowFrom?: Array<string | number> };

function accountPolicyFields(account: ResolvedBasecampAccount): AccountPolicyFields {
  return account.config as AccountPolicyFields;
}

// ---------------------------------------------------------------------------
// Finding collectors
// ---------------------------------------------------------------------------

type SecurityParams = { cfg: OpenClawConfig; accountId?: string | null; account: ResolvedBasecampAccount };

const collectOpenDmPolicyFindings = createConditionalWarningCollector.findings<SecurityParams>({
  checkId: "basecamp.dm.open-without-allowfrom",
  severity: "critical",
  title: "Open DM policy with empty allowlist",
  collectWarnings: ({ cfg }) => {
    const section = getBasecampSection(cfg);
    if (section?.dmPolicy === "open" && (!section.allowFrom || section.allowFrom.length === 0)) {
      return ['dmPolicy is "open" with no allowFrom entries — any Basecamp user can DM agents'];
    }
    return [];
  },
});

const collectDanglingPersonaFindings = createConditionalWarningCollector.findings<SecurityParams>({
  checkId: "basecamp.personas.dangling",
  severity: "warn",
  title: "Persona mapped to missing account",
  collectWarnings: ({ cfg }) => {
    const section = getBasecampSection(cfg);
    const personas = section?.personas ?? {};
    const accounts = section?.accounts ?? {};
    const warnings: string[] = [];
    for (const [agentId, targetAccountId] of Object.entries(personas)) {
      if (!accounts[targetAccountId]) {
        warnings.push(`Persona "${agentId}" maps to account "${targetAccountId}" which does not exist`);
      }
    }
    return warnings;
  },
});

const collectDanglingVirtualAccountFindings = createConditionalWarningCollector.findings<SecurityParams>({
  checkId: "basecamp.virtual-accounts.dangling",
  severity: "warn",
  title: "Virtual account references missing account",
  collectWarnings: ({ cfg }) => {
    const section = getBasecampSection(cfg);
    const virtualAccounts = section?.virtualAccounts ?? {};
    const accounts = section?.accounts ?? {};
    const warnings: string[] = [];
    for (const [scopeId, va] of Object.entries(virtualAccounts)) {
      if (!accounts[va.accountId]) {
        warnings.push(`Virtual account "${scopeId}" references backing account "${va.accountId}" which does not exist`);
      }
    }
    return warnings;
  },
});

const collectDuplicatePersonIdFindings = createConditionalWarningCollector.findings<SecurityParams>({
  checkId: "basecamp.accounts.duplicate-person-id",
  severity: "warn",
  title: "Duplicate personId across accounts",
  collectWarnings: ({ cfg }) => {
    const accounts = getBasecampSection(cfg)?.accounts ?? {};
    const personIdMap = new Map<string, string[]>();
    for (const [id, acct] of Object.entries(accounts)) {
      const pid = acct.personId;
      if (pid) {
        const existing = personIdMap.get(pid) ?? [];
        existing.push(id);
        personIdMap.set(pid, existing);
      }
    }
    const warnings: string[] = [];
    for (const [pid, ids] of personIdMap) {
      if (ids.length > 1) {
        warnings.push(`Person ID ${pid} is used by multiple accounts: ${ids.join(", ")}`);
      }
    }
    return warnings;
  },
});

const collectMissingAuthFindings = createConditionalWarningCollector.findings<SecurityParams>({
  checkId: "basecamp.accounts.no-auth",
  severity: "warn",
  title: "Account without credentials",
  collectWarnings: ({ cfg }) => {
    const accounts = getBasecampSection(cfg)?.accounts ?? {};
    const warnings: string[] = [];
    for (const [id, acct] of Object.entries(accounts)) {
      if (!acct.token && !acct.tokenFile && !acct.oauthTokenFile) {
        warnings.push(`Account "${id}" has no token, tokenFile, or oauthTokenFile configured`);
      }
    }
    return warnings;
  },
});

const collectNonNumericAllowFromFindings = createConditionalWarningCollector.findings<SecurityParams>({
  checkId: "basecamp.allowfrom.non-numeric",
  severity: "info",
  title: "allowFrom entry is not a person ID",
  collectWarnings: ({ cfg }) => {
    const allowFrom = getBasecampSection(cfg)?.allowFrom ?? [];
    const warnings: string[] = [];
    for (const entry of allowFrom) {
      const str = String(entry);
      if (str !== "*" && !/^\d+$/.test(str)) {
        warnings.push(`allowFrom entry "${str}" does not look like a numeric person ID`);
      }
    }
    return warnings;
  },
});

const FINDING_COLLECTORS = [
  collectOpenDmPolicyFindings,
  collectDanglingPersonaFindings,
  collectDanglingVirtualAccountFindings,
  collectDuplicatePersonIdFindings,
  collectMissingAuthFindings,
  collectNonNumericAllowFromFindings,
];

function collectBasecampSecurityFindings(params: SecurityParams): SecurityAuditFinding[] {
  if (!getBasecampSection(params.cfg)) return [];
  return FINDING_COLLECTORS.flatMap((collect) => collect(params));
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const basecampSecurityAdapter: ChannelSecurityAdapter<ResolvedBasecampAccount> = {
  resolveDmPolicy: createScopedDmSecurityResolver<ResolvedBasecampAccount>({
    channelKey: "basecamp",
    resolvePolicy: (account) => accountPolicyFields(account).dmPolicy,
    resolveAllowFrom: (account) => accountPolicyFields(account).allowFrom,
    resolveAccess: ({ cfg, account }) => {
      const section = getBasecampSection(cfg);
      const fields = accountPolicyFields(account);
      return {
        dmPolicy: fields.dmPolicy ?? section?.dmPolicy,
        allowFrom: fields.allowFrom ?? section?.allowFrom,
      };
    },
    defaultPolicy: "pairing",
    policyPathSuffix: "dmPolicy",
    allowFromPathSuffix: "allowFrom",
    approveHint: "Add the sender's Basecamp person ID to channels.basecamp.allowFrom",
  }),

  collectWarnings: async (params: SecurityParams) => collectBasecampSecurityFindings(params),

  collectAuditFindings: async (
    params: SecurityParams & {
      sourceConfig: OpenClawConfig;
      orderedAccountIds: string[];
      hasExplicitAccountPath: boolean;
    },
  ) => collectBasecampSecurityFindings(params),
};
