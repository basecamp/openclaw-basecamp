/**
 * Doctor contract sidecar (SPEC §2.23).
 *
 * The host cold-loads `doctor-contract-api.js` from the installed package
 * (package root or dist/) to run `openclaw doctor` config repairs without
 * loading the plugin runtime. Keep this module import-light: no Basecamp SDK
 * client, webhooks, poller, or dedup imports.
 *
 * Exports follow the host's doctor-contract module shape:
 *   - legacyConfigRules: ChannelDoctorLegacyConfigRule[]
 *   - normalizeCompatibilityConfig({cfg}) → {config, changes, warnings?}
 *
 * State migrations are intentionally omitted (migrations waived for the
 * 2026.8.1 move).
 *
 * NOTE (WP1/merge): tsc emits this as dist/src/doctor-contract-api.js; the
 * host resolver only checks <root>/doctor-contract-api.js and
 * <root>/dist/doctor-contract-api.js, so the build/manifest step must place a
 * re-export shim at one of those paths and set doctorContract.configRepair
 * in openclaw.plugin.json.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { repairBasecampConfig } from "./adapters/doctor.js";

/** No legacy Basecamp config keys exist yet — the channel shipped on 2.0 shapes. */
export const legacyConfigRules: never[] = [];

/** Repair Basecamp config sections for `openclaw doctor --fix`. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }) {
  return repairBasecampConfig({ cfg });
}
