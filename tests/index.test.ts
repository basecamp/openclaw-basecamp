import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import basecampPluginEntry from "../index.js";
import { buildBasecampTools } from "../src/adapters/agent-tools.js";
import { basecampChannel } from "../src/channel.js";
import { clearBasecampRuntime, tryGetBasecampRuntime } from "../src/runtime.js";
import { BASECAMP_TOOL_NAMES } from "../src/tools/catalog.js";

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "openclaw.plugin.json"), "utf8"));

type RegistrationMode = "full" | "discovery" | "tool-discovery" | "setup-only" | "setup-runtime" | "cli-metadata";

/**
 * Fake OpenClawPluginApi that records registrations. `runtime` is a throwing
 * getter unless a runtime is supplied, so any registration-time runtime
 * access in a runtime-less mode fails the test instead of passing silently.
 */
function fakeApi(mode: RegistrationMode, runtime?: unknown) {
  const api = {
    registrationMode: mode,
    registerChannel: vi.fn(),
    registerTool: vi.fn(),
    registerHttpRoute: vi.fn(),
    on: vi.fn(),
    registerCli: vi.fn(),
  };
  Object.defineProperty(api, "runtime", {
    get() {
      if (runtime === undefined) throw new Error(`api.runtime is unavailable in "${mode}" mode`);
      return runtime;
    },
  });
  return api;
}

afterEach(() => {
  clearBasecampRuntime();
});

describe("plugin entry", () => {
  it("is the basecamp channel entry", () => {
    expect(basecampPluginEntry.id).toBe("basecamp");
    expect(basecampPluginEntry.name).toBe("Basecamp");
    expect(basecampPluginEntry.channelPlugin).toBe(basecampChannel);
  });

  it("registers exactly the catalog tools in tool-discovery mode, without runtime or channel", () => {
    const api = fakeApi("tool-discovery");

    basecampPluginEntry.register(api as any);

    expect(api.registerChannel).not.toHaveBeenCalled();
    expect(api.registerTool).toHaveBeenCalledTimes(1);
    const [factory, opts] = api.registerTool.mock.calls[0]!;
    expect(factory).toBe(buildBasecampTools);
    expect(opts).toEqual({ names: [...BASECAMP_TOOL_NAMES] });
    // The factory itself is runtime-free: building descriptors needs no config.
    const built = factory({ getRuntimeConfig: () => undefined });
    expect(built.map((t: { name: string }) => t.name)).toEqual([...BASECAMP_TOOL_NAMES]);
    expect(tryGetBasecampRuntime()).toBeFalsy();
  });

  it("keeps the manifest contracts.tools identical to the registered tool names", () => {
    const api = fakeApi("tool-discovery");

    basecampPluginEntry.register(api as any);

    const registered = api.registerTool.mock.calls.flatMap(([, opts]) => opts?.names ?? []);
    expect(registered).toEqual(manifest.contracts.tools);
    expect(Object.keys(manifest.toolMetadata)).toEqual(registered);
  });

  it("registers channel, runtime, webhook route, gateway_stop hook, and tools in full mode", () => {
    const runtime = { config: { current: () => ({}) } };
    const api = fakeApi("full", runtime);

    basecampPluginEntry.register(api as any);

    expect(api.registerChannel).toHaveBeenCalledWith({ plugin: basecampChannel });
    expect(tryGetBasecampRuntime()).toBe(runtime);
    expect(api.registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/webhooks/basecamp", auth: "plugin", handler: expect.any(Function) }),
    );
    expect(api.on).toHaveBeenCalledWith("gateway_stop", expect.any(Function));
    expect(api.registerTool).toHaveBeenCalledTimes(1);
    expect(api.registerTool.mock.calls[0]![1]).toEqual({ names: [...BASECAMP_TOOL_NAMES] });
  });

  it("registers nothing runtime-bound in cli-metadata mode", () => {
    const api = fakeApi("cli-metadata");

    basecampPluginEntry.register(api as any);

    expect(api.registerChannel).not.toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.registerHttpRoute).not.toHaveBeenCalled();
  });

  it("registers only the channel in setup-only mode", () => {
    const api = fakeApi("setup-only", { config: { current: () => ({}) } });

    basecampPluginEntry.register(api as any);

    expect(api.registerChannel).toHaveBeenCalledTimes(1);
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.registerHttpRoute).not.toHaveBeenCalled();
  });
});
