/**
 * Basecamp onboarding adapter — guides users through initial channel setup.
 *
 * Supports two authentication paths:
 * - Browser-based OAuth (recommended) — uses @37signals/basecamp interactive login
 * - Legacy Basecamp CLI profile — uses bcq auth for token management
 *
 * Both paths converge on discoverIdentity() for account/person resolution.
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
import { bcqAuthStatus, bcqProfileList } from "../bcq.js";
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
  getCurrent: (cfg) => (getBasecampSection(cfg)?.dmPolicy as DmPolicy) ?? "pairing",
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
      return account.tokenSource !== "none" && !!account.personId;
    });

    return {
      channel,
      configured,
      statusLines: [`Basecamp: ${configured ? "configured" : "needs setup"}`],
      selectionHint: configured ? "configured" : "requires setup",
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

    // Step 1: Resolve OpenClaw account ID
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

    // Step 2: Auth method choice
    // Probe for CLI availability
    let cliProfileNames: string[] = [];
    try {
      const profileResult = await bcqProfileList();
      cliProfileNames = profileResult.data;
    } catch {
      // CLI not installed or profiles unavailable
    }

    const cliAvailable = cliProfileNames.length > 0;

    type AuthMethod = "oauth" | "cli";
    let authMethod: AuthMethod;

    if (cliAvailable) {
      const choice = await prompter.select({
        message: "How do you want to authenticate?",
        options: [
          { value: "oauth", label: "Authenticate with browser (recommended)" },
          { value: "cli", label: "Use existing Basecamp CLI profile" },
        ],
      });
      authMethod = choice as AuthMethod;
    } else {
      authMethod = "oauth";
    }

    // Step 3: Obtain token provider (branched by auth method)
    let accessToken: string | undefined;
    let selectedProfile: string | undefined;
    let oauthTokenFile: string | undefined;
    let promptedClientId: string | undefined;
    let promptedClientSecret: string | undefined;

    if (authMethod === "oauth") {
      // Resolve clientId: check resolved account's oauthClientId (falls through to channel-level)
      const resolved = resolveBasecampAccount(cfg, accountId);
      let clientId = resolved.oauthClientId;
      let clientSecret = resolved.oauthClientSecret;

      if (!clientId) {
        await prompter.note(
          "You'll need a Basecamp OAuth app. Register one at:\nhttps://launchpad.37signals.com/integrations",
          "OAuth setup",
        );
        const enteredId = await prompter.text({
          message: "Enter your Basecamp OAuth app Client ID",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        });
        clientId = String(enteredId).trim();
        promptedClientId = clientId;

        const enteredSecret = await prompter.text({
          message: "Client Secret (leave blank to skip)",
        });
        const secretVal = String(enteredSecret).trim();
        if (secretVal) {
          clientSecret = secretVal;
          promptedClientSecret = secretVal;
        }
      }

      // Run interactive login
      const { interactiveLogin, resolveTokenFilePath } = await import("../oauth-credentials.js");
      oauthTokenFile = resolveTokenFilePath(accountId);
      const partialAccount = {
        ...resolved,
        accountId,
        oauthClientId: clientId,
        oauthClientSecret: clientSecret,
        config: { ...resolved.config, oauthTokenFile },
      };
      const token = await interactiveLogin(partialAccount, { clientId, clientSecret });
      accessToken = token.accessToken;

      // Build a token provider for later use if needed
    } else {
      // CLI path
      if (cliProfileNames.length > 1) {
        const choice = await prompter.select({
          message: "Basecamp CLI profile",
          options: [
            ...cliProfileNames.map((name) => ({ value: name, label: name })),
            { value: "__none__", label: "Use default (no profile)" },
          ],
        });
        selectedProfile = choice === "__none__" ? undefined : choice;
      } else if (cliProfileNames.length === 1) {
        selectedProfile = cliProfileNames[0];
      }

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
            "Basecamp CLI is not authenticated. Run:",
            selectedProfile
              ? `  basecamp auth login --profile ${selectedProfile}`
              : "  basecamp auth login",
            "Then re-run setup.",
          ].join("\n"),
          "Basecamp auth",
        );
      }

      // Get token for identity discovery
      if (authenticated) {
        try {
          const { bcqTokenProvider } = await import("../basecamp-client.js");
          const provider = bcqTokenProvider(selectedProfile);
          accessToken = await provider();
        } catch {
          // Token extraction failed — will fall back to manual entry
        }
      }
    }

    // Step 4: Discover identity
    type DiscoveredAccount = { id: number; name: string; product: string; href: string; appHref: string };
    let discoveredAccounts: DiscoveredAccount[] = [];
    let identityId: number | undefined;
    let identityName: string | undefined;

    if (accessToken) {
      try {
        const { discoverIdentity } = await import("@37signals/basecamp/oauth");
        const info = await discoverIdentity(accessToken);
        identityId = info.identity.id;
        identityName = [info.identity.firstName, info.identity.lastName].filter(Boolean).join(" ");
        discoveredAccounts = info.accounts.filter((a: DiscoveredAccount) => a.product === "bc3");
      } catch {
        // Discovery failed — fall back to manual entry
      }
    }

    // Step 5: Select Basecamp account
    let basecampAccountId: string | undefined;
    if (discoveredAccounts.length > 1) {
      const choice = await prompter.select({
        message: "Basecamp account",
        options: discoveredAccounts.map((a) => ({
          value: String(a.id),
          label: `${a.name} (${a.id})`,
        })),
      });
      basecampAccountId = choice;
    } else if (discoveredAccounts.length === 1) {
      basecampAccountId = String(discoveredAccounts[0]!.id);
      await prompter.note(
        `Using account: ${discoveredAccounts[0]!.name} (${basecampAccountId})`,
        "Basecamp account",
      );
    }

    // Step 6: Resolve personId
    let personId = identityId ? String(identityId) : "";
    if (!personId) {
      const entered = await prompter.text({
        message: "Basecamp person ID (your service account's person ID)",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      });
      personId = String(entered).trim();
    } else {
      await prompter.note(
        `Detected person ID: ${personId}${identityName ? ` (${identityName})` : ""}`,
        "Basecamp identity",
      );
    }

    // Step 7: Apply config
    const section = getBasecampSection(next) ?? {};
    const accounts = (section.accounts ?? {}) as Record<string, Record<string, unknown>>;
    const existingAccount = accounts[accountId] ?? {};

    // Auth-method conflict cleanup: build patch and clear stale keys
    const accountPatch: Record<string, unknown> = {
      ...existingAccount,
      personId,
      enabled: true,
      ...(basecampAccountId ? { basecampAccountId } : {}),
    };

    if (authMethod === "oauth") {
      accountPatch.oauthTokenFile = oauthTokenFile;
      // Clear CLI-path keys
      delete accountPatch.bcqProfile;
    } else {
      if (selectedProfile) accountPatch.bcqProfile = selectedProfile;
      if (basecampAccountId) accountPatch.bcqAccountId = basecampAccountId;
      // Clear OAuth-path keys
      delete accountPatch.oauthTokenFile;
      delete accountPatch.oauthClientId;
      delete accountPatch.oauthClientSecret;
    }

    // Build channel-level OAuth config when credentials were prompted
    const channelOauth = promptedClientId
      ? {
          clientId: promptedClientId,
          ...(promptedClientSecret ? { clientSecret: promptedClientSecret } : {}),
        }
      : section.oauth;

    next = {
      ...next,
      channels: {
        ...next.channels,
        basecamp: {
          ...section,
          enabled: true,
          ...(channelOauth ? { oauth: channelOauth } : {}),
          accounts: {
            ...accounts,
            [accountId]: accountPatch,
          },
        },
      },
    };

    // Step 8: Offer to add another identity via hatch
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
