/**
 * Basecamp hatch adapter — interactive wizard for provisioning new service identities.
 *
 * Supports two auth paths:
 *   1. Browser/OAuth — interactive login via @37signals/basecamp OAuth flow
 *   2. Basecamp CLI — legacy CLI profile-based authentication
 *
 * Steps: auth method choice → identity discovery → account selection →
 * personId resolution → account ID key → optional persona mapping → config write.
 *
 * This is not a formal SDK adapter (no ChannelHatchAdapter interface exists);
 * it's a standalone wizard function called from the onboarding adapter.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { normalizeAccountId } from "openclaw/plugin-sdk";
import type { AuthorizationInfo } from "@37signals/basecamp";
import type { BasecampChannelConfig } from "../types.js";
import type { ResolvedBasecampAccount } from "../types.js";
import { cliMe, cliProfileList } from "../basecamp-cli.js";
import { listBasecampAccountIds } from "../config.js";
import {
  interactiveLogin,
  resolveTokenFilePath,
} from "../oauth-credentials.js";
import { discoverIdentity } from "@37signals/basecamp/oauth";

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

type AuthMethod = "browser" | "cli";

// ---------------------------------------------------------------------------
// Step 1: Auth method choice
// ---------------------------------------------------------------------------

async function chooseAuthMethod(
  prompter: WizardPrompter,
  cliAvailable: boolean,
): Promise<AuthMethod> {
  if (!cliAvailable) return "browser";

  return await prompter.select({
    message: "How do you want to authenticate this identity?",
    options: [
      { value: "browser", label: "Authenticate with browser (recommended)" },
      { value: "cli", label: "Use existing Basecamp CLI profile" },
    ],
  }) as AuthMethod;
}

// ---------------------------------------------------------------------------
// Step 2a: Browser/OAuth identity discovery
// ---------------------------------------------------------------------------

type OAuthDiscoveryResult = {
  info: AuthorizationInfo;
  clientId: string;
  clientSecret?: string;
  tempTokenFile: string;
  promptedClientId: boolean;
  promptedClientSecret: boolean;
};

async function discoverViaBrowser(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<OAuthDiscoveryResult> {
  const section = getBasecampSection(cfg);

  // Resolve or prompt for clientId
  let clientId = section?.oauth?.clientId;
  let promptedClientId = false;
  if (!clientId) {
    clientId = await prompter.text({
      message: "OAuth client ID",
      validate: (v) => (v?.trim() ? undefined : "Required"),
    });
    clientId = clientId.trim();
    promptedClientId = true;
  }

  // Resolve or prompt for clientSecret
  let clientSecret = section?.oauth?.clientSecret;
  let promptedClientSecret = false;
  if (!clientSecret && promptedClientId) {
    const entered = await prompter.text({
      message: "Client Secret (leave blank to skip)",
    });
    const val = String(entered).trim();
    if (val) {
      clientSecret = val;
      promptedClientSecret = true;
    }
  }

  // Use a unique temp key to avoid cross-identity token file collisions.
  // The token file will be relocated to {accountId}.json after the user
  // chooses their account key in step 5.
  const tempKey = `__hatch_${crypto.randomUUID()}__`;
  const tempAccount: ResolvedBasecampAccount = {
    accountId: tempKey,
    enabled: true,
    personId: "",
    token: "",
    tokenSource: "oauth",
    oauthClientId: clientId,
    oauthClientSecret: clientSecret,
    config: { personId: "" },
  };

  // Interactive login — opens browser, waits for callback, persists token
  const token = await interactiveLogin(tempAccount, { clientId, clientSecret });

  // Discover identity using the access token directly (no cached TokenManager needed)
  const info = await discoverIdentity(token.accessToken);

  const tempTokenFile = resolveTokenFilePath(tempKey);

  return { info, clientId, clientSecret, tempTokenFile, promptedClientId, promptedClientSecret };
}

// ---------------------------------------------------------------------------
// Step 2b: CLI identity discovery
// ---------------------------------------------------------------------------

type CliDiscoveryResult = {
  profile: string | undefined;
  identity: { id: number; name: string; email_address: string; attachable_sgid?: string };
  accounts: Array<{ id: number; name: string }>;
  basecampAccountId?: string;
};

async function discoverViaCli(
  profileNames: string[],
  prompter: WizardPrompter,
): Promise<CliDiscoveryResult | undefined> {
  // Select profile
  let selectedProfile: string | undefined;
  if (profileNames.length > 1) {
    const choice = await prompter.select({
      message: "Select CLI profile for the new identity",
      options: [
        ...profileNames.map((name) => ({ value: name, label: name })),
        { value: "__none__", label: "Use default (no profile)" },
      ],
    });
    selectedProfile = choice === "__none__" ? undefined : choice;
  } else if (profileNames.length === 1) {
    selectedProfile = profileNames[0];
  }

  try {
    const meResult = await cliMe(selectedProfile ? { profile: selectedProfile } : {});
    const data = meResult.data as unknown as {
      identity?: { id: number; name: string; email_address: string; attachable_sgid?: string };
      accounts?: Array<{ id: number; name: string }>;
    };
    const identity = data.identity ?? (meResult.data as unknown as typeof data.identity);
    if (!identity) return undefined;
    return {
      profile: selectedProfile,
      identity,
      accounts: data.accounts ?? [],
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Step 3: Select Basecamp account (filter bc3, extract numeric ID)
// ---------------------------------------------------------------------------

async function selectBasecampAccount(
  accounts: Array<{ id: number; name: string; product?: string }>,
  prompter: WizardPrompter,
): Promise<string | undefined> {
  const bc3 = accounts.filter((a) => !a.product || a.product === "bc3");
  if (bc3.length === 0) return undefined;

  if (bc3.length === 1) {
    await prompter.note(
      `Using account: ${bc3[0]!.name} (${bc3[0]!.id})`,
      "Basecamp account",
    );
    return String(bc3[0]!.id);
  }

  return await prompter.select({
    message: "Basecamp account for this identity",
    options: bc3.map((a) => ({
      value: String(a.id),
      label: `${a.name} (${a.id})`,
    })),
  });
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

/**
 * Run the hatch identity wizard.
 *
 * Steps:
 * 1. Auth method choice (browser vs CLI)
 * 2. Obtain token + discover identity (branched by method)
 * 3. Select Basecamp account
 * 4. Resolve personId
 * 5. Prompt for unique accountId key
 * 6. Optional persona mapping
 * 7. Apply config (with auth-method conflict cleanup)
 */
