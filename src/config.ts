import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { buildChannelAccountSchemaParts, requireOpenAllowFrom } from "openclaw/plugin-sdk/channel-config-schema";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import { buildSecretInputSchema, registerSensitiveConfigSchema } from "openclaw/plugin-sdk/secret-input";
import { resolveSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { z } from "zod";
import { isValidLaunchpadClientId } from "./oauth-lite.js";
import type {
  BasecampAccountConfig,
  BasecampChannelConfig,
  BasecampVirtualAccountConfig,
  ResolvedBasecampAccount,
} from "./types.js";

// ---------------------------------------------------------------------------
// Zod schema for channels.basecamp config section (SPEC §2.10)
//
// Built on the SDK's common channel-account schema parts so Basecamp accounts
// carry the standard per-account policy leaves (dmPolicy, allowFrom,
// groupPolicy, mentionPatterns, historyLimit, markdown.tables, …) alongside
// the Basecamp-specific credential and identity fields.
// ---------------------------------------------------------------------------

/**
 * Secret-bearing config leaf: a literal string or a SecretRef
 * ({source: "env"|"file"|"exec"|"store", provider, id}). Registered as
 * sensitive so host config projections redact it.
 */
const SecretValueSchema = registerSensitiveConfigSchema(buildSecretInputSchema().optional());

const { accountShape, rootPolicyShape } = buildChannelAccountSchemaParts();

const BasecampAccountSchemaBase = z
  .object({
    ...accountShape,
    /** Path to a file containing the OAuth/bearer token. Sugar for {source:"file"} SecretRefs. */
    tokenFile: z.string().optional(),
    /** Inline token or SecretRef (prefer a SecretRef or tokenFile). */
    token: SecretValueSchema,
    /** Basecamp person ID for this service account. */
    personId: z.string().optional(),
    /** Human-readable display name. */
    displayName: z.string().optional(),
    /** Pre-resolved attachable SGID (auto-resolved at startup if absent). */
    attachableSgid: z.string().optional(),
    /** CLI profile name for identity discovery during setup (not used at runtime). */
    cliProfile: z.string().optional(),
    /** Numeric Basecamp account ID for SDK client creation. */
    basecampAccountId: z.string().optional(),
    /** Path to file where OAuth tokens are stored. Presence implies tokenSource "oauth". */
    oauthTokenFile: z.string().optional(),
    /** Per-account OAuth client ID override. */
    oauthClientId: z.string().optional(),
    /** Per-account OAuth client secret override (string or SecretRef). */
    oauthClientSecret: SecretValueSchema,
  })
  .strict();

const BasecampVirtualAccountSchema = z
  .object({
    accountId: z.string(),
    bucketId: z.string(),
  })
  .strict();

const EngagementTypeSchema = z.enum(["dm", "mention", "assignment", "checkin", "conversation", "activity"]);

const BasecampBucketConfigSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    enabled: z.boolean().optional(),
    engage: z.array(EngagementTypeSchema).optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

export const BasecampConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    ...rootPolicyShape,
    /** Display name for the default account; the SDK setup flow writes it at the channel root (single-account convention). */
    name: z.string().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    accounts: z.record(z.string(), BasecampAccountSchemaBase.optional()).optional(),
    virtualAccounts: z.record(z.string(), BasecampVirtualAccountSchema).optional(),
    personas: z.record(z.string(), z.string()).optional(),
    buckets: z.record(z.string(), BasecampBucketConfigSchema).optional(),
    engage: z.array(EngagementTypeSchema).optional(),
    /** Secret token for webhook URL verification (string or SecretRef). Required to accept webhook requests. */
    webhookSecret: SecretValueSchema,
    /** Webhook subscription management. */
    webhooks: z
      .object({
        payloadUrl: z.url().optional(),
        projects: z.array(z.string()).optional(),
        types: z.array(z.string()).optional(),
        autoRegister: z.boolean().optional(),
        deactivateOnStop: z.boolean().optional(),
      })
      .strict()
      .optional(),
    oauth: z
      .object({
        clientId: z.string(),
        clientSecret: SecretValueSchema,
      })
      .strict()
      .optional(),
    polling: z
      .object({
        activityIntervalMs: z.number().positive().optional(),
        readingsIntervalMs: z.number().positive().optional(),
        assignmentsIntervalMs: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    retry: z
      .object({
        maxAttempts: z.number().positive().optional(),
        baseDelayMs: z.number().positive().optional(),
        maxDelayMs: z.number().positive().optional(),
        jitter: z.boolean().optional(),
      })
      .strict()
      .optional(),
    circuitBreaker: z
      .object({
        threshold: z.number().positive().optional(),
        cooldownMs: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    safetyNet: z
      .object({
        projects: z.array(z.string()).optional(),
        intervalMs: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    reconciliation: z
      .object({
        enabled: z.boolean().optional(),
        intervalMs: z.number().positive().optional(),
        gapThreshold: z.number().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message: 'channels.basecamp.dmPolicy="open" requires channels.basecamp.allowFrom to include "*"',
    });
    for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
      if (!account) continue;
      requireOpenAllowFrom({
        policy: account.dmPolicy ?? value.dmPolicy,
        allowFrom: account.allowFrom ?? value.allowFrom,
        ctx,
        path: ["accounts", accountId, "allowFrom"],
        message:
          'channels.basecamp.accounts.*.dmPolicy="open" requires channels.basecamp.accounts.*.allowFrom ' +
          '(or channels.basecamp.allowFrom) to include "*"',
      });
    }
  });

// ---------------------------------------------------------------------------
// Secret-input helpers
// ---------------------------------------------------------------------------

/** Read state of a secret-bearing config leaf, without throwing on unresolved SecretRefs. */
export type BasecampSecretStatus = "available" | "configured_unavailable" | "missing";

/**
 * Inspect a secret-bearing config value (literal string or SecretRef).
 * Returns the literal value when available, plus a status usable by
 * read-only paths (`configured_unavailable` = a SecretRef the host has not
 * materialized into this config snapshot yet).
 */
export function inspectSecretValue(value: unknown, path: string): { status: BasecampSecretStatus; value?: string } {
  const resolution = resolveSecretInputString({ value, path, mode: "inspect" });
  return resolution.status === "available"
    ? { status: "available", value: resolution.value }
    : { status: resolution.status };
}

/** Resolve a secret-bearing config value to a string, or undefined when unset/unavailable. */
function resolveOptionalSecret(value: unknown, path: string): string | undefined {
  return inspectSecretValue(value, path).value;
}

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
 * List concrete account IDs configured under channels.basecamp.accounts.
 * Virtual (project-scoped) account aliases are excluded — they are routing
 * aliases for real accounts, not independent accounts that need workers.
 * Returns [DEFAULT_ACCOUNT_ID] if none are configured.
 */
export function listBasecampAccountIds(cfg: OpenClawConfig): string[] {
  const ids = new Set(listConfiguredAccountIds(cfg));

  if (ids.size === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return Array.from(ids).sort();
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
 * Expand `~` and `~/...` to the user's home directory and resolve to an
 * absolute path. Paths like `~username/...` are treated as literal.
 */
export function expandTokenFilePath(
  filePath: string,
  deps: { homedir: () => string; resolve: (...p: string[]) => string },
): string {
  if (filePath === "~") {
    return deps.homedir();
  }
  if (filePath.startsWith("~/")) {
    return deps.resolve(deps.homedir(), filePath.slice(2));
  }
  return deps.resolve(filePath);
}

/**
 * Read the token from a tokenFile path, returning the trimmed contents.
 * Expands `~` and `~/...` to the user's home directory.
 * Paths like `~username/...` are treated as literal (not expanded).
 */
export async function readTokenFile(filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const resolved = expandTokenFilePath(filePath, { homedir, resolve });
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
 * The token and oauthClientSecret fields accept SecretRefs; unresolved refs
 * still mark the account configured (tokenSource "config") with an empty
 * token, so read-only paths report `configured_unavailable` semantics
 * instead of "unconfigured".
 *
 * When accountId matches a virtualAccounts (project-scope) entry, the real
 * account is resolved and scopedBucketId is set on the result.
 */
export function resolveBasecampAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
  _visited?: Set<string>,
): ResolvedBasecampAccount {
  const effectiveId = normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID);
  const section = getBasecampSection(cfg);

  // Check if this is a project-scope (virtual account) entry
  const scope = resolveProjectScope(cfg, effectiveId);
  if (scope) {
    // Cycle detection: virtual accounts must not reference each other
    const visited = _visited ?? new Set<string>();
    if (visited.has(effectiveId)) {
      return {
        accountId: effectiveId,
        enabled: false,
        personId: "",
        token: "",
        tokenSource: "none",
        config: { personId: "" },
      };
    }
    visited.add(effectiveId);
    const resolved = resolveBasecampAccount(cfg, scope.accountId, visited);
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
      // Channel-level OAuth client credentials still apply to accounts that
      // have no config yet — first-time setup reuses them for browser login.
      oauthClientId: section?.oauth?.clientId,
      oauthClientSecret: resolveOptionalSecret(section?.oauth?.clientSecret, "channels.basecamp.oauth.clientSecret"),
      config: { personId: "" },
    };
  }

  let token = "";
  let tokenSource: ResolvedBasecampAccount["tokenSource"] = "none";

  const tokenStatus = inspectSecretValue(accountCfg.token, `channels.basecamp.accounts.${effectiveId}.token`);
  if (tokenStatus.status !== "missing") {
    // Literal value or a SecretRef the host has not materialized yet — either
    // way the account is configured with an inline token.
    token = tokenStatus.value ?? "";
    tokenSource = "config";
  }
  // tokenFile is resolved asynchronously at gateway start; here we mark intent
  if (tokenSource === "none" && accountCfg.tokenFile) {
    tokenSource = "tokenFile";
  }
  // oauthTokenFile means token lifecycle is managed by the OAuth credentials module
  if (tokenSource === "none" && accountCfg.oauthTokenFile) {
    tokenSource = "oauth";
  }

  const secretPath = (field: string) => `channels.basecamp.accounts.${effectiveId}.${field}`;
  const useAccountOAuthClient = isValidLaunchpadClientId(accountCfg.oauthClientId);

  return {
    accountId: effectiveId,
    enabled: accountCfg.enabled !== false,
    displayName:
      accountCfg.displayName ?? (effectiveId === DEFAULT_ACCOUNT_ID ? getBasecampSection(cfg)?.name : undefined),
    personId: accountCfg.personId ?? "",
    attachableSgid: accountCfg.attachableSgid,
    token,
    tokenSource,
    cliProfile: accountCfg.cliProfile,
    oauthClientId: useAccountOAuthClient ? accountCfg.oauthClientId : section?.oauth?.clientId,
    oauthClientSecret: useAccountOAuthClient
      ? resolveOptionalSecret(accountCfg.oauthClientSecret, secretPath("oauthClientSecret"))
      : resolveOptionalSecret(section?.oauth?.clientSecret, "channels.basecamp.oauth.clientSecret"),
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
  if (!account.token && account.tokenSource === "tokenFile" && account.config.tokenFile) {
    try {
      account.token = await readTokenFile(account.config.tokenFile);
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
export function resolvePersonaAccountId(cfg: OpenClawConfig, agentId: string): string | undefined {
  const section = getBasecampSection(cfg);
  return section?.personas?.[agentId];
}

/** Get polling interval config with defaults. */
export function resolvePollingIntervals(cfg: unknown) {
  const section = getBasecampSection(cfg as OpenClawConfig);
  return {
    activityIntervalMs: section?.polling?.activityIntervalMs ?? 120_000,
    readingsIntervalMs: section?.polling?.readingsIntervalMs ?? 60_000,
    assignmentsIntervalMs: section?.polling?.assignmentsIntervalMs ?? 300_000,
  };
}

/** Resolve retry options from config, with defaults. */
export function resolveRetryConfig(cfg: OpenClawConfig): {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
} {
  const section = getBasecampSection(cfg);
  return {
    maxAttempts: section?.retry?.maxAttempts ?? 3,
    baseDelayMs: section?.retry?.baseDelayMs ?? 1000,
    maxDelayMs: section?.retry?.maxDelayMs ?? 30000,
    jitter: section?.retry?.jitter ?? true,
  };
}

/** Resolve circuit breaker options from config, with defaults. */
export function resolveCircuitBreakerConfig(cfg: OpenClawConfig): { threshold: number; cooldownMs: number } {
  const section = getBasecampSection(cfg);
  return {
    threshold: section?.circuitBreaker?.threshold ?? 5,
    cooldownMs: section?.circuitBreaker?.cooldownMs ?? 5 * 60 * 1000,
  };
}

/**
 * Get the DM policy for Basecamp Pings. Defaults to "allowlist".
 * Per-account dmPolicy (channels.basecamp.accounts.<id>.dmPolicy) takes
 * precedence over the channel-level policy when an accountId is given.
 */
export function resolveBasecampDmPolicy(cfg: OpenClawConfig, accountId?: string | null) {
  const section = getBasecampSection(cfg);
  const accountPolicy = accountId
    ? (section?.accounts?.[normalizeAccountId(accountId)] as { dmPolicy?: string } | undefined)?.dmPolicy
    : undefined;
  return (accountPolicy ?? section?.dmPolicy ?? "pairing") as "pairing" | "allowlist" | "open" | "disabled";
}

/**
 * Get the allow-from list. Per-account allowFrom takes precedence over the
 * channel-level list when an accountId is given.
 */
export function resolveBasecampAllowFrom(cfg: OpenClawConfig, accountId?: string | null): string[] {
  const section = getBasecampSection(cfg);
  const accountAllowFrom = accountId
    ? (section?.accounts?.[normalizeAccountId(accountId)] as { allowFrom?: Array<string | number> } | undefined)
        ?.allowFrom
    : undefined;
  return (accountAllowFrom ?? section?.allowFrom ?? []).map((entry) => String(entry));
}

/**
 * Group history window for the inbound turn's session transcript
 * (SPEC §2.2 `sessionTranscript.historyLimit`). Per-account `historyLimit`
 * (SDK account schema part) → channel-level → `messages.groupChat.historyLimit`
 * → SDK default. Never negative; 0 disables the window.
 */
export function resolveBasecampHistoryLimit(cfg: OpenClawConfig, accountId?: string | null): number {
  const section = getBasecampSection(cfg);
  const accountLimit = accountId
    ? (section?.accounts?.[normalizeAccountId(accountId)] as { historyLimit?: number } | undefined)?.historyLimit
    : undefined;
  const limit =
    accountLimit ?? section?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT;
  return Math.max(0, Math.floor(limit));
}

/** Get the allow-from list for a specific bucket. Returns undefined if unset (all senders allowed). */
export function resolveBasecampBucketAllowFrom(cfg: OpenClawConfig, bucketId: string): string[] | undefined {
  const section = getBasecampSection(cfg);
  const bucketConfig = section?.buckets?.[bucketId] ?? section?.buckets?.["*"];
  if (!bucketConfig?.allowFrom) return undefined;
  return bucketConfig.allowFrom.map((entry) => String(entry));
}

/** Get the webhook secret (undefined = webhooks disabled). Accepts SecretRefs. */
export function resolveWebhookSecret(cfg: OpenClawConfig): string | undefined {
  const section = getBasecampSection(cfg);
  return resolveOptionalSecret(section?.webhookSecret, "channels.basecamp.webhookSecret");
}

/** Resolve webhook subscription config with defaults. */
export function resolveWebhooksConfig(cfg: OpenClawConfig): {
  payloadUrl?: string;
  projects: string[];
  types: string[];
  autoRegister: boolean;
  deactivateOnStop: boolean;
} {
  const section = getBasecampSection(cfg);
  const wh = section?.webhooks;
  return {
    payloadUrl: wh?.payloadUrl,
    projects: wh?.projects ?? [],
    types: wh?.types ?? [],
    autoRegister: wh?.autoRegister ?? true,
    deactivateOnStop: wh?.deactivateOnStop ?? false,
  };
}

/**
 * Resolve the concrete account ID that owns a given bucket.
 * Checks virtualAccounts for a scope mapping and returns the concrete
 * accountId (not the virtual alias key). Returns undefined if no mapping found.
 */
export function resolveAccountForBucket(cfg: OpenClawConfig, bucketId: string): string | undefined {
  const section = getBasecampSection(cfg);
  // Check virtualAccounts for a scope mapping to this bucket.
  // Return the concrete account ID — not the alias key — so callers can
  // look up per-account resources (secret registries, circuit breakers, etc.).
  if (section?.virtualAccounts) {
    for (const [_key, va] of Object.entries(section.virtualAccounts)) {
      if (va.bucketId === bucketId) return normalizeAccountId(va.accountId);
    }
  }
  // No virtual account mapping for this bucket
  return undefined;
}

/** Resolve safety net config with defaults. */
export function resolveSafetyNetConfig(cfg: OpenClawConfig): {
  projects: string[];
  intervalMs: number;
} {
  const section = getBasecampSection(cfg);
  return {
    projects: section?.safetyNet?.projects ?? [],
    intervalMs: section?.safetyNet?.intervalMs ?? 600_000,
  };
}

/** Resolve reconciliation config with defaults. */
export function resolveReconciliationConfig(cfg: OpenClawConfig): {
  enabled: boolean;
  intervalMs: number;
  gapThreshold: number;
} {
  const section = getBasecampSection(cfg);
  const rc = section?.reconciliation as { enabled?: boolean; intervalMs?: number; gapThreshold?: number } | undefined;
  return {
    enabled: rc?.enabled ?? true,
    intervalMs: rc?.intervalMs ?? 21_600_000,
    gapThreshold: rc?.gapThreshold ?? 3,
  };
}

/**
 * Scope webhook projects to a specific account.
 *
 * In multi-account mode, only projects mapped to this account via
 * virtualAccounts are included. Unmapped projects are allowed only when
 * there is exactly one concrete account (single-account mode).
 */
export function scopeWebhookProjects(opts: {
  cfg: OpenClawConfig;
  projects: string[];
  accountId: string;
  log?: { warn: (msg: string) => void };
}): string[] {
  const { cfg, projects, accountId, log } = opts;
  const concreteAccountIds = listBasecampAccountIds(cfg);
  const isSingleAccount = concreteAccountIds.length <= 1;

  return projects.filter((projectId) => {
    const owner = resolveAccountForBucket(cfg, projectId);
    if (owner) return owner === accountId;
    if (isSingleAccount) return true;
    log?.warn(
      `[${accountId}] skipping unmapped webhook project ${projectId} — ` +
        `add a virtualAccounts entry to assign it to an account`,
    );
    return false;
  });
}
