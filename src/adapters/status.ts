/**
 * Basecamp status adapter — probes account health and builds snapshots.
 *
 * Uses bcq to verify authentication and connectivity. Builds the
 * ChannelAccountSnapshot used by `openclaw status` output.
 * Enhanced with identity resolution, project audit, persona validation,
 * and status issue collection.
 */

import type { ChannelStatusAdapter, ChannelAccountSnapshot, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, createDefaultChannelRuntimeState, buildBaseChannelStatusSummary } from "openclaw/plugin-sdk";
import type { ResolvedBasecampAccount, BasecampChannelConfig, BasecampProject } from "../types.js";
import { bcqAuthStatus, bcqMe, bcqApiGet } from "../bcq.js";
import type { BcqOptions } from "../bcq.js";
import { resolveBasecampAccount } from "../config.js";
import { getAccountMetrics } from "../metrics.js";
import type { AccountMetrics, PollerSourceMetrics } from "../metrics.js";

export type BasecampProbe = {
  ok: boolean;
  authenticated: boolean;
  personName?: string;
  accountCount?: number;
  error?: string;
  /** Operational metrics snapshot (populated from in-memory metrics registry). */
  metrics?: AccountMetrics;
};

export type BasecampAudit = {
  projectsAccessible: number;
  personasMapped: number;
  personasValid: number;
  errors: Array<{ kind: "config" | "runtime"; message: string }>;
  /** Whether personId is set for self-message filtering. */
  personIdSet?: boolean;
  /** Poller lag per source (seconds since last successful poll, null if never polled). */
  pollerLag?: {
    activity: number | null;
    readings: number | null;
    assignments: number | null;
  };
  /** Circuit breaker states for outbound delivery. */
  circuitBreakers?: Record<string, { state: string; failures: number }>;
  /** Dedup store sizes. */
  dedupSize?: number;
  webhookDedupSize?: number;
  /** Webhook handler stats. */
  webhookStats?: {
    received: number;
    dispatched: number;
    dropped: number;
    errors: number;
  };
  /** Count of dispatch failures (dead-lettered events). */
  dispatchFailures?: number;
  /** Count of events dropped due to full dispatch queue. */
  queueFullDrops?: number;
  /** Count of events dropped because their kind was not in KIND_TO_RECORDABLE_TYPE. */
  unknownKindCount?: number;
  /** Most recent unknown kind string (for diagnostics). */
  lastUnknownKind?: string | null;
};

/** Seconds since last successful poll, or null if never succeeded. */
function pollerLagSeconds(source: PollerSourceMetrics): number | null {
  if (!source.lastSuccessAt) return null;
  return Math.round((Date.now() - source.lastSuccessAt) / 1000);
}

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

