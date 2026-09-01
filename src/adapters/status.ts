/**
 * Basecamp status adapter — probes account health and builds snapshots.
 *
 * Uses the SDK client to verify authentication and connectivity for all
 * token sources. The client's TokenProvider handles auth per source
 * (static token for "config", file read for "tokenFile", auto-refresh
 * for "oauth").
 *
 * Built on the SDK's computed-status helpers (SPEC §2.18): the runtime
 * default state, per-account snapshot, and channel summary all come from
 * `status-helpers`/`channel-status`, while Basecamp-owned extras (token
 * source, audit, operational metrics) ride in the snapshot's extra fields.
 *
 * Lifecycle surfacing: the gateway publishes "starting"/"ready"/"blocked"/
 * "stopped" through status patches; this adapter overrides to "recovering"
 * while a poller circuit breaker is open and "blocked" when the probe shows
 * an auth failure, sets `ingressUnavailable` when the webhook route/secret
 * store is broken, and derives `lastTransportActivityAt` from poller ticks.
 */

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type {
  ChannelAccountSnapshot,
  ChannelStatusAdapter,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTransportActivityStatusPatch } from "openclaw/plugin-sdk/gateway-runtime";
import {
  buildTokenChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { getClient } from "../basecamp-client.js";
import { resolveBasecampAccount } from "../config.js";
import type { AccountMetrics, PollerSourceMetrics } from "../metrics.js";
import { getAccountMetrics } from "../metrics.js";
import type { BasecampChannelConfig, ResolvedBasecampAccount } from "../types.js";

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
    safetyNet: number | null;
  };
  /** Circuit breaker states for outbound delivery. */
  circuitBreakers?: Record<string, { state: string; failures: number }>;
  /** Dedup store sizes. */
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
  /** Reconciliation pass stats. */
  reconciliation?: {
    lastRunAt: number | null;
    replayed: number;
    unseen: number;
    promotedTypes: string[];
  };
  /** Webhook auth method distribution. */
  webhookAuthMethods?: Record<string, number>;
};

/** Seconds since last successful poll, or null if never succeeded. */
function pollerLagSeconds(source: PollerSourceMetrics): number | null {
  if (!source.lastSuccessAt) return null;
  return Math.round((Date.now() - source.lastSuccessAt) / 1000);
}

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

/** Latest poller transport activity (successful tick) across all sources. */
function latestTransportActivityAt(metrics: AccountMetrics | undefined): number | null {
  if (!metrics) return null;
  const at = Math.max(
    metrics.poller.activity.lastSuccessAt ?? 0,
    metrics.poller.readings.lastSuccessAt ?? 0,
    metrics.poller.assignments.lastSuccessAt ?? 0,
    metrics.poller.safetyNet.lastSuccessAt ?? 0,
    metrics.webhook.lastReceivedAt ?? 0,
  );
  return at > 0 ? at : null;
}

/** True when any recorded poller/dispatch circuit breaker is currently open. */
function anyBreakerOpen(metrics: AccountMetrics | undefined): boolean {
  return Object.values(metrics?.circuitBreaker ?? {}).some((cb) => cb.state === "open");
}

/** Snapshot extras owned by this channel (ride alongside the standard fields). */
type BasecampSnapshotExtra = {
  tokenSource: "tokenFile" | "config" | "oauth" | "none";
  cliProfile?: string;
  audit?: BasecampAudit;
  personName?: string;
  accountCount?: number;
  lifecycle?: ChannelAccountSnapshot["lifecycle"];
  ingressUnavailable?: true;
  lastTransportActivityAt?: number;
};

