import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

// Global named slot keyed by plugin id so duplicate SDK module instances
// (managed per-plugin npm projects) share the same runtime.
const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "basecamp",
  errorMessage: "Basecamp runtime not initialized",
});

export const setBasecampRuntime = store.setRuntime;
export const getBasecampRuntime = store.getRuntime;
export const tryGetBasecampRuntime = store.tryGetRuntime;
export const clearBasecampRuntime = store.clearRuntime;
