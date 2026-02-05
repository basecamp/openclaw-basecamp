/**
 * Basecamp hatch adapter — interactive wizard for provisioning new service identities.
 *
 * Walks the user through selecting a bcq profile, discovering their Basecamp
 * identity, choosing an account key, and optionally mapping to an agent persona.
 *
 * This is not a formal SDK adapter (no ChannelHatchAdapter interface exists);
 * it's a standalone wizard function called from the onboarding adapter.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { normalizeAccountId } from "openclaw/plugin-sdk";
import type { BasecampChannelConfig } from "../types.js";
import { bcqMe, bcqProfileList } from "../bcq.js";
import { listBasecampAccountIds } from "../config.js";

type WizardPrompter = {
  select: (opts: { message: string; options: Array<{ value: string; label: string }>; initialValue?: string }) => Promise<string>;
  text: (opts: { message: string; validate?: (value: string | undefined) => string | undefined }) => Promise<string>;
  note: (message: string, title?: string) => Promise<void>;
};

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

export type HatchResult = {
  cfg: OpenClawConfig;
  accountId: string;
  personId: string;
  personaMapping?: { agentId: string; accountId: string };
};

/**
 * Run the hatch identity wizard.
 *
 * Steps:
 * 1. List bcq profiles — select existing or prompt to create
 * 2. Call bcqMe — enumerate Basecamp accounts, select one
 * 3. Resolve identity — personId, name, attachableSgid; confirm with user
 * 4. Assign account ID key — prompt, validate uniqueness
 * 5. Optionally map to agent persona
 * 6. Apply config
 */
export async function hatchIdentity(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<HatchResult> {
  // Step 1: List bcq profiles
  let profileNames: string[] = [];
  try {
    const result = await bcqProfileList();
    profileNames = result.data;
  } catch {
    // bcq not available
  }

  let selectedProfile: string | undefined;
  if (profileNames.length > 1) {
    const choice = await prompter.select({
      message: "Select bcq profile for the new identity",
      options: [
        ...profileNames.map((name) => ({ value: name, label: name })),
        { value: "__none__", label: "Use default (no profile)" },
      ],
    });
    selectedProfile = choice === "__none__" ? undefined : choice;
  } else if (profileNames.length === 1) {
    selectedProfile = profileNames[0];
  }

  // Step 2: Call bcqMe to get identity
  type BcqAccount = { id: number; name: string };
  let meIdentity: { id: number; name: string; email_address: string; attachable_sgid?: string } | undefined;
  let bcqAccountId: string | undefined;

  try {
    const meResult = await bcqMe(selectedProfile ? { profile: selectedProfile } : {});
    const data = meResult.data as unknown as {
      identity?: { id: number; name: string; email_address: string; attachable_sgid?: string };
      accounts?: BcqAccount[];
    };
    // bcqMe may return {id, name, ...} directly or nested under {identity: ...}
    meIdentity = data.identity ?? (meResult.data as typeof meIdentity);

    const accounts = data.accounts ?? [];
    if (accounts.length > 1) {
      bcqAccountId = await prompter.select({
        message: "Basecamp account for this identity",
        options: accounts.map((a) => ({
          value: String(a.id),
          label: `${a.name} (${a.id})`,
        })),
      });
    } else if (accounts.length === 1) {
      bcqAccountId = String(accounts[0]!.id);
    }
  } catch {
    await prompter.note(
      "Could not fetch identity. Make sure bcq is authenticated.",
      "Identity error",
    );
    // Fall through to manual entry
  }

  // Step 3: Resolve identity — confirm or prompt
  let personId: string;
  if (meIdentity) {
    await prompter.note(
      `Identity: ${meIdentity.name} (ID: ${meIdentity.id}, ${meIdentity.email_address})`,
      "Detected identity",
    );
    personId = String(meIdentity.id);
  } else {
    personId = await prompter.text({
      message: "Basecamp person ID for this identity",
      validate: (v) => (v?.trim() ? undefined : "Required"),
    });
    personId = personId.trim();
  }

  // Step 4: Assign account ID key — validate uniqueness
  const existingIds = new Set(listBasecampAccountIds(cfg));
  const accountId = normalizeAccountId(
    await prompter.text({
      message: "Account ID key for this identity (e.g. 'security', 'design-bot')",
      validate: (v) => {
        if (!v?.trim()) return "Required";
        if (existingIds.has(normalizeAccountId(v))) return `"${v}" is already in use`;
        return undefined;
      },
    }),
  );

  // Step 5: Optionally map to agent persona
  let personaMapping: { agentId: string; accountId: string } | undefined;
  const mapChoice = await prompter.select({
    message: "Map this identity to an agent?",
    options: [
      { value: "__skip__", label: "Skip — configure later" },
      { value: "__enter__", label: "Enter agent ID now" },
    ],
  });

  if (mapChoice === "__enter__") {
    const agentId = await prompter.text({
      message: "Agent ID to use this identity",
      validate: (v) => (v?.trim() ? undefined : "Required"),
    });
    personaMapping = { agentId: agentId.trim(), accountId };
  }

  // Step 6: Apply config
  const section = getBasecampSection(cfg) ?? {};
  const accounts = (section.accounts ?? {}) as Record<string, Record<string, unknown>>;
  const personas = { ...(section.personas ?? {}) };

  if (personaMapping) {
    personas[personaMapping.agentId] = personaMapping.accountId;
  }

  const next: OpenClawConfig = {
    ...cfg,
    channels: {
      ...cfg.channels,
      basecamp: {
        ...section,
        accounts: {
          ...accounts,
          [accountId]: {
            personId,
            enabled: true,
            ...(selectedProfile ? { bcqProfile: selectedProfile } : {}),
            ...(bcqAccountId ? { bcqAccountId } : {}),
            ...(meIdentity?.name ? { displayName: meIdentity.name } : {}),
            ...(meIdentity?.attachable_sgid ? { attachableSgid: meIdentity.attachable_sgid } : {}),
          },
        },
        personas,
      },
    },
  };

  return { cfg: next, accountId, personId, personaMapping };
}
