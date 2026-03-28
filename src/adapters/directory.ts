/**
 * Basecamp directory adapter — people & project discovery.
 *
 * Implements ChannelDirectoryAdapter for `openclaw channels resolve`,
 * agent targeting, and people/project lookup via the Basecamp API.
 */

import type { Person, Project } from "@37signals/basecamp";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ChannelDirectoryAdapter, ChannelDirectoryEntry } from "openclaw/plugin-sdk/channel-runtime";
import { getClient, numId } from "../basecamp-client.js";
import { resolveBasecampAccount } from "../config.js";
import type { BasecampChannelConfig } from "../types.js";

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

    let people: Person[];
    try {
      const client = getClient(account);
      people = await client.people.listForProject(projectId);
    } catch {
      return [];
    }

    return people.map((p) => ({
      kind: "user" as const,
      id: String(p.id),
      name: p.name,
      handle: p.email_address,
      avatarUrl: p.avatar_url,
    }));
  },
};
