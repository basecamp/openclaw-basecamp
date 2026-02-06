/**
 * Basecamp onboarding adapter — guides users through initial channel setup.
 *
 * Prompts for bcq profile selection, Basecamp account, person ID, and DM policy
 * using the WizardPrompter from the onboarding context.
 */

import type { OpenClawConfig, ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "openclaw/plugin-sdk";
import type { DmPolicy } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { BasecampChannelConfig } from "../types.js";
import {
  listBasecampAccountIds,
  resolveDefaultBasecampAccountId,
  resolveBasecampAccount,
} from "../config.js";
import { bcqMe, bcqAuthStatus, bcqProfileList } from "../bcq.js";
import type { BcqOptions } from "../bcq.js";

const channel = "basecamp" as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBasecampSection(cfg: OpenClawConfig): BasecampChannelConfig | undefined {
  return cfg.channels?.basecamp as BasecampChannelConfig | undefined;
}

function setBasecampDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      basecamp: {
        ...getBasecampSection(cfg),
        dmPolicy,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// DM policy descriptor
// ---------------------------------------------------------------------------

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Basecamp",
  channel,
  policyKey: "channels.basecamp.dmPolicy",
  allowFromKey: "channels.basecamp.allowFrom",
  getCurrent: (cfg) => (getBasecampSection(cfg)?.dmPolicy as DmPolicy) ?? "open",
  setPolicy: (cfg, policy) => setBasecampDmPolicy(cfg, policy),
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const basecampOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg }) => {
    const accountIds = listBasecampAccountIds(cfg);
    const configured = accountIds.some((id) => {
      const account = resolveBasecampAccount(cfg, id);
      return account.tokenSource !== "none" && account.personId;
    });

    return {
      channel,
      configured,
      statusLines: [`Basecamp: ${configured ? "configured" : "needs setup"}`],
      selectionHint: configured ? "configured" : "requires bcq auth",
      quickstartScore: configured ? 1 : 5,
    };
  },

  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
  }) => {
    let next = cfg;

    // Step 1: Discover available bcq profiles
    let profileNames: string[] = [];
    try {
      const profileResult = await bcqProfileList();
      profileNames = profileResult.data;
    } catch {
      // bcq profiles not available — proceed without profile selection
    }

    let selectedProfile: string | undefined;
    if (profileNames.length > 1) {
      const choice = await prompter.select({
        message: "bcq profile",
        options: [
          ...profileNames.map((name) => ({ value: name, label: name })),
          { value: "__none__", label: "Use default (no profile)" },
        ],
      });
      selectedProfile = choice === "__none__" ? undefined : choice;
    } else if (profileNames.length === 1) {
      selectedProfile = profileNames[0];
    }

    // Step 2: Check auth status
    const bcqOpts: BcqOptions = selectedProfile ? { profile: selectedProfile } : {};
    let authenticated = false;
    try {
      const authResult = await bcqAuthStatus(bcqOpts);
      authenticated = authResult.data.authenticated;
    } catch {
      // Auth check failed
    }

    if (!authenticated) {
      await prompter.note(
        [
          "bcq is not authenticated. Run:",
          selectedProfile
            ? `  bcq auth login --profile ${selectedProfile}`
            : "  bcq auth login",
          "Then re-run setup.",
        ].join("\n"),
        "Basecamp auth",
      );
    }

    // Step 3: Discover Basecamp accounts from bcq me
    type BcqAccount = { id: number; name: string; href?: string };
    let bcqAccounts: BcqAccount[] = [];
    let meIdentity: { id: number; name: string; email_address: string } | undefined;

    if (authenticated) {
      try {
        const meResult = await bcqMe(bcqOpts);
        const data = meResult.data as unknown as {
          accounts?: BcqAccount[];
          identity?: { id: number; name: string; email_address: string };
        };
        bcqAccounts = data.accounts ?? [];
        meIdentity = data.identity;
      } catch {
        // bcq me failed — proceed without account list
      }
    }

    // Step 4: Select Basecamp account (bcq --account)
    let selectedBcqAccountId: string | undefined;
    if (bcqAccounts.length > 1) {
      const choice = await prompter.select({
        message: "Basecamp account",
        options: bcqAccounts.map((a) => ({
          value: String(a.id),
          label: `${a.name} (${a.id})`,
        })),
      });
      selectedBcqAccountId = choice;
    } else if (bcqAccounts.length === 1) {
      selectedBcqAccountId = String(bcqAccounts[0]!.id);
      await prompter.note(
        `Using account: ${bcqAccounts[0]!.name} (${selectedBcqAccountId})`,
        "Basecamp account",
      );
    }

    // Step 5: Resolve OpenClaw account ID
    const basecampOverride = accountOverrides.basecamp?.trim();
    const defaultAccountId = resolveDefaultBasecampAccountId(cfg);
    let accountId = basecampOverride
      ? normalizeAccountId(basecampOverride)
      : defaultAccountId;

    if (shouldPromptAccountIds && !basecampOverride) {
      const existingIds = listBasecampAccountIds(cfg);
      const choice = await prompter.select({
        message: "OpenClaw account ID for this Basecamp connection",
        options: [
          ...existingIds.map((id) => ({
            value: id,
            label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id,
          })),
          { value: "__new__", label: "Add a new account" },
        ],
        initialValue: accountId,
      });

      if (choice === "__new__") {
        const entered = await prompter.text({
          message: "New account ID",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        });
        accountId = normalizeAccountId(String(entered));
      } else {
        accountId = normalizeAccountId(choice);
      }
    }

    // Step 6: Resolve person ID
    let personId = meIdentity ? String(meIdentity.id) : "";
    if (!personId) {
      const entered = await prompter.text({
        message: "Basecamp person ID (your service account's person ID)",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      });
      personId = String(entered).trim();
    } else {
      await prompter.note(
        `Detected person ID: ${personId} (${meIdentity?.name ?? ""})`,
        "Basecamp identity",
      );
    }

    // Step 7: Apply config
    const section = getBasecampSection(next) ?? {};
    const accounts = (section.accounts ?? {}) as Record<string, Record<string, unknown>>;
    const existingAccount = accounts[accountId] ?? {};

    next = {
      ...next,
      channels: {
        ...next.channels,
        basecamp: {
          ...section,
          enabled: true,
          accounts: {
            ...accounts,
            [accountId]: {
              ...existingAccount,
              personId,
              enabled: true,
              ...(selectedProfile ? { bcqProfile: selectedProfile } : {}),
              ...(selectedBcqAccountId ? { bcqAccountId: selectedBcqAccountId } : {}),
            },
          },
        },
      },
    };

    // Step 8: Offer to add another identity via hatch flow
    if (authenticated) {
      const postChoice = await prompter.select({
        message: "What would you like to do?",
        options: [
          { value: "done", label: "Done — use this account" },
          { value: "hatch", label: "Add another identity" },
        ],
      });

      if (postChoice === "hatch") {
        try {
          const { hatchIdentity } = await import("./hatch.js");
          const result = await hatchIdentity(next, prompter);
          next = result.cfg;
        } catch {
          await prompter.note(
            "Failed to add another identity. You can add more later with `openclaw channels hatch basecamp`.",
            "Hatch error",
          );
        }
      }
    }

    return { cfg: next, accountId };
  },

  dmPolicy,

  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      basecamp: { ...getBasecampSection(cfg), enabled: false },
    },
  }),
};