export async function hatchIdentity(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<HatchResult> {
  // Probe CLI availability
  let profileNames: string[] = [];
  try {
    const result = await cliProfileList();
    profileNames = result.data;
  } catch {
    // CLI not available
  }
  const cliAvailable = profileNames.length > 0;

  // Step 1: Auth method choice
  const authMethod = await chooseAuthMethod(prompter, cliAvailable);

  // Step 2: Discover identity
  let personId: string | undefined;
  let displayName: string | undefined;
  let attachableSgid: string | undefined;
  let basecampAccountId: string | undefined;

  // Auth-specific config fields
  let oauthTokenFile: string | undefined;
  let oauthClientId: string | undefined;
  let oauthClientSecret: string | undefined;
  let promptedClientId = false;
  let promptedClientSecret = false;
  let oauthResult: OAuthDiscoveryResult | undefined;
  let cliProfile: string | undefined;

  if (authMethod === "browser") {
    // Browser auth is all-or-nothing: if login or identity discovery fails,
    // abort rather than creating an account with no auth material.
    oauthResult = await discoverViaBrowser(cfg, prompter);
    const { info } = oauthResult;

    await prompter.note(
      `Identity: ${info.identity.firstName} ${info.identity.lastName} (ID: ${info.identity.id}, ${info.identity.emailAddress})`,
      "Detected identity",
    );

    personId = String(info.identity.id);
    displayName = `${info.identity.firstName} ${info.identity.lastName}`;

    // Select Basecamp account from discovered accounts
    basecampAccountId = await selectBasecampAccount(
      info.accounts as Array<{ id: number; name: string; product?: string }>,
      prompter,
    );
  } else {
    const cliResult = await discoverViaCli(profileNames, prompter);

    if (cliResult) {
      await prompter.note(
        `Identity: ${cliResult.identity.name} (ID: ${cliResult.identity.id}, ${cliResult.identity.email_address})`,
        "Detected identity",
      );

      personId = String(cliResult.identity.id);
      displayName = cliResult.identity.name;
      attachableSgid = cliResult.identity.attachable_sgid;
      cliProfile = cliResult.profile;

      // Select Basecamp account from CLI-discovered accounts
      basecampAccountId = await selectBasecampAccount(
        cliResult.accounts as Array<{ id: number; name: string; product?: string }>,
        prompter,
      );
    }
  }

  // Step 4: Resolve personId — confirm or prompt for manual entry
  if (!personId) {
    personId = await prompter.text({
      message: "Basecamp person ID for this identity",
      validate: (v) => (v?.trim() ? undefined : "Required"),
    });
    personId = personId.trim();
  }

  // Step 5: Prompt for unique accountId key
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

  // Relocate OAuth temp token file to final {accountId}-based path.
  // Try rename first; fall back to copy+unlink for cross-device moves.
  // If all moves fail, keep the temp path (the file exists there).
  if (oauthResult) {
    const finalPath = resolveTokenFilePath(accountId);
    let relocated = false;
    try {
      const { rename, mkdir, copyFile, unlink } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(finalPath), { recursive: true });
      try {
        await rename(oauthResult.tempTokenFile, finalPath);
        relocated = true;
      } catch {
        // rename fails across devices — fall back to copy+unlink
        await copyFile(oauthResult.tempTokenFile, finalPath);
        relocated = true;
        await unlink(oauthResult.tempTokenFile).catch(() => {});
      }
    } catch {
      // All move attempts failed — keep temp path
      console.warn(
        `[basecamp:hatch] Could not relocate token file to ${finalPath}; using ${oauthResult.tempTokenFile}`,
      );
    }
    oauthTokenFile = relocated ? finalPath : oauthResult.tempTokenFile;
    oauthClientId = oauthResult.clientId;
    oauthClientSecret = oauthResult.clientSecret;
    promptedClientId = oauthResult.promptedClientId;
    promptedClientSecret = oauthResult.promptedClientSecret;
  }

  // Step 6: Optional persona mapping
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

  // Step 7: Apply config
  const section = getBasecampSection(cfg) ?? {};
  const accounts = (section.accounts ?? {}) as Record<string, Record<string, unknown>>;
  const personas = { ...(section.personas ?? {}) };

  if (personaMapping) {
    personas[personaMapping.agentId] = personaMapping.accountId;
  }

  // Build account entry — include auth-method fields, omit the other method's fields
  const accountEntry: Record<string, unknown> = {
    personId,
    enabled: true,
    ...(displayName ? { displayName } : {}),
    ...(attachableSgid ? { attachableSgid } : {}),
    ...(basecampAccountId ? { basecampAccountId } : {}),
  };

  if (authMethod === "browser") {
    if (oauthTokenFile) accountEntry.oauthTokenFile = oauthTokenFile;
    // Auth-method conflict cleanup: strip CLI fields
  } else {
    if (cliProfile) accountEntry.cliProfile = cliProfile;
    if (basecampAccountId) accountEntry.basecampAccountId = basecampAccountId;
    // Auth-method conflict cleanup: strip OAuth fields
  }

  // Build updated channel-level oauth if credentials were prompted
  const oauthSection = promptedClientId && oauthClientId
    ? {
        ...(section.oauth ?? {}),
        clientId: oauthClientId,
        ...(promptedClientSecret && oauthClientSecret ? { clientSecret: oauthClientSecret } : {}),
      }
    : section.oauth;

  const next: OpenClawConfig = {
    ...cfg,
    channels: {
      ...cfg.channels,
      basecamp: {
        ...section,
        accounts: {
          ...accounts,
          [accountId]: accountEntry,
        },
        personas,
        ...(oauthSection ? { oauth: oauthSection } : {}),
      },
    },
  };

  return { cfg: next, accountId, personId, personaMapping };
}
