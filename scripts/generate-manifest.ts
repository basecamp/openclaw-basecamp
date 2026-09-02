/**
 * Manifest generator (SPEC §1.3): emits `openclaw.plugin.json` from the code
 * sources of truth — the Zod config schema + uiHints in `src/channel-setup.ts`
 * and the agent tool catalog in `src/tools/catalog.ts`.
 *
 * Run via `npm run manifest:gen` (builds, then executes the compiled script).
 * `tests/manifest-contract.test.ts` runs `buildBasecampManifest` in-process
 * and asserts the checked-in manifest matches, so schema drift fails CI.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { basecampChannelMeta, basecampConfigSchema } from "../src/channel-setup.js";
import { BASECAMP_TOOL_METADATA, BASECAMP_TOOL_NAMES } from "../src/tools/catalog.js";

/** Build the full `openclaw.plugin.json` document as a plain JSON value. */
export function buildBasecampManifest(rootDir: string): Record<string, unknown> {
  const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
  // `contracts.tools` gates api.registerTool at load time; `toolMetadata`
  // carries the replay/side-effect facts. Both come from the catalog.
  const tools = [...BASECAMP_TOOL_NAMES];
  const toolMetadata = Object.fromEntries(tools.map((name) => [name, BASECAMP_TOOL_METADATA[name]]));

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
