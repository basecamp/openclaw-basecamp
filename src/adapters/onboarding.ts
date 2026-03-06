/**
 * Basecamp onboarding adapter — guides users through initial channel setup.
 *
 * Supports two authentication paths:
 * - Browser-based OAuth (recommended) — uses @37signals/basecamp interactive login
 * - Basecamp CLI profile — imports CLI's stored credentials for persistent token
 *
 * Both paths converge on discoverIdentity() for account/person resolution.
 */

import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  DmPolicy,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import {
  type CliProfile,
  cliProfileListFull,
  exportCliCredentials,
  extractCliBootstrapToken,
} from "../basecamp-cli.js";
import { listBasecampAccountIds, resolveBasecampAccount, resolveDefaultBasecampAccountId } from "../config.js";
import { isValidLaunchpadClientId } from "../oauth-credentials.js";
import type { BasecampChannelConfig } from "../types.js";

const channel = "basecamp" as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run the interactive OAuth login flow, prompting for client credentials if
 * none are available. Used by both the primary OAuth path and the CLI
 * fallback when credential import fails.
 */
async function runOAuthLogin(params: { cfg: OpenClawConfig; accountId: string; prompter: any }): Promise<{
  accessToken: string;
  oauthTokenFile: string;
  promptedClientId?: string;
  promptedClientSecret?: string;
}> {
  const { cfg, accountId, prompter } = params;
  const resolved = resolveBasecampAccount(cfg, accountId);
  let clientId = resolved.oauthClientId;
  let clientSecret = resolved.oauthClientSecret;
  let promptedClientId: string | undefined;
  let promptedClientSecret: string | undefined;

  if (!isValidLaunchpadClientId(clientId)) {
    // Discard paired secret when client ID is invalid (e.g. DCR placeholder)
    clientId = undefined;
    clientSecret = undefined;
    await prompter.note(
      "You'll need a Basecamp OAuth app. Register one at:\n" +
        "https://launchpad.37signals.com/integrations\n\n" +
        "When creating the app, set the redirect URI to:\n" +
        "http://localhost:14923/callback\n\n" +
        "You can leave the other fields as defaults.",
      "OAuth setup",
    );
    const enteredId = await prompter.text({
      message: "Enter your Basecamp OAuth app Client ID",
      validate: (value: string) =>
        isValidLaunchpadClientId(value?.trim()) ? undefined : "Must be a 40-character hex string",
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

  const { interactiveLogin, resolveTokenFilePath } = await import("../oauth-credentials.js");
  const oauthTokenFile = resolveTokenFilePath(accountId);
  const partialAccount = {
    ...resolved,
    accountId,
    oauthClientId: clientId,
    oauthClientSecret: clientSecret,
    config: { ...resolved.config, oauthTokenFile },
  };
  const token = await interactiveLogin(partialAccount, { clientId, clientSecret });

  return {
    accessToken: token.accessToken,
    oauthTokenFile,
    promptedClientId,
    promptedClientSecret,
  };
}

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

  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    let next = cfg;

    // Step 1: Resolve OpenClaw account ID
    const basecampOverride = accountOverrides.basecamp?.trim();
    const defaultAccountId = resolveDefaultBasecampAccountId(cfg);
    let accountId = basecampOverride ? normalizeAccountId(basecampOverride) : defaultAccountId;

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
    let cliProfiles: CliProfile[] = [];
    try {
      const profileResult = await cliProfileListFull();
      cliProfiles = profileResult.data;
    } catch {
      // CLI not installed or profiles unavailable
    }

    const cliAvailable = cliProfiles.length > 0;

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
    // CLI-imported client creds go per-account (not channel-level) to avoid
    // overwriting existing channel OAuth config that other accounts rely on.
    let cliImportedClientId: string | undefined;
    let cliImportedClientSecret: string | undefined;

    if (authMethod === "oauth") {
      const oauthResult = await runOAuthLogin({ cfg, accountId, prompter });
      accessToken = oauthResult.accessToken;
      oauthTokenFile = oauthResult.oauthTokenFile;
      promptedClientId = oauthResult.promptedClientId;
      promptedClientSecret = oauthResult.promptedClientSecret;
    } else {
      // CLI path — import credentials from existing CLI profile
      let selectedCliProfile: CliProfile | undefined;

      if (cliProfiles.length > 1) {
        const choice = await prompter.select({
          message: "Basecamp CLI profile",
          options: [
            ...cliProfiles.map((p) => ({ value: p.name, label: p.name })),
            { value: "__none__", label: "Use default (no profile)" },
          ],
        });
        if (choice === "__none__") {
          // No explicit profile flag, but resolve active/default profile for credential import
          selectedCliProfile = cliProfiles.find((p) => p.active || p.default) ?? cliProfiles[0];
        } else {
          selectedCliProfile = cliProfiles.find((p) => p.name === choice);
          selectedProfile = selectedCliProfile?.name;
        }
      } else if (cliProfiles.length === 1) {
        selectedCliProfile = cliProfiles[0];
        selectedProfile = selectedCliProfile?.name;
      }

      // Extract token for identity discovery
      try {
        accessToken = await extractCliBootstrapToken(selectedProfile);
      } catch {
        // Token extraction failed — will fall back to manual entry
      }

      // Import CLI's stored OAuth credentials for persistent use
      if (selectedCliProfile) {
        const cliCreds = exportCliCredentials(selectedCliProfile.base_url);
        if (cliCreds) {
          const { resolveTokenFilePath } = await import("../oauth-credentials.js");
          const { FileTokenStore } = await import("@37signals/basecamp/oauth");
          oauthTokenFile = resolveTokenFilePath(accountId);
          const store = new FileTokenStore(oauthTokenFile);
          await store.save({
            accessToken: cliCreds.accessToken,
            refreshToken: cliCreds.refreshToken,
            tokenType: "Bearer",
            expiresAt: cliCreds.expiresAt ? new Date(cliCreds.expiresAt * 1000) : undefined,
          });
          // Store per-account so we don't overwrite channel-level OAuth
          cliImportedClientId = cliCreds.clientId;
          cliImportedClientSecret = cliCreds.clientSecret || undefined;
        }
      }
    }

    // CLI path: if credential import failed, fall back to browser OAuth.
    // Must run before identity discovery so the OAuth token is available.
    if (authMethod === "cli" && !oauthTokenFile) {
      await prompter.note("Could not import CLI credentials. Falling back to browser OAuth.", "Note");
      const oauthResult = await runOAuthLogin({ cfg, accountId, prompter });
      accessToken = oauthResult.accessToken;
      oauthTokenFile = oauthResult.oauthTokenFile;
      promptedClientId = oauthResult.promptedClientId;
      promptedClientSecret = oauthResult.promptedClientSecret;
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
      await prompter.note(`Using account: ${discoveredAccounts[0]!.name} (${basecampAccountId})`, "Basecamp account");
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

    if (oauthTokenFile) accountPatch.oauthTokenFile = oauthTokenFile;
    if (selectedProfile) accountPatch.cliProfile = selectedProfile;
    // When credentials were freshly prompted (OAuth path) and written to
    // channel-level oauth, remove per-account overrides so the account
    // inherits from channel-level.
    if (promptedClientId) {
      delete accountPatch.oauthClientId;
      delete accountPatch.oauthClientSecret;
    }
    // CLI-imported client creds go per-account to avoid overwriting
    // channel-level OAuth that other accounts depend on.
    if (cliImportedClientId) {
      accountPatch.oauthClientId = cliImportedClientId;
      accountPatch.oauthClientSecret = cliImportedClientSecret;
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
