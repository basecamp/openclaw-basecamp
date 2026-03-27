/**
 * Basecamp resolver adapter — batch fuzzy name→ID resolution.
 *
 * Implements ChannelResolverAdapter for `openclaw channels resolve`.
 * Fetches people or projects once, then matches each input by exact ID,
 * exact name (case-insensitive), partial name, or email prefix.
 */

import type { ChannelResolveResult, ChannelResolverAdapter } from "openclaw/plugin-sdk/channel-runtime";
import { getClient } from "../basecamp-client.js";
import { resolveBasecampAccount } from "../config.js";
import type { BasecampPerson, BasecampProject } from "../types.js";

function matchPerson(input: string, people: BasecampPerson[]): BasecampPerson | undefined {
  const lower = input.toLowerCase();

  // Exact ID match
  const byId = people.find((p) => String(p.id) === input);
  if (byId) return byId;

  // Exact name match (case-insensitive)
  const byName = people.find((p) => p.name.toLowerCase() === lower);
  if (byName) return byName;

  // Partial name match
  const byPartial = people.find((p) => p.name.toLowerCase().includes(lower));
  if (byPartial) return byPartial;

  // Email prefix match
  const byEmail = people.find((p) => p.email_address.toLowerCase().startsWith(lower));
  if (byEmail) return byEmail;

  return undefined;
}

function matchProject(input: string, projects: BasecampProject[]): BasecampProject | undefined {
  const lower = input.toLowerCase();

  // Exact bucket ID match (with or without prefix)
  const bareId = input.replace(/^bucket:/, "");
  const byId = projects.find((p) => String(p.id) === bareId);
  if (byId) return byId;

  // Exact name match (case-insensitive)
  const byName = projects.find((p) => p.name.toLowerCase() === lower);
  if (byName) return byName;

  // Partial name match
  const byPartial = projects.find((p) => p.name.toLowerCase().includes(lower));
  if (byPartial) return byPartial;

  return undefined;
}

export const basecampResolverAdapter: ChannelResolverAdapter = {
  resolveTargets: async ({ cfg, accountId, inputs, kind }) => {
    const account = resolveBasecampAccount(cfg, accountId);

    if (kind === "user") {
      let people: BasecampPerson[];
      try {
        const client = getClient(account);
        people = (await client.people.list()) as any;
      } catch {
        return inputs.map((input) => ({
          input,
          resolved: false,
          note: "Failed to fetch people list",
        }));
      }

      if (!Array.isArray(people)) {
        return inputs.map((input) => ({ input, resolved: false }));
      }

      return inputs.map((input): ChannelResolveResult => {
        const person = matchPerson(input, people);
        if (person) {
          return {
            input,
            resolved: true,
            id: String(person.id),
            name: person.name,
          };
        }
        return { input, resolved: false };
      });
    }

    if (kind === "group") {
      let projects: BasecampProject[];
      try {
        const client = getClient(account);
        projects = (await client.projects.list()) as any;
      } catch {
        return inputs.map((input) => ({
          input,
          resolved: false,
          note: "Failed to fetch projects list",
        }));
      }

      if (!Array.isArray(projects)) {
        return inputs.map((input) => ({ input, resolved: false }));
      }

      return inputs.map((input): ChannelResolveResult => {
        const project = matchProject(input, projects);
        if (project) {
          return {
            input,
            resolved: true,
            id: `bucket:${project.id}`,
            name: project.name,
          };
        }
        return { input, resolved: false };
      });
    }

    return inputs.map((input) => ({ input, resolved: false }));
  },
};
