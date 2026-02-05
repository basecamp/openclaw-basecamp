import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setBasecampRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getBasecampRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Basecamp runtime not initialized");
  }
  return runtime;
}