export const basecampStatusAdapter: ChannelStatusAdapter<ResolvedBasecampAccount, BasecampProbe, BasecampAudit> = {
  defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),

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
        const metrics = getAccountMetrics(account.accountId);
        return { ok: false, authenticated: false, metrics };
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

      const metrics = getAccountMetrics(account.accountId);
      return { ok: true, authenticated: true, personName, accountCount, metrics };
    } catch (err) {
      const metrics = getAccountMetrics(account.accountId);
      return {
        ok: false,
        authenticated: false,
        error: String(err),
        metrics,
      };
    }
  },

  auditAccount: async ({ account, cfg, probe }) => {
    const errors: Array<{ kind: "config" | "runtime"; message: string }> = [];
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
      errors.push({ kind: "runtime", message: `Failed to verify project access: ${String(err)}` });
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
          errors.push({ kind: "config", message: `Persona "${agentId}" → account "${targetAccountId}": no auth configured` });
        }
      } else {
        errors.push({ kind: "config", message: `Persona "${agentId}" → account "${targetAccountId}": account does not exist` });
      }
    }

    // Enrich with operational metrics
    const metrics = getAccountMetrics(account.accountId);
    const result: BasecampAudit = { projectsAccessible, personasMapped, personasValid, errors, personIdSet: !!account.personId };

    if (metrics) {
      result.pollerLag = {
        activity: pollerLagSeconds(metrics.poller.activity),
        readings: pollerLagSeconds(metrics.poller.readings),
        assignments: pollerLagSeconds(metrics.poller.assignments),
      };

      if (Object.keys(metrics.circuitBreaker).length > 0) {
        result.circuitBreakers = {};
        for (const [key, cb] of Object.entries(metrics.circuitBreaker)) {
          result.circuitBreakers[key] = { state: cb.state, failures: cb.failures };
        }
      }

      result.dedupSize = metrics.dedupSize;
      result.webhookDedupSize = metrics.webhookDedupSize;

      result.webhookStats = {
        received: metrics.webhook.receivedCount,
        dispatched: metrics.webhook.dispatchedCount,
        dropped: metrics.webhook.droppedCount,
        errors: metrics.webhook.errorCount,
      };

      if (metrics.dispatchFailureCount > 0) {
        result.dispatchFailures = metrics.dispatchFailureCount;
      }
      if (metrics.queueFullDropCount > 0) {
        result.queueFullDrops = metrics.queueFullDropCount;
      }
      if (metrics.unknownKindCount > 0) {
        result.unknownKindCount = metrics.unknownKindCount;
        result.lastUnknownKind = metrics.lastUnknownKind;
      }
    }

    return result;
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
    ...buildBaseChannelStatusSummary(snapshot),
    tokenSource: snapshot.tokenSource ?? "none",
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
    const issues: Array<{
      channel: "basecamp";
      accountId: string;
      kind: "auth" | "runtime" | "config";
      message: string;
      fix?: string;
    }> = [];

    for (const s of accounts) {
      const probe = s.probe as BasecampProbe | undefined;

      // Unauthenticated accounts
      if (probe && !probe.authenticated) {
        issues.push({
          channel: "basecamp",
          accountId: s.accountId,
          kind: "auth",
          message: "Account is not authenticated",
          fix: "Run `bcq auth login` to authenticate",
        });
      }

      // Configured but never started (no runtime record)
      if (s.configured && s.enabled && !s.running && !s.lastStartAt) {
        issues.push({
          channel: "basecamp",
          accountId: s.accountId,
          kind: "runtime",
          message: "Account is configured but has never started",
          fix: "Start the channel with `openclaw start` or check gateway logs",
        });
      }

      // Missing personId — risk of self-message loops
      const audit = s.audit as BasecampAudit | undefined;
      if (audit && audit.personIdSet === false) {
        issues.push({
          channel: "basecamp",
          accountId: s.accountId,
          kind: "config",
          message: "personId is not set — self-message filtering disabled (risk of response loops)",
          fix: `Set channels.basecamp.accounts.${s.accountId}.personId`,
        });
      }

      // Surface audit errors (persona misconfigs, project access failures)
      if (audit?.errors) {
        for (const err of audit.errors) {
          issues.push({
            channel: "basecamp",
            accountId: s.accountId,
            kind: err.kind,
            message: err.message,
          });
        }
      }

      // Operational issues from audit metrics
      if (audit?.pollerLag) {
        const LAG_THRESHOLD_S = 600; // 10 minutes
        for (const [source, lag] of Object.entries(audit.pollerLag)) {
          if (lag !== null && lag > LAG_THRESHOLD_S) {
            issues.push({
              channel: "basecamp",
              accountId: s.accountId,
              kind: "runtime",
              message: `Poller source "${source}" is lagging (${lag}s since last success)`,
              fix: "Check gateway logs for errors or network issues",
            });
          }
        }
      }
      if (audit?.circuitBreakers) {
        for (const [key, cb] of Object.entries(audit.circuitBreakers)) {
          if (cb.state === "open") {
            issues.push({
              channel: "basecamp",
              accountId: s.accountId,
              kind: "runtime",
              message: `Circuit breaker "${key}" is open (${cb.failures} failures)`,
              fix: "Check Basecamp API availability and authentication",
            });
          }
        }
      }
      if (audit?.dispatchFailures && audit.dispatchFailures > 0) {
        issues.push({
          channel: "basecamp",
          accountId: s.accountId,
          kind: "runtime",
          message: `${audit.dispatchFailures} dispatch failure(s) (dead-lettered events)`,
          fix: "Check gateway logs for dead_letter entries with correlationId for details",
        });
      }
      if (audit?.queueFullDrops && audit.queueFullDrops > 0) {
        issues.push({
          channel: "basecamp",
          accountId: s.accountId,
          kind: "runtime",
          message: `${audit.queueFullDrops} event(s) dropped due to full dispatch queue`,
          fix: "Check for slow agent responses or increase dispatch concurrency",
        });
      }
      if (audit?.unknownKindCount && audit.unknownKindCount > 0) {
        issues.push({
          channel: "basecamp",
          accountId: s.accountId,
          kind: "runtime",
          message: `${audit.unknownKindCount} event(s) dropped with unknown kind (last: ${audit.lastUnknownKind ?? "?"})`,
          fix: "Add the kind to KIND_TO_RECORDABLE_TYPE in normalize.ts, or upgrade the plugin",
        });
      }
    }

    return issues;
  },
};
