import { homedir } from "node:os";
import { join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { tryGetBasecampRuntime } from "../runtime.js";

/**
 * Resolve the plugin-specific state directory.
 *
 * Prefers the installed runtime's resolver (tests stub it; the host may scope
 * it), falling back to the SDK's standalone resolver — the same env/homedir
 * logic — so setup-only contexts (onboarding through the import-light setup
 * entry, before setRuntime runs) still land on the canonical state dir
 * covered by `backupResources`, never a legacy home path.
 */
export function resolvePluginStateDir(): string {
  const runtime = tryGetBasecampRuntime();
  const baseDir = runtime ? runtime.state.resolveStateDir(process.env, homedir) : resolveStateDir(process.env, homedir);
  return join(baseDir, "plugins", "basecamp");
}
