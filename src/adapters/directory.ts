/**
 * Basecamp directory adapter — people & project discovery.
 *
 * Implements ChannelDirectoryAdapter for `openclaw channels resolve`,
 * agent targeting, and people/project lookup via the Basecamp API.
 */

import type { ChannelDirectoryAdapter, ChannelDirectoryEntry, OpenClawConfig } from "openclaw/plugin-sdk";
import { getClient, numId } from "../basecamp-client.js";
import { resolveBasecampAccount } from "../config.js";
import type { BasecampChannelConfig, BasecampPerson, BasecampProject, ResolvedBasecampAccount } from "../types.js";

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

export const basecampDirectoryAdapter: ChannelDirectoryAdapter = {
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

  listPeers: async ({ cfg }) => {
    const section = getBasecampSection(cfg);
    const entries: ChannelDirectoryEntry[] = [];

    // Include allowFrom person IDs as known peers
    const allowFrom = section?.allowFrom ?? [];
    for (const entry of allowFrom) {
      const id = String(entry);
      entries.push({ kind: "user", id, name: undefined });
    }

    // Include all account personIds (use Set for O(1) dedup)
    const seenIds = new Set(entries.map((e) => e.id));
    const accounts = section?.accounts;
    if (accounts) {
      for (const acct of Object.values(accounts)) {
        if (acct.personId && !seenIds.has(acct.personId)) {
          seenIds.add(acct.personId);
          entries.push({
            kind: "user",
            id: acct.personId,
            name: acct.displayName,
          });
        }
      }
    }

    return entries;
  },

  listPeersLive: async ({ cfg, accountId, query }) => {
    const account = resolveBasecampAccount(cfg, accountId);

    let people: Array<{ id: number; name: string; email_address: string; avatar_url?: string }>;
    try {
      const client = getClient(account);
      people = (await client.people.list()) as any;
    } catch {
      return [];
    }

    if (!Array.isArray(people)) return [];

    let filtered = people;
    if (query) {
      const q = query.toLowerCase();
      filtered = people.filter((p) => p.name.toLowerCase().includes(q) || p.email_address.toLowerCase().includes(q));
    }

    return filtered.map((p) => ({
      kind: "user" as const,
      id: String(p.id),
      name: p.name,
      handle: p.email_address,
      avatarUrl: p.avatar_url,
    }));
  },

  listGroups: async ({ cfg }) => {
    const section = getBasecampSection(cfg);
    const entries: ChannelDirectoryEntry[] = [];

    // Include virtual account (project-scope) entries as groups
    const virtualAccounts = section?.virtualAccounts;
    if (virtualAccounts) {
      for (const [key, va] of Object.entries(virtualAccounts)) {
        entries.push({
          kind: "group",
          id: `bucket:${va.bucketId}`,
          name: key,
        });
      }
    }

    return entries;
  },

  listGroupsLive: async ({ cfg, accountId, query }) => {
    const account = resolveBasecampAccount(cfg, accountId);

    let projects: Array<{ id: number; name: string }>;
    try {
      const client = getClient(account);
      projects = (await client.projects.list()) as any;
    } catch {
      return [];
    }

    if (!Array.isArray(projects)) return [];

    let filtered = projects;
    if (query) {
      const q = query.toLowerCase();
      filtered = projects.filter((p) => p.name.toLowerCase().includes(q));
    }

    return filtered.map((p) => ({
      kind: "group" as const,
      id: `bucket:${p.id}`,
      name: p.name,
    }));
  },

  listGroupMembers: async ({ cfg, accountId, groupId }) => {
    const bucketMatch = groupId.match(/^bucket:(\d+)$/);
    if (!bucketMatch) return [];

    const projectId = numId("project", bucketMatch[1]);
    const account = resolveBasecampAccount(cfg, accountId);

    let people: Array<{ id: number; name: string; email_address: string; avatar_url?: string }>;
    try {
      const client = getClient(account);
      people = (await client.people.listForProject(projectId)) as any;
    } catch {
      return [];
    }

    if (!Array.isArray(people)) return [];

    return people.map((p) => ({
      kind: "user" as const,
      id: String(p.id),
      name: p.name,
      handle: p.email_address,
      avatarUrl: p.avatar_url,
    }));
  },
};
