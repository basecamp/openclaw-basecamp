import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { basecampChannel } from "./src/channel.js";
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
      api.on("gateway_stop", () => {
        flushWebhookSecrets();
      });
    },
  });

export default basecampPluginEntry;
