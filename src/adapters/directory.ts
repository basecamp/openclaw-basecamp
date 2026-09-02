/**
 * Basecamp directory adapter — people & project discovery.
 *
 * Implements ChannelDirectoryAdapter for `openclaw channels resolve`,
 * agent targeting, and people/project lookup via the Basecamp API.
 *
 * Built on the SDK's directory helpers (SPEC §2.27):
 * `createChannelDirectoryAdapter` supplies the adapter shell and
 * `applyDirectoryQueryAndLimit` handles query/limit for config-derived id
 * lists. Live lists filter on names/emails (which ids can't express) and
 * then apply the same limit semantics.
 */

import type { Person, Project } from "@37signals/basecamp";
import type { ChannelDirectoryAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { applyDirectoryQueryAndLimit, createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { getClient, numId } from "../basecamp-client.js";
import { resolveBasecampAccount } from "../config.js";
import type { BasecampChannelConfig } from "../types.js";

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

/** Apply a positive limit to already query-filtered live entries. */
function applyLimit<T>(entries: T[], limit?: number | null): T[] {
  return typeof limit === "number" && limit > 0 ? entries.slice(0, limit) : entries;
}

export const basecampDirectoryAdapter: ChannelDirectoryAdapter = createChannelDirectoryAdapter({
  self: async ({ cfg, accountId }) => {
    const account = resolveBasecampAccount(cfg, accountId);
    if (!account.token && !account.config.tokenFile && !account.config.oauthTokenFile) return null;

    try {
      const client = getClient(account);
      const info = await client.authorization.getInfo();
      return {
        kind: "user" as const,
        id: String(info.identity.id),
        name: `${info.identity.firstName} ${info.identity.lastName}`.trim(),
        handle: info.identity.emailAddress,
      };
    } catch {
      return null;
    }
  },

  listPeers: async ({ cfg, query, limit }) => {
    const section = getBasecampSection(cfg);
    const names = new Map<string, string | undefined>();

    // allowFrom person IDs are known peers; account personIds carry names.
    for (const entry of section?.allowFrom ?? []) {
      const id = String(entry);
      if (!names.has(id)) names.set(id, undefined);
    }
    for (const acct of Object.values(section?.accounts ?? {})) {
      if (acct.personId && !names.has(acct.personId)) {
        names.set(acct.personId, acct.displayName);
      }
    }

    const ids = applyDirectoryQueryAndLimit([...names.keys()], { query, limit });
    return ids.map((id) => ({ kind: "user" as const, id, name: names.get(id) }));
  },

  listPeersLive: async ({ cfg, accountId, query, limit }) => {
    const account = resolveBasecampAccount(cfg, accountId);

    let people: Person[];
    try {
      const client = getClient(account);
      people = await client.people.list();
    } catch {
      return [];
    }

    let filtered = people;
    if (query) {
      const q = query.toLowerCase();
      filtered = filtered.filter((p) => p.name.toLowerCase().includes(q) || p.email_address?.toLowerCase().includes(q));
    }

    return applyLimit(filtered, limit).map((p) => ({
      kind: "user" as const,
      id: String(p.id),
      name: p.name,
      handle: p.email_address,
      avatarUrl: p.avatar_url,
    }));
  },

  listGroups: async ({ cfg, query, limit }) => {
    const section = getBasecampSection(cfg);

    // Virtual account (project-scope) entries are groups keyed by bucket id.
    const names = new Map<string, string>();
    for (const [key, va] of Object.entries(section?.virtualAccounts ?? {})) {
      names.set(`bucket:${va.bucketId}`, key);
    }

    const ids = applyDirectoryQueryAndLimit([...names.keys()], { query, limit });
    return ids.map((id) => ({ kind: "group" as const, id, name: names.get(id) }));
  },

  listGroupsLive: async ({ cfg, accountId, query, limit }) => {
    const account = resolveBasecampAccount(cfg, accountId);

    let projects: Project[];
    try {
      const client = getClient(account);
      projects = await client.projects.list();
    } catch {
      return [];
    }

    let filtered = projects;
    if (query) {
      const q = query.toLowerCase();
      filtered = filtered.filter((p) => p.name.toLowerCase().includes(q));
    }

    return applyLimit(filtered, limit).map((p) => ({
      kind: "group" as const,
      id: `bucket:${p.id}`,
      name: p.name,
    }));
  },

  listGroupMembers: async ({ cfg, accountId, groupId, limit }) => {
    const bucketMatch = groupId.match(/^bucket:(\d+)$/);
    if (!bucketMatch) return [];

    const projectId = numId("project", bucketMatch[1]);
    const account = resolveBasecampAccount(cfg, accountId);

    let people: Person[];
    try {
      const client = getClient(account);
      people = await client.people.listForProject(projectId);
    } catch {
      return [];
    }

    return applyLimit(people, limit).map((p) => ({
      kind: "user" as const,
      id: String(p.id),
      name: p.name,
      handle: p.email_address,
      avatarUrl: p.avatar_url,
    }));
  },
});
