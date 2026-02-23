import { homedir } from "node:os";
import { join } from "node:path";
import { getBasecampRuntime } from "../runtime.js";

const FALLBACK_STATE_DIR = "/tmp/openclaw-basecamp-state";
let fallbackWarned = false;

/**
 * Resolve the plugin-specific state directory from the OpenClaw runtime.
 * Falls back to /tmp/openclaw-basecamp-state if runtime is unavailable
 * (e.g. webhooks arriving before channel start on first boot).
 */
export function resolvePluginStateDir(): string {
  try {
    const runtime = getBasecampRuntime();
    const baseDir = runtime.state.resolveStateDir(process.env, homedir);
    return join(baseDir, "plugins", "basecamp");
  } catch {
    if (!fallbackWarned) {
      fallbackWarned = true;
      console.warn(
        `[basecamp:state-dir] runtime unavailable, using fallback ${FALLBACK_STATE_DIR} — ` +
        "secrets and dedup state will persist here with default file permissions",
      );
    }
    return FALLBACK_STATE_DIR;
  }
}
