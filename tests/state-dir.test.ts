/**
 * Tests: plugin state directory resolution.
 *
 * Fails closed when the runtime is unavailable — never writes state or
 * secrets to a fallback path.
 */

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

  it("throws (fails closed) when the runtime is not initialized", () => {
    clearBasecampRuntime();
    expect(() => resolvePluginStateDir()).toThrow(/runtime not initialized/i);
  });
});
