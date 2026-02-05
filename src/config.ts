import { z } from "zod";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type {
  BasecampAccountConfig,
  BasecampChannelConfig,
  BasecampVirtualAccountConfig,
  ResolvedBasecampAccount,
} from "./types.js";

// ---------------------------------------------------------------------------
// Zod schema for channels.basecamp config section
// ---------------------------------------------------------------------------

const BasecampAccountConfigSchema = z.object({
  tokenFile: z.string().optional(),
  token: z.string().optional(),
  personId: z.string(),
  displayName: z.string().optional(),
  attachableSgid: z.string().optional(),
  enabled: z.boolean().optional(),
  bcqProfile: z.string().optional(),
  bcqAccountId: z.string().optional(),
});

const BasecampVirtualAccountSchema = z.object({
  accountId: z.string(),
  bucketId: z.string(),
});

const BasecampBucketConfigSchema = z.object({
  requireMention: z.boolean().optional(),
  tools: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }).optional(),
  enabled: z.boolean().optional(),
});

export const BasecampConfigSchema = z.object({
  enabled: z.boolean().optional(),
  accounts: z.record(z.string(), BasecampAccountConfigSchema).optional(),
  virtualAccounts: z.record(z.string(), BasecampVirtualAccountSchema).optional(),
  personas: z.record(z.string(), z.string()).optional(),
  dmPolicy: z.enum(["open", "pairing", "closed"]).optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  buckets: z.record(z.string(), BasecampBucketConfigSchema).optional(),
  polling: z
    .object({
      activityIntervalMs: z.number().positive().optional(),
      readingsIntervalMs: z.number().positive().optional(),
      directPollIntervalMs: z.number().positive().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const section = getBasecampSection(cfg);
  const accounts = section?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (key) {
      ids.add(normalizeAccountId(key));
    }
  }
  return [...ids];
}

/**
 * List all account IDs configured under channels.basecamp.accounts,
 * including virtual (project-scoped) account keys.
 * Returns [DEFAULT_ACCOUNT_ID] if none are configured.
 */
export function listBasecampAccountIds(cfg: OpenClawConfig): string[] {
  const ids = new Set(listConfiguredAccountIds(cfg));

  // Include virtual account (project-scope) keys
  const section = getBasecampSection(cfg);
  const virtualAccounts = section?.virtualAccounts;
  if (virtualAccounts && typeof virtualAccounts === "object") {
    for (const key of Object.keys(virtualAccounts)) {
      if (key) ids.add(normalizeAccountId(key));
    }
  }

  if (ids.size === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].sort((a: string, b: string) => a.localeCompare(b));
}

/**
 * Resolve the default account ID. Returns the first configured account
 * or DEFAULT_ACCOUNT_ID if none exist.
 */
export function resolveDefaultBasecampAccountId(cfg: OpenClawConfig): string {
  const ids = listBasecampAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Read the token from a tokenFile path, returning the trimmed contents.
 * Expands `~` and `~/...` to the user's home directory.
 * Paths like `~username/...` are treated as literal (not expanded).
 */
async function readTokenFile(filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  let resolved: string;
  if (filePath === "~") {
    resolved = homedir();
  } else if (filePath.startsWith("~/")) {
    resolved = resolve(homedir(), filePath.slice(2));
  } else {
    resolved = resolve(filePath);
  }
  const content = await readFile(resolved, "utf-8");
  return content.trim();
}

/**
 * Resolve a project-scope entry by its key.
 * Returns the real account ID and scoped bucket ID, or undefined if not found.
 */
export function resolveProjectScope(
  cfg: OpenClawConfig,
  scopeId: string,
): { accountId: string; bucketId: string } | undefined {
  const section = getBasecampSection(cfg);
  const va = section?.virtualAccounts?.[scopeId] as BasecampVirtualAccountConfig | undefined;
  if (!va) return undefined;
  return { accountId: va.accountId, bucketId: va.bucketId };
}

/**
 * Synchronously resolve a Basecamp account from config.
 * Token loading from file is deferred — use the token field if available,
 * otherwise the gateway startup will load it.
 *
 * When accountId matches a virtualAccounts (project-scope) entry, the real
 * account is resolved and scopedBucketId is set on the result.
 */
export function resolveBasecampAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedBasecampAccount {
  const effectiveId = normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID);
  const section = getBasecampSection(cfg);

  // Check if this is a project-scope (virtual account) entry
  const scope = resolveProjectScope(cfg, effectiveId);
  if (scope) {
    const resolved = resolveBasecampAccount(cfg, scope.accountId);
    return {
      ...resolved,
      accountId: effectiveId,
      scopedBucketId: scope.bucketId,
    };
  }

  const accountCfg = section?.accounts?.[effectiveId] as BasecampAccountConfig | undefined;

  if (!accountCfg) {
    return {
      accountId: effectiveId,
      enabled: false,
      personId: "",
      token: "",
      tokenSource: "none",
      config: { personId: "" },
    };
  }

  let token = "";
  let tokenSource: ResolvedBasecampAccount["tokenSource"] = "none";

  if (accountCfg.token) {
    token = accountCfg.token.trim();
    tokenSource = "config";
  }
  // tokenFile is resolved asynchronously at gateway start; here we mark intent
  if (!token && accountCfg.tokenFile) {
    tokenSource = "tokenFile";
  }
  // If no token and no tokenFile, but a bcqProfile is configured, bcq manages auth
  if (!token && !accountCfg.tokenFile && accountCfg.bcqProfile) {
    tokenSource = "bcq";
  }

  return {
    accountId: effectiveId,
    enabled: accountCfg.enabled !== false,
    displayName: accountCfg.displayName,
    personId: accountCfg.personId,
    attachableSgid: accountCfg.attachableSgid,
    token,
    tokenSource,
    bcqProfile: accountCfg.bcqProfile,
    config: accountCfg,
  };
}

/**
 * Resolve account with async token loading (for gateway startup).
 */
export async function resolveBasecampAccountAsync(
  cfg: OpenClawConfig,
  accountId?: string | null,
): Promise<ResolvedBasecampAccount> {
  const account = resolveBasecampAccount(cfg, accountId);

  // If token is empty but tokenFile is configured, load it now
  if (!account.token && account.config.tokenFile) {
    try {
      account.token = await readTokenFile(account.config.tokenFile);
      account.tokenSource = "tokenFile";
    } catch (err) {
      // Token file missing or unreadable — log and leave as empty
      console.warn(`[basecamp] failed to read token file "${account.config.tokenFile}": ${String(err)}`);
      account.tokenSource = "none";
    }
  }

  return account;
}

/**
 * Resolve the persona (Basecamp account) for a given agent ID.
 * Returns undefined if no persona mapping exists.
 */
export function resolvePersonaAccountId(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  const section = getBasecampSection(cfg);
  return section?.personas?.[agentId];
}

/** Get polling interval config with defaults. */
export function resolvePollingIntervals(cfg: unknown) {
  const section = getBasecampSection(cfg as OpenClawConfig);
  return {
    activityIntervalMs: section?.polling?.activityIntervalMs ?? 120_000,
    readingsIntervalMs: section?.polling?.readingsIntervalMs ?? 60_000,
    directPollIntervalMs: section?.polling?.directPollIntervalMs ?? 300_000,
  };
}

/** Get the DM policy for Basecamp Pings. */
export function resolveBasecampDmPolicy(cfg: OpenClawConfig) {
  const section = getBasecampSection(cfg);
  return section?.dmPolicy ?? "open";
}

/** Get the allow-from list. */
export function resolveBasecampAllowFrom(cfg: OpenClawConfig): string[] {
  const section = getBasecampSection(cfg);
  return (section?.allowFrom ?? []).map((entry) => String(entry));
}
