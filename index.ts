import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { basecampChannel } from "./src/channel.js";
import { setBasecampRuntime } from "./src/runtime.js";
import { handleBasecampWebhook } from "./src/inbound/webhooks.js";
import { getSurfacePrompt } from "./src/hooks/agent-prompt-context.js";

const plugin: {
  id: string;
  name: string;
  description: string;
  configSchema: ReturnType<typeof emptyPluginConfigSchema>;
  register: (api: OpenClawPluginApi) => void;
} = {
  id: "openclaw-basecamp",
  name: "Basecamp",
  description: "Basecamp channel — Campfire, cards, todos, check-ins, pings",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setBasecampRuntime(api.runtime);
    // Cast required: SDK's registerChannel expects ChannelPlugin<unknown> but
    // our concrete Probe/Audit type params are contravariant with unknown.
    api.registerChannel({ plugin: basecampChannel as any });
    api.registerHttpRoute({
      path: "/webhooks/basecamp",
      handler: handleBasecampWebhook,
    });
    api.on("before_agent_start", (event) => {
      const lines = event.prompt.split(/\r?\n/).filter((l) => l.startsWith("[basecamp] "));
      const surfacePrompt = getSurfacePrompt(lines);
      if (surfacePrompt) {
        return { prependContext: surfacePrompt };
      }
    });
  },
};

export default plugin;
