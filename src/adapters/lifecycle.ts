/**
 * Basecamp lifecycle adapter (SPEC §2.19).
 *
 * - onAccountConfigChanged: evict cached SDK client + token manager when an
 *   account's token/OAuth config changes, so the next call picks up the new
 *   credentials instead of a stale cached TokenProvider.
 * - onAccountRemoved: delete plugin-owned state for the account — poll
 *   cursors, webhook secret store, recording index, OAuth token files —
 *   and drop in-memory caches.
 * - runStartupMaintenance: prune cursor files left behind by accounts that
 *   are no longer configured.
 */

import { readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { clearClient } from "../basecamp-client.js";
import { listBasecampAccountIds } from "../config.js";
import { closeRecordingIndex } from "../inbound/recording-index.js";
import { resolvePluginStateDir } from "../inbound/state-dir.js";
import { closeWebhookSecretRegistry } from "../inbound/webhooks.js";
import type { ChannelLifecycleAdapter } from "../sdk-types.js";
import type { BasecampChannelConfig } from "../types.js";

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

/**
 * Serialize the credential-relevant slice of an account's config. A change in
 * this signature invalidates the cached client and token manager.
 */
function credentialSignature(cfg: OpenClawConfig, accountId: string): string {
  const section = getBasecampSection(cfg);
  const account: Partial<NonNullable<BasecampChannelConfig["accounts"]>[string]> = section?.accounts?.[accountId] ?? {};
  return JSON.stringify({
    token: account.token,
    tokenFile: account.tokenFile,
    oauthTokenFile: account.oauthTokenFile,
    oauthClientId: account.oauthClientId,
    oauthClientSecret: account.oauthClientSecret,
    basecampAccountId: account.basecampAccountId,
    oauth: section?.oauth,
  });
}

async function evictAccountCaches(accountId: string): Promise<void> {
  const { clearTokenManager } = await import("../oauth-credentials.js");
  clearTokenManager(accountId);
  clearClient(accountId);
}

/** Best-effort file removal — missing files and permission noise are ignored. */
async function removeQuietly(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {});
}

export const basecampLifecycleAdapter: ChannelLifecycleAdapter = {
  onAccountConfigChanged: async ({ prevCfg, nextCfg, accountId }) => {
    if (credentialSignature(prevCfg, accountId) !== credentialSignature(nextCfg, accountId)) {
      await evictAccountCaches(accountId);
    }
  },

  onAccountRemoved: async ({ prevCfg, accountId }) => {
    await evictAccountCaches(accountId);
    // Replay-guard entries are namespaced per account and expire on their
    // 24h TTL; there is no per-account store to drop.
    await closeRecordingIndex(accountId);
    closeWebhookSecretRegistry(accountId);

    let stateDir: string | undefined;
    try {
      stateDir = resolvePluginStateDir();
    } catch {
      // Runtime store unavailable (e.g. config-only CLI path) — nothing on
      // disk can be located, so leave files for the next full-runtime pass.
    }
    if (stateDir) {
      await removeQuietly(join(stateDir, `cursors-${accountId}.json`));
      await removeQuietly(join(stateDir, `webhook-secrets-${accountId}.json`));
      await removeQuietly(join(stateDir, `recording-index-${accountId}.json`));
    }

    // OAuth token files: the configured path when set, else the default
    // location — plus the companion .client.json either way.
    const { resolveClientFilePath, resolveTokenFilePath } = await import("../oauth-credentials.js");
    const configuredTokenFile = getBasecampSection(prevCfg)?.accounts?.[accountId]?.oauthTokenFile;
    const tokenFile = configuredTokenFile ?? resolveTokenFilePath(accountId);
    await removeQuietly(tokenFile);
    await removeQuietly(resolveClientFilePath(tokenFile));
  },

  runStartupMaintenance: ({ cfg, log }) => {
    let stateDir: string;
    try {
      stateDir = resolvePluginStateDir();
    } catch {
      return;
    }

    let files: string[];
    try {
      files = readdirSync(stateDir);
    } catch {
      return; // State dir doesn't exist yet — nothing to prune.
    }

    const known = new Set(listBasecampAccountIds(cfg));
    for (const file of files) {
      const match = /^cursors-(.+)\.json$/.exec(file);
      if (!match || known.has(match[1]!)) continue;
      void rm(join(stateDir, file), { force: true })
        .then(() => log.info?.(`[basecamp] pruned stale cursor file ${file}`))
        .catch((err) => log.warn?.(`[basecamp] failed to prune ${file}: ${String(err)}`));
    }
  },
};
