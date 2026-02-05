import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { basecampChannel } from "./src/channel.js";
import { setBasecampRuntime } from "./src/runtime.js";
import { handleBasecampWebhook } from "./src/inbound/webhooks.js";

const plugin = {
  id: "basecamp",
  name: "Basecamp",
  description: "Basecamp channel — Campfire, cards, todos, check-ins, pings",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setBasecampRuntime(api.runtime);
    api.registerChannel({ plugin: basecampChannel as any });
    api.registerHttpRoute({
      path: "/webhooks/basecamp",
      handler: handleBasecampWebhook,
    });
  },
};

export default plugin;
