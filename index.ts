import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { registerBasecampTools } from "./src/adapters/agent-tools.js";
import { basecampChannel } from "./src/channel.js";
import { closeAllRecordingIndexes } from "./src/inbound/recording-index.js";
import { flushWebhookSecrets, handleBasecampWebhook } from "./src/inbound/webhooks.js";
import { setBasecampRuntime } from "./src/runtime.js";

// Explicit annotation keeps the declaration-emit portable: the inferred entry
// type references SDK-internal chunk types TS refuses to name (TS2883).
const basecampPluginEntry: ReturnType<typeof defineChannelPluginEntry<typeof basecampChannel>> =
  defineChannelPluginEntry({
    id: "basecamp",
    name: "Basecamp",
    description: "Basecamp channel — Campfire, cards, todos, check-ins, pings",
    plugin: basecampChannel,
    setRuntime: setBasecampRuntime,
    registerFull(api) {
      api.registerHttpRoute({
        path: "/webhooks/basecamp",
        handler: handleBasecampWebhook,
        auth: "plugin",
      });
      api.on("gateway_stop", async () => {
        flushWebhookSecrets();
        await closeAllRecordingIndexes();
      });
      // Agent tools (SPEC §2.9). Also runs in "tool-discovery" mode, where no
      // runtime exists — the factory defers all config/client access to execute.
      registerBasecampTools(api);
    },
  });

export default basecampPluginEntry;
