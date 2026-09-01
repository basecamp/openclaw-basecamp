import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildBasecampManifest, renderBasecampManifest } from "../scripts/generate-manifest.js";
import { registerBasecampTools } from "../src/adapters/agent-tools.js";
import { BASECAMP_TOOL_METADATA, BASECAMP_TOOL_NAMES } from "../src/tools/catalog.js";

const rootDir = process.cwd();

const readJson = (path: string) => JSON.parse(readFileSync(resolve(rootDir, path), "utf8"));

// ---------------------------------------------------------------------------
// Manifest contract (SPEC §1.3, §4.4): the checked-in openclaw.plugin.json is
// generated output — `npm run manifest:gen` is the only sanctioned editor.
// ---------------------------------------------------------------------------

describe("openclaw.plugin.json contract", () => {
  const manifest = readJson("openclaw.plugin.json");
  const pkg = readJson("package.json");

  it("matches the generator output exactly (run `npm run manifest:gen` after schema changes)", () => {
    expect(manifest).toEqual(buildBasecampManifest(rootDir));
    expect(readFileSync(resolve(rootDir, "openclaw.plugin.json"), "utf8")).toBe(renderBasecampManifest(rootDir));
  });

  it("uses the channel id as plugin id and declares lazy channel activation", () => {
    expect(manifest.id).toBe("basecamp");
    expect(manifest.channels).toEqual(["basecamp"]);
    expect(manifest.activation).toEqual({ onStartup: false, onChannels: ["basecamp"] });
  });

  it("keeps the manifest version in lockstep with package.json", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("declares an empty strict plugin configSchema (channel schema lives in channelConfigs)", () => {
    expect(manifest.configSchema).toEqual({ type: "object", additionalProperties: false, properties: {} });
  });

  it("declares contracts.tools equal to the names the plugin registers via api.registerTool", () => {
    // The loader rejects api.registerTool for any name missing from
    // contracts.tools, so the registered names and the manifest must agree.
    const api = { registerTool: vi.fn() };
    registerBasecampTools(api);
    const registered = api.registerTool.mock.calls.flatMap(([, opts]) => opts?.names ?? []);

    expect(registered).toHaveLength(10);
    expect(manifest.contracts.tools).toEqual(registered);
    expect(manifest.contracts.tools).toEqual([...BASECAMP_TOOL_NAMES]);
  });

  it("declares toolMetadata for every tool: replaySafe reads, sideEffecting mutations", () => {
    expect(Object.keys(manifest.toolMetadata)).toEqual(manifest.contracts.tools);
    expect(manifest.toolMetadata).toEqual(BASECAMP_TOOL_METADATA);
    const replaySafe = ["basecamp_read_history", "basecamp_api_read"];
    for (const [name, meta] of Object.entries(manifest.toolMetadata)) {
      expect(meta, name).toEqual(replaySafe.includes(name) ? { replaySafe: true } : { sideEffecting: true });
    }
  });

  it("declares the plugin state dir as a backup resource", () => {
    expect(manifest.backupResources).toEqual([
      { disposition: "include", scope: "state", relativePath: "plugins/basecamp" },
    ]);
  });

  it("ships channelConfigs.basecamp with generated schema, uiHints, and command defaults", () => {
    const channel = manifest.channelConfigs.basecamp;
    expect(channel.label).toBe("Basecamp");
    expect(channel.commands).toEqual({ nativeCommandsAutoEnabled: false, nativeSkillsAutoEnabled: false });
    expect(channel.schema.type).toBe("object");
    expect(channel.schema.properties).toHaveProperty("accounts");
    expect(channel.schema.properties).toHaveProperty("dmPolicy");
    // SDK-standard hints and Basecamp-specific hints are both present.
    expect(channel.uiHints).toHaveProperty("dmPolicy");
    expect(channel.uiHints).toHaveProperty("accounts.*.tokenFile");
    expect(channel.uiHints["accounts.*.token"].sensitive).toBe(true);
  });

  it("declares the doctor contract and no forbidden manifest surfaces", () => {
    // doctorContract pairs with the doctor adapter + doctor-contract-api
    // sidecar; the rest are permanently out per SPEC §1.3 "Do NOT add".
    expect(manifest.doctorContract).toEqual({ configRepair: true });
    expect(manifest).not.toHaveProperty("configContracts");
    expect(manifest).not.toHaveProperty("runtimeExtensions");
    expect(manifest).not.toHaveProperty("setupFeatures");
  });
});

describe("tool catalog module", () => {
  it("stays import-free so the generator and setup-time readers never load the Basecamp SDK", () => {
    const source = readFileSync(resolve(rootDir, "src/tools/catalog.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/^\s*import\b/m);
    expect(code).not.toMatch(/\brequire\(/);
  });

  it("has no duplicate names", () => {
    expect(new Set(BASECAMP_TOOL_NAMES).size).toBe(BASECAMP_TOOL_NAMES.length);
  });
});

// ---------------------------------------------------------------------------
// package.json openclaw section (SPEC §1.3 table)
// ---------------------------------------------------------------------------

describe("package.json openclaw contract", () => {
  const pkg = readJson("package.json");
  const oc = pkg.openclaw;

  it("declares the setup entry and ships it (plus the manifest) in the pack", () => {
    expect(oc.setupEntry).toBe("./dist/setup-entry.js");
    expect(pkg.files).toContain("dist/");
    expect(pkg.files).toContain("openclaw.plugin.json");
  });

  it("declares host compat, build provenance, and install floor", () => {
    expect(oc.compat.pluginApi).toBe(">=2026.8.1");
    expect(oc.install.minHostVersion).toBe(">=2026.8.1");
    expect(oc.build).toEqual({ openclawVersion: "2026.8.1", pluginSdkVersion: "2026.8.1" });
  });

  it("declares channel metadata for runtime-free `openclaw channels add basecamp`", () => {
    const channel = oc.channel;
    expect(channel.id).toBe("basecamp");
    expect(channel.systemImage).toBe("building.2");
    expect(channel.markdownCapable).toBe(true);
    expect(channel.aliases).toEqual(["bc"]);
    expect(channel.commands).toEqual({ nativeCommandsAutoEnabled: false, nativeSkillsAutoEnabled: false });
    expect(channel.doctorCapabilities).toEqual({ dmAllowFromMode: "topOnly", groupModel: "route" });
    expect(typeof channel.detailLabel).toBe("string");
  });

  it("mirrors the setup contract fields", async () => {
    const { basecampSetupContract } = await import("../src/channel-setup.js");
    const contractKeys = (basecampSetupContract.metadata as { fields: Array<{ key: string }> }).fields.map(
      (f) => f.key,
    );
    const keys = oc.channel.setup.fields.map((f: { key: string }) => f.key);
    expect(keys).toEqual(contractKeys);
    for (const field of oc.channel.setup.fields) {
      expect(field.kind, field.key).toBe("string");
      expect(field.cli.flags, field.key).toMatch(/^--[a-z-]+ </);
      expect(typeof field.cli.description, field.key).toBe("string");
    }
    const sensitive = oc.channel.setup.fields
      .filter((f: { sensitive?: boolean }) => f.sensitive)
      .map((f: { key: string }) => f.key);
    const contractSensitive = (
      basecampSetupContract.metadata as { fields: Array<{ key: string; sensitive?: boolean }> }
    ).fields
      .filter((f) => f.sensitive)
      .map((f) => f.key);
    expect(sensitive).toEqual(contractSensitive);
  });
});
