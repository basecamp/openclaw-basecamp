/**
 * Tests: plugin state directory resolution.
 *
 * The runtime's resolver wins when installed; without one, the SDK's
 * standalone resolver lands on the same canonical state dir (never a
 * legacy or tmp fallback path).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePluginStateDir } from "../src/inbound/state-dir.js";
import { clearBasecampRuntime, setBasecampRuntime } from "../src/runtime.js";

describe("resolvePluginStateDir", () => {
  afterEach(() => {
    clearBasecampRuntime();
  });

  it("resolves <stateDir>/plugins/basecamp from the runtime", () => {
    setBasecampRuntime({
      state: { resolveStateDir: () => "/var/state/openclaw" },
    } as never);

    expect(resolvePluginStateDir()).toBe("/var/state/openclaw/plugins/basecamp");
  });

  it("resolves the canonical state dir standalone when no runtime is installed", () => {
    clearBasecampRuntime();
    expect(resolvePluginStateDir()).toBe(join(resolveStateDir(process.env, homedir), "plugins", "basecamp"));
  });

  it("honors OPENCLAW_STATE_DIR without a runtime (setup-only contexts)", () => {
    clearBasecampRuntime();
    const prev = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = "/var/custom-state";
    try {
      expect(resolvePluginStateDir()).toBe(join("/var/custom-state", "plugins", "basecamp"));
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prev;
    }
  });
});
