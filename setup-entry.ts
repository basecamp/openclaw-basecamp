/**
 * Setup entry (SPEC §1.4): loaded by the host for read-only status, channels
 * listings, and SecretRef scans without the full plugin runtime — referenced
 * from `package.json#openclaw.setupEntry` as `./dist/setup-entry.js`.
 *
 * Its static import graph must never reach `@37signals/basecamp`, the webhook
 * handler, or the poller (asserted by tests/setup-entry-imports.test.ts).
 */

import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { basecampSetupPlugin } from "./src/channel-setup.js";

// Explicit annotation keeps the declaration-emit portable (TS2883), matching
// the pattern in index.ts.
const basecampSetupEntry: { plugin: typeof basecampSetupPlugin } = defineSetupPluginEntry(basecampSetupPlugin);

export default basecampSetupEntry;
