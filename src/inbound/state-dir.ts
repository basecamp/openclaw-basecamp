import { homedir } from "node:os";
import { join } from "node:path";
import { getBasecampRuntime } from "../runtime.js";

/**
 * Resolve the plugin-specific state directory from the OpenClaw runtime.
 *
 * Fails closed (throws) when the runtime is unavailable: the webhook route
 * is only registered in full-runtime mode, after setRuntime has run, so this
 * only fires on genuine programming errors — never write secrets or dedup
 * state to a fallback path.
 */
export function resolvePluginStateDir(): string {
  const runtime = getBasecampRuntime();
  const baseDir = runtime.state.resolveStateDir(process.env, homedir);
  return join(baseDir, "plugins", "basecamp");
}
