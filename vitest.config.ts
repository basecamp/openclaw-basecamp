import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Resolve openclaw/plugin-sdk to local source for testing.
      // Set OPENCLAW_PLUGIN_SDK_PATH to override the default location.
      "openclaw/plugin-sdk": process.env.OPENCLAW_PLUGIN_SDK_PATH ??
        path.resolve(
          process.env.HOME ?? "~",
          "Work/basecamp/openclaw/src/plugin-sdk/index.ts",
        ),
    },
  },
});