export const basecampStatusAdapter: ChannelStatusAdapter<ResolvedBasecampAccount, BasecampProbe, BasecampAudit> =
  createComputedAccountStatusAdapter<ResolvedBasecampAccount, BasecampProbe, BasecampAudit, BasecampSnapshotExtra>({
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),

    probeAccount: async ({ account }) => {
      try {
        const client = getClient(account);
        const info = await client.authorization.getInfo();
        const personName = `${info.identity.firstName} ${info.identity.lastName}`.trim();
        const accountCount = info.accounts.length;
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

    formatCapabilitiesProbe: ({ probe }) => {
      const lines: Array<{ text: string; tone?: "default" | "muted" | "success" | "warn" | "error" }> = [];
      if (probe.authenticated) {
        lines.push({ text: `Authenticated as ${probe.personName ?? "unknown"}`, tone: "success" });
        if (typeof probe.accountCount === "number") {
          lines.push({ text: `${probe.accountCount} Basecamp account(s) visible`, tone: "muted" });
        }
      } else {
        lines.push({ text: `Not authenticated${probe.error ? `: ${probe.error}` : ""}`, tone: "error" });
      }
      const metrics = probe.metrics;
      if (metrics) {
        const lagParts = (["activity", "readings", "assignments", "safetyNet"] as const)
          .map((source) => {
            const lag = pollerLagSeconds(metrics.poller[source]);
            return lag === null ? `${source}: never` : `${source}: ${lag}s`;
          })
          .join(", ");
        lines.push({ text: `Poller lag — ${lagParts}`, tone: "muted" });
        for (const [key, cb] of Object.entries(metrics.circuitBreaker)) {
          if (cb.state !== "closed") {
            lines.push({ text: `Circuit breaker ${key}: ${cb.state} (${cb.failures} failures)`, tone: "warn" });
          }
        }
        if (metrics.ingress.unavailable) {
          lines.push({ text: `Webhook ingress unavailable: ${metrics.ingress.reason ?? "unknown"}`, tone: "warn" });
        }
      }
      return lines;
    },

    auditAccount: async ({ account, cfg }) => {
      const errors: Array<{ kind: "config" | "runtime"; message: string }> = [];

      // Check project access
      let projectsAccessible = 0;
      try {
        const client = getClient(account);
        const projects = await client.projects.list();
        projectsAccessible = projects.length;
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
          if (resolved.tokenSource !== "none") {
            personasValid++;
          } else {
            errors.push({
              kind: "config",
              message: `Persona "${agentId}" → account "${targetAccountId}": no auth configured`,
            });
          }
        } else {
          errors.push({
            kind: "config",
            message: `Persona "${agentId}" → account "${targetAccountId}": account does not exist`,
          });
        }
      }

      // Enrich with operational metrics
      const metrics = getAccountMetrics(account.accountId);
      const result: BasecampAudit = {
        projectsAccessible,
        personasMapped,
        personasValid,
        errors,
        personIdSet: !!account.personId,
      };

      if (metrics) {
        result.pollerLag = {
          activity: pollerLagSeconds(metrics.poller.activity),
          readings: pollerLagSeconds(metrics.poller.readings),
          assignments: pollerLagSeconds(metrics.poller.assignments),
          safetyNet: pollerLagSeconds(metrics.poller.safetyNet),
        };

        if (Object.keys(metrics.circuitBreaker).length > 0) {
          result.circuitBreakers = {};
          for (const [key, cb] of Object.entries(metrics.circuitBreaker)) {
            result.circuitBreakers[key] = { state: cb.state, failures: cb.failures };
          }
        }

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

        if (metrics.reconciliation.lastRunAt) {
          result.reconciliation = metrics.reconciliation;
        }

        const authMethods = metrics.webhook.authMethods;
        if (Object.keys(authMethods).length > 0) {
          result.webhookAuthMethods = authMethods;
        }
      }

      return result;
    },

    resolveAccountSnapshot: ({ account, runtime, probe, audit }) => {
      // Host snapshot builders may hand us a projected account without `config`.
      const configured = account.tokenSource !== "none";
      const metrics = getAccountMetrics(account.accountId);

      const extra: BasecampSnapshotExtra = {
        tokenSource: account.tokenSource,
        cliProfile: account.cliProfile,
        audit,
        personName: probe?.personName,
        accountCount: probe?.accountCount,
      };

      // lastTransportActivityAt from poller ticks (and webhook receipts),
      // unless the gateway already published something newer.
      const transportAt = latestTransportActivityAt(metrics);
      const publishedAt = typeof runtime?.lastTransportActivityAt === "number" ? runtime.lastTransportActivityAt : 0;
      if (transportAt !== null && transportAt > publishedAt) {
        Object.assign(extra, createTransportActivityStatusPatch(transportAt));
      }

      // Lifecycle overrides: auth failure trumps everything; an open poller
      // breaker downgrades a running account to "recovering".
      if (probe && !probe.authenticated) {
        extra.lifecycle = "blocked";
      } else if (runtime?.running && anyBreakerOpen(metrics)) {
        extra.lifecycle = "recovering";
      }

      if (metrics?.ingress.unavailable) {
        extra.ingressUnavailable = true;
      }

      return {
        accountId: account.accountId,
        name: account.displayName,
        enabled: account.enabled,
        configured,
        extra,
      };
    },

    buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot, { includeMode: false }),

    logSelfId: ({ account, runtime }) => {
      const name = account.displayName ?? "unknown";
      runtime.log(`[basecamp:${account.accountId}] identity: ${name} (personId=${account.personId})`);
    },

    resolveAccountState: ({ account, configured, enabled }) => {
      if (!enabled) return "disabled";
      if (!configured) return "not configured";
      return "configured";
    },

    collectStatusIssues: (accounts) => {
      const issues: ChannelStatusIssue[] = [];

      for (const s of accounts) {
        const probe = s.probe as BasecampProbe | undefined;

        // Unauthenticated accounts — token-source-specific fix message
        if (probe && !probe.authenticated) {
          let fix: string;
          switch (s.tokenSource) {
            case "oauth":
              fix = `Run \`openclaw channels login --channel basecamp --account ${s.accountId}\``;
              break;
            case "config":
            case "tokenFile":
              fix = `Check token or tokenFile configuration for account ${s.accountId}`;
              break;
            default:
              fix = "Run `openclaw channels add` and select Basecamp to configure credentials";
          }
          issues.push({
            channel: "basecamp",
            accountId: s.accountId,
            kind: "auth",
            message: "Account is not authenticated",
            fix,
          });
        }

        // Migration nudge: cliProfile-only accounts now resolve to tokenSource "none"
        const snapshot = s as ChannelAccountSnapshot & { cliProfile?: string };
        if (snapshot.tokenSource === "none" && snapshot.cliProfile) {
          issues.push({
            channel: "basecamp",
            accountId: s.accountId,
            kind: "config",
            message: "Account uses CLI profile only — runtime auth requires OAuth",
            fix: `Run \`openclaw channels add\` to set up browser login for account ${s.accountId}`,
          });
        }

        // Configured but never started (no runtime record)
        if (s.configured && s.enabled && !s.running && !s.lastStartAt) {
          issues.push({
            channel: "basecamp",
            accountId: s.accountId,
            kind: "runtime",
            message: "Account is configured but has never started",
            fix: "Start the channel with `openclaw gateway` or check gateway logs",
          });
        }

        // Webhook ingress broken — polling still provides correctness, but
        // event latency degrades to the poll interval.
        if (s.ingressUnavailable) {
          issues.push({
            channel: "basecamp",
            accountId: s.accountId,
            kind: "runtime",
            message: "Webhook ingress unavailable — events arrive via polling only",
            fix: "Check webhook payload URL reachability and the webhook secret store",
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
  });
