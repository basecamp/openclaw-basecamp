/**
 * Manifest generator (SPEC §1.3): emits `openclaw.plugin.json` from the code
 * sources of truth — the Zod config schema + uiHints in `src/channel-setup.ts`
 * and the tool names in `src/adapters/agent-tools.ts`.
 *
 * Run via `npm run manifest:gen` (builds, then executes the compiled script).
 * `tests/manifest-contract.test.ts` runs `buildBasecampManifest` in-process
 * and asserts the checked-in manifest matches, so schema drift fails CI.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { basecampChannelMeta, basecampConfigSchema } from "../src/channel-setup.js";

/** Tools whose execution is safe to repeat after an incomplete model turn. */
const REPLAY_SAFE_TOOLS = new Set(["basecamp_read_history", "basecamp_api_read"]);

/**
 * Extract the `basecamp_*` agent tool names from the agent-tools source, in
 * declaration order. Parsed from source because the tool factory requires a
 * configured account/client to run; WP6's `api.registerTool` migration can
 * replace this with a real export.
 */
export function extractBasecampToolNames(source: string): string[] {
  const names = [...source.matchAll(/name: "(basecamp_[a-z_]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(names)];
  if (unique.length !== names.length) throw new Error("duplicate basecamp_* tool names in agent-tools.ts");
  if (unique.length === 0) throw new Error("no basecamp_* tool names found in agent-tools.ts");
  return unique;
}

/** Read the repo's agent tool names (rootDir must be the repo root). */
export function readBasecampToolNames(rootDir: string): string[] {
  return extractBasecampToolNames(readFileSync(resolve(rootDir, "src/adapters/agent-tools.ts"), "utf8"));
}

/** Build the full `openclaw.plugin.json` document as a plain JSON value. */
export function buildBasecampManifest(rootDir: string): Record<string, unknown> {
  const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
  const tools = readBasecampToolNames(rootDir);
  const toolMetadata = Object.fromEntries(
    tools.map((name) => [name, REPLAY_SAFE_TOOLS.has(name) ? { replaySafe: true } : { sideEffecting: true }]),
  );

  const manifest = {
    id: "basecamp",
    name: "Basecamp",
    description: basecampChannelMeta.blurb,
    version: pkg.version,
    icon: "https://cdn.simpleicons.org/basecamp",
    channels: ["basecamp"],
    activation: { onStartup: false, onChannels: ["basecamp"] },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
    contracts: { tools },
    toolMetadata,
    doctorContract: { configRepair: true },
    backupResources: [{ disposition: "include", scope: "state", relativePath: "plugins/basecamp" }],
    channelConfigs: {
      basecamp: {
        label: basecampChannelMeta.label,
        description: basecampChannelMeta.blurb,
        commands: { nativeCommandsAutoEnabled: false, nativeSkillsAutoEnabled: false },
        schema: basecampConfigSchema.schema,
        uiHints: basecampConfigSchema.uiHints,
      },
    },
  };

  // Round-trip through JSON to drop undefined values and non-serializable
  // fields (e.g. the runtime validator on ChannelConfigSchema).
  return JSON.parse(JSON.stringify(manifest));
}

/** Render the manifest exactly as checked in. */
export function renderBasecampManifest(rootDir: string): string {
  return `${JSON.stringify(buildBasecampManifest(rootDir), null, 2)}\n`;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const rootDir = process.cwd();
  const target = resolve(rootDir, "openclaw.plugin.json");
  writeFileSync(target, renderBasecampManifest(rootDir));
  console.log(`wrote ${target}`);
}
